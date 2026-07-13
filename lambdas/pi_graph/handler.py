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

from common import tenant_from_event, TenantError, audit_events, http
from common.pi_aurora import (
    get_process_graph_status,
    get_full_graph,
    patch_graph,
)

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_GRAPH_READABLE = {"needs_review", "ready"}


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


# ── Dispatcher (single Lambda for all three graph routes) ────────────────────

def handler(event: dict, context: object) -> dict:
    """
    Single Lambda entry point dispatching by HTTP method.

    Routes:
      GET  .../{process_id}/status → status_handler
      GET  .../{process_id}/graph  → graph_get_handler
      PATCH .../{process_id}/graph → graph_patch_handler
    """
    method   = (event.get("requestContext") or {}).get("http", {}).get("method", "").upper()
    raw_path = event.get("rawPath") or event.get("path") or ""

    if raw_path.endswith("/status"):
        return status_handler(event, context)

    if method == "GET":
        return graph_get_handler(event, context)

    if method == "PATCH":
        return graph_patch_handler(event, context)

    return http.bad_request(f"unsupported method {method} on this route")
