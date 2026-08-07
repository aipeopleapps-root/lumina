"""
Project Admin: assign/unassign a consultant to a client, or list all assignments.

GET  /admin/assignments          → { assignments: [{consultant_sub, consultant_email, client_tenant_id}] }
POST /admin/assign-consultant    → assign or unassign
"""

from __future__ import annotations

import json
import logging
import os

from common import tenant_from_event, TenantError, audit_events, config, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("project_admin", "admin")
    except TenantError as e:
        return http.forbidden(str(e))

    method = event.get("requestContext", {}).get("http", {}).get("method", "POST")

    if method == "GET":
        return _list_assignments()

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    consultant_sub = (body.get("consultant_sub") or "").strip()
    consultant_email = (body.get("consultant_email") or "").strip().lower()
    client_tenant_id = (body.get("client_tenant_id") or "").strip().lower()
    action = (body.get("action") or "assign").strip().lower()

    if not consultant_sub or not client_tenant_id:
        return http.bad_request("consultant_sub and client_tenant_id are required")
    if action not in ("assign", "unassign"):
        return http.bad_request("action must be 'assign' or 'unassign'")

    client_name = client_tenant_id
    meta = config.get_item(f"TENANT#{client_tenant_id}", "METADATA")
    if meta is not None:
        client_name = meta.get("name", client_tenant_id)

    pk = f"ASSIGN#{consultant_sub}"
    sk = f"CLIENT#{client_tenant_id}"

    if action == "assign":
        config.put_item({
            "pk": pk,
            "sk": sk,
            "consultant_sub": consultant_sub,
            "consultant_email": consultant_email,
            "client_tenant_id": client_tenant_id,
            "client_name": client_name,
            "assigned_by": ctx.user_id,
        })
        log.info("project_admin %s assigned %s → %s", ctx.user_id, consultant_sub, client_tenant_id)
        audit_events.write(
            ctx, "admin.consultant_assign",
            ip=audit_events.get_ip(event),
            resource_type="consultant",
            resource_id=consultant_sub,
            resource_name=consultant_email,
            details={"client_tenant_id": client_tenant_id, "client_name": client_name},
        )
        return http.ok({"message": f"Consultant assigned to {client_tenant_id}"})

    else:
        config.delete_item(pk, sk)
        log.info("project_admin %s unassigned %s from %s", ctx.user_id, consultant_sub, client_tenant_id)
        audit_events.write(
            ctx, "admin.consultant_unassign",
            ip=audit_events.get_ip(event),
            resource_type="consultant",
            resource_id=consultant_sub,
            resource_name=consultant_email,
            details={"client_tenant_id": client_tenant_id},
        )
        return http.ok({"message": f"Consultant unassigned from {client_tenant_id}"})


def _list_assignments() -> dict:
    """All ASSIGN#/CLIENT# items, across all consultants."""
    items = config.scan_prefix("ASSIGN#", "CLIENT#")

    assignments = [
        {
            "consultant_sub": item.get("consultant_sub", item["pk"].removeprefix("ASSIGN#")),
            "consultant_email": item.get("consultant_email", ""),
            "client_tenant_id": item.get("client_tenant_id", item["sk"].removeprefix("CLIENT#")),
            "client_name": item.get("client_name", ""),
        }
        for item in items
    ]
    return http.ok({"assignments": assignments})
