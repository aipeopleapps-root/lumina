"""
Admin: Create new Entra ID user.

POST /manage/create-user
{
  "email": "user@example.com",
  "given_name": "Jane",
  "family_name": "Smith",
  "tenant_id": "acme",
  "role": "consultant",
  "temporary_password": "TempPass123!"
}
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

    email       = (body.get("email") or "").strip().lower()
    given_name  = (body.get("given_name") or "").strip()
    family_name = (body.get("family_name") or "").strip()
    tenant_id   = (body.get("tenant_id") or "").strip().lower()
    role        = (body.get("role") or "").strip().lower()
    temp_password = body.get("temporary_password") or "TempPass123!"

    if not email or not role:
        return http.bad_request("email and role are required")
    if not given_name or not family_name:
        return http.bad_request("given_name and family_name are required")
    if role not in _VALID_ROLES:
        return http.bad_request(f"role must be one of: {', '.join(sorted(_VALID_ROLES))}")
    # project_admin can create teammates for their own client(s) but must not be able to grant
    # itself or anyone else broader access — only super_admin can create project_admin/super_admin.
    if ctx.role == "project_admin" and role != "consultant":
        return http.forbidden("project_admin can only create consultant users")

    try:
        graph.create_user(email, given_name, family_name, tenant_id, role, temp_password)

        log.info("Admin %s created user %s (tenant=%s, role=%s)", ctx.user_id, email, tenant_id, role)
        audit_events.write(
            ctx, "admin.user_create",
            ip=audit_events.get_ip(event),
            resource_type="user",
            resource_name=email,
            details={"tenant_id": tenant_id, "role": role},
        )

        return http.ok({
            "email": email,
            "given_name": given_name,
            "family_name": family_name,
            "tenant_id": tenant_id,
            "role": role,
            "temporary_password": temp_password,
            "message": "User created successfully",
        })

    except graph.GraphConflictError:
        return http.bad_request(f"User {email} already exists")
    except graph.GraphError as e:
        log.error("Failed to create user: %s", e, exc_info=True)
        return http.server_error(f"Failed to create user: {e}")
