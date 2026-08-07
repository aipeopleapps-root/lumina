"""
Project Admin: archive or restore a client tenant.

POST /admin/archive-client
{ "tenant_id": "acme", "action": "archive" | "restore" }
"""

from __future__ import annotations

import json
import logging
import os

from common import tenant_from_event, TenantError, audit_events, config, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("project_admin", "admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    tenant_id = (body.get("tenant_id") or "").strip().lower()
    action = (body.get("action") or "").strip().lower()

    if not tenant_id:
        return http.bad_request("tenant_id is required")
    if action not in ("archive", "restore"):
        return http.bad_request("action must be 'archive' or 'restore'")

    # Verify tenant exists
    item = config.get_item(f"TENANT#{tenant_id}", "METADATA")
    if item is None:
        return http.bad_request(f"Tenant '{tenant_id}' not found")

    tenant_name = item.get("name", tenant_id)
    new_status = "archived" if action == "archive" else "active"

    try:
        config.update_item(f"TENANT#{tenant_id}", "METADATA", {"status": new_status})
    except Exception as e:
        log.error("Failed to update tenant status: %s", e)
        return http.server_error(f"Failed to update tenant: {e}")

    audit_action = "admin.client_archive" if action == "archive" else "admin.client_restore"
    audit_events.write(
        ctx,
        audit_action,
        ip=audit_events.get_ip(event),
        resource_type="tenant",
        resource_id=tenant_id,
        resource_name=tenant_name,
    )

    log.info("%s %s tenant=%s", ctx.user_id, action, tenant_id)
    msg = f"Client '{tenant_name}' has been {'archived' if action == 'archive' else 'restored'}."
    return http.ok({"message": msg, "tenant_id": tenant_id, "status": new_status})
