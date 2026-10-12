"""
Test Automation Suite — requirements/user-stories/config-workbook/BPW -> user
stories -> test scenarios -> test steps, with a 3-sheet Excel export.

Ported from the standalone requirements-to-test-steps app (see that repo's
CLAUDE.md for the original spec) — domain logic (readers, agent prompts,
Excel formatting) carried over close to verbatim; plumbing rebuilt on
Lumina's own conventions: tenant_from_event() for auth (not Entra CIAM),
common.ai.generate_json() on the user's own Azure AI Foundry / Claude
deployment (not a raw httpx call to a Deloitte GPT-5.1 gateway), Postgres
(test_automation schema, common/test_automation_store.py — mirrors
pi_aurora.py) for run/scenario/step history (not a single-tenant Cosmos
container), and Blob Storage kept for the Excel export only.

Retires functions/generate_tests + functions/test_scripts_status entirely —
this covers everything that flow did (flat test-case generation from
ingested docs) plus user stories, scenario/step staging, and Excel export,
which it didn't.

Routes, one module (function_app.py wires each to a differently-named
Function, mirroring rfp_reimagine's rawPath-dispatch convention):
  POST /test-automation/upload-url          -> _upload_url   (SAS PUT URL —
    functions/common/http_adapter.py unconditionally UTF-8-decodes the
    request body, so a direct multipart upload route (as an earlier draft
    of this port assumed) cannot work here; every other Lumina upload flow
    already uses this SAS-URL pattern, see admin_industry_docs._upload_url)
  POST /test-automation/runs                -> _create_run   (sync: fetch +
    detect + parse; requirements type kicks off an async "stories" stage
    since Agent 1 needs to fan out one call per requirement; every other
    type parses fast enough to return needs_review synchronously)
  GET  /test-automation/runs                -> _list_runs
  GET  /test-automation/runs/{run_id}       -> _get_run       (poll route
    reused across every stage, including execution — scenarios/steps carry
    their execution_status/execution_result fields straight through)
  POST /test-automation/runs/{run_id}/scenarios -> _trigger_scenarios (async)
  POST /test-automation/runs/{run_id}/steps     -> _trigger_steps     (async)
  POST /test-automation/runs/{run_id}/export    -> _export            (sync)
  GET  /test-automation/runs/{run_id}/download  -> _download          (sync)

Execution (Workday-UI-driving Playwright engine — Container Apps Job, KEDA
queue-scaled off the dedicated "execution" Storage Queue, NOT this Function
App's own worker_handler/`jobs` queue; see queue.enqueue_execution's
docstring for why it's a separate queue):
  POST /test-automation/runs/{run_id}/execute -> _trigger_execute (consultant/
    admin JWT auth like every route above) — one execution-queue message per
    scenario, one Chromium session per message.

  Everything under /test-automation/internal/... is called by the execution
  container, NOT the browser — no real user JWT exists for that call, so
  these do NOT go through tenant_from_event()/APIM's validate-jwt. Instead
  they check a dedicated shared-secret header (_require_execution_key) and
  take tenant_id explicitly in the request body/query, trusting it the same
  way any of Lumina's own trigger->worker payloads already do (the container
  only ever runs what this module's own _trigger_execute enqueued):
    GET   /test-automation/internal/scenarios/{scenario_id}  -> scenario + its
      steps, so the container knows what to execute
    PATCH /test-automation/internal/scenarios/{scenario_id}  -> scenario-level
      execution status
    PATCH /test-automation/internal/steps/{step_id}          -> per-step
      execution status/result, reported as-it-goes (not batched) so the poll
      route shows live progress
    POST  /test-automation/internal/credentials               -> Workday
      username/password for one tenant, fetched server-side from Key Vault
      (see functions/common/keyvault.py) — the container never touches Key
      Vault directly, and the credential never appears in a browser
    POST  /test-automation/internal/screenshot-upload-url      -> SAS PUT URL
      for one step's screenshot, same pattern as every other upload in this
      app

Consultant-edited stage data is only ever persisted client-forward (sent in
the next stage's POST body) — Postgres only gains/replaces rows once a
stage's generation actually runs, via test_automation_store's
delete-then-reinsert helpers. Human-readable display labels ("US-001",
"TS-001", "TS-001-001") are never trusted from the model's own JSON output —
they're computed positionally by this handler (see _label_for_display) from
Postgres insertion order / step_number, matching the source app's own
pipeline.py behaviour of reassigning sequential IDs after generation.
"""

from __future__ import annotations

import io
import json
import logging
import os
import uuid

import openpyxl

from common import tenant_from_event, TenantError, blob, queue, keyvault, audit_events, http, config
from common.tenant import TenantContext
from common import test_automation_store as store

