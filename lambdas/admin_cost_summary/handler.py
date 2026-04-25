"""
Project Admin: cost summary — real AWS spend via Cost Explorer + AI usage from audit table.

GET /admin/costs?days=30
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone

import boto3
from boto3.dynamodb.conditions import Attr

from common import tenant_from_event, TenantError, http

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_AUDIT_TABLE = os.environ.get("AUDIT_TABLE_NAME", "")
_CONFIG_TABLE = os.environ.get("CONFIG_TABLE_NAME", "")

# Cost Explorer is a global service — always accessed through us-east-1
_ce = boto3.client("ce", region_name="us-east-1")
_dynamodb = boto3.resource("dynamodb")

# Map verbose AWS service names to display labels
_SERVICE_LABELS = {
    "Amazon Bedrock": "Bedrock (AI)",
    "AWS Lambda": "Lambda (Compute)",
    "Amazon DynamoDB": "DynamoDB (Database)",
    "Amazon Simple Storage Service": "S3 (Document Storage)",
    "Amazon API Gateway": "API Gateway",
    "Amazon Cognito": "Cognito (Auth)",
    "Amazon CloudWatch": "CloudWatch (Logs)",
    "Amazon Virtual Private Cloud": "VPC / NAT Gateway",
    "Amazon Elastic Compute Cloud - Compute": "EC2",
    "AWS Key Management Service": "KMS (Encryption)",
    "AWS Secrets Manager": "Secrets Manager",
    "Amazon Route 53": "Route 53 (DNS)",
}


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("project_admin", "admin")
    except TenantError as e:
        return http.forbidden(str(e))

    qs = event.get("queryStringParameters") or {}
    days = min(max(int(qs.get("days", 30)), 1), 365)

    now = datetime.now(timezone.utc)
    end = now.date()
    start = (now - timedelta(days=days)).date()

    service_costs = _get_service_costs(str(start), str(end))
    ai_usage = _get_ai_usage(start, end)

    total_usd = sum(s["cost_usd"] for s in service_costs)
    bedrock_cost = next(
        (s["cost_usd"] for s in service_costs if "Bedrock" in s["service"]), 0.0
    )

    for s in service_costs:
        s["pct"] = round((s["cost_usd"] / total_usd * 100) if total_usd > 0 else 0, 1)

    return http.ok({
        "period": {"start": str(start), "end": str(end), "days": days},
        "total_usd": round(total_usd, 4),
        "bedrock_usd": round(bedrock_cost, 4),
        "currency": "USD",
        "services": sorted(service_costs, key=lambda x: x["cost_usd"], reverse=True),
        "ai_usage": ai_usage,
        "data_lag_note": "AWS cost data has approximately 24-hour lag.",
    })


def _get_service_costs(start: str, end: str) -> list[dict]:
    """Query Cost Explorer for per-service costs, summed across months."""
    try:
        resp = _ce.get_cost_and_usage(
            TimePeriod={"Start": start, "End": end},
            Granularity="MONTHLY",
            Metrics=["BlendedCost"],
            GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
        )
    except Exception as e:
        log.warning("Cost Explorer query failed: %s", e)
        return []

    totals: dict[str, float] = {}
    for result in resp.get("ResultsByTime", []):
        for group in result.get("Groups", []):
            raw_name = group["Keys"][0]
            amount = float(group["Metrics"]["BlendedCost"]["Amount"])
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
    """Count AI calls from audit table, broken down by action and tenant."""
    if not _AUDIT_TABLE:
        return {"total_calls": 0, "by_action": {}, "by_tenant": []}

    table = _dynamodb.Table(_AUDIT_TABLE)
    start_iso = start.isoformat()
    end_iso = end.isoformat() + "T23:59:59"

    items: list[dict] = []
    last_key = None
    for _ in range(20):
        kwargs: dict = {
            "FilterExpression": (
                Attr("action").begins_with("ai.")
                & Attr("created_at").between(start_iso, end_iso)
            )
        }
        if last_key:
            kwargs["ExclusiveStartKey"] = last_key
        resp = table.scan(**kwargs)
        items.extend(resp.get("Items", []))
        last_key = resp.get("LastEvaluatedKey")
        if not last_key:
            break

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
    if not _CONFIG_TABLE or not tenant_ids:
        return {}
    table = _dynamodb.Table(_CONFIG_TABLE)
    names: dict[str, str] = {}
    for tid in tenant_ids:
        try:
            resp = table.get_item(Key={"pk": f"TENANT#{tid}", "sk": "METADATA"})
            if "Item" in resp:
                names[tid] = resp["Item"].get("name", tid)
        except Exception:
            pass
    return names
