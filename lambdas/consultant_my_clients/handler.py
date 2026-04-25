"""
Returns the list of client tenants the authenticated consultant is assigned to.
Used to populate the client-switcher in the consultant portal.
"""

from __future__ import annotations

import json
import logging
import os

import boto3
from boto3.dynamodb.conditions import Key

from common import tenant_from_event, TenantError, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_CONFIG_TABLE = os.environ["CONFIG_TABLE_NAME"]


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant")
    except TenantError as e:
        return http.forbidden(str(e))

    dynamodb = boto3.resource("dynamodb")
    table = dynamodb.Table(_CONFIG_TABLE)

    # All assignments for this consultant: pk=ASSIGN#<sub>, sk starts with CLIENT#
    resp = table.query(
        KeyConditionExpression=(
            Key("pk").eq(f"ASSIGN#{ctx.user_id}") &
            Key("sk").begins_with("CLIENT#")
        )
    )

    clients = []
    for item in resp.get("Items", []):
        tenant_id = item["sk"].removeprefix("CLIENT#")
        clients.append({
            "tenant_id": tenant_id,
            "name": item.get("client_name", tenant_id),
            "industry": item.get("industry", ""),
        })

    return http.ok({"clients": clients})
