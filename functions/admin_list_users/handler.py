"""
Security Admin: list all users from Entra ID with their tenant and role.
"""

from __future__ import annotations

import logging
import os

from common import tenant_from_event, TenantError, graph, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("project_admin", "super_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    tenant_attr, role_attr = graph.tenant_attr(), graph.role_attr()

    users = []
    for u in graph.list_users():
        users.append({
            "sub":         u.get("id", ""),
            "email":       u.get("mail") or u.get("userPrincipalName", ""),
            "given_name":  u.get("givenName") or "",
            "family_name": u.get("surname") or "",
            "tenant_id":   u.get(tenant_attr) or "",
            "role":        u.get(role_attr) or "",
            "status":      "active" if u.get("accountEnabled", True) else "disabled",
            "enabled":     u.get("accountEnabled", True),
            "created_at":  u.get("createdDateTime") or "",
        })

    return http.ok({"users": users})
