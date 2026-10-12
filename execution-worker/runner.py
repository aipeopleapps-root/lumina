"""
Workday-execution runner — Playwright-driving Container Apps Job entrypoint.

One container execution = one scenario (see bicep/modules/execution.bicep's
eventTriggerConfig: parallelism=1, scale.maxExecutions=N concurrent
executions — concurrency comes from running multiple independent executions,
not multiple replicas cooperating on one). Talks to the Function App's
/test-automation/internal/... routes (functions/test_automation/handler.py)
over plain HTTPS, authenticated with a function key + a shared secret header
— never touches Postgres/Cosmos/Key Vault directly, see that handler's
module docstring for the full trust model.

Best-effort step execution — see execute_step()'s own docstring for exactly
what that means. This is the explicitly-scoped MVP: a screenshot and a
best-effort completion signal per step, not an autonomous, guaranteed-correct
pass/fail verdict (the generated `action`/`expected_result` text is natural
language, not a structured assertion — there's no reliable selector to
assert against). A Claude-vision-assisted executor is a plausible follow-on,
not this phase.
"""

from __future__ import annotations

import faulthandler
import json
import logging
import os
import re
import sys
import time

import requests
from azure.identity import ManagedIdentityCredential
from azure.storage.queue import QueueClient, TextBase64DecodePolicy, TextBase64EncodePolicy
from playwright.sync_api import Page, sync_playwright

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("workday-executor")

# Four prior debugging passes all showed the same thing: a container that's genuinely
# "Running" per Azure, yet produces zero visible log output via `az containerapp job logs
# show` even for a build proven (via local `docker run`) to log instantly — meaning we can't
# trust that command to tell us where execution actually is. This dumps the real Python
# thread stack to stdout every 20s regardless, so if something blocks, the exact blocked
# line is on record rather than guessed at. Was unconditionally on in every production
# execution; gated behind DEBUG_DIAGNOSTICS now that the hang investigation's done — leave
# it off normally, flip it on again if a similar hang resurfaces.
DEBUG_DIAGNOSTICS = os.environ.get("DEBUG_DIAGNOSTICS", "").lower() in ("1", "true", "yes")

if DEBUG_DIAGNOSTICS:
    faulthandler.enable()
    faulthandler.dump_traceback_later(20, repeat=True, exit=False, file=sys.stdout)

FUNCTION_APP_URL = os.environ["FUNCTION_APP_URL"].rstrip("/")
EXECUTION_WORKER_KEY = os.environ["EXECUTION_WORKER_KEY"]
FUNCTION_KEY = os.environ["EXECUTION_WORKER_FUNCTION_KEY"]
QUEUE_URL = os.environ["AZURE_STORAGE_QUEUE_URL"]
QUEUE_NAME = os.environ.get("EXECUTION_QUEUE_NAME", "execution")

_HEADERS = {
    "x-functions-key": FUNCTION_KEY,
    "x-execution-key": EXECUTION_WORKER_KEY,
    "Content-Type": "application/json",
}


# ── Function API client ──────────────────────────────────────────────────────

_RETRYABLE_STATUS = {429, 500, 502, 503, 504}
_MAX_ATTEMPTS = 4
_BACKOFF_BASE_SECONDS = 1.5


def _request_with_retry(method: str, path: str, **kwargs) -> dict:
    """Bounded retry with linear backoff on connection errors and 429/5xx
    responses. Without this, a single transient blip on ANY internal call —
    especially a scenario's own final completion PATCH in run_scenario()'s
    last line — permanently stranded that scenario in pending/running with
    no way to recover short of a manual DB fix (confirmed live: this is
    exactly what happened to one scenario in a real run). The reconciliation
    sweep (functions/test_automation/handler.py's reconcile_stale_executions,
    a 40-minutes-later backstop) still exists for the case a container gets
    killed outright — retrying here just means far fewer scenarios ever need
    that backstop in the first place."""
    last_exc: Exception | None = None
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            r = requests.request(method, f"{FUNCTION_APP_URL}{path}", headers=_HEADERS, timeout=30, **kwargs)
        except requests.exceptions.RequestException as exc:
            last_exc = exc
            if attempt < _MAX_ATTEMPTS:
                log.warning("%s %s failed (%s) — retrying (%d/%d)", method, path, exc, attempt, _MAX_ATTEMPTS)
                time.sleep(_BACKOFF_BASE_SECONDS * attempt)
                continue
            raise
        if r.status_code in _RETRYABLE_STATUS and attempt < _MAX_ATTEMPTS:
            log.warning("%s %s -> %d — retrying (%d/%d)", method, path, r.status_code, attempt, _MAX_ATTEMPTS)
            time.sleep(_BACKOFF_BASE_SECONDS * attempt)
            continue
        r.raise_for_status()
        return r.json()
    raise last_exc or RuntimeError(f"{method} {path} failed after {_MAX_ATTEMPTS} attempts")


