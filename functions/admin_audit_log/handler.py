"""
Security Admin: query the audit log across all tenants.

GET /manage/audit-log?limit=50&tenant_id=acme&action=document.upload
"""

from __future__ import annotations

import json
import logging
import os

from common import tenant_from_event, TenantError, audit_events, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("super_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    qs = event.get("queryStringParameters") or {}
    limit = min(int(qs.get("limit", 100)), 500)
    filter_tenant = (qs.get("tenant_id") or "").strip().lower()
    filter_action = (qs.get("action") or "").strip().lower()

    try:
        if filter_tenant:
            entries = audit_events.query_by_tenant(
                filter_tenant, limit=limit, action_prefix=filter_action or None
            )
        else:
            entries = audit_events.query_all(limit=limit, action_prefix=filter_action or None)
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
