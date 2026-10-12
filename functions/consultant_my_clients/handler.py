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
        # Archiving a client only flips its own TENANT#/METADATA status — the
        # ASSIGN# record itself is untouched, so this list must cross-check
        # the tenant's current status itself rather than trust the
        # assignment record alone (otherwise a consultant keeps seeing an
        # archived client indefinitely).
        tenant = config.get_item(f"TENANT#{tenant_id}", "METADATA")
        if tenant is None or tenant.get("status") == "archived":
            continue
        clients.append({
            "tenant_id": tenant_id,
            "name": item.get("client_name", tenant_id),
            "industry": item.get("industry", ""),
        })

    return http.ok({"clients": clients})