def api_get(path: str, params: dict | None = None) -> dict:
    return _request_with_retry("GET", path, params=params)


def api_post(path: str, body: dict) -> dict:
    return _request_with_retry("POST", path, json=body)


def api_patch(path: str, body: dict) -> dict:
    return _request_with_retry("PATCH", path, json=body)


# ── Queue ─────────────────────────────────────────────────────────────────────

def fetch_one_message() -> dict | None:
    """
    Dequeues+deletes exactly one message, or returns None if the queue is
    momentarily empty — a normal race under queue-scaled concurrency (KEDA
    may start an execution for a message another concurrent execution just
    claimed). visibility_timeout matches the ACA Job's replicaTimeout (30
    min) so a crashed execution's message becomes reprocessable rather than
    stuck invisible.
    """
    # ManagedIdentityCredential directly, not DefaultAzureCredential — the job's identity is the
    # only mechanism that applies here, and DefaultAzureCredential's chain probes several other
    # credential sources first (Environment, WorkloadIdentity, SharedTokenCache, CLI, PowerShell,
    # ...) before reaching it; any one of those behaving unexpectedly slowly inside this specific
    # Container Apps Jobs runtime is a needless variable to rule out.
    #
    # client_id passed explicitly (user-assigned identity, bicep/modules/execution.bicep) rather
    # than left implicit (system-assigned, as this was originally) — with a system-assigned
    # identity and no client_id, ManagedIdentityCredential must ask IMDS which identity it is
    # before it can even request a token; that discovery round-trip is one of the two remaining,
    # untested hypotheses for the multi-pass container hang (the other being SAS-based queue auth,
    # bypassing managed identity for the queue call entirely).
    client_id = os.environ.get("AZURE_CLIENT_ID")
    if DEBUG_DIAGNOSTICS:
        log.info("fetch_one_message: creating ManagedIdentityCredential client_id=%s", client_id)
    cred = ManagedIdentityCredential(client_id=client_id)
    if DEBUG_DIAGNOSTICS:
        log.info("fetch_one_message: credential created, requesting token to force resolution")
    try:
        token = cred.get_token("https://storage.azure.com/.default")
        if DEBUG_DIAGNOSTICS:
            log.info("fetch_one_message: got token, expires_on=%s", token.expires_on)
    except Exception:
        log.exception("fetch_one_message: get_token failed")
        raise
    if DEBUG_DIAGNOSTICS:
        log.info("fetch_one_message: creating QueueClient account_url=%s queue=%s", QUEUE_URL, QUEUE_NAME)
    client = QueueClient(
        account_url=QUEUE_URL, queue_name=QUEUE_NAME,
        credential=cred,
        message_decode_policy=TextBase64DecodePolicy(),
        message_encode_policy=TextBase64EncodePolicy(),
    )
    if DEBUG_DIAGNOSTICS:
        log.info("fetch_one_message: calling receive_messages")
    for msg in client.receive_messages(max_messages=1, visibility_timeout=1800):
        log.info("fetch_one_message: got a message id=%s", msg.id)
        payload = json.loads(msg.content)
        client.delete_message(msg)
        if DEBUG_DIAGNOSTICS:
            log.info("fetch_one_message: deleted message id=%s", msg.id)
        return payload
    log.info("fetch_one_message: no message available")
    return None


# ── Workday login (deterministic — Workday's own sign-in form is consistent) ──

