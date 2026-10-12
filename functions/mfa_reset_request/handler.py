"""
POST /mfa/request-reset  (PUBLIC — no auth)
  User requests an admin to reset their MFA (e.g. lost authenticator device).
  Stores one pending request per email; duplicate requests update the timestamp.

GET /manage/mfa-reset-requests  (admin only)
  Lists all pending reset requests for the admin to review.

POST /manage/mfa-reset-requests  (admin only)
  { "email": "...", "action": "dismiss" }  — removes the pending request
  (Actual MFA reset goes through /manage/manage-user with action reset_mfa)
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone

from common import tenant_from_event, TenantError, config, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_PK = "MFA_RESET_REQUEST"
_TTL_SECONDS = 72 * 3600  # requests expire after 72 hours if unactioned


def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "POST")
    path = event.get("rawPath", "")

    # ── Admin routes ──────────────────────────────────────────────────────────
    if "/manage/" in path:
        try:
            ctx = tenant_from_event(event)
            ctx.require_role("super_admin")
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

    now = datetime.now(timezone.utc)

    config.put_item({
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
    items = config.query_by_pk(_PK)
    now_epoch = int(time.time())
    requests = [
        {
            "email": item["email"],
            "requested_at": item.get("requested_at", ""),
            "ip": item.get("ip", ""),
        }
        for item in items
        if item.get("ttl", now_epoch + 1) > now_epoch  # exclude expired (Cosmos has no TTL on this container)
    ]
    return http.ok({"requests": requests})


def _delete_request(email: str) -> dict:
    config.delete_item(_PK, email)
    return http.ok({"message": f"Request for {email} dismissed"})
