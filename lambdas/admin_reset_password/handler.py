"""
Security Admin: reset a user's password to a new temporary password.
The user must change it on next login.

POST /admin/reset-password
{ "email": "user@example.com", "temporary_password": "NewTemp123!" }
"""

from __future__ import annotations

import json
import logging
import os

import boto3

from common import tenant_from_event, TenantError, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_USER_POOL_ID = os.environ["USER_POOL_ID"]
_cognito = boto3.client("cognito-idp")


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
    temp_password = (body.get("temporary_password") or "").strip()

    if not email or not temp_password:
        return http.bad_request("email and temporary_password are required")

    try:
        _cognito.admin_set_user_password(
            UserPoolId=_USER_POOL_ID,
            Username=email,
            Password=temp_password,
            Permanent=False,  # forces change on next login
        )
        log.info("security_admin %s reset password for %s", ctx.user_id, email)
        return http.ok({"message": f"Password reset for {email}. User must change on next login."})
    except _cognito.exceptions.UserNotFoundException:
        return http.bad_request(f"User {email} not found")
    except _cognito.exceptions.InvalidPasswordException as e:
        return http.bad_request(f"Invalid password: {e}")
    except Exception as e:
        log.error("Failed to reset password: %s", e, exc_info=True)
        return http.server_error(f"Failed to reset password: {e}")