def _first_matching(page: Page, selectors: list[str], timeout_ms: int = 30000):
    """Waits until one of the selectors matches. Workday's sign-in is a client-rendered SPA,
    so the field often isn't in the DOM yet at domcontentloaded; checking once and giving up
    (as this previously did) failed before the page had a chance to render. The error names
    the page URL and title so a failed login is diagnosable without another run."""
    deadline = time.monotonic() + timeout_ms / 1000
    while True:
        for sel in selectors:
            loc = page.locator(sel)
            if loc.count() > 0:
                return loc.first
        if time.monotonic() >= deadline:
            raise RuntimeError(
                f"no element matched any selector in {selectors!r} after {timeout_ms}ms "
                f"(page url={page.url!r}, title={page.title()!r})"
            )
        page.wait_for_timeout(500)


_USERNAME_SELECTORS = [
    "input[name='username']", "input#input-1", "input[type='email']",
    "input[autocomplete='username']", "input#okta-signin-username",
    "input[name='loginfmt']", "input#i0116",
]
_LOGIN_ERROR_RE = re.compile(
    r"something went wrong|invalid user id|invalid password|unable to process request|incorrect|"
    r"account (is )?locked|sign.?in failed",
    re.IGNORECASE,
)


def login_to_workday(page: Page, workday_url: str, username: str, password: str) -> None:
    page.goto(workday_url, wait_until="domcontentloaded", timeout=60000)

    # domcontentloaded fires before Workday's sign-in SPA has finished hydrating — the
    # username input can exist in the DOM before the framework has attached its real event
    # handlers. Waiting for it to be *visible* (not just present) gives the framework a real
    # chance to finish wiring up before we fill+click, avoiding a malformed submission that
    # Workday's backend rejects with a generic error rather than a specific one.
    username_field = _first_matching(page, _USERNAME_SELECTORS)
    username_field.wait_for(state="visible", timeout=15000)
    username_field.fill(username, timeout=15000)
    _first_matching(page, ["input[name='password']", "input[type='password']"]).fill(
        password, timeout=15000
    )
    _first_matching(page, ["button[type='submit']", "text=Sign In", "text=Sign in"]).click(timeout=15000)
    page.wait_for_load_state("networkidle", timeout=30000)

    # login_to_workday previously assumed success whenever no selector-matching exception was
    # thrown — even a real login failure (wrong creds, tenant error, rejected submission) would
    # silently fall through and get misreported downstream as "requires manual execution" on
    # step 1, rather than the actual login failure it was. Check explicitly for either a known
    # error banner or the sign-in form still being present (Workday re-renders it on failure).
    error_banner = page.get_by_text(_LOGIN_ERROR_RE)
    if error_banner.count() > 0:
        raise RuntimeError(f"Workday rejected login: {error_banner.first.inner_text()[:300]!r}")
    if page.locator(",".join(_USERNAME_SELECTORS)).count() > 0:
        raise RuntimeError("still on Workday sign-in page after submit — login did not complete")


# ── Best-effort step execution ───────────────────────────────────────────────

_QUOTED_RE = re.compile(r"'([^']+)'")


def extract_target_text(action: str) -> str | None:
    m = _QUOTED_RE.findall(action)
    return m[0] if m else None


