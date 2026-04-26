"""
Admin: list all tenants from DynamoDB config table with user + document counts.
"""

from __future__ import annotations

import logging
import os

import boto3
from boto3.dynamodb.conditions import Attr

from common import tenant_from_event, TenantError, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_dynamodb = boto3.resource("dynamodb")
_cognito = boto3.client("cognito-idp")
_CONFIG_TABLE = os.environ["CONFIG_TABLE_NAME"]
_VECTOR_TABLE = os.environ["VECTOR_TABLE_NAME"]
_USER_POOL_ID = os.environ["USER_POOL_ID"]


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("admin", "project_admin", "security_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        tenants = _scan_tenants()
        user_counts = _cognito_user_counts()
        doc_counts = _doc_counts([t["tenant_id"] for t in tenants])

        for t in tenants:
            tid = t["tenant_id"]
            t["user_count"] = user_counts.get(tid, 0)
            t["document_count"] = doc_counts.get(tid, 0)

        # Active first, then archived; within each group newest first
        tenants.sort(key=lambda x: (x["status"] != "active", x.get("created_at", "")), reverse=False)

        return http.ok({"tenants": tenants})

    except Exception as e:
        log.error("Failed to list tenants: %s", e, exc_info=True)
        return http.server_error(f"Failed to list tenants: {e}")


def _scan_tenants() -> list[dict]:
    table = _dynamodb.Table(_CONFIG_TABLE)
    items: list[dict] = []
    last_key = None
    while True:
        kwargs: dict = {
            "FilterExpression": Attr("sk").eq("METADATA") & Attr("pk").begins_with("TENANT#")
        }
        if last_key:
            kwargs["ExclusiveStartKey"] = last_key
        resp = table.scan(**kwargs)
        for item in resp.get("Items", []):
            items.append({
                "tenant_id": item.get("tenant_id", item["pk"].removeprefix("TENANT#")),
                "name": item.get("name", ""),
                "industry": item.get("industry", ""),
                "region": item.get("region", ""),
                "status": item.get("status", "active"),
                "created_at": item.get("created_at", ""),
            })
        last_key = resp.get("LastEvaluatedKey")
        if not last_key:
            break
    return items


def _cognito_user_counts() -> dict[str, int]:
    counts: dict[str, int] = {}
    try:
        paginator = _cognito.get_paginator("list_users")
        for page in paginator.paginate(UserPoolId=_USER_POOL_ID):
            for u in page.get("Users", []):
                attrs = {a["Name"]: a["Value"] for a in u.get("Attributes", [])}
                tid = attrs.get("custom:tenant_id", "")
                if tid:
                    counts[tid] = counts.get(tid, 0) + 1
    except Exception as e:
        log.warning("Could not fetch Cognito user counts: %s", e)
    return counts


def _doc_counts(tenant_ids: list[str]) -> dict[str, int]:
    table = _dynamodb.Table(_VECTOR_TABLE)
    counts: dict[str, int] = {}
    for tid in tenant_ids:
        try:
            from boto3.dynamodb.conditions import Key
            doc_ids: set[str] = set()
            last_key = None
            while True:
                kwargs: dict = {
                    "KeyConditionExpression": Key("tenant_id").eq(tid),
                    "ProjectionExpression": "doc_id",
                }
                if last_key:
                    kwargs["ExclusiveStartKey"] = last_key
                resp = table.query(**kwargs)
                for item in resp.get("Items", []):
                    if item.get("doc_id"):
                        doc_ids.add(item["doc_id"])
                last_key = resp.get("LastEvaluatedKey")
                if not last_key:
                    break
            counts[tid] = len(doc_ids)
        except Exception as e:
            log.warning("Could not count docs for tenant %s: %s", tid, e)
            counts[tid] = 0
    return counts
