"""
RFP Reimagine — generates a first-draft RFP response package (RFP Response document, Cover
Letter, Project Plan, Resource Plan) from a short client questionnaire, grounded in Deloitte's
own per-industry firm knowledge (functions/common/industry_knowledge.py) rather than any
client's own documents.

Three routes, one module (functions/function_app.py wires each to a differently-named function
here rather than splitting into three directories — matching that existing flexibility, since
these three are conceptually one feature):
  - POST /rfp/autopopulate        -> autopopulate_handler   (sync, one quick model call)
  - POST /rfp/generate             -> trigger_handler         (async — enqueues, mirrors
                                                                generate_tests/pi_parse's pattern:
                                                                generating 4 documents can run
                                                                past a sync request's time budget)
  - GET  /rfp/status/{jobId}       -> poll_handler
  - (queue-triggered)              -> worker_handler(payload)

Job-status records live in the `vectors` Cosmos container (chunk_id `rfp_job#<job_id>`), same
convention `generate_tests` already established for async job records — NOT in
industry_knowledge, which holds only the shared firm-knowledge corpus itself, never per-request
job state.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from common import tenant_from_event, TenantError, ai, industry_knowledge, vectors, audit_events, queue, app_settings, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_PROMPTS_DIR = Path(__file__).parent
_AUTOPOPULATE_PROMPT = (_PROMPTS_DIR / "prompt_autopopulate.md").read_text(encoding="utf-8")
_RFP_RESPONSE_PROMPT = (_PROMPTS_DIR / "prompt_rfp_response.md").read_text(encoding="utf-8")
_COVER_LETTER_PROMPT = (_PROMPTS_DIR / "prompt_cover_letter.md").read_text(encoding="utf-8")
_PROJECT_PLAN_PROMPT = (_PROMPTS_DIR / "prompt_project_plan.md").read_text(encoding="utf-8")
_RESOURCE_PLAN_PROMPT = (_PROMPTS_DIR / "prompt_resource_plan.md").read_text(encoding="utf-8")

_VALID_TIERS = {"Go", "FastForward", "Full-scale"}
_VALID_DELIVERY = {"Phased", "Full-scale"}
# valid_modules / valid_budget_ranges are admin-configurable — see
# common/settings_registry.py's "rfp-reimagine" schema. Resolved once in
# trigger_handler() and passed into _validate_questionnaire().

_JOB_TTL_SECONDS = 24 * 3600


# ── Dispatcher (single Function for autopopulate/generate/status — mirrors pi_graph's
# rawPath-based dispatch: these three routes need different `functions/function_app.py`
# registrations since they're different paths, not just different methods on one path, but
# funneling them through one registered `handler()` here keeps the routing table simple and
# matches the established convention rather than extending function_app.py's tuple shape.) ──

def handler(event: dict, context: object) -> dict:
    raw_path = event.get("rawPath") or event.get("path") or ""
    if raw_path.endswith("/autopopulate"):
        return autopopulate_handler(event, context)
    if raw_path.endswith("/generate"):
        return trigger_handler(event, context)
    return poll_handler(event, context)  # /rfp/status/{jobId}


# ── Autopopulate (sync) ───────────────────────────────────────────────────────

def autopopulate_handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    company_name = (body.get("company_name") or "").strip()
    if not company_name:
        return http.bad_request("company_name is required")

    try:
        result = ai.generate_json(
            _AUTOPOPULATE_PROMPT, f"Company name: {company_name}",
            max_tokens=500, temperature=0.2,
        )
    except ValueError as e:
        log.exception("rfp autopopulate model output was not valid JSON")
        return http.server_error(f"model output error: {e}")

    audit_events.write(
        ctx, "ai.rfp_autopopulate",
        ip=audit_events.get_ip(event),
        resource_type="rfp_reimagine",
        resource_name=company_name,
    )

    return http.ok(result)


# ── Trigger (async) ────────────────────────────────────────────────────────────

def trigger_handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    settings = app_settings.get_app_settings("rfp-reimagine")
    questionnaire, error = _validate_questionnaire(
        body, set(settings["valid_modules"]), set(settings["valid_budget_ranges"]),
    )
    if error:
        return http.bad_request(error)

    job_id = uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc).isoformat()

    vectors.put_item({
        "tenant_id": ctx.tenant_id,
        "chunk_id": f"rfp_job#{job_id}",
        "job_id": job_id,
        "status": "generating",
        "questionnaire": questionnaire,
        "created_at": now,
        "ttl": _JOB_TTL_SECONDS,
    })

    worker_payload = {
        "job_id": job_id,
        "tenant_id": ctx.tenant_id,
        "user_id": ctx.user_id,
        "questionnaire": questionnaire,
    }
    queue.enqueue_job("rfp_reimagine", worker_payload)

    audit_events.write(
        ctx, "ai.rfp_generate",
        ip=audit_events.get_ip(event),
        resource_type="rfp_reimagine",
        resource_id=job_id,
        resource_name=questionnaire["client_name"],
        details={"industry": questionnaire["industry"], "workday_tier": questionnaire["workday_tier"]},
    )

    log.info("rfp_reimagine triggered job_id=%s client=%s", job_id, questionnaire["client_name"])
    return http.ok({"job_id": job_id, "status": "generating"})


def _validate_questionnaire(
    body: dict, valid_modules: set[str], valid_budget_ranges: set[str],
) -> tuple[dict, str | None]:
    client_name = (body.get("client_name") or "").strip()
    industry = (body.get("industry") or "").strip()
    workday_tier = (body.get("workday_tier") or "").strip()
    scope_modules = body.get("scope_modules") or []
    delivery_approach = (body.get("delivery_approach") or "").strip()

    if not client_name:
        return {}, "client_name is required"
    if not industry:
        return {}, "industry is required"
    if workday_tier not in _VALID_TIERS:
        return {}, f"workday_tier must be one of: {', '.join(sorted(_VALID_TIERS))}"
    if not scope_modules or not set(scope_modules).issubset(valid_modules):
        return {}, f"scope_modules must be a non-empty subset of: {', '.join(sorted(valid_modules))}"
    if delivery_approach not in _VALID_DELIVERY:
        return {}, f"delivery_approach must be one of: {', '.join(sorted(_VALID_DELIVERY))}"

    budget_range = (body.get("budget_range") or "").strip()
    if budget_range and budget_range not in valid_budget_ranges:
        return {}, f"budget_range must be one of: {', '.join(sorted(valid_budget_ranges))}"

    return {
        "client_name": client_name,
        "industry": industry,
        "estimated_employee_count": (body.get("estimated_employee_count") or "").strip(),
        "locations": body.get("locations") or [],
        "workday_tier": workday_tier,
        "scope_modules": scope_modules,
        "delivery_approach": delivery_approach,
        # Optional context — all degrade gracefully when omitted; prompts are written to not
        # penalize a thin questionnaire, just to produce a sharper draft when given more.
        "executive_sponsor_name": (body.get("executive_sponsor_name") or "").strip(),
        "executive_sponsor_title": (body.get("executive_sponsor_title") or "").strip(),
        "current_systems": (body.get("current_systems") or "").strip(),
        "business_drivers": (body.get("business_drivers") or "").strip(),
        "target_go_live": (body.get("target_go_live") or "").strip(),
        "key_integrations": body.get("key_integrations") or [],
        "budget_range": budget_range,
        "union_environment": bool(body.get("union_environment", False)),
    }, None


# ── Poll (sync) ─────────────────────────────────────────────────────────────────

def poll_handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    path_params = event.get("pathParameters") or {}
    job_id = (path_params.get("jobId") or "").strip()
    if not job_id:
        return http.bad_request("jobId path parameter is required")

    item = vectors.get_item(ctx.tenant_id, f"rfp_job#{job_id}")
    if not item:
        return {"statusCode": 404, "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"}, "body": json.dumps({"error": "job not found"})}

    status = item.get("status", "generating")
    if status == "done":
        return http.ok({"job_id": job_id, "status": "done", "documents": item.get("documents", {})})
    if status == "error":
        return http.ok({"job_id": job_id, "status": "error", "error": item.get("error", "Unknown error")})
    return http.ok({"job_id": job_id, "status": "generating"})


# ── Worker (queue-triggered) ───────────────────────────────────────────────────

def worker_handler(payload: dict) -> None:
    job_id = payload["job_id"]
    tenant_id = payload["tenant_id"]
    questionnaire = payload["questionnaire"]
    industry = questionnaire["industry"]

    try:
        knowledge_context = _retrieve_knowledge_context(industry, questionnaire)

        documents = {
            "rfp_response": ai.generate(
                _RFP_RESPONSE_PROMPT,
                [{"role": "user", "content": _questionnaire_prompt(questionnaire, knowledge_context)}],
                max_tokens=4000, temperature=0.3,
            ),
            "cover_letter": ai.generate(
                _COVER_LETTER_PROMPT,
                [{"role": "user", "content": _questionnaire_prompt(questionnaire, knowledge_context)}],
                max_tokens=800, temperature=0.3,
            ),
            "project_plan": ai.generate(
                _PROJECT_PLAN_PROMPT,
                [{"role": "user", "content": _questionnaire_prompt(questionnaire, knowledge_context)}],
                max_tokens=1500, temperature=0.2,
            ),
            "resource_plan": ai.generate(
                _RESOURCE_PLAN_PROMPT,
                [{"role": "user", "content": _questionnaire_prompt(questionnaire, knowledge_context)}],
                max_tokens=1500, temperature=0.2,
            ),
        }

        vectors.update_item(tenant_id, f"rfp_job#{job_id}", {
            "status": "done",
            "documents": documents,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        })
        log.info("rfp_reimagine job_id=%s completed", job_id)

    except Exception as exc:
        log.exception("rfp_reimagine job_id=%s failed: %s", job_id, exc)
        try:
            vectors.update_item(tenant_id, f"rfp_job#{job_id}", {
                "status": "error",
                "error": str(exc),
            })
        except Exception:
            log.exception("rfp_reimagine job_id=%s: also failed to write error status", job_id)


def _retrieve_knowledge_context(industry: str, questionnaire: dict) -> str:
    """
    Embeds a query describing the engagement and retrieves the closest firm-knowledge chunks
    for this industry. Returns an empty string (not an error) if the industry has no indexed
    content yet — the prompts are written to degrade gracefully (write from general best
    practice, don't claim specific past-engagement experience) rather than fail outright, since
    the knowledge base starts empty and grows as consultants upload content.
    """
    query_text = (
        f"Workday {questionnaire['workday_tier']} implementation, "
        f"scope: {', '.join(questionnaire['scope_modules'])}, "
        f"{questionnaire['delivery_approach']} delivery, "
        f"{industry} industry, client size {questionnaire.get('estimated_employee_count', 'unknown')}"
    )
    try:
        query_vector = ai.embed(query_text)
        hits = industry_knowledge.search(industry, query_vector, top_k=6, app="rfp-reimagine")
    except Exception:
        log.exception("industry knowledge retrieval failed for industry=%s, continuing with no context", industry)
        return ""

    if not hits:
        return ""

    return "\n\n".join(
        f"[Excerpt: {h.get('source_name', 'unknown source')}] {h['text']}" for h in hits
    )


def _questionnaire_prompt(questionnaire: dict, knowledge_context: str) -> str:
    context_block = knowledge_context if knowledge_context else "(no firm-knowledge excerpts available yet for this industry)"
    # Drop unanswered optional fields entirely rather than showing empty strings/false —
    # the prompts distinguish "not provided" (write generically) from "provided as empty".
    answered = {k: v for k, v in questionnaire.items() if v not in ("", [], False)}
    return f"""Client questionnaire:
{json.dumps(answered, indent=2)}

Relevant firm knowledge (industry: {questionnaire['industry']}):
{context_block}

Draft the document now."""
