"""
Unified audit event writer.

Writes a structured event to the Cosmos DB audit container.
Every meaningful app action should call audit_events.write().
Failures are logged but never propagate — auditing must not break the main request.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any

from azure.cosmos import CosmosClient
from azure.identity import DefaultAzureCredential

from .tenant import TenantContext

log = logging.getLogger(__name__)

_TTL_DAYS = 90

_client: CosmosClient | None = None


def _container():
    global _client
    if _client is None:
        endpoint = os.environ.get("COSMOS_ENDPOINT", "")
        if not endpoint:
            return None
        _client = CosmosClient(endpoint, credential=DefaultAzureCredential())
    database = _client.get_database_client(os.environ.get("COSMOS_DATABASE", "lumina"))
    return database.get_container_client(os.environ.get("AUDIT_CONTAINER_NAME", "audit"))


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
    Write one audit event. Safe to call from any Function — never raises.

    action examples:
      document.upload, document.publish, document.unpublish, document.delete,
      document.download, ai.chat, ai.analyze,
      admin.user_create, admin.tenant_create, admin.password_reset,
      admin.consultant_assign, admin.consultant_unassign
    """
    try:
        container = _container()
        if container is None:
            return

        now = datetime.now(timezone.utc)
        event_id = uuid.uuid4().hex[:12]
        # Sort key: ISO timestamp + id makes events globally orderable
        event_ts = f"{now.isoformat()}#{event_id}"
        # Cosmos ttl is a RELATIVE duration in seconds since last write,
        # unlike DynamoDB's absolute epoch timestamp — do not add time.time().
        ttl = _TTL_DAYS * 86400

        item: dict[str, Any] = {
            "id": event_ts,
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

        container.upsert_item(item)
    except Exception:
        log.exception("audit_events.write failed (non-fatal) action=%s", action)


def query_recent(tenant_id: str, since_iso: str, limit: int = 30) -> list[dict[str, Any]]:
    """
    Most recent events for one tenant since a timestamp, newest first.
    `event_ts` is `"{isoformat}#{event_id}"` — a plain `since_iso` (no `#`)
    still compares correctly since the timestamp prefix differs first.
    """
    container = _container()
    if container is None:
        return []
    query = (
        "SELECT * FROM c WHERE c.tenant_id = @tenant_id AND c.event_ts > @since "
        "ORDER BY c.event_ts DESC OFFSET 0 LIMIT @limit"
    )
    parameters = [
        {"name": "@tenant_id", "value": tenant_id},
        {"name": "@since", "value": since_iso},
        {"name": "@limit", "value": limit},
    ]
    return list(container.query_items(query, parameters=parameters, partition_key=tenant_id))


def query_by_action_prefix(
    action_prefix: str, start_iso: str, end_iso: str
) -> list[dict[str, Any]]:
    """Cross-tenant scan for reporting (e.g. all 'ai.*' events in a date range)."""
    container = _container()
    if container is None:
        return []
    query = (
        "SELECT * FROM c WHERE STARTSWITH(c.action, @prefix) "
        "AND c.created_at >= @start AND c.created_at <= @end"
    )
    parameters = [
        {"name": "@prefix", "value": action_prefix},
        {"name": "@start", "value": start_iso},
        {"name": "@end", "value": end_iso},
    ]
    return list(container.query_items(
        query, parameters=parameters, enable_cross_partition_query=True
    ))


def query_by_tenant(tenant_id: str, limit: int = 100, action_prefix: str | None = None) -> list[dict[str, Any]]:
    """All-time recent events for one tenant, optionally filtered by action prefix, newest first."""
    container = _container()
    if container is None:
        return []
    query = "SELECT * FROM c WHERE c.tenant_id = @tenant_id"
    parameters: list[dict[str, Any]] = [{"name": "@tenant_id", "value": tenant_id}]
    if action_prefix:
        query += " AND STARTSWITH(c.action, @prefix)"
        parameters.append({"name": "@prefix", "value": action_prefix})
    query += " ORDER BY c.event_ts DESC OFFSET 0 LIMIT @limit"
    parameters.append({"name": "@limit", "value": limit})
    return list(container.query_items(query, parameters=parameters, partition_key=tenant_id))


def query_all(limit: int = 100, action_prefix: str | None = None) -> list[dict[str, Any]]:
    """Cross-tenant recent events (security_admin audit log view), optionally filtered
    by action prefix, newest first."""
    container = _container()
    if container is None:
        return []
    query = "SELECT * FROM c"
    parameters: list[dict[str, Any]] = []
    if action_prefix:
        query += " WHERE STARTSWITH(c.action, @prefix)"
        parameters.append({"name": "@prefix", "value": action_prefix})
    query += " ORDER BY c.event_ts DESC OFFSET 0 LIMIT @limit"
    parameters.append({"name": "@limit", "value": limit})
    return list(container.query_items(
        query, parameters=parameters, enable_cross_partition_query=True
    ))


def get_ip(event: dict) -> str:
    """Extract source IP from the request event."""
    # TODO(Phase 7): confirm the actual Azure Functions/APIM request shape
    # once the Function App + APIM front door exists; this assumes the same
    # API-Gateway-v2-style shape used elsewhere in this codebase today.
    try:
        return event["requestContext"]["http"]["sourceIp"]
    except (KeyError, TypeError):
        return "unknown"
