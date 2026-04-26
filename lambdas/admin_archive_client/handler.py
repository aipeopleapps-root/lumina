"""
Project Admin: archive or restore a client tenant.

POST /admin/archive-client
{ "tenant_id": "acme", "action": "archive" | "restore" }
"""

from __future__ import annotations

import json
import logging
import os

import boto3
from botocore.exceptions import ClientError

from common import tenant_from_event, TenantError, audit_events, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_dynamodb = boto3.resource("dynamodb")
_CONFIG_TABLE = os.environ["CONFIG_TABLE_NAME"]


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

    table = _dynamodb.Table(_CONFIG_TABLE)

    # Verify tenant exists
    resp = table.get_item(Key={"pk": f"TENANT#{tenant_id}", "sk": "METADATA"})
    if "Item" not in resp:
        return http.bad_request(f"Tenant '{tenant_id}' not found")

    item = resp["Item"]
    tenant_name = item.get("name", tenant_id)
    new_status = "archived" if action == "archive" else "active"

    try:
        table.update_item(
            Key={"pk": f"TENANT#{tenant_id}", "sk": "METADATA"},
            UpdateExpression="SET #st = :s",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={":s": new_status},
        )
    except ClientError as e:
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
