"""
Project Admin: edit a client tenant's name/industry/region.

POST /manage/update-tenant
{ "tenant_id": "acme", "name": "Acme Corporation", "industry": "Manufacturing", "region": "North America" }

Only name/industry/region are editable — tenant_id itself is immutable (it's
the partition key everything else, S3 prefixes, Postgres schema names, is
keyed by; renaming it would orphan existing data rather than move it).
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
        ctx.require_role("super_admin", "project_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    tenant_id = (body.get("tenant_id") or "").strip().lower()
    if not tenant_id:
        return http.bad_request("tenant_id is required")

    existing = config.get_item(f"TENANT#{tenant_id}", "METADATA")
    if existing is None:
        return http.bad_request(f"Tenant '{tenant_id}' not found")

    updates: dict = {}
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            return http.bad_request("name cannot be empty")
        updates["name"] = name
    if "industry" in body:
        updates["industry"] = body.get("industry") or ""
    if "region" in body:
        updates["region"] = body.get("region") or ""

    if not updates:
        return http.bad_request("no editable fields provided (name, industry, region)")

    try:
        config.update_item(f"TENANT#{tenant_id}", "METADATA", updates)
    except Exception as e:
        log.error("Failed to update tenant %s: %s", tenant_id, e)
        return http.server_error(f"Failed to update tenant: {e}")

    audit_events.write(
        ctx, "admin.tenant_update",
        ip=audit_events.get_ip(event),
        resource_type="tenant",
        resource_id=tenant_id,
        resource_name=updates.get("name", existing.get("name", tenant_id)),
        details=updates,
    )

    log.info("Admin %s updated tenant %s: %s", ctx.user_id, tenant_id, updates)
    return http.ok({"tenant_id": tenant_id, **updates, "message": "Client updated successfully"})
