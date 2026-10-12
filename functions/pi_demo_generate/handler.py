"""
Process Intelligence — unified agent demo generation.

Trigger: POST /process-intelligence/{process_id}/demo
  Role: consultant | super_admin
  Body: { agents: [{agent_id, kind, name, description}], theme?: {clientName, clientLogoText, primaryColor} }
  Applies the consultant's review-step edits (name/description/kind override/
  reorder — array order defines position) to pi.agents, then enqueues a
  'pi_demo_generate' job. Returns: { process_id, demo_status: "generating" }

Poll:    GET /process-intelligence/{process_id}/demo
  Role: consultant | super_admin
  Returns: { process_id, demo_status, download_url, demo_error, demo_agent_ids }
  download_url is a freshly-signed SAS URL on every call (never cached), only
  present once demo_status == "done".

Worker:  queue-triggered, dispatched by job_type == "pi_demo_generate".
  Sequentially, per confirmed agent: calls the content-generation model
  (prompt_demo_content.md) to produce persona/currentState/agenticWorkflow/
  humanRoles/maturity/actionsPerformed/agenticAbilities/knowledgeRequired/
  democontent, and stores it on pi.agents.demo_profile. Any failure aborts
  the whole run (all-or-nothing, matching pi_agent_lld's style — a demo
  missing an agent isn't a valid demo). On success, renders the unified HTML
  (renderer.render_demo) and uploads it to blob storage.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from common import tenant_from_event, TenantError, ai, audit_events, blob, queue, http
from common.tenant import TenantContext
from common.pi_aurora import (
    get_process_graph_status,
    get_agent,
    get_full_graph,
    update_agent_review,
    update_agent_demo_profile,
    set_demo_generating,
    set_demo_done,
    set_demo_failed,
    get_demo_status,
)

from .renderer import render_demo

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_DEMO_CONTENT_SYSTEM = (Path(__file__).parent / "prompt_demo_content.md").read_text(encoding="utf-8")

_VALID_KINDS = {"conversational", "workspace"}
_VALID_STAGES = ["Detect", "Plan", "Nudge", "Insight", "Action", "Learning Loop"]
_DEFAULT_PRIMARY_COLOR = "#0875E1"


# ── Dispatcher (GET/POST split, same shape as pi_agent_lld) ──────────────────

def handler(event: dict, context: object) -> dict:
    method = (event.get("requestContext") or {}).get("http", {}).get("method", "").upper()
    if method == "GET":
        return poll_handler(event, context)
    return trigger_handler(event, context)


# ── Trigger handler (API) ─────────────────────────────────────────────────────

def trigger_handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    process_id = (event.get("pathParameters") or {}).get("process_id", "")
    if not process_id:
        return http.bad_request("process_id path parameter is required")

    try:
        body = json.loads(event.get("body") or "{}")
    except Exception:
        return http.bad_request("invalid JSON body")

    agents_in = body.get("agents") or []
    if not agents_in:
        return http.bad_request("agents must be a non-empty array")

    try:
        process_meta = get_process_graph_status(process_id=process_id, tenant_id=ctx.tenant_id)
    except Exception as exc:
        log.exception("get_process_graph_status error process_id=%s: %s", process_id, exc)
        return http.server_error(f"Failed to load process: {exc}")
    if not process_meta:
        return http.bad_request("process graph not found")

    agent_ids: list[str] = []
    try:
        for position, a in enumerate(agents_in):
            agent_id = a.get("agent_id")
            if not agent_id:
                return http.bad_request("every agent entry requires agent_id")
            existing = get_agent(agent_id=agent_id, tenant_id=ctx.tenant_id)
            if not existing or existing.get("process_id") != process_id:
                return http.bad_request(f"agent {agent_id} not found on this process")
            kind = a.get("kind") if a.get("kind") in _VALID_KINDS else (existing.get("kind") or "workspace")
            update_agent_review(
                agent_id=agent_id,
                tenant_id=ctx.tenant_id,
                name=(a.get("name") or existing["name"]),
                description=(a.get("description") if "description" in a else existing.get("description")),
                kind=kind,
                position=position,
            )
            agent_ids.append(agent_id)
    except Exception as exc:
        log.exception("apply review edits error process_id=%s: %s", process_id, exc)
        return http.server_error(f"Failed to apply review edits: {exc}")

    theme_in = body.get("theme") or {}
    client_name = (theme_in.get("clientName") or "").strip() or ctx.tenant_id.replace("-", " ").title()
    theme = {
        "clientName": client_name,
        "clientLogoText": (theme_in.get("clientLogoText") or "").strip() or "".join(w[0] for w in client_name.split()[:2]).upper(),
        "primaryColor": (theme_in.get("primaryColor") or "").strip() or _DEFAULT_PRIMARY_COLOR,
    }

    try:
        set_demo_generating(process_id=process_id, tenant_id=ctx.tenant_id, agent_ids=agent_ids, theme=theme)
    except Exception as exc:
        log.exception("set_demo_generating error process_id=%s: %s", process_id, exc)
        return http.server_error(f"Failed to start demo generation: {exc}")

    queue.enqueue_job("pi_demo_generate", {
        "process_id": process_id,
        "tenant_id":  ctx.tenant_id,
        "agent_ids":  agent_ids,
        "theme":      theme,
        "user_id":    ctx.user_id,
        "role":       ctx.role,
        "email":      ctx.email,
        "domain":     process_meta.get("domain", ""),
        "ip":         audit_events.get_ip(event),
    })

    log.info("pi_demo_generate triggered process_id=%s agent_count=%d", process_id, len(agent_ids))
    return http.ok({"process_id": process_id, "demo_status": "generating"})


# ── Poll handler (API) ────────────────────────────────────────────────────────

def poll_handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    process_id = (event.get("pathParameters") or {}).get("process_id", "")
    if not process_id:
        return http.bad_request("process_id path parameter is required")

    try:
        status = get_demo_status(process_id=process_id, tenant_id=ctx.tenant_id)
    except Exception as exc:
        log.exception("get_demo_status error process_id=%s: %s", process_id, exc)
        return http.server_error(f"Failed to load demo status: {exc}")
    if status is None:
        return http.bad_request("process graph not found")

    download_url = None
    if status["demo_status"] == "done" and status.get("demo_blob_key"):
        try:
            download_url = blob.generate_download_sas(status["demo_blob_key"], expires_in=3600)
        except Exception as exc:
            log.exception("generate_download_sas error process_id=%s: %s", process_id, exc)
            return http.server_error(f"Failed to sign download URL: {exc}")

    return http.ok({
        "process_id":     process_id,
        "demo_status":    status["demo_status"],
        "download_url":   download_url,
        "demo_error":     status["demo_error"],
        "demo_agent_ids": status["demo_agent_ids"],
    })


# ── Worker handler (queue-triggered, dispatched by job_type) ─────────────────

def _clamp_stage_name(stage: str | None) -> str | None:
    return stage if stage in _VALID_STAGES else None


def _validate_and_clean_profile(profile: dict, kind: str) -> dict:
    stages = ((profile.get("agenticWorkflow") or {}).get("stages")) or []
    cleaned_stages = []
    for s in stages:
        stage_name = _clamp_stage_name(s.get("stage"))
        if stage_name is None:
            log.warning("dropping demo content stage with invalid name: %r", s.get("stage"))
            continue
        cleaned_stages.append({**s, "stage": stage_name})
    profile.setdefault("agenticWorkflow", {})["stages"] = cleaned_stages

    democontent = profile.get("democontent") or {}
    has_transcript = bool(democontent.get("transcript"))
    has_dashboard = bool(democontent.get("dashboard"))
    if kind == "conversational" and not has_transcript:
        raise ValueError("conversational agent produced no transcript")
    if kind == "workspace" and not has_dashboard:
        raise ValueError("workspace agent produced no dashboard")
    return profile


def worker_handler(payload: dict) -> None:
    process_id = payload["process_id"]
    tenant_id  = payload["tenant_id"]
    agent_ids  = payload["agent_ids"]
    theme      = payload["theme"]
    domain     = payload.get("domain", "")
    ip         = payload.get("ip", "unknown")

    ctx = TenantContext(
        tenant_id=tenant_id,
        user_id=payload.get("user_id", ""),
        role=payload.get("role", "consultant"),
        email=payload.get("email", ""),
    )

    try:
        graph = get_full_graph(process_id=process_id, tenant_id=tenant_id) or {}
        steps_by_id = {s["step_id"]: s for s in graph.get("steps", [])}

        for agent_id in agent_ids:
            agent = get_agent(agent_id=agent_id, tenant_id=tenant_id)
            if not agent:
                raise ValueError(f"agent {agent_id} not found")

            replaced_steps = [
                {"step_id": sid, "label": steps_by_id[sid]["label"], "systems_touched": steps_by_id[sid].get("systems_touched", [])}
                for sid in (agent.get("replaces_step_ids") or [])
                if sid in steps_by_id
            ]
            user_prompt = (
                f"<client_name>{theme.get('clientName', '')}</client_name>\n"
                f"<process_domain>{domain}</process_domain>\n\n"
                "<agent>\n" + json.dumps({
                    "name":        agent["name"],
                    "description": agent["description"],
                    "model":       agent["model"],
                    "tools":       agent["tools"],
                    "kind":        agent["kind"],
                }, indent=2) + "\n</agent>\n\n"
                "<as_is_steps_replaced>\n" + json.dumps(replaced_steps, indent=2) + "\n</as_is_steps_replaced>"
            )

            profile = ai.generate_json(
                system=_DEMO_CONTENT_SYSTEM,
                user_prompt=user_prompt,
                max_tokens=6000,
                temperature=0.3,
            )
            profile = _validate_and_clean_profile(profile, agent["kind"])
            update_agent_demo_profile(agent_id=agent_id, tenant_id=tenant_id, demo_profile=profile)
            log.info("pi_demo_generate content done agent_id=%s kind=%s", agent_id, agent["kind"])

        agents_full = [get_agent(agent_id=aid, tenant_id=tenant_id) for aid in agent_ids]
        html = render_demo(agents=agents_full, theme=theme)

        blob_key = ctx.s3_key("pi-demos", process_id, "demo.html")
        blob.put_object(blob_key, html.encode("utf-8"), content_type="text/html; charset=utf-8")

        set_demo_done(process_id=process_id, tenant_id=tenant_id, blob_key=blob_key)

        audit_events.write(
            ctx,
            "pi.demo.generated",
            ip=ip,
            resource_type="process_graph",
            resource_id=process_id,
            resource_name=process_id,
            details={"agent_count": len(agent_ids)},
        )
        log.info("pi_demo_generate worker done process_id=%s agent_count=%d", process_id, len(agent_ids))

    except Exception as exc:
        log.error("pi_demo_generate worker error process_id=%s: %s", process_id, exc, exc_info=True)
        set_demo_failed(process_id=process_id, tenant_id=tenant_id, error=str(exc))
