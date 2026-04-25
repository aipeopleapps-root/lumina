"""
Admin: Create new Cognito user.

POST /admin/create-user
{ "email": "user@example.com", "tenant_id": "acme", "role": "consultant", "temporary_password": "TempPass123!" }
"""

import json
import logging
import os

import boto3

from common import tenant_from_event, TenantError, audit_events, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_cognito = boto3.client("cognito-idp")
_USER_POOL_ID = os.environ.get("USER_POOL_ID", "")

_VALID_ROLES = {"consultant", "client", "project_admin", "security_admin", "admin"}


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("admin", "security_admin", "project_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    email = (body.get("email") or "").strip().lower()
    tenant_id = (body.get("tenant_id") or "").strip().lower()
    role = (body.get("role") or "").strip().lower()
    temp_password = body.get("temporary_password") or "TempPass123!"

    if not email or not role:
        return http.bad_request("email and role are required")
    if role not in _VALID_ROLES:
        return http.bad_request(f"role must be one of: {', '.join(sorted(_VALID_ROLES))}")

    try:
        _cognito.admin_create_user(
            UserPoolId=_USER_POOL_ID,
            Username=email,
            UserAttributes=[
                {"Name": "email", "Value": email},
                {"Name": "email_verified", "Value": "true"},
                {"Name": "custom:tenant_id", "Value": tenant_id},
                {"Name": "custom:role", "Value": role},
            ],
            TemporaryPassword=temp_password,
            MessageAction="SUPPRESS",
        )

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
            "tenant_id": tenant_id,
            "role": role,
            "temporary_password": temp_password,
            "message": "User created successfully",
        })

    except _cognito.exceptions.UsernameExistsException:
        return http.bad_request(f"User {email} already exists")
    except Exception as e:
        log.error("Failed to create user: %s", e, exc_info=True)
        return http.server_error(f"Failed to create user: {e}")
