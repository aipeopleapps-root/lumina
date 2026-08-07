"""
Returns the list of client tenants the authenticated consultant is assigned to.
Used to populate the client-switcher in the consultant portal.
"""

from __future__ import annotations

import logging
import os

from common import tenant_from_event, TenantError, config, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant")
    except TenantError as e:
        return http.forbidden(str(e))

    # All assignments for this consultant: pk=ASSIGN#<sub>, sk starts with CLIENT#
    items = config.query_by_pk(f"ASSIGN#{ctx.user_id}", "CLIENT#")

    clients = []
    for item in items:
        tenant_id = item["sk"].removeprefix("CLIENT#")
        clients.append({
            "tenant_id": tenant_id,
            "name": item.get("client_name", tenant_id),
            "industry": item.get("industry", ""),
        })

    return http.ok({"clients": clients})
