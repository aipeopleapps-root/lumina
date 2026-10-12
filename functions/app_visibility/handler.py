"""
Admin-controlled Platform Home tile state, per view.

Two views exist: "consultant" (real staff, home tenant "platform") and
"demo" (the demo walkthrough account, home tenant "demo" — see
bicep-independent seeding: created directly via Graph + /manage/create-tenant
in session 15, not through bootstrap.py). Each view has its own independent
set of "work in progress" app tiles — grayed out on Platform Home with an
admin-written reason, rather than removed from the grid, so the tile stays
visible (people know the app exists) but isn't clickable. This replaces the
old binary hidden/shown "hidden_apps" list with a per-view, per-app reason
map, since a single global list couldn't express "hide this from demo but
keep it live for real consultants" (exactly the reason a demo user with a
curated tile set was requested).

Two separate Cosmos items, one per view (pk="APP_VISIBILITY", sk=view name)
rather than one item nesting both views — avoids a read-modify-write race
between two admins editing different views at the same time.

GET  /manage/app-visibility[?view=demo]  (any authenticated role) —
     Platform Home fetches this on load. The view is inferred from the
     caller's own home tenant (ctx.tenant_id == "demo" -> demo view,
     everything else -> consultant view) UNLESS the caller is an admin AND
     passes an explicit ?view= override, which is how AdminPanel's Apps tab
     loads both views' current config to populate two edit tabs.
POST /manage/app-visibility  (admin only) — { view, wip_apps: {appId: reason} }
     full replacement of one view's WIP map.
"""

from __future__ import annotations

import json
import logging
import os

from common import tenant_from_event, TenantError, config, http

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_PK = "APP_VISIBILITY"
_VIEWS = {"consultant", "demo"}


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
    except TenantError as e:
        return http.forbidden(str(e))

    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")

    if method == "GET":
        return _get(ctx, event)

    try:
        ctx.require_role("super_admin")
    except TenantError as e:
        return http.forbidden(str(e))
    return _post(event)


def _get(ctx, event):
    inferred_view = "demo" if ctx.tenant_id == "demo" else "consultant"

    qs = event.get("queryStringParameters") or {}
    requested_view = (qs.get("view") or "").strip().lower()
    if requested_view and ctx.role == "super_admin" and requested_view in _VIEWS:
        view = requested_view
    else:
        view = inferred_view

    item = config.get_item(_PK, view)
    return http.ok({"view": view, "wip_apps": (item or {}).get("wip_apps", {})})


def _post(event):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    view = (body.get("view") or "").strip().lower()
    if view not in _VIEWS:
        return http.bad_request(f"view must be one of: {', '.join(sorted(_VIEWS))}")

    wip_apps = body.get("wip_apps")
    if not isinstance(wip_apps, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in wip_apps.items()
    ):
        return http.bad_request("wip_apps must be an object mapping app id -> reason string")

    config.put_item({"pk": _PK, "sk": view, "wip_apps": wip_apps})
    return http.ok({"view": view, "wip_apps": wip_apps})
