"""
Security Admin: query the audit log across all tenants.

GET /admin/audit-log?limit=50&tenant_id=acme&action=document.upload
"""

from __future__ import annotations

import json
import logging
import os

import boto3
from boto3.dynamodb.conditions import Key, Attr

from common import tenant_from_event, TenantError, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_AUDIT_TABLE = os.environ.get("AUDIT_TABLE_NAME", "")


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("security_admin", "admin")
    except TenantError as e:
        return http.forbidden(str(e))

    qs = event.get("queryStringParameters") or {}
    limit = min(int(qs.get("limit", 100)), 500)
    filter_tenant = (qs.get("tenant_id") or "").strip().lower()
    filter_action = (qs.get("action") or "").strip().lower()

    if not _AUDIT_TABLE:
        return http.server_error("Audit table not configured")

    dynamodb = boto3.resource("dynamodb")
    table = dynamodb.Table(_AUDIT_TABLE)

    entries: list[dict] = []

    try:
        if filter_tenant:
            # Query by tenant_id (partition key), newest first via ScanIndexForward=False
            kwargs: dict = {
                "KeyConditionExpression": Key("tenant_id").eq(filter_tenant),
                "ScanIndexForward": False,
                "Limit": limit,
            }
            if filter_action:
                kwargs["FilterExpression"] = Attr("action").begins_with(filter_action)
            resp = table.query(**kwargs)
            entries = resp.get("Items", [])
        else:
            # Full scan across all tenants — sorted client-side
            kwargs = {}
            if filter_action:
                kwargs["FilterExpression"] = Attr("action").begins_with(filter_action)
            all_items: list[dict] = []
            last_key = None
            # Scan up to 5 pages to avoid timeouts; limit applied after sort
            for _ in range(5):
                if last_key:
                    kwargs["ExclusiveStartKey"] = last_key
                resp = table.scan(**kwargs)
                all_items.extend(resp.get("Items", []))
                last_key = resp.get("LastEvaluatedKey")
                if not last_key or len(all_items) >= limit * 3:
                    break
            # Sort by event_ts descending (ISO + uuid makes this reliable)
            all_items.sort(key=lambda x: x.get("event_ts", ""), reverse=True)
            entries = all_items[:limit]

    except Exception as e:
        log.error("Failed to query audit log: %s", e, exc_info=True)
        return http.server_error(f"Failed to query audit log: {e}")

    # Deserialise details JSON string back to dict for frontend
    result = []
    for item in entries:
        details = item.get("details", "{}")
        if isinstance(details, str):
            try:
                details = json.loads(details)
            except Exception:
                details = {}
        result.append({
            "tenant_id": item.get("tenant_id", ""),
            "event_id": item.get("event_id", ""),
            "event_ts": item.get("event_ts", ""),
            "action": item.get("action", ""),
            "user_id": item.get("user_id", ""),
            "user_email": item.get("user_email", ""),
            "role": item.get("role", ""),
            "ip_address": item.get("ip_address", "unknown"),
            "resource_type": item.get("resource_type", ""),
            "resource_id": item.get("resource_id", ""),
            "resource_name": item.get("resource_name", ""),
            "details": details,
            "created_at": item.get("created_at", ""),
        })

    return http.ok({"entries": result, "count": len(result)})
