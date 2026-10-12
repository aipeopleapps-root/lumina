"""
Security Admin: disable, enable, or delete an Entra ID user, or reset their MFA.

POST /manage/manage-user
{ "email": "user@example.com", "action": "disable" | "enable" | "delete" | "reset_mfa" }
"""

from __future__ import annotations

import json
import logging
import os

from common import tenant_from_event, TenantError, audit_events, graph, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_ACTIONS = {"disable", "enable", "delete", "reset_mfa"}


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
    action = (body.get("action") or "").strip().lower()

    if not email:
        return http.bad_request("email is required")
    if action not in _ACTIONS:
        return http.bad_request("action must be 'disable', 'enable', 'delete', or 'reset_mfa'")

    # Prevent self-modification
    if ctx.email and ctx.email == email:
        return http.bad_request("You cannot modify your own account")

    try:
        user = graph.get_user_by_upn(email)
        if user is None:
            return http.bad_request(f"User '{email}' not found")
        user_id = user["id"]

        if action == "disable":
            graph.disable_user(user_id)
            audit_action = "admin.user_disable"
            msg = f"{email} has been disabled. They cannot sign in until re-enabled."

        elif action == "enable":
            graph.enable_user(user_id)
            audit_action = "admin.user_enable"
            msg = f"{email} has been re-enabled."

        elif action == "reset_mfa":
            graph.reset_mfa(user_id)
            audit_action = "admin.mfa_reset"
            msg = f"MFA has been reset for {email}. They will be prompted to set up MFA on next login."

        else:  # delete
            graph.delete_user(user_id)
            audit_action = "admin.user_delete"
            msg = f"{email} has been permanently deleted."

        audit_events.write(
            ctx,
            audit_action,
            ip=audit_events.get_ip(event),
            resource_type="user",
            resource_name=email,
        )

        log.info("%s performed %s on %s", ctx.user_id, action, email)
        return http.ok({"message": msg, "email": email, "action": action})

    except graph.GraphNotFoundError:
        return http.bad_request(f"User '{email}' not found")
    except graph.GraphError as e:
        log.error("manage_user failed action=%s email=%s: %s", action, email, e, exc_info=True)
        return http.server_error(f"Failed to {action} user: {e}")
