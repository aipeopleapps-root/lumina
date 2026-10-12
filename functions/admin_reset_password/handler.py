"""
Security Admin: reset a user's password to a new temporary password.
The user must change it on next login.

POST /manage/reset-password
{ "email": "user@example.com", "temporary_password": "NewTemp123!" }
"""

from __future__ import annotations

import json
import logging
import os

from common import tenant_from_event, TenantError, audit_events, graph, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("super_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    email = (body.get("email") or "").strip().lower()
    temp_password = (body.get("temporary_password") or "").strip()

    if not email or not temp_password:
        return http.bad_request("email and temporary_password are required")

    try:
        user = graph.get_user_by_upn(email)
        if user is None:
            return http.bad_request(f"User {email} not found")

        graph.set_password(user["id"], temp_password, force_change=True)
        log.info("%s %s reset password for %s", ctx.role, ctx.user_id, email)
        audit_events.write(
            ctx, "admin.password_reset",
            ip=audit_events.get_ip(event),
            resource_type="user",
            resource_name=email,
        )
        return http.ok({"message": f"Password reset for {email}. User must change on next login."})
    except graph.GraphNotFoundError:
        return http.bad_request(f"User {email} not found")
    except graph.GraphError as e:
        # Graph's password-policy rejection (weak/short password) is a 400 with a
        # descriptive message, mirroring Cognito's InvalidPasswordException.
        if e.status_code == 400:
            return http.bad_request(f"Invalid password: {e.message}")
        log.error("Failed to reset password: %s", e, exc_info=True)
        return http.server_error(f"Failed to reset password: {e}")
