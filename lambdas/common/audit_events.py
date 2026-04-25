"""
Unified audit event writer.

Writes a structured event to the DynamoDB audit table.
Every meaningful app action should call audit_events.write().
Failures are logged but never propagate — auditing must not break the main request.
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from typing import Any

import boto3

from .tenant import TenantContext

log = logging.getLogger(__name__)

_TABLE_NAME = os.environ.get("AUDIT_TABLE_NAME", "")
_TTL_DAYS = 90


def write(
    ctx: TenantContext,
    action: str,
    *,
    ip: str = "unknown",
    resource_type: str = "",
    resource_id: str = "",
    resource_name: str = "",
    details: dict[str, Any] | None = None,
) -> None:
    """
    Write one audit event. Safe to call from any lambda — never raises.

    action examples:
      document.upload, document.publish, document.unpublish, document.delete,
      document.download, ai.chat, ai.analyze,
      admin.user_create, admin.tenant_create, admin.password_reset,
      admin.consultant_assign, admin.consultant_unassign
    """
    if not _TABLE_NAME:
        return

    try:
        now = datetime.now(timezone.utc)
        event_id = uuid.uuid4().hex[:12]
        # Sort key: ISO timestamp + id makes events globally orderable
        event_ts = f"{now.isoformat()}#{event_id}"
        ttl = int(time.time()) + _TTL_DAYS * 86400

        item: dict[str, Any] = {
            "tenant_id": ctx.tenant_id,
            "event_ts": event_ts,
            "event_id": event_id,
            "action": action,
            "user_id": ctx.user_id,
            "user_email": ctx.email or "",
            "role": ctx.role,
            "ip_address": ip,
            "resource_type": resource_type,
            "resource_id": resource_id,
            "resource_name": resource_name,
            "details": json.dumps(details or {}),
            "created_at": now.isoformat(),
            "ttl": ttl,
        }

        dynamodb = boto3.resource("dynamodb")
        dynamodb.Table(_TABLE_NAME).put_item(Item=item)
    except Exception:
        log.exception("audit_events.write failed (non-fatal) action=%s", action)


def get_ip(event: dict) -> str:
    """Extract source IP from API Gateway v2 event."""
    try:
        return event["requestContext"]["http"]["sourceIp"]
    except (KeyError, TypeError):
        return "unknown"
