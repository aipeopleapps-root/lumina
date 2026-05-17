"""
Security Admin: list all users from Cognito with their tenant and role.
Returns up to 60 users; for larger pools add pagination support.
"""

from __future__ import annotations

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
        ctx.require_role("security_admin", "project_admin", "admin")
    except TenantError as e:
        return http.forbidden(str(e))

    users = []
    paginator = _cognito.get_paginator("list_users")
    for page in paginator.paginate(UserPoolId=_USER_POOL_ID, Limit=60):
        for u in page.get("Users", []):
            attrs = {a["Name"]: a["Value"] for a in u.get("Attributes", [])}
            users.append({
                "sub":         attrs.get("sub", ""),
                "email":       attrs.get("email", u["Username"]),
                "given_name":  attrs.get("given_name", ""),
                "family_name": attrs.get("family_name", ""),
                "tenant_id":   attrs.get("custom:tenant_id", ""),
                "role":        attrs.get("custom:role", "client"),
                "status":      u.get("UserStatus", ""),
                "enabled":     u.get("Enabled", True),
                "created_at":  u["UserCreateDate"].isoformat() if u.get("UserCreateDate") else "",
            })

    return http.ok({"users": users})
