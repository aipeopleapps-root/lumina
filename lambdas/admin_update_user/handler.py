"""
Admin: update a user's name, role, or tenant assignment.

POST /admin/update-user
{ "email": "user@example.com", "given_name": "Jane", "family_name": "Smith",
  "role": "consultant", "tenant_id": "acme" }
"""

import json
import logging
import os

import boto3

from common import tenant_from_event, TenantError, audit_events, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_USER_POOL_ID = os.environ["USER_POOL_ID"]
_cognito = boto3.client("cognito-idp")

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
    if not email:
        return http.bad_request("email is required")

    updates = []
    if "given_name" in body:
        updates.append({"Name": "given_name", "Value": body["given_name"].strip()})
    if "family_name" in body:
        updates.append({"Name": "family_name", "Value": body["family_name"].strip()})
    if "role" in body:
        role = body["role"].strip().lower()
        if role not in _VALID_ROLES:
            return http.bad_request(f"invalid role: {role}")
        updates.append({"Name": "custom:role", "Value": role})
    if "tenant_id" in body:
        updates.append({"Name": "custom:tenant_id", "Value": body["tenant_id"].strip().lower()})

    if not updates:
        return http.bad_request("no fields to update")

    try:
        _cognito.admin_update_user_attributes(
            UserPoolId=_USER_POOL_ID,
            Username=email,
            UserAttributes=updates,
        )
        log.info("Admin %s updated user %s: %s", ctx.user_id, email, [u["Name"] for u in updates])
        audit_events.write(
            ctx, "admin.user_update",
            ip=audit_events.get_ip(event),
            resource_type="user",
            resource_name=email,
            details={"fields": [u["Name"] for u in updates]},
        )
        return http.ok({"message": f"User {email} updated successfully"})

    except _cognito.exceptions.UserNotFoundException:
        return http.bad_request(f"User '{email}' not found")
    except Exception as e:
        log.error("Failed to update user: %s", e, exc_info=True)
        return http.server_error(f"Failed to update user: {e}")
