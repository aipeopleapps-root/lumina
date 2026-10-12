"""
Assign/unassign a consultant OR project_admin to a client, or list all assignments.

GET  /manage/assignments          → { assignments: [{consultant_sub, consultant_email, client_tenant_id, assignee_role}] }
POST /manage/assign-consultant    → assign or unassign

Permission split (deliberate — see the role-model restructure plan):
  - Assigning a project_admin to a client is super_admin-only. It's a privilege-granting
    action (gives the assignee broad, scoped access to that client), so it stays with the
    role that already has unrestricted access rather than letting project_admins expand
    their own or each other's reach.
  - Assigning a consultant to a client can be done by super_admin OR a project_admin who is
    themselves assigned to that client — matches "project_admin has everything for their
    client", including building their own team without waiting on a super_admin.

Storage field names (`consultant_sub`/`consultant_email`) predate this dual-role support and
are kept as-is to avoid a data migration — they now just mean "the assignee", regardless of
role. `assignee_role` is the new field that actually distinguishes the two; existing records
written before this change have no `assignee_role` and are treated as `consultant` (that was
the only role this ever assigned before).
"""

from __future__ import annotations

import json
import logging
import os

from common import tenant_from_event, TenantError, audit_events, config, http
from common import tenant as tenant_module

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("project_admin", "super_admin")
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
    assignee_role = (body.get("assignee_role") or "consultant").strip().lower()

    if not consultant_sub or not client_tenant_id:
        return http.bad_request("consultant_sub and client_tenant_id are required")
    if action not in ("assign", "unassign"):
        return http.bad_request("action must be 'assign' or 'unassign'")
    if assignee_role not in ("consultant", "project_admin"):
        return http.bad_request("assignee_role must be 'consultant' or 'project_admin'")

    if assignee_role == "project_admin":
        if ctx.role != "super_admin":
            return http.forbidden("only super_admin can assign a project_admin to a client")
    else:
        if ctx.role != "super_admin" and not tenant_module.is_assigned(ctx.user_id, client_tenant_id):
            return http.forbidden(
                "project_admin can only assign consultants to a client they're themselves assigned to"
            )

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
            "assignee_role": assignee_role,
            "assigned_by": ctx.user_id,
        })
        log.info("%s %s assigned %s (%s) → %s", ctx.role, ctx.user_id, consultant_sub, assignee_role, client_tenant_id)
        audit_events.write(
            ctx, "admin.consultant_assign",
            ip=audit_events.get_ip(event),
            resource_type="consultant",
            resource_id=consultant_sub,
            resource_name=consultant_email,
            details={"client_tenant_id": client_tenant_id, "client_name": client_name, "assignee_role": assignee_role},
        )
        return http.ok({"message": f"{assignee_role} assigned to {client_tenant_id}"})

    else:
        config.delete_item(pk, sk)
        log.info("%s %s unassigned %s from %s", ctx.role, ctx.user_id, consultant_sub, client_tenant_id)
        audit_events.write(
            ctx, "admin.consultant_unassign",
            ip=audit_events.get_ip(event),
            resource_type="consultant",
            resource_id=consultant_sub,
            resource_name=consultant_email,
            details={"client_tenant_id": client_tenant_id},
        )
        return http.ok({"message": f"Unassigned from {client_tenant_id}"})


def _list_assignments() -> dict:
    """All ASSIGN#/CLIENT# items, across all consultants and project_admins."""
    items = config.scan_prefix("ASSIGN#", "CLIENT#")

    assignments = [
        {
            "consultant_sub": item.get("consultant_sub", item["pk"].removeprefix("ASSIGN#")),
            "consultant_email": item.get("consultant_email", ""),
            "client_tenant_id": item.get("client_tenant_id", item["sk"].removeprefix("CLIENT#")),
            "assignee_role": item.get("assignee_role", "consultant"),
            "client_name": item.get("client_name", ""),
        }
        for item in items
    ]
    return http.ok({"assignments": assignments})
