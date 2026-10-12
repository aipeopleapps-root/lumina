"""
Admin-only read/write of per-app configurable settings (see
functions/common/settings_registry.py for the schema registry and storage
shape this wraps — mirrors app_visibility/handler.py's admin-only, per-app,
partial-override-map pattern).

GET  /manage/app-settings  (admin only) — every app's schema + resolved
     current values in one call, e.g. { "apps": { "ask-stuey": { "schema":
     [...], "values": {...} }, ... } }. Apps with no declared settings are
     simply absent, not returned empty.
POST /manage/app-settings  (admin only) — { app, settings: {key: value} }
     full replacement of one app's override map. Validated against that
     app's schema server-side (type/range/options) before being stored, so
     the check can't be bypassed by calling the API directly. Writes an
     audit event — these values change model behavior and cost, the kind of
     admin action the Audit Log tab exists to catch.
"""

from __future__ import annotations

import json
import logging
import os

from common import tenant_from_event, TenantError, config, app_settings, audit_events, http

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_PK = "APP_SETTINGS"


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("super_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    if method == "GET":
        return _get()
    return _post(ctx, event)


def _get():
    return http.ok({"apps": app_settings.list_all_resolved()})


def _post(ctx, event):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    app_id = (body.get("app") or "").strip()
    if not app_id:
        return http.bad_request("app is required")

    settings = body.get("settings")
    if not isinstance(settings, dict):
        return http.bad_request("settings must be an object")

    before = app_settings.get_app_settings(app_id) if app_id in app_settings.SETTINGS_SCHEMAS else {}

    try:
        app_settings.validate_and_normalize(app_id, settings)
    except ValueError as e:
        return http.bad_request(str(e))

    config.put_item({"pk": _PK, "sk": app_id, "settings": settings})

    after = dict(before)
    after.update(settings)

    audit_events.write(
        ctx,
        "app_settings.update",
        ip=audit_events.get_ip(event),
        resource_type="app_settings",
        resource_id=app_id,
        resource_name=app_id,
        details={"before": before, "after": after},
    )

    return http.ok({"app": app_id, "settings": settings})
