"""
Project Admin: assign/unassign a consultant to a client, or list all assignments.

GET  /admin/assignments          → { assignments: [{consultant_sub, consultant_email, client_tenant_id}] }
POST /admin/assign-consultant    → assign or unassign
"""

from __future__ import annotations

import json
import logging
import os

import boto3
from boto3.dynamodb.conditions import Attr

from common import tenant_from_event, TenantError, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_CONFIG_TABLE = os.environ["CONFIG_TABLE_NAME"]


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("project_admin", "admin")
    except TenantError as e:
        return http.forbidden(str(e))

    method = event.get("requestContext", {}).get("http", {}).get("method", "POST")

    if method == "GET":
        return _list_assignments()

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    consultant_sub = (body.get("consultant_sub") or "").strip()
    consultant_email = (body.get("consultant_email") or "").strip().lower()
    client_tenant_id = (body.get("client_tenant_id") or "").strip().lower()
    action = (body.get("action") or "assign").strip().lower()

    if not consultant_sub or not client_tenant_id:
        return http.bad_request("consultant_sub and client_tenant_id are required")
    if action not in ("assign", "unassign"):
        return http.bad_request("action must be 'assign' or 'unassign'")

    dynamodb = boto3.resource("dynamodb")
    table = dynamodb.Table(_CONFIG_TABLE)

    client_name = client_tenant_id
    meta = table.get_item(Key={"pk": f"TENANT#{client_tenant_id}", "sk": "METADATA"})
    if "Item" in meta:
        client_name = meta["Item"].get("name", client_tenant_id)

    pk = f"ASSIGN#{consultant_sub}"
    sk = f"CLIENT#{client_tenant_id}"

    if action == "assign":
        table.put_item(Item={
            "pk": pk,
            "sk": sk,
            "consultant_sub": consultant_sub,
            "consultant_email": consultant_email,
            "client_tenant_id": client_tenant_id,
            "client_name": client_name,
            "assigned_by": ctx.user_id,
        })
        log.info("project_admin %s assigned %s → %s", ctx.user_id, consultant_sub, client_tenant_id)
        return http.ok({"message": f"Consultant assigned to {client_tenant_id}"})

    else:
        table.delete_item(Key={"pk": pk, "sk": sk})
        log.info("project_admin %s unassigned %s from %s", ctx.user_id, consultant_sub, client_tenant_id)
        return http.ok({"message": f"Consultant unassigned from {client_tenant_id}"})


def _list_assignments() -> dict:
    """Scan config table for all ASSIGN# items and return flat list."""
    dynamodb = boto3.resource("dynamodb")
    table = dynamodb.Table(_CONFIG_TABLE)

    items = []
    last_key = None
    while True:
        kwargs: dict = {
            "FilterExpression": Attr("pk").begins_with("ASSIGN#") & Attr("sk").begins_with("CLIENT#"),
        }
        if last_key:
            kwargs["ExclusiveStartKey"] = last_key
        resp = table.scan(**kwargs)
        items.extend(resp.get("Items", []))
        last_key = resp.get("LastEvaluatedKey")
        if not last_key:
            break

    assignments = [
        {
            "consultant_sub": item.get("consultant_sub", item["pk"].removeprefix("ASSIGN#")),
            "consultant_email": item.get("consultant_email", ""),
            "client_tenant_id": item.get("client_tenant_id", item["sk"].removeprefix("CLIENT#")),
            "client_name": item.get("client_name", ""),
        }
        for item in items
    ]
    return http.ok({"assignments": assignments})
