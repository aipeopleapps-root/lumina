"""
Process Intelligence — graph read/patch endpoints.

GET  /process-intelligence/{process_id}/status
  Role: consultant | admin
  Returns current parse_status + confidence + warnings.

GET  /process-intelligence/{process_id}/graph
  Role: consultant | admin
  Returns full parsed graph (swimlanes, steps, connectors).
  Only available when parse_status in {needs_review, ready}.

PATCH /process-intelligence/{process_id}/graph
  Role: consultant | admin
  Body: { step_patches?: [...], lane_patches?: [...], connector_patches?: [...] }
  Applies corrections; advances needs_review → ready.
"""

from __future__ import annotations

import json
import logging
import os

from common import tenant_from_event, TenantError, audit_events, bedrock, http
from common.pi_aurora import (
    get_process_graph_status,
    get_full_graph,
    patch_graph,
    store_tobe_graph,
    get_tobe_graph,
)

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_GRAPH_READABLE = {"needs_review", "ready"}

_TOBE_SYSTEM = """You are a Workday AI transformation architect. You will receive a JSON object describing \
an as-is Workday implementation process, with each step's AI opportunity classification already assessed.

Redesign the process for the AI-enabled future state and return a single JSON object with this exact structure:

{
  "transformation_summary": "2-3 sentence narrative: which categories of steps were automated, what the net effect is",
  "ai_stats": {
    "steps_automated": <integer>,
    "steps_assisted": <integer>,
    "steps_unchanged": <integer>,
    "cycle_time_reduction_pct": <integer 0-85>
  },
  "swimlanes": [
    {"lane_id": "string", "label": "string", "persona": "string or null", "position": 0}
  ],
  "steps": [
    {
      "step_id": "string",
      "lane_id": "string matching a swimlane lane_id",
      "label": "string — prefix: ⚡ illuminate_agent, 💬 digital_employee, 🔄 workday_native, 🤖 partial_ai, no prefix for human_only",
      "step_type": "system|manual|decision|approval|wait",
      "ai_opportunity": "illuminate_agent|digital_employee|workday_native|partial_ai|human_only",
      "systems_touched": [],
      "transformation_note": "what changed vs as-is (omit for human_only unchanged steps)"
    }
  ],
  "connectors": [
    {"from": "step_id", "to": "step_id", "condition": "string or null"}
  ]
}

Transformation rules:
1. illuminate_agent steps → move to a new "Workday AI" lane (lane_id="ai_lane", position=0, persona="Illuminate AI Agent"). Prefix label ⚡. Fully automated.
2. digital_employee steps → keep in original lane, prefix label 💬. Digital Employee replaces manual initiation.
3. workday_native steps → keep in original lane, prefix label 🔄. Automated — no human action.
4. partial_ai steps → keep in original lane, prefix label 🤖. Human still decides; AI prepares context.
5. human_only steps → keep exactly as-is, no prefix.
6. Create the "Workday AI" lane only if ≥1 illuminate_agent step exists; place it at position 0 (top).
7. If consecutive illuminate_agent steps have no human steps between them, you MAY merge them into one consolidated step.
8. Preserve ALL decision steps and their branching connectors exactly.
9. Do NOT duplicate steps — each as-is step maps to exactly one to-be step (or is merged).
10. Keep original step_ids for unchanged steps. Use "tobe_001", "tobe_002"… for moved/merged steps.
11. ALL connectors must reference valid step_ids that appear in your steps array — validate before returning.
12. Every step must be reachable in the flow. No orphaned steps."""


# ── GET /process-intelligence/{process_id}/status ────────────────────────────

def status_handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    process_id = (event.get("pathParameters") or {}).get("process_id", "")
    if not process_id:
        return http.bad_request("process_id path parameter is required")

    meta = get_process_graph_status(process_id=process_id, tenant_id=ctx.tenant_id)
    if not meta:
        return http.bad_request("process graph not found")

    return http.ok({
        "process_id":       meta["process_id"],
        "parse_status":     meta["parse_status"],
        "parse_confidence": meta["parse_confidence"],
        "parse_warnings":   meta["parse_warnings"],
        "parse_error":      meta["parse_error"],
        "domain":           meta["domain"],
        "source_name":      meta["source_name"],
        "created_at":       meta["created_at"],
        "updated_at":       meta["updated_at"],
    })


# ── GET /process-intelligence/{process_id}/graph ─────────────────────────────

def graph_get_handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    process_id = (event.get("pathParameters") or {}).get("process_id", "")
    if not process_id:
        return http.bad_request("process_id path parameter is required")

    graph = get_full_graph(process_id=process_id, tenant_id=ctx.tenant_id)
    if not graph:
        return http.bad_request("process graph not found")

    if graph["parse_status"] not in _GRAPH_READABLE:
        return http.bad_request(
            f"graph is not yet available (status: {graph['parse_status']})"
        )

    return http.ok(graph)


