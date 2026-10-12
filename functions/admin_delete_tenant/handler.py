"""
Project Admin: permanently delete a client tenant.

POST /manage/delete-tenant
{ "tenant_id": "acme" }

Deliberately requires the tenant to already be archived (see
admin_archive_client/handler.py) before it can be hard-deleted — a two-step
"archive, confirm it's really unused, then delete" flow, same reasoning as
requiring a document be unpublished before it can be deleted elsewhere in
this app. The platform system tenant can never be deleted.

What this does and does NOT remove — mirrors admin_manage_user's "delete
user" scope (Entra account removed, but their uploaded documents and audit
history are preserved):
  - Removes the tenant's TENANT#/METADATA config record.
  - Removes any consultant->client ASSIGN# records pointing at this tenant,
    so no consultant is left with a dangling assignment to a client that no
    longer exists.
  - Does NOT touch the tenant's uploaded documents/chunks (Cosmos `vectors`
    container) or S3 objects — those are the client's actual delivered work
    product, and silently mass-deleting them as a side effect of removing a
    metadata record is a much bigger, easier-to-regret blast radius than
    this action should have. If a tenant's documents genuinely need
    purging, that's a separate, explicit action.
"""

from __future__ import annotations

import json
import logging
import os

from common import tenant_from_event, TenantError, audit_events, config, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_PROTECTED_TENANTS = {"platform"}


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
    if tenant_id in _PROTECTED_TENANTS:
        return http.forbidden(f"'{tenant_id}' is a system tenant and cannot be deleted")

    existing = config.get_item(f"TENANT#{tenant_id}", "METADATA")
    if existing is None:
        return http.bad_request(f"Tenant '{tenant_id}' not found")
    if existing.get("status") != "archived":
        return http.bad_request("Archive this client first, then delete it")

    tenant_name = existing.get("name", tenant_id)

    removed_assignments = 0
    for item in config.scan_prefix("ASSIGN#"):
        if item.get("client_tenant_id") == tenant_id:
            config.delete_item(item["pk"], item["sk"])
            removed_assignments += 1

    config.delete_item(f"TENANT#{tenant_id}", "METADATA")

    audit_events.write(
        ctx, "admin.tenant_delete",
        ip=audit_events.get_ip(event),
        resource_type="tenant",
        resource_id=tenant_id,
        resource_name=tenant_name,
        details={"removed_assignments": removed_assignments},
    )

    log.info("Admin %s deleted tenant %s (removed %d assignments)", ctx.user_id, tenant_id, removed_assignments)
    return http.ok({
        "tenant_id": tenant_id,
        "removed_assignments": removed_assignments,
        "message": f"Client '{tenant_name}' has been permanently deleted.",
    })
