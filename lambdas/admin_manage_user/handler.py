"""
Security Admin: disable, enable, or delete a Cognito user.

POST /admin/manage-user
{ "email": "user@example.com", "action": "disable" | "enable" | "delete" }
"""

from __future__ import annotations

import json
import logging
import os

import boto3

from common import tenant_from_event, TenantError, audit_events, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_USER_POOL_ID = os.environ["USER_POOL_ID"]
_cognito = boto3.client("cognito-idp")

_ACTIONS = {"disable", "enable", "delete", "reset_mfa"}


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("security_admin", "admin")
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
        if action == "disable":
            _cognito.admin_disable_user(UserPoolId=_USER_POOL_ID, Username=email)
            audit_action = "admin.user_disable"
            msg = f"{email} has been disabled. They cannot sign in until re-enabled."

        elif action == "enable":
            _cognito.admin_enable_user(UserPoolId=_USER_POOL_ID, Username=email)
            audit_action = "admin.user_enable"
            msg = f"{email} has been re-enabled."

        elif action == "reset_mfa":
            _cognito.admin_set_user_mfa_preference(
                UserPoolId=_USER_POOL_ID,
                Username=email,
                SoftwareTokenMfaSettings={"Enabled": False, "PreferredMfa": False},
            )
            audit_action = "admin.mfa_reset"
            msg = f"MFA has been reset for {email}. They will be prompted to set up MFA on next login."

        else:  # delete
            _cognito.admin_delete_user(UserPoolId=_USER_POOL_ID, Username=email)
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

    except _cognito.exceptions.UserNotFoundException:
        return http.bad_request(f"User '{email}' not found")
    except Exception as e:
        log.error("manage_user failed action=%s email=%s: %s", action, email, e, exc_info=True)
        return http.server_error(f"Failed to {action} user: {e}")
