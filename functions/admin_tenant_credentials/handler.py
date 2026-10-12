"""
Admin-only management of per-client-tenant third-party credentials — first
use case: a Workday service-account username/password so the
Test-Automation-Suite execution engine can log in and drive that tenant's
Workday UI (see functions/test_automation/handler.py's execute routes).

No pattern for this existed anywhere in the codebase before this — confirmed
by a full-repo search. Deliberately NOT modeled on app_settings (which is
per-app, global across tenants) or on the Cosmos `config` container holding
the secret directly (raw credentials have no business sitting in a
general-purpose key-value store an every handler can read). Instead:

  - The actual secret lives in Key Vault (`functions/common/keyvault.py`),
    written/read only by this Function App's own managed identity — Key Vault
    is VNet-private, so nothing outside this VNet (including the execution
    engine's Container App, deliberately NOT VNet-integrated, see the design
    doc) can reach it directly.
  - Cosmos `config` (pk=TENANT_CREDS, sk=f"{tenant_id}#{environment_id}")
    holds only a non-secret marker — {has_credential, updated_at, updated_by}
    — so the admin UI can show "configured" without ever round-tripping the
    password back to a browser.

One client tenant can have several Workday environments (sandbox, preview, a
production mirror, ...) — see test_automation.environments
(migrations/008_test_automation_environments.sql), the registry of which
environments exist per tenant. This module only handles the *credential* half
(the secret); environment registration (name, nightly settings) lives in
functions/test_automation/handler.py's /test-automation/environments routes.

GET  /manage/tenant-credentials?tenant_id=...&environment_id=...  (admin, project_admin) —
     marker only, never the secret.
POST /manage/tenant-credentials  (admin, project_admin) —
     { tenant_id, environment_id, workday_username, workday_password, workday_url } —
     writes the secret to Key Vault, then the marker to Cosmos. workday_url is
     the environment's actual Workday sign-in page (e.g.
     https://wd5.myworkday.com/<tenant>/login.htmld) — stored alongside the
     credential since the execution container has no other way to know which
     Workday tenant to even navigate to. Writes an audit event (without the
     credential value — same discipline as every other audit_events.write
     call in this codebase never logging secrets).
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone

from common import tenant_from_event, TenantError, config, keyvault, audit_events, http

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_PK = "TENANT_CREDS"


def _valid_tenant_id(tenant_id: str) -> bool:
    return bool(tenant_id) and tenant_id.replace("-", "").replace("_", "").isalnum()


def _valid_environment_id(environment_id: str) -> bool:
    try:
        uuid.UUID(environment_id)
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def _marker_sk(tenant_id: str, environment_id: str) -> str:
    return f"{tenant_id}#{environment_id}"


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("super_admin", "project_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    if method == "GET":
        return _get(event)
    return _post(ctx, event)


def _get(event):
    qs = event.get("queryStringParameters") or {}
    tenant_id = (qs.get("tenant_id") or "").strip().lower()
    environment_id = (qs.get("environment_id") or "").strip()
    if not _valid_tenant_id(tenant_id):
        return http.bad_request("valid tenant_id query parameter is required")
    if not _valid_environment_id(environment_id):
        return http.bad_request("valid environment_id query parameter is required")

    marker = config.get_item(_PK, _marker_sk(tenant_id, environment_id))
    if not marker:
        return http.ok({"tenant_id": tenant_id, "environment_id": environment_id, "has_credential": False})

    return http.ok({
        "tenant_id": tenant_id,
        "environment_id": environment_id,
        "has_credential": True,
        "updated_at": marker.get("updated_at"),
        "updated_by": marker.get("updated_by"),
    })


def _post(ctx, event):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    tenant_id = (body.get("tenant_id") or "").strip().lower()
    environment_id = (body.get("environment_id") or "").strip()
    username = (body.get("workday_username") or "").strip()
    password = body.get("workday_password") or ""
    workday_url = (body.get("workday_url") or "").strip()
    if not _valid_tenant_id(tenant_id):
        return http.bad_request("valid tenant_id is required")
    if not _valid_environment_id(environment_id):
        return http.bad_request("valid environment_id is required")
    if not username or not password or not workday_url:
        return http.bad_request("workday_username, workday_password, and workday_url are required")
    if not workday_url.startswith("https://"):
        return http.bad_request("workday_url must be an https:// URL")

    keyvault.set_tenant_workday_credential(tenant_id, environment_id, username, password, workday_url)

    now_iso = datetime.now(timezone.utc).isoformat()
    config.put_item({
        "pk": _PK,
        "sk": _marker_sk(tenant_id, environment_id),
        "has_credential": True,
        "updated_at": now_iso,
        "updated_by": ctx.email or ctx.user_id,
    })

    audit_events.write(
        ctx,
        "tenant_credentials.update",
        ip=audit_events.get_ip(event),
        resource_type="tenant_credentials",
        resource_id=f"{tenant_id}#{environment_id}",
        resource_name=tenant_id,
        details={"environment_id": environment_id, "workday_username": username, "workday_url": workday_url},  # never the password
    )

    return http.ok({"tenant_id": tenant_id, "environment_id": environment_id, "has_credential": True})
