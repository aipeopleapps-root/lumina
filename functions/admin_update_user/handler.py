"""
Admin: update a user's name, role, or tenant assignment.

POST /manage/update-user
{ "email": "user@example.com", "given_name": "Jane", "family_name": "Smith",
  "role": "consultant", "tenant_id": "acme" }
"""

import json
import logging
import os

from common import tenant_from_event, TenantError, audit_events, graph, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_VALID_ROLES = {"consultant", "project_admin", "super_admin"}


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("super_admin", "project_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    email = (body.get("email") or "").strip().lower()
    if not email:
        return http.bad_request("email is required")

    updates: dict = {}
    updated_fields: list[str] = []
    if "given_name" in body:
        updates["givenName"] = body["given_name"].strip()
        updated_fields.append("givenName")
    if "family_name" in body:
        updates["surname"] = body["family_name"].strip()
        updated_fields.append("surname")
    if "role" in body:
        role = body["role"].strip().lower()
        if role not in _VALID_ROLES:
            return http.bad_request(f"invalid role: {role}")
        # Same reasoning as admin_create_user — project_admin must not be able to grant itself
        # or anyone else broader access via an edit.
        if ctx.role == "project_admin" and role != "consultant":
            return http.forbidden("project_admin can only set the consultant role")
        updates[graph.role_attr()] = role
        updated_fields.append("role")
    if "tenant_id" in body:
        updates[graph.tenant_attr()] = body["tenant_id"].strip().lower()
        updated_fields.append("tenant_id")

    if not updates:
        return http.bad_request("no fields to update")

    try:
        user = graph.get_user_by_upn(email)
        if user is None:
            return http.bad_request(f"User '{email}' not found")

        graph.update_user_attributes(user["id"], updates)
        log.info("Admin %s updated user %s: %s", ctx.user_id, email, updated_fields)
        audit_events.write(
            ctx, "admin.user_update",
            ip=audit_events.get_ip(event),
            resource_type="user",
            resource_name=email,
            details={"fields": updated_fields},
        )
        return http.ok({"message": f"User {email} updated successfully"})

    except graph.GraphNotFoundError:
        return http.bad_request(f"User '{email}' not found")
    except graph.GraphError as e:
        log.error("Failed to update user: %s", e, exc_info=True)
        return http.server_error(f"Failed to update user: {e}")
