"""
POST /mfa/request-reset  (PUBLIC — no auth)
  User requests an admin to reset their MFA (e.g. lost authenticator device).
  Stores one pending request per email; duplicate requests update the timestamp.

GET /admin/mfa-reset-requests  (admin only)
  Lists all pending reset requests for the admin to review.

POST /admin/mfa-reset-requests  (admin only)
  { "email": "...", "action": "dismiss" }  — removes the pending request
  (Actual MFA reset goes through /admin/manage-user with action reset_mfa)
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key

from common import tenant_from_event, TenantError, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_CONFIG_TABLE = os.environ["CONFIG_TABLE_NAME"]
_PK = "MFA_RESET_REQUEST"
_TTL_SECONDS = 72 * 3600  # requests expire after 72 hours if unactioned


def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "POST")
    path = event.get("rawPath", "")

    # ── Admin routes ──────────────────────────────────────────────────────────
    if "/admin/" in path:
        try:
            ctx = tenant_from_event(event)
            ctx.require_role("admin", "security_admin")
        except TenantError as e:
            return http.forbidden(str(e))

        if method == "GET":
            return _list_requests()

        try:
            body = json.loads(event.get("body") or "{}")
        except json.JSONDecodeError:
            return http.bad_request("invalid JSON body")

        action = (body.get("action") or "").strip().lower()
        email = (body.get("email") or "").strip().lower()
        if action == "dismiss" and email:
            return _delete_request(email)
        return http.bad_request("action must be 'dismiss'")

    # ── Public: store reset request ───────────────────────────────────────────
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    email = (body.get("email") or "").strip().lower()
    if not email:
        return http.bad_request("email is required")

    ip = (
        event.get("requestContext", {})
        .get("http", {})
        .get("sourceIp", "unknown")
    )

    dynamodb = boto3.resource("dynamodb")
    table = dynamodb.Table(_CONFIG_TABLE)
    now = datetime.now(timezone.utc)

    table.put_item(Item={
        "pk": _PK,
        "sk": email,
        "email": email,
        "requested_at": now.isoformat(),
        "ip": ip,
        "ttl": int(time.time()) + _TTL_SECONDS,
    })

    log.info("MFA reset requested for %s from IP %s", email, ip)
    return http.ok({"message": "Reset request submitted. An administrator will verify your identity before resetting."})


def _list_requests() -> dict:
    dynamodb = boto3.resource("dynamodb")
    table = dynamodb.Table(_CONFIG_TABLE)
    resp = table.query(KeyConditionExpression=Key("pk").eq(_PK))
    now_epoch = int(time.time())
    requests = [
        {
            "email": item["email"],
            "requested_at": item.get("requested_at", ""),
            "ip": item.get("ip", ""),
        }
        for item in resp.get("Items", [])
        if item.get("ttl", now_epoch + 1) > now_epoch  # exclude expired
    ]
    return http.ok({"requests": requests})


def _delete_request(email: str) -> dict:
    dynamodb = boto3.resource("dynamodb")
    table = dynamodb.Table(_CONFIG_TABLE)
    table.delete_item(Key={"pk": _PK, "sk": email})
    return http.ok({"message": f"Request for {email} dismissed"})