# ── PATCH /process-intelligence/{process_id}/graph ───────────────────────────

def graph_patch_handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    process_id = (event.get("pathParameters") or {}).get("process_id", "")
    if not process_id:
        return http.bad_request("process_id path parameter is required")

    try:
        body = json.loads(event.get("body") or "{}")
    except Exception:
        return http.bad_request("invalid JSON body")

    step_patches      = body.get("step_patches") or []
    lane_patches      = body.get("lane_patches") or []
    connector_patches = body.get("connector_patches") or []

    if not step_patches and not lane_patches and not connector_patches:
        return http.bad_request("at least one of step_patches, lane_patches, or connector_patches is required")

    try:
        patch_graph(
            process_id=process_id,
            tenant_id=ctx.tenant_id,
            step_patches=step_patches,
            lane_patches=lane_patches,
            connector_patches=connector_patches,
        )
    except PermissionError as exc:
        return http.forbidden(str(exc))
    except Exception as exc:
        log.exception("patch_graph error process_id=%s: %s", process_id, exc)
        return http.server_error(f"patch error: {exc}")

    audit_events.write(
        ctx,
        "pi.graph.patched",
        resource_type="process_graph",
        resource_id=process_id,
        resource_name=process_id,
        details={
            "step_patches":      len(step_patches),
            "lane_patches":      len(lane_patches),
            "connector_patches": len(connector_patches),
        },
    )

    return http.ok({"process_id": process_id, "patched": True})


# ── POST /process-intelligence/{process_id}/tobe ────────────────────────────

def tobe_handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    process_id = (event.get("pathParameters") or {}).get("process_id", "")
    if not process_id:
        return http.bad_request("process_id path parameter is required")

    graph = get_full_graph(process_id=process_id, tenant_id=ctx.tenant_id)
    if not graph:
        return http.bad_request("process graph not found")

    if graph["parse_status"] not in _GRAPH_READABLE:
        return http.bad_request(
            f"graph not ready for to-be generation (status: {graph['parse_status']})"
        )

    as_is = {
        "swimlanes": graph["swimlanes"],
        "steps": [
            {
                "step_id":        s["step_id"],
                "lane_id":        s["lane_id"],
                "label":          s["label"],
                "step_type":      s["type"],
                "systems_touched": s["systems_touched"],
                "ai_opportunity": s["ai_opportunity"],
                "ai_rationale":   s["ai_rationale"],
            }
            for s in graph["steps"]
        ],
        "connectors": [
            {"from": c["from"], "to": c["to"], "condition": c.get("condition")}
            for c in graph["connectors"]
        ],
    }

    try:
        tobe = bedrock.generate_json(
            system=_TOBE_SYSTEM,
            user_prompt=json.dumps(as_is, indent=2),
            max_tokens=4096,
        )
    except Exception as exc:
        log.exception("tobe bedrock error process_id=%s: %s", process_id, exc)
        return http.server_error(f"AI generation failed: {exc}")

    try:
        store_tobe_graph(
            process_id=process_id,
            tenant_id=ctx.tenant_id,
            tobe_graph=tobe,
        )
    except Exception as exc:
        log.exception("store_tobe_graph error process_id=%s: %s", process_id, exc)
        return http.server_error(f"Failed to store to-be graph: {exc}")

    audit_events.write(
        ctx,
        "pi.tobe.generated",
        resource_type="process_graph",
        resource_id=process_id,
        resource_name=process_id,
        details={"steps_automated": tobe.get("ai_stats", {}).get("steps_automated")},
    )

    return http.ok({"process_id": process_id, "tobe": tobe})


# ── Dispatcher (single Lambda for all three graph routes) ────────────────────

def handler(event: dict, context: object) -> dict:
    """
    Single Lambda entry point dispatching by path + HTTP method.

    Routes:
      GET   .../{process_id}/status → status_handler
      GET   .../{process_id}/graph  → graph_get_handler
      PATCH .../{process_id}/graph  → graph_patch_handler
      POST  .../{process_id}/tobe   → tobe_handler
    """
    method   = (event.get("requestContext") or {}).get("http", {}).get("method", "").upper()
    raw_path = event.get("rawPath") or event.get("path") or ""

    if raw_path.endswith("/status"):
        return status_handler(event, context)

    if raw_path.endswith("/tobe"):
        return tobe_handler(event, context)

    if method == "GET":
        return graph_get_handler(event, context)

    if method == "PATCH":
        return graph_patch_handler(event, context)

    return http.bad_request(f"unsupported method {method} on this route")