from . import agents, docx_reader, input_detector, xlsx_reader, excel_writer

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_CONTENT_TYPES = {
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
_XLSX_CONTENT_TYPE = _CONTENT_TYPES["xlsx"]
_SAS_EXPIRES_IN = 3600

_EXECUTION_STATUSES = {"not_executed", "pending", "running", "passed", "failed", "error"}

# Build tab's run-configuration fields (migration 009) — fixed lists, same set-membership
# validation pattern as admin_create_user._VALID_ROLES. Mirrored client-side in api.ts's
# TEST_PHASES/TEST_MODULES so the Build form and this validation never drift apart silently.
_VALID_TEST_PHASES = {"SIT", "UAT", "Regression", "Parallel", "Production Validation"}
_VALID_MODULES = {"HCM", "Payroll", "Absence", "Recruiting", "Benefits"}


# ── Dispatcher ────────────────────────────────────────────────────────────────

def handler(event: dict, context: object) -> dict:
    raw_path = event.get("rawPath") or event.get("path") or ""
    method = (event.get("requestContext") or {}).get("http", {}).get("method", "GET").upper()

    if "/test-automation/internal/" in raw_path:
        return _internal_dispatch(raw_path, method, event)

    if "/environments" in raw_path:
        return _environments_dispatch(raw_path, method, event)

    if raw_path.endswith("/reports") and method == "GET":
        return _reports_dashboard(event)
    if raw_path.endswith("/upload-url") and method == "POST":
        return _upload_url(event)
    if raw_path.endswith("/execute") and method == "POST":
        return _trigger_execute(event)
    if raw_path.endswith("/scenarios") and method == "POST":
        return _trigger_scenarios(event)
    if raw_path.endswith("/steps") and method == "POST":
        return _trigger_steps(event)
    if raw_path.endswith("/export-results") and method == "POST":
        return _export_results(event)
    if raw_path.endswith("/export") and method == "POST":
        return _export(event)
    if raw_path.endswith("/download") and method == "GET":
        return _download(event)
    if raw_path.endswith("/screenshot-url") and method == "GET":
        return _screenshot_url(event)
    if raw_path.endswith("/runs") and method == "GET":
        return _list_runs(event)
    if raw_path.endswith("/runs") and method == "POST":
        return _create_run(event)
    if method == "GET":
        return _get_run(event)  # /runs/{run_id}
    return http.bad_request("unknown route")


# ── Environments (migration 008 — multiple Workday environments per client) ────
# Registry only (name, nightly settings) — the actual credential is handled by
# functions/admin_tenant_credentials/handler.py (Key Vault + a separate Cosmos
# marker), same split as every other secret-vs-metadata boundary in this app.

def _environments_dispatch(raw_path: str, method: str, event: dict):
    if raw_path.endswith("/environments") and method == "GET":
        return _list_environments(event)
    if raw_path.endswith("/environments") and method == "POST":
        return _create_environment(event)
    if method == "PATCH":
        return _update_environment(event)  # /environments/{environment_id}
    return http.bad_request("unknown route")


def _resolve_tenant_id(ctx: TenantContext, event: dict, *, from_query: bool) -> str:
    """AdminPanel manages every client from one global view (no X-Client-Tenant
    "switch" — same reasoning admin_tenant_credentials.py takes tenant_id explicitly),
    while a consultant in TestAutomationSuite is already scoped to whichever client
    they've switched into via X-Client-Tenant, reflected in ctx.tenant_id. Only
    admin/project_admin may override via an explicit tenant_id — consultants always
    get ctx.tenant_id, they can't spoof an arbitrary tenant this way."""
    if ctx.role not in ("super_admin", "project_admin"):
        return ctx.tenant_id
    qs_or_body = (event.get("queryStringParameters") or {}) if from_query else _json_body(event)
    explicit = (qs_or_body.get("tenant_id") or "").strip().lower()
    return explicit or ctx.tenant_id


def _json_body(event: dict) -> dict:
    try:
        return json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return {}


def _list_environments(event):
    try:
        ctx = tenant_from_event(event)
    except TenantError as e:
        return http.forbidden(str(e))

    tenant_id = _resolve_tenant_id(ctx, event, from_query=True)
    environments = store.list_environments(tenant_id=tenant_id)
    for env in environments:
        marker = config.get_item("TENANT_CREDS", f"{tenant_id}#{env['environment_id']}")
        env["has_credential"] = bool(marker)
    return http.ok({"environments": environments})


def _create_environment(event):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("super_admin", "project_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    body = _json_body(event)
    tenant_id = (body.get("tenant_id") or "").strip().lower() or ctx.tenant_id
    name = (body.get("name") or "").strip()
    if not name:
        return http.bad_request("name is required")

    environment_id = store.create_environment(tenant_id=tenant_id, name=name)
    audit_events.write(
        ctx, "test_automation.environment_created", ip=audit_events.get_ip(event),
        resource_type="test_automation_environment", resource_id=environment_id, resource_name=name,
    )
    return http.ok({"environment_id": environment_id, "tenant_id": tenant_id, "name": name})


def _update_environment(event):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("super_admin", "project_admin", "consultant")
    except TenantError as e:
        return http.forbidden(str(e))

    environment_id = (event.get("pathParameters") or {}).get("environment_id", "")
    if not environment_id:
        return http.bad_request("environment_id path parameter is required")

    body = _json_body(event)

    # Consultants get the Schedule/Execute tab's "toggle nightly, pick which run" capability
    # (same nightly_enabled/nightly_run_id fields WorkdayCredentialsModal already exposes to
    # admins) but not name/is_active — those are environment lifecycle management, which stays
    # admin-only. Same reasoning/shape as admin_create_user's project_admin role-escalation
    # guard: restrict which FIELDS a broadened caller may touch, rather than a second route.
    if ctx.role == "consultant":
        if "name" in body or "is_active" in body:
            return http.forbidden("consultants can only update nightly_enabled/nightly_run_id")
        tenant_id = ctx.tenant_id
    else:
        tenant_id = (body.get("tenant_id") or "").strip().lower() or ctx.tenant_id

    existing = store.get_environment(environment_id=environment_id, tenant_id=tenant_id)
    if not existing:
        return http.bad_request("environment not found")

    store.update_environment(
        environment_id=environment_id,
        tenant_id=tenant_id,
        name=body.get("name"),
        is_active=body.get("is_active"),
        nightly_enabled=body.get("nightly_enabled"),
        nightly_run_id=body.get("nightly_run_id"),
    )
    audit_events.write(
        ctx, "test_automation.environment_updated", ip=audit_events.get_ip(event),
        resource_type="test_automation_environment", resource_id=environment_id,
        resource_name=existing["name"], details=body,
    )
    return http.ok(store.get_environment(environment_id=environment_id, tenant_id=tenant_id))


# ── Upload URL (sync) ────────────────────────────────────────────────────────

def _upload_url(event):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    filename = (body.get("filename") or "").strip()
    if not filename:
        return http.bad_request("filename is required")

    ext = filename.lower().rsplit(".", 1)[-1]
    if ext not in _CONTENT_TYPES:
        return http.bad_request("only .xlsx and .docx files are supported")

    upload_id = uuid.uuid4().hex[:12]
    key = ctx.s3_key("test-automation", "uploads", upload_id, filename)
    sas_url = blob.generate_upload_sas(key, _CONTENT_TYPES[ext], expires_in=_SAS_EXPIRES_IN)

    return http.ok({"url": sas_url, "key": key, "content_type": _CONTENT_TYPES[ext]})


# ── Create run (sync parse + detect; async stage-1 generation for requirements) ──

def _create_run(event):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    s3_key = (body.get("s3_key") or "").strip()
    filename = (body.get("filename") or s3_key.rsplit("/", 1)[-1]).strip()
    if not s3_key or not filename:
        return http.bad_request("s3_key is required")

    run_name = (body.get("run_name") or "").strip() or None
    test_phase = (body.get("test_phase") or "").strip() or None
    module = (body.get("module") or "").strip() or None
    description = (body.get("description") or "").strip() or None
    if test_phase is not None and test_phase not in _VALID_TEST_PHASES:
        return http.bad_request(f"test_phase must be one of: {', '.join(sorted(_VALID_TEST_PHASES))}")
    if module is not None and module not in _VALID_MODULES:
        return http.bad_request(f"module must be one of: {', '.join(sorted(_VALID_MODULES))}")

    try:
        file_bytes = blob.get_object_bytes(s3_key)
    except Exception as exc:
        log.warning("test_automation upload not found key=%s: %s", s3_key, exc)
        return http.bad_request("uploaded file not found")

    input_type = input_detector.detect_input_type(filename, file_bytes)

    try:
        if input_type == "bpw":
            bpw_steps, bpw_processes = docx_reader.read_bpw(file_bytes)
            if not bpw_steps:
                return http.bad_request("no process steps found in the uploaded document")
            input_items = {"bpw_steps": bpw_steps, "bpw_processes": bpw_processes}
        else:
            wb = openpyxl.load_workbook(io.BytesIO(file_bytes), data_only=True)
            if input_type == "user_stories":
                input_items = xlsx_reader.read_user_stories(wb)
            elif input_type == "config_workbook":
                input_items = xlsx_reader.read_config_workbook(wb)
            else:
                input_items = xlsx_reader.read_requirements(wb)
            if not input_items:
                return http.bad_request("no usable rows found in the uploaded file")
    except ValueError as exc:
        return http.bad_request(str(exc))

    ip = audit_events.get_ip(event)

    if input_type == "requirements":
        run_id = store.create_run(
            tenant_id=ctx.tenant_id, user_id=ctx.user_id, file_name=filename,
            input_type=input_type, input_items=input_items, status="generating_stories",
            run_name=run_name, test_phase=test_phase, module=module, description=description,
        )
        queue.enqueue_job("test_automation", {
            "stage": "stories", "run_id": run_id, "tenant_id": ctx.tenant_id,
            "user_id": ctx.user_id, "role": ctx.role, "email": ctx.email, "ip": ip,
        })
        audit_events.write(
            ctx, "test_automation.run_created", ip=ip,
            resource_type="test_automation_run", resource_id=run_id, resource_name=filename,
            details={"input_type": input_type},
        )
        log.info("test_automation run created run_id=%s type=%s (async stories)", run_id, input_type)
        return http.ok({"run_id": run_id, "status": "generating_stories"})

    run_id = store.create_run(
        tenant_id=ctx.tenant_id, user_id=ctx.user_id, file_name=filename,
        input_type=input_type, input_items=input_items, status="needs_review",
        run_name=run_name, test_phase=test_phase, module=module, description=description,
    )
    audit_events.write(
        ctx, "test_automation.run_created", ip=ip,
        resource_type="test_automation_run", resource_id=run_id, resource_name=filename,
        details={"input_type": input_type},
    )
    log.info("test_automation run created run_id=%s type=%s (sync needs_review)", run_id, input_type)
    run = store.get_run(run_id=run_id, tenant_id=ctx.tenant_id)
    return http.ok(run)


# ── List / poll (sync) ────────────────────────────────────────────────────────

def _list_runs(event):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin", "project_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    # Default: only the calling consultant's own runs (unchanged). ?all=true&tenant_id=... is
    # for admins picking a "nightly regression suite" run for an environment — they need to
    # see every completed run for an arbitrary client tenant, not just their own runs in
    # whichever tenant their JWT/X-Client-Tenant currently resolves to. Takes tenant_id
    # explicitly from the query, same pattern admin_tenant_credentials already uses, rather
    # than requiring the admin to have "switched into" that client tenant first.
    qs = event.get("queryStringParameters") or {}
    if (qs.get("all") or "").lower() == "true":
        if ctx.role not in ("super_admin", "project_admin"):
            return http.forbidden("only admins can list all runs for a tenant")
        target_tenant_id = (qs.get("tenant_id") or "").strip().lower()
        if not target_tenant_id:
            return http.bad_request("tenant_id query parameter is required with all=true")
        runs = store.list_runs_for_tenant(tenant_id=target_tenant_id)
    else:
        runs = store.list_runs(tenant_id=ctx.tenant_id, user_id=ctx.user_id)
    return http.ok({"runs": runs})


def _get_run(event):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin", "project_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    run_id = (event.get("pathParameters") or {}).get("run_id", "")
    if not run_id:
        return http.bad_request("run_id path parameter is required")

    # Admins may pass an explicit tenant_id to drill into a specific client's run from the
    # cross-client Test Executions rollup — same _resolve_tenant_id helper _list_environments/
    # _list_runs already use; defaults to ctx.tenant_id, unchanged for every other caller.
    tenant_id = _resolve_tenant_id(ctx, event, from_query=True)

    run = store.get_run(run_id=run_id, tenant_id=tenant_id)
    if not run:
        return http.bad_request("run not found")

    scenarios = store.list_scenarios(run_id=run_id, tenant_id=tenant_id)
    steps = store.list_steps(run_id=run_id, tenant_id=tenant_id)
    labeled = _label_for_display(run, scenarios, steps)

    return http.ok({**run, "scenarios": labeled["scenarios"], "steps": labeled["steps"]})


# ── Reports dashboard (sync — aggregate rollup across executed runs) ─────────

def _reports_dashboard(event):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin", "project_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    qs = event.get("queryStringParameters") or {}
    environment_id = (qs.get("environment_id") or "").strip() or None
    test_phase = (qs.get("test_phase") or "").strip() or None
    module = (qs.get("module") or "").strip() or None
    since = (qs.get("since") or "").strip() or None
    limit = int(qs.get("limit") or 100)

    # all=true with no tenant_id: super-admin-only cross-client rollup (AdminPanel's Test
    # Executions tab). Any other call — including all=true WITH a tenant_id, or no `all` at
    # all — stays the existing single-client behavior via _resolve_tenant_id.
    all_clients = (qs.get("all") or "").lower() == "true" and not (qs.get("tenant_id") or "").strip()
    if all_clients:
        if ctx.role != "super_admin":
            return http.forbidden("only super_admin can view test executions across all clients")
        runs = store.list_executed_runs_with_counts_all_tenants(
            environment_id=environment_id, test_phase=test_phase, module=module,
            since=since, limit=limit,
        )
    else:
        tenant_id = _resolve_tenant_id(ctx, event, from_query=True)
        runs = store.list_executed_runs_with_counts(
            tenant_id=tenant_id, environment_id=environment_id, test_phase=test_phase,
            module=module, since=since, limit=limit,
        )

    summary = {"total_runs": len(runs), "total_scenarios": 0, "passed": 0, "failed": 0, "error": 0, "pending": 0}
    for r in runs:
        c = r["scenario_counts"]
        summary["total_scenarios"] += c["total"]
        summary["passed"] += c["passed"]
        summary["failed"] += c["failed"]
        summary["error"] += c["error"]
        summary["pending"] += c["pending"]
    executed = summary["passed"] + summary["failed"] + summary["error"]
    summary["pass_rate"] = round(summary["passed"] / executed * 100, 1) if executed else None

    return http.ok({"runs": runs, "summary": summary})


# ── Trigger scenarios (async) ────────────────────────────────────────────────

def _trigger_scenarios(event):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    run_id = (event.get("pathParameters") or {}).get("run_id", "")
    if not run_id:
        return http.bad_request("run_id path parameter is required")

    run = store.get_run(run_id=run_id, tenant_id=ctx.tenant_id)
    if not run:
        return http.bad_request("run not found")

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    edited_items = body.get("input_items")
    store.update_run(
        run_id=run_id, tenant_id=ctx.tenant_id, status="generating_scenarios",
        input_items=edited_items if edited_items is not None else None,
    )

    ip = audit_events.get_ip(event)
    queue.enqueue_job("test_automation", {
        "stage": "scenarios", "run_id": run_id, "tenant_id": ctx.tenant_id,
        "user_id": ctx.user_id, "role": ctx.role, "email": ctx.email, "ip": ip,
    })
    audit_events.write(
        ctx, "test_automation.scenarios_triggered", ip=ip,
        resource_type="test_automation_run", resource_id=run_id, resource_name=run["file_name"],
    )
    log.info("test_automation scenarios triggered run_id=%s", run_id)
    return http.ok({"run_id": run_id, "status": "generating_scenarios"})


# ── Trigger steps (async) ─────────────────────────────────────────────────────

def _trigger_steps(event):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    run_id = (event.get("pathParameters") or {}).get("run_id", "")
    if not run_id:
        return http.bad_request("run_id path parameter is required")

    run = store.get_run(run_id=run_id, tenant_id=ctx.tenant_id)
    if not run:
        return http.bad_request("run not found")

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    edited_scenarios = body.get("scenarios")
    if edited_scenarios:
        try:
            store.replace_scenarios(run_id=run_id, tenant_id=ctx.tenant_id, scenarios=edited_scenarios)
        except (KeyError, PermissionError) as exc:
            return http.bad_request(f"invalid scenarios payload: {exc}")

    store.update_run(run_id=run_id, tenant_id=ctx.tenant_id, status="generating_steps")

    ip = audit_events.get_ip(event)
    queue.enqueue_job("test_automation", {
        "stage": "steps", "run_id": run_id, "tenant_id": ctx.tenant_id,
        "user_id": ctx.user_id, "role": ctx.role, "email": ctx.email, "ip": ip,
    })
    audit_events.write(
        ctx, "test_automation.steps_triggered", ip=ip,
        resource_type="test_automation_run", resource_id=run_id, resource_name=run["file_name"],
    )
    log.info("test_automation steps triggered run_id=%s", run_id)
    return http.ok({"run_id": run_id, "status": "generating_steps"})


# ── Trigger execution (async — Container Apps Job, not this Function App) ────

def queue_run_execution(*, ctx: TenantContext, run_id: str, environment_id: str, ip: str, source: str) -> dict:
    """Validates a run against one environment and enqueues every scenario for execution.
    Shared by the interactive execute route and the nightly timer. Returns
    {"error": str | None, "scenario_count": int}."""
    environment = store.get_environment(environment_id=environment_id, tenant_id=ctx.tenant_id)
    if not environment or not environment["is_active"]:
        return {"error": "environment not found for this client", "scenario_count": 0}

    run = store.get_run(run_id=run_id, tenant_id=ctx.tenant_id)
    if not run:
        return {"error": "run not found", "scenario_count": 0}
    if run["status"] not in ("steps_ready", "completed"):
        return {"error": f"run has no generated steps yet (status: {run['status']})", "scenario_count": 0}
    if run.get("execution_status") in ("pending", "running"):
        return {"error": "run is already executing", "scenario_count": 0}

    if keyvault.get_tenant_workday_credential(ctx.tenant_id, environment_id) is None:
        return {"error": "no Workday credential configured for this environment — ask an admin to add one", "scenario_count": 0}

    scenarios = store.list_scenarios(run_id=run_id, tenant_id=ctx.tenant_id)
    if not scenarios:
        return {"error": "run has no scenarios to execute", "scenario_count": 0}

    for sc in scenarios:
        store.update_scenario_execution(
            scenario_id=sc["scenario_id"], tenant_id=ctx.tenant_id, execution_status="pending",
            queued=True,
        )
        queue.enqueue_execution({
            "run_id": run_id, "scenario_id": sc["scenario_id"], "tenant_id": ctx.tenant_id,
            "environment_id": environment_id,
        })
    store.update_run_execution(
        run_id=run_id, tenant_id=ctx.tenant_id, execution_status="pending", environment_id=environment_id,
    )

    audit_events.write(
        ctx, "test_automation.execute_triggered", ip=ip,
        resource_type="test_automation_run", resource_id=run_id, resource_name=run["file_name"],
        details={"scenario_count": len(scenarios), "environment_id": environment_id, "source": source},
    )
    log.info(
        "test_automation execute triggered run_id=%s environment_id=%s scenarios=%d source=%s",
        run_id, environment_id, len(scenarios), source,
    )
    return {"error": None, "scenario_count": len(scenarios)}


def _trigger_execute(event):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    run_id = (event.get("pathParameters") or {}).get("run_id", "")
    if not run_id:
        return http.bad_request("run_id path parameter is required")

    body = _json_body(event)
    environment_id = (body.get("environment_id") or "").strip()
    if not environment_id:
        return http.bad_request("environment_id is required")

    result = queue_run_execution(
        ctx=ctx, run_id=run_id, environment_id=environment_id,
        ip=audit_events.get_ip(event), source="manual",
    )
    if result["error"]:
        return http.bad_request(result["error"])
    return http.ok({"run_id": run_id, "execution_status": "pending", "scenario_count": result["scenario_count"]})


def run_nightly_executions() -> None:
    """Timer-triggered (function_app.py): runs each environment's chosen regression run.
    Runs across every tenant with no caller, so each environment gets a synthetic
    system context scoped to its own tenant — same pattern as reconcile_stale_executions.
    Environments that can't run tonight (no credential, run not ready, still executing
    from last night) are logged and skipped, never allowed to block the rest."""
    environments = store.list_nightly_environments_all_tenants()
    log.info("test_automation nightly: %d environment(s) scheduled", len(environments))
    for env in environments:
        ctx = TenantContext(tenant_id=env["tenant_id"], user_id="system-nightly", role="super_admin", email="")
        result = queue_run_execution(
            ctx=ctx, run_id=env["nightly_run_id"], environment_id=env["environment_id"],
            ip="internal", source="nightly",
        )
        if result["error"]:
            log.warning(
                "test_automation nightly skipped environment_id=%s tenant_id=%s run_id=%s: %s",
                env["environment_id"], env["tenant_id"], env["nightly_run_id"], result["error"],
            )


# ── Internal routes (execution container only — shared-secret auth, no JWT) ──

def _require_execution_key(event) -> str | None:
    """Returns an error message if the shared execution-worker key is missing/wrong, else None.
    No tenant_from_event() here — the caller is Lumina's own Container Apps Job, not a browser
    with a real Entra JWT; see module docstring for the trust model."""
    expected = os.environ.get("EXECUTION_WORKER_KEY", "")
    provided = (event.get("headers") or {}).get("x-execution-key", "")
    if not expected or provided != expected:
        return "invalid or missing execution worker key"
    return None


def _internal_dispatch(raw_path: str, method: str, event: dict):
    auth_error = _require_execution_key(event)
    if auth_error:
        return http.forbidden(auth_error)

    if "/credentials" in raw_path and method == "POST":
        return _internal_credentials(event)
    if "/screenshot-upload-url" in raw_path and method == "POST":
        return _internal_screenshot_upload_url(event)
    if "/scenarios/" in raw_path and "/steps/" in raw_path and method == "PATCH":
        return _internal_patch_step(event)
    if "/scenarios/" in raw_path and method == "GET":
        return _internal_get_scenario(event)
    if "/scenarios/" in raw_path and method == "PATCH":
        return _internal_patch_scenario(event)
    return http.bad_request("unknown internal route")


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
        return True
    except (ValueError, TypeError, AttributeError):
        return False


def _internal_get_scenario(event):
    path_params = event.get("pathParameters") or {}
    qs = event.get("queryStringParameters") or {}
    scenario_id = path_params.get("scenario_id", "")
    tenant_id = (qs.get("tenant_id") or "").strip().lower()
    if not scenario_id or not tenant_id:
        return http.bad_request("scenario_id and tenant_id are required")
    if not _is_uuid(scenario_id):
        return http.bad_request("scenario not found")

    scenario = store.get_scenario(scenario_id=scenario_id, tenant_id=tenant_id)
    if not scenario:
        return http.bad_request("scenario not found")
    steps = store.list_steps_for_scenario(scenario_id=scenario_id, tenant_id=tenant_id)
    return http.ok({"scenario": scenario, "steps": steps})


def _internal_patch_scenario(event):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    scenario_id = (event.get("pathParameters") or {}).get("scenario_id", "")
    if not _is_uuid(scenario_id):
        return http.bad_request("scenario not found")
    tenant_id = (body.get("tenant_id") or "").strip().lower()
    execution_status = body.get("execution_status")
    if not scenario_id or not tenant_id or execution_status not in _EXECUTION_STATUSES:
        return http.bad_request("scenario_id, tenant_id, and a valid execution_status are required")

    store.update_scenario_execution(
        scenario_id=scenario_id, tenant_id=tenant_id, execution_status=execution_status,
        started=bool(body.get("started")), completed=bool(body.get("completed")),
    )

    if body.get("completed"):
        _maybe_rollup_run_execution(scenario_id=scenario_id, tenant_id=tenant_id)

    return http.ok({"scenario_id": scenario_id, "execution_status": execution_status})


def _maybe_rollup_run_execution(*, scenario_id: str, tenant_id: str) -> None:
    """Once every scenario in a run reaches a terminal execution state, roll
    the run's own execution_status up from its scenarios — the container only
    ever reports its own scenario, so this aggregation happens here."""
    scenario = store.get_scenario(scenario_id=scenario_id, tenant_id=tenant_id)
    if not scenario:
        return
    run_id = scenario["run_id"]
    siblings = store.list_scenarios(run_id=run_id, tenant_id=tenant_id)
    terminal = {"passed", "failed", "error"}
    if not all(s["execution_status"] in terminal for s in siblings):
        return
    if any(s["execution_status"] == "error" for s in siblings):
        rollup = "error"
    elif any(s["execution_status"] == "failed" for s in siblings):
        rollup = "failed"
    else:
        rollup = "passed"
    store.update_run_execution(run_id=run_id, tenant_id=tenant_id, execution_status=rollup)
    log.info("test_automation execution rollup run_id=%s -> %s", run_id, rollup)


# ── Stale-execution reconciliation (timer-triggered, function_app.py) ────────

def reconcile_stale_executions() -> None:
    """Sweeps for scenarios whose execution never called back in time — either the
    Container Apps Job that was running it got killed mid-scenario (confirmed live:
    executions with status "Stopped" in Container Apps Job history) or its queue
    message was never picked up at all. Without this, such a scenario — and its run —
    stays 'pending'/'running' forever with no way to recover short of a manual DB fix.
    See store.list_stale_executing_scenarios's docstring for the staleness rule.

    Runs across every tenant — a platform-maintenance job, not a per-request handler,
    so there's no caller TenantContext; each stale scenario gets its own synthetic one
    (mirrors _ctx_from_payload's pattern for queue workers below) purely so
    audit_events.write() has one, scoped to that scenario's own tenant."""
    stale = store.list_stale_executing_scenarios()
    if not stale:
        return
    log.warning("test_automation reconciliation: %d stale scenario(s) found", len(stale))

    for item in stale:
        scenario_id, run_id, tenant_id = item["scenario_id"], item["run_id"], item["tenant_id"]

        steps = store.list_steps_for_scenario(scenario_id=scenario_id, tenant_id=tenant_id)
        for st in steps:
            if st["execution_status"] in ("not_executed", "pending", "running"):
                store.update_step_execution(
                    step_id=st["step_id"], tenant_id=tenant_id, execution_status="error",
                    execution_result={"note": "execution timed out or was interrupted — no completion signal received"},
                )

        store.update_scenario_execution(
            scenario_id=scenario_id, tenant_id=tenant_id, execution_status="error", completed=True,
        )
        _maybe_rollup_run_execution(scenario_id=scenario_id, tenant_id=tenant_id)

        ctx = TenantContext(tenant_id=tenant_id, user_id="system-reconciler", role="super_admin", email="")
        audit_events.write(
            ctx, "test_automation.execution_reconciled", ip="internal",
            resource_type="test_automation_scenario", resource_id=scenario_id, resource_name=run_id,
            details={"stale_since": item.get("stale_since")},
        )
        log.warning(
            "test_automation reconciled stale scenario_id=%s run_id=%s tenant_id=%s stale_since=%s",
            scenario_id, run_id, tenant_id, item.get("stale_since"),
        )


def _internal_patch_step(event):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    step_id = (event.get("pathParameters") or {}).get("step_id", "")
    if not _is_uuid(step_id):
        return http.bad_request("step not found")
    tenant_id = (body.get("tenant_id") or "").strip().lower()
    execution_status = body.get("execution_status")
    if not step_id or not tenant_id or execution_status not in _EXECUTION_STATUSES:
        return http.bad_request("step_id, tenant_id, and a valid execution_status are required")

    store.update_step_execution(
        step_id=step_id, tenant_id=tenant_id, execution_status=execution_status,
        execution_result=body.get("execution_result"),
    )
    return http.ok({"step_id": step_id, "execution_status": execution_status})


def _internal_credentials(event):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    tenant_id = (body.get("tenant_id") or "").strip().lower()
    environment_id = (body.get("environment_id") or "").strip()
    if not tenant_id or not environment_id:
        return http.bad_request("tenant_id and environment_id are required")

    cred = keyvault.get_tenant_workday_credential(tenant_id, environment_id)
    if not cred:
        return http.bad_request("no Workday credential configured for this environment")
    return http.ok(cred)


def _internal_screenshot_upload_url(event):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    tenant_id = (body.get("tenant_id") or "").strip().lower()
    run_id = body.get("run_id") or ""
    scenario_id = body.get("scenario_id") or ""
    filename = body.get("filename") or "step.png"
    if not tenant_id or not run_id or not scenario_id:
        return http.bad_request("tenant_id, run_id, and scenario_id are required")
    # Same unsafe-part check as TenantContext.s3_key() — no TenantContext exists on this
    # shared-secret-authenticated internal path, but the key parts still come from a request
    # body and deserve the same path-traversal guard.
    for part in (tenant_id, run_id, scenario_id, filename):
        if not part or ".." in part or part.startswith("/"):
            return http.bad_request(f"unsafe key part: {part!r}")

    key = f"tenants/{tenant_id}/test-automation/{run_id}/execution/{scenario_id}/{filename}"
    sas_url = blob.generate_upload_sas(key, "image/png", expires_in=_SAS_EXPIRES_IN)
    return http.ok({"url": sas_url, "key": key})


# ── Export (sync) ─────────────────────────────────────────────────────────────

def _export(event):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    run_id = (event.get("pathParameters") or {}).get("run_id", "")
    if not run_id:
        return http.bad_request("run_id path parameter is required")

    run = store.get_run(run_id=run_id, tenant_id=ctx.tenant_id)
    if not run:
        return http.bad_request("run not found")
    if run["status"] not in ("steps_ready", "completed"):
        return http.bad_request(f"run is not ready for export (status: {run['status']})")

    scenarios = store.list_scenarios(run_id=run_id, tenant_id=ctx.tenant_id)
    steps = store.list_steps(run_id=run_id, tenant_id=ctx.tenant_id)
    labeled = _label_for_display(run, scenarios, steps)

    try:
        xlsx_bytes = excel_writer.build_output_workbook(
            input_type=run["input_type"],
            sheet1_items=labeled["sheet1_items"],
            scenarios=labeled["scenarios"],
            steps=labeled["steps"],
        )
    except Exception as exc:
        log.exception("test_automation export failed run_id=%s: %s", run_id, exc)
        return http.server_error(f"failed to build export: {exc}")

    key = ctx.s3_key("test-automation", run_id, "results.xlsx")
    blob.put_object(key, xlsx_bytes, content_type=_XLSX_CONTENT_TYPE)
    store.update_run(run_id=run_id, tenant_id=ctx.tenant_id, output_blob_key=key, status="completed")

    download_url = blob.generate_download_sas(key, expires_in=_SAS_EXPIRES_IN)

    audit_events.write(
        ctx, "test_automation.exported", ip=audit_events.get_ip(event),
        resource_type="test_automation_run", resource_id=run_id, resource_name=run["file_name"],
        details={"scenarios": len(scenarios), "steps": len(steps)},
    )
    log.info("test_automation exported run_id=%s scenarios=%d steps=%d", run_id, len(scenarios), len(steps))
    return http.ok({"run_id": run_id, "status": "completed", "download_url": download_url})


def _export_results(event):
    """Exports Workday-execution outcomes (pass/fail/error per scenario+step,
    with notes), as opposed to _export() above which exports the generated
    test *script* itself. Independent of run.status/output_blob_key — this
    only cares about execution_status, and regenerates fresh on every call
    rather than persisting its own blob key (see plan: additive-only, no
    schema migration)."""
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin", "project_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    run_id = (event.get("pathParameters") or {}).get("run_id", "")
    if not run_id:
        return http.bad_request("run_id path parameter is required")

    # Same explicit-tenant_id admin drill-down as _get_run — see that function's comment.
    tenant_id = _resolve_tenant_id(ctx, event, from_query=True)

    run = store.get_run(run_id=run_id, tenant_id=tenant_id)
    if not run:
        return http.bad_request("run not found")
    if run["execution_status"] == "not_executed":
        return http.bad_request("run has not been executed yet")

    scenarios = store.list_scenarios(run_id=run_id, tenant_id=tenant_id)
    steps = store.list_steps(run_id=run_id, tenant_id=tenant_id)
    labeled = _label_for_display(run, scenarios, steps)

    try:
        xlsx_bytes = excel_writer.build_execution_report_workbook(
            run=run, scenarios=labeled["scenarios"], steps=labeled["steps"],
        )
    except Exception as exc:
        log.exception("test_automation export-results failed run_id=%s: %s", run_id, exc)
        return http.server_error(f"failed to build execution report: {exc}")

    # Not ctx.s3_key() — that always uses the caller's OWN tenant_id (the JWT claim), which
    # would misfile this under the admin's tenant instead of the run's actual client when
    # tenant_id was resolved explicitly above. Same manual guard ctx.s3_key() itself applies.
    for part in (tenant_id, run_id):
        if not part or ".." in part or part.startswith("/"):
            return http.bad_request(f"unsafe key part: {part!r}")
    key = f"tenants/{tenant_id}/test-automation/{run_id}/execution-report.xlsx"
    blob.put_object(key, xlsx_bytes, content_type=_XLSX_CONTENT_TYPE)
    download_url = blob.generate_download_sas(key, expires_in=_SAS_EXPIRES_IN)

    audit_events.write(
        ctx, "test_automation.results_exported", ip=audit_events.get_ip(event),
        resource_type="test_automation_run", resource_id=run_id, resource_name=run["file_name"],
        details={"scenarios": len(scenarios), "steps": len(steps)},
    )
    log.info("test_automation results exported run_id=%s scenarios=%d steps=%d", run_id, len(scenarios), len(steps))
    return http.ok({"run_id": run_id, "download_url": download_url})


def _download(event):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    run_id = (event.get("pathParameters") or {}).get("run_id", "")
    run = store.get_run(run_id=run_id, tenant_id=ctx.tenant_id) if run_id else None
    if not run:
        return http.bad_request("run not found")
    if not run["output_blob_key"]:
        return http.bad_request("no export available for this run yet")

    download_url = blob.generate_download_sas(run["output_blob_key"], expires_in=_SAS_EXPIRES_IN)
    return http.ok({"download_url": download_url})


def _screenshot_url(event):
    """Real-user JWT route (not internal) — lets the review UI open an execution
    screenshot the container uploaded via /internal/screenshot-upload-url."""
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin", "project_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    run_id = (event.get("pathParameters") or {}).get("run_id", "")
    qs = event.get("queryStringParameters") or {}
    key = qs.get("key") or ""
    # Same explicit-tenant_id admin drill-down as _get_run — see that function's comment.
    tenant_id = _resolve_tenant_id(ctx, event, from_query=True)
    expected_prefix = f"tenants/{tenant_id}/test-automation/{run_id}/execution/"
    if not key.startswith(expected_prefix):
        return http.bad_request("invalid or unauthorized screenshot key")

    url = blob.generate_download_sas(key, expires_in=_SAS_EXPIRES_IN)
    return http.ok({"url": url})


# ── Display-label helper (shared by poll + export) ───────────────────────────

def _label_for_display(run: dict, scenarios: list[dict], steps: list[dict]) -> dict:
    """
    Compute human-readable IDs from Postgres insertion order / step_number —
    never trust the model's own "US-XXX"/"TS-XXX" guesses (see agents.py's
    module docstring), since concurrent/independent generation calls have no
    way to agree on non-overlapping numbering.
    """
    input_type = run["input_type"]
    items = run["input_items"] or []

    if input_type in ("requirements", "user_stories"):
        sheet1_items = [{**it, "story_label": f"US-{i + 1:03d}"} for i, it in enumerate(items)]
    elif input_type == "bpw":
        sheet1_items = (items or {}).get("bpw_steps", [])
    else:  # config_workbook — item_id ("CFG-001") is already stable/display-ready
        sheet1_items = items

    scenario_label_by_id: dict[str, str] = {}
    labeled_scenarios = []
    for i, sc in enumerate(scenarios):
        label = f"TS-{i + 1:03d}"
        scenario_label_by_id[sc["scenario_id"]] = label
        labeled_scenarios.append({**sc, "scenario_label": label})

    labeled_steps = []
    for st in steps:
        scenario_label = scenario_label_by_id.get(st["scenario_id"], "TS-???")
        labeled_steps.append({
            **st,
            "scenario_label": scenario_label,
            "step_label": f"{scenario_label}-{st['step_number']:03d}",
        })

    return {"sheet1_items": sheet1_items, "scenarios": labeled_scenarios, "steps": labeled_steps}


# ── Worker (queue-triggered, dispatched by job_type="test_automation") ──────

def worker_handler(payload: dict) -> None:
    stage = payload.get("stage")
    if stage == "stories":
        _worker_stories(payload)
    elif stage == "scenarios":
        _worker_scenarios(payload)
    elif stage == "steps":
        _worker_steps(payload)
    else:
        log.error("test_automation worker: unknown stage %r", stage)


def _ctx_from_payload(payload: dict) -> TenantContext:
    return TenantContext(
        tenant_id=payload["tenant_id"],
        user_id=payload.get("user_id", ""),
        role=payload.get("role", "consultant"),
        email=payload.get("email", ""),
    )


def _worker_stories(payload: dict) -> None:
    run_id, tenant_id = payload["run_id"], payload["tenant_id"]
    ctx = _ctx_from_payload(payload)
    ip = payload.get("ip", "unknown")

    try:
        run = store.get_run(run_id=run_id, tenant_id=tenant_id)
        if not run:
            raise ValueError(f"run {run_id} not found")

        stories = [agents.generate_user_story(req) for req in run["input_items"]]

        store.update_run(run_id=run_id, tenant_id=tenant_id, input_items=stories, status="needs_review")
        audit_events.write(
            ctx, "ai.test_automation_stories_generated", ip=ip,
            resource_type="test_automation_run", resource_id=run_id, resource_name=run["file_name"],
            details={"stories": len(stories)},
        )
        log.info("test_automation stories worker done run_id=%s count=%d", run_id, len(stories))
    except Exception as exc:
        log.error("test_automation stories worker error run_id=%s: %s", run_id, exc, exc_info=True)
        store.update_run(run_id=run_id, tenant_id=tenant_id, status="failed", error=str(exc))


def _worker_scenarios(payload: dict) -> None:
    run_id, tenant_id = payload["run_id"], payload["tenant_id"]
    ctx = _ctx_from_payload(payload)
    ip = payload.get("ip", "unknown")

    try:
        run = store.get_run(run_id=run_id, tenant_id=tenant_id)
        if not run:
            raise ValueError(f"run {run_id} not found")

        input_type = run["input_type"]
        items = run["input_items"] or []
        all_scenarios: list[dict] = []

        if input_type in ("requirements", "user_stories"):
            for i, story in enumerate(items):
                labeled_story = {**story, "story_id": f"US-{i + 1:03d}"}
                all_scenarios.extend(agents.generate_test_scenarios(labeled_story))
        elif input_type == "config_workbook":
            for item in items:
                all_scenarios.extend(agents.generate_config_scenarios(item))
        elif input_type == "bpw":
            bpw_steps = items.get("bpw_steps", [])
            bpw_processes = items.get("bpw_processes", [])
            for process in bpw_processes:
                proc_steps = [s for s in bpw_steps if s["process_name"] == process["process_name"]]
                all_scenarios.extend(agents.generate_bpw_scenarios(process, proc_steps))
        else:
            raise ValueError(f"unknown input_type {input_type!r}")

        store.replace_scenarios(run_id=run_id, tenant_id=tenant_id, scenarios=all_scenarios)
        store.update_run(run_id=run_id, tenant_id=tenant_id, status="scenarios_ready")
        audit_events.write(
            ctx, "ai.test_automation_scenarios_generated", ip=ip,
            resource_type="test_automation_run", resource_id=run_id, resource_name=run["file_name"],
            details={"scenarios": len(all_scenarios)},
        )
        log.info("test_automation scenarios worker done run_id=%s count=%d", run_id, len(all_scenarios))
    except Exception as exc:
        log.error("test_automation scenarios worker error run_id=%s: %s", run_id, exc, exc_info=True)
        store.update_run(run_id=run_id, tenant_id=tenant_id, status="failed", error=str(exc))


def _worker_steps(payload: dict) -> None:
    run_id, tenant_id = payload["run_id"], payload["tenant_id"]
    ctx = _ctx_from_payload(payload)
    ip = payload.get("ip", "unknown")

    try:
        run = store.get_run(run_id=run_id, tenant_id=tenant_id)
        if not run:
            raise ValueError(f"run {run_id} not found")

        scenarios = store.list_scenarios(run_id=run_id, tenant_id=tenant_id)
        all_steps: list[dict] = []
        for sc in scenarios:
            all_steps.extend(agents.generate_test_steps(sc))

        store.replace_steps(run_id=run_id, tenant_id=tenant_id, steps=all_steps)
        store.update_run(run_id=run_id, tenant_id=tenant_id, status="steps_ready")
        audit_events.write(
            ctx, "ai.test_automation_steps_generated", ip=ip,
            resource_type="test_automation_run", resource_id=run_id, resource_name=run["file_name"],
            details={"steps": len(all_steps)},
        )
        log.info("test_automation steps worker done run_id=%s count=%d", run_id, len(all_steps))
    except Exception as exc:
        log.error("test_automation steps worker error run_id=%s: %s", run_id, exc, exc_info=True)
        store.update_run(run_id=run_id, tenant_id=tenant_id, status="failed", error=str(exc))
