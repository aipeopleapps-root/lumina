"""
Project Admin: cost summary — real Azure spend via Cost Management + AI usage from audit container.

GET /manage/costs?days=30
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone

from azure.identity import DefaultAzureCredential
from azure.mgmt.costmanagement import CostManagementClient
from azure.mgmt.costmanagement.models import (
    QueryAggregation,
    QueryDataset,
    QueryDefinition,
    QueryGrouping,
    QueryTimePeriod,
)

from common import tenant_from_event, TenantError, audit_events, config, http

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

# Cost Management scope: the resource group everything in this stack lives in
# (single-resource-group deployment — see bicep/main.bicep).
_SCOPE = (
    f"/subscriptions/{os.environ.get('AZURE_SUBSCRIPTION_ID', '')}"
    f"/resourceGroups/{os.environ.get('AZURE_RESOURCE_GROUP', '')}"
)

_cm_client = CostManagementClient(credential=DefaultAzureCredential())

# Map verbose Azure service/meter-category names to display labels
_SERVICE_LABELS = {
    "Azure OpenAI": "Azure OpenAI (AI)",
    "Cognitive Services": "AI Foundry (AI)",
    "Azure Cosmos DB": "Cosmos DB (Database)",
    "Storage": "Blob/Queue Storage (Document Storage)",
    "Azure Database for PostgreSQL": "PostgreSQL (Database)",
    "Functions": "Functions (Compute)",
    "API Management": "API Management",
    "Key Vault": "Key Vault (Encryption)",
    "Virtual Network": "VNet / NAT Gateway",
    "Log Analytics": "Log Analytics (Logs)",
    "Azure Monitor": "Azure Monitor (Logs)",
    "Microsoft Entra ID": "Entra ID (Auth)",
    "Bandwidth": "Bandwidth / Egress",
}


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("project_admin", "super_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    qs = event.get("queryStringParameters") or {}
    days = min(max(int(qs.get("days", 30)), 1), 365)

    now = datetime.now(timezone.utc)
    end = now.date()
    start = (now - timedelta(days=days)).date()

    service_costs = _get_service_costs(start, end)
    ai_usage = _get_ai_usage(start, end)

    total_usd = sum(s["cost_usd"] for s in service_costs)
    ai_cost = sum(
        s["cost_usd"] for s in service_costs
        if "OpenAI" in s["service_raw"] or "Cognitive" in s["service_raw"]
    )

    for s in service_costs:
        s["pct"] = round((s["cost_usd"] / total_usd * 100) if total_usd > 0 else 0, 1)

    return http.ok({
        "period": {"start": str(start), "end": str(end), "days": days},
        "total_usd": round(total_usd, 4),
        "bedrock_usd": round(ai_cost, 4),
        "currency": "USD",
        "services": sorted(service_costs, key=lambda x: x["cost_usd"], reverse=True),
        "ai_usage": ai_usage,
        "data_lag_note": "Azure cost data has approximately 8-24 hour lag.",
    })


def _get_service_costs(start, end) -> list[dict]:
    """Query Cost Management for per-service costs, summed across the whole range."""
    try:
        query = QueryDefinition(
            type="ActualCost",
            timeframe="Custom",
            time_period=QueryTimePeriod(
                from_property=datetime(start.year, start.month, start.day, tzinfo=timezone.utc),
                to=datetime(end.year, end.month, end.day, 23, 59, 59, tzinfo=timezone.utc),
            ),
            dataset=QueryDataset(
                granularity="Monthly",
                aggregation={"totalCost": QueryAggregation(name="Cost", function="Sum")},
                grouping=[QueryGrouping(type="Dimension", name="ServiceName")],
            ),
        )
        result = _cm_client.query.usage(scope=_SCOPE, parameters=query)
    except Exception as e:
        log.warning("Cost Management query failed: %s", e)
        return []

    columns = [c.name for c in (result.columns or [])]
    try:
        cost_idx = columns.index("Cost")
        service_idx = columns.index("ServiceName")
    except ValueError:
        log.warning("Cost Management response missing expected columns: %s", columns)
        return []

    totals: dict[str, float] = {}
    for row in (result.rows or []):
        raw_name = row[service_idx]
        amount = float(row[cost_idx])
        totals[raw_name] = totals.get(raw_name, 0.0) + amount

    return [
        {
            "service": _SERVICE_LABELS.get(name, name),
            "service_raw": name,
            "cost_usd": round(amount, 4),
        }
        for name, amount in totals.items()
        if amount > 0.0001
    ]


def _get_ai_usage(start, end) -> dict:
    """Count AI calls from the audit container, broken down by action and tenant."""
    start_iso = start.isoformat()
    end_iso = end.isoformat() + "T23:59:59"

    items = audit_events.query_by_action_prefix("ai.", start_iso, end_iso)

    by_action: dict[str, int] = {}
    by_tenant: dict[str, int] = {}
    for item in items:
        action = item.get("action", "unknown")
        tenant = item.get("tenant_id", "unknown")
        by_action[action] = by_action.get(action, 0) + 1
        by_tenant[tenant] = by_tenant.get(tenant, 0) + 1

    tenant_names = _get_tenant_names(list(by_tenant.keys()))

    return {
        "total_calls": len(items),
        "by_action": by_action,
        "by_tenant": [
            {"tenant_id": tid, "name": tenant_names.get(tid, tid), "calls": count}
            for tid, count in sorted(by_tenant.items(), key=lambda x: -x[1])
        ],
    }


def _get_tenant_names(tenant_ids: list[str]) -> dict[str, str]:
    if not tenant_ids:
        return {}
    names: dict[str, str] = {}
    for tid in tenant_ids:
        try:
            item = config.get_item(f"TENANT#{tid}", "METADATA")
            if item:
                names[tid] = item.get("name", tid)
        except Exception:
            pass
    return names