def _first_visible(strategies: list, timeout_ms: int):
    """Try each locator strategy in turn, each getting a slice of the overall
    timeout — a real UI element's accessible role/label/placeholder often
    doesn't exactly match the free-text an LLM guessed, so trying only one
    exact-text locator (the previous behavior) gave up too early on real
    near-misses. Re-raises the last strategy's exception if none matched, so
    the caller still sees a real Playwright timeout message."""
    per_try = max(1500, timeout_ms // len(strategies))
    last_exc: Exception | None = None
    for make_locator in strategies:
        try:
            loc = make_locator().first
            loc.wait_for(state="visible", timeout=per_try)
            return loc
        except Exception as exc:  # noqa: BLE001 - deliberately broad, tried in sequence
            last_exc = exc
    raise last_exc or RuntimeError(f"no locator strategy matched (tried {len(strategies)})")


def _locate_field(page: Page, label: str, timeout_ms: int = 8000):
    """`label` is the field's own on-screen label (e.g. 'Project Name'), not
    the value to type into it — see execute_step()'s note on why those two
    were previously conflated."""
    return _first_visible([
        lambda: page.get_by_label(label, exact=False),
        lambda: page.get_by_placeholder(label, exact=False),
        lambda: page.get_by_role("textbox", name=label, exact=False),
        lambda: page.get_by_role("textbox"),  # last resort: whatever textbox is on screen
    ], timeout_ms)


def _locate_clickable(page: Page, label: str, timeout_ms: int = 8000):
    return _first_visible([
        lambda: page.get_by_role("button", name=label, exact=False),
        lambda: page.get_by_role("link", name=label, exact=False),
        lambda: page.get_by_role("menuitem", name=label, exact=False),
        lambda: page.get_by_text(label, exact=False),
    ], timeout_ms)


def execute_step(page: Page, step: dict) -> dict:
    """
    Best-effort ONLY — see module docstring. Only steps whose generated
    `action` text quotes a literal UI element name (e.g. "Click the 'Create
    New' button", "Enter the value in the 'Annual Leave' field" — now a
    required convention in functions/test_automation/agents.py's step-
    generation prompt, not just a common pattern) get an actual attempted
    action; everything else is marked 'error' with an explanatory note
    rather than guessed at blindly.
    """
    action = step["action"]
    target = step.get("ui_target") or extract_target_text(action)
    lower = action.lower()

    if not target:
        return {"execution_status": "error", "note": "no UI target for this step — requires manual execution"}

    try:
        if "enter" in lower or ("type" in lower and "dropdown" not in lower):
            # `target` extracted from the action text is the FIELD'S OWN LABEL
            # (e.g. "Enter the project name in the 'Project Name' field" ->
            # target == "Project Name") — it was previously typed in verbatim
            # as if it were the value, which is wrong whenever the model
            # didn't also happen to quote a real value. The actual value to
            # type belongs in the step's own test_data field; fall back to
            # the label text only when no test_data was generated, so a step
            # still attempts something rather than silently no-op'ing.
            value = step.get("test_data") or target
            _locate_field(page, target).fill(str(value), timeout=8000)
        else:
            _locate_clickable(page, target).click(timeout=8000)
        page.wait_for_timeout(500)
        return {"execution_status": "passed", "note": f"best-effort action against {target!r} completed"}
    except Exception as exc:
        return {"execution_status": "failed", "note": str(exc)[:500]}


def upload_screenshot(page: Page, tenant_id: str, run_id: str, scenario_id: str, filename: str) -> str | None:
    try:
        url_resp = api_post("/test-automation/internal/screenshot-upload-url", {
            "tenant_id": tenant_id, "run_id": run_id, "scenario_id": scenario_id, "filename": filename,
        })
        png_bytes = page.screenshot(full_page=False)
        put_resp = requests.put(
            url_resp["url"], data=png_bytes,
            headers={"x-ms-blob-type": "BlockBlob", "Content-Type": "image/png"}, timeout=30,
        )
        put_resp.raise_for_status()
        return url_resp["key"]
    except Exception as exc:
        log.warning("screenshot upload failed for %s: %s", filename, exc)
        return None


# ── One scenario end-to-end ──────────────────────────────────────────────────

def run_scenario(message: dict) -> None:
    run_id, scenario_id, tenant_id, environment_id = (
        message["run_id"], message["scenario_id"], message["tenant_id"], message["environment_id"]
    )
    log.info(
        "executing scenario_id=%s run_id=%s tenant_id=%s environment_id=%s",
        scenario_id, run_id, tenant_id, environment_id,
    )

    data = api_get(f"/test-automation/internal/scenarios/{scenario_id}", params={"tenant_id": tenant_id})
    steps = sorted(data["steps"], key=lambda s: s["step_number"])

    api_patch(f"/test-automation/internal/scenarios/{scenario_id}", {
        "tenant_id": tenant_id, "execution_status": "running", "started": True,
    })

    try:
        cred = api_post("/test-automation/internal/credentials", {"tenant_id": tenant_id, "environment_id": environment_id})
    except Exception as exc:
        log.error("could not fetch credentials: %s", exc)
        api_patch(f"/test-automation/internal/scenarios/{scenario_id}", {
            "tenant_id": tenant_id, "execution_status": "error", "completed": True,
        })
        return

    scenario_failed = False
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        try:
            login_to_workday(page, cred["workday_url"], cred["username"], cred["password"])
        except Exception as exc:
            log.error("login failed: %s", exc)
            for step in steps:
                api_patch(f"/test-automation/internal/scenarios/{scenario_id}/steps/{step['step_id']}", {
                    "tenant_id": tenant_id, "execution_status": "error",
                    "execution_result": {"note": f"login failed: {exc}"},
                })
            scenario_failed = True
        else:
            for step in steps:
                api_patch(f"/test-automation/internal/scenarios/{scenario_id}/steps/{step['step_id']}", {
                    "tenant_id": tenant_id, "execution_status": "running",
                })
                result = execute_step(page, step)
                result["screenshot_key"] = upload_screenshot(
                    page, tenant_id, run_id, scenario_id, f"step-{step['step_number']:03d}.png",
                )
                api_patch(f"/test-automation/internal/scenarios/{scenario_id}/steps/{step['step_id']}", {
                    "tenant_id": tenant_id,
                    "execution_status": result["execution_status"],
                    "execution_result": result,
                })
                if result["execution_status"] in ("failed", "error"):
                    scenario_failed = True
        finally:
            browser.close()

    final_status = "failed" if scenario_failed else "passed"
    try:
        api_patch(f"/test-automation/internal/scenarios/{scenario_id}", {
            "tenant_id": tenant_id,
            "execution_status": final_status,
            "completed": True,
        })
    except Exception:
        # _request_with_retry already exhausted its own retries before raising here — this is a
        # genuinely persistent outage, not a blip. The scenario is now stuck in "running" with no
        # way to directly mark it otherwise (this worker never touches Postgres/Cosmos directly,
        # only this same API that just failed), so it'll sit until the 40-minute reconciliation
        # sweep catches it. Log loudly and distinctly from main()'s generic catch-all so this
        # specific, previously-silent failure mode is immediately greppable/alertable rather than
        # indistinguishable from any other unhandled exception.
        log.error(
            "FINAL COMPLETION PATCH FAILED after exhausting retries — scenario_id=%s run_id=%s "
            "tenant_id=%s is now stranded in 'running' and will only resolve via the 40-minute "
            "reconciliation sweep (intended final_status was %r)",
            scenario_id, run_id, tenant_id, final_status,
        )
        raise
    log.info("scenario_id=%s done, failed=%s", scenario_id, scenario_failed)


def main() -> None:
    log.info("runner starting up")

    # Independent, verifiable-from-outside heartbeat — az containerapp job logs show has
    # proven unreliable for surfacing this container's own stdout, so the actual proof this
    # process is executing at all needs to land somewhere we can check independently: our own
    # Function App's request telemetry (Application Insights), not Azure's container log tool.
    # A 400 back (scenario "heartbeat-test" doesn't exist) is a SUCCESSFUL round trip, not a
    # failure — any HTTP response at all proves the container reached this line.
    try:
        r = requests.get(
            f"{FUNCTION_APP_URL}/test-automation/internal/scenarios/heartbeat-test",
            headers=_HEADERS, params={"tenant_id": "heartbeat"}, timeout=15,
        )
        log.info("heartbeat: Function API reachable, status=%s", r.status_code)
    except Exception as exc:
        log.error("heartbeat: Function API call FAILED: %s", exc)

    # Third-party egress check (confirms outbound internet reachability at all) — useful during
    # the original hang investigation, not routine production value, and it's an unconditional
    # call to a non-Microsoft endpoint on every single scenario execution. Gated off by default;
    # flip on DEBUG_DIAGNOSTICS if egress reachability itself is ever back in question.
    if DEBUG_DIAGNOSTICS:
        try:
            probe = requests.get("https://api.ipify.org", timeout=10)
            log.info("egress probe ok: outbound IP=%s status=%s", probe.text, probe.status_code)
        except Exception as exc:
            log.error("egress probe FAILED: %s", exc)

    message = fetch_one_message()
    if message is None:
        log.info("no message available — exiting cleanly (normal race under queue-scaled concurrency)")
        return
    try:
        run_scenario(message)
    except Exception:
        log.exception("unhandled error executing scenario")
        sys.exit(1)


if __name__ == "__main__":
    main()
