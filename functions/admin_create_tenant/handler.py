"""
Admin: Create new tenant (Cosmos `config` container only — no Aurora dependency).

POST /manage/create-tenant
{ "tenant_id": "newcorp", "name": "New Corp", "industry": "...", "region": "..." }
"""

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
    name = (body.get("name") or "").strip()
    industry = body.get("industry") or ""
    region = body.get("region") or ""

    if not tenant_id or not name:
        return http.bad_request("tenant_id and name are required")
    if not tenant_id.replace("-", "").replace("_", "").isalnum():
        return http.bad_request("tenant_id must be alphanumeric (dashes/underscores allowed)")

    try:
        config.create_item({
            "pk": f"TENANT#{tenant_id}",
            "sk": "METADATA",
            "tenant_id": tenant_id,
            "name": name,
            "industry": industry,
            "region": region,
            "status": "active",
            "created_by": ctx.user_id,
        })
    except FileExistsError:
        return http.bad_request(f"Tenant '{tenant_id}' already exists")

    log.info("Admin %s created tenant %s (%s)", ctx.user_id, tenant_id, name)

    audit_events.write(
        ctx, "admin.tenant_create",
        ip=audit_events.get_ip(event),
        resource_type="tenant",
        resource_id=tenant_id,
        resource_name=name,
        details={"industry": industry, "region": region},
    )

    return http.ok({"tenant_id": tenant_id, "name": name, "message": "Tenant created successfully"})
