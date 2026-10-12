"""
Postgres helpers for the Test Automation Suite (`test_automation` schema —
see migrations/006_test_automation_schema.sql).

Follows Process Intelligence's established pattern (pi_aurora.py): a shared
schema with a `tenant_id` column on every table (not schema-per-tenant),
tenant isolation enforced by always filtering on tenant_id, ownership
verified via an existence check before every child-table mutation, and
delete-then-reinsert for regenerated scenario/step sets.

Uses common.db.get_connection() (psycopg2 over Postgres Flexible Server).
Column ordering in SELECT queries is documented inline so callers can map
tuples -> dicts without relying on cursor column metadata.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from .db import get_connection

# ── Runs ──────────────────────────────────────────────────────────────────────

_RUN_COLS = (
    "run_id, run_name, file_name, input_type, input_items, status, output_blob_key, "
    "error, created_at, updated_at, execution_status, test_phase, module, description"
)


def create_run(
    *,
    tenant_id: str,
    user_id: str,
    file_name: str,
    input_type: str,
    input_items: list[dict] | None = None,
    status: str = "parsing",
    run_name: str | None = None,
    test_phase: str | None = None,
    module: str | None = None,
    description: str | None = None,
) -> str:
    """Insert a new run record. Returns run_id."""
    run_id = str(uuid.uuid4())
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO test_automation.runs
                  (run_id, tenant_id, user_id, run_name, file_name, input_type, input_items,
                   status, test_phase, module, description)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                [run_id, tenant_id, user_id, run_name, file_name, input_type,
                 json.dumps(input_items or []), status, test_phase, module, description],
            )
    return run_id


def get_run(*, run_id: str, tenant_id: str) -> dict[str, Any] | None:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT {_RUN_COLS}
                FROM test_automation.runs
                WHERE run_id = %s AND tenant_id = %s
                """,
                [run_id, tenant_id],
            )
            row = cur.fetchone()
    if not row:
        return None
    return _run_row_to_dict(row)


def list_runs(*, tenant_id: str, user_id: str, limit: int = 30) -> list[dict[str, Any]]:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT {_RUN_COLS}
                FROM test_automation.runs
                WHERE tenant_id = %s AND user_id = %s
                ORDER BY created_at DESC
                LIMIT %s
                """,
                [tenant_id, user_id, limit],
            )
            rows = cur.fetchall()
    return [_run_row_to_dict(r) for r in rows]


def list_runs_for_tenant(*, tenant_id: str, limit: int = 100) -> list[dict[str, Any]]:
    """Every run for a tenant regardless of which user created it — admin-only use case
    (picking a 'nightly regression suite' run for an environment), see
    functions/test_automation/handler.py's _list_runs ?all=true branch."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT {_RUN_COLS}
                FROM test_automation.runs
                WHERE tenant_id = %s
                ORDER BY created_at DESC
                LIMIT %s
                """,
                [tenant_id, limit],
            )
            rows = cur.fetchall()
    return [_run_row_to_dict(r) for r in rows]


def update_run(
    *,
    run_id: str,
    tenant_id: str,
    status: str | None = None,
    input_items: list[dict] | None = None,
    output_blob_key: str | None = None,
    error: str | None = None,
    run_name: str | None = None,
) -> None:
    """Partial update — only fields explicitly passed (non-None) are changed."""
    sets: list[str] = []
    params: list[Any] = []
    if status is not None:
        sets.append("status = %s")
        params.append(status)
    if input_items is not None:
        sets.append("input_items = %s")
        params.append(json.dumps(input_items))
    if output_blob_key is not None:
        sets.append("output_blob_key = %s")
        params.append(output_blob_key)
    if error is not None:
        sets.append("error = %s")
        params.append(error)
    if run_name is not None:
        sets.append("run_name = %s")
        params.append(run_name)
    if not sets:
        return
    sets.append("updated_at = NOW()")
    params.extend([run_id, tenant_id])
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE test_automation.runs SET {', '.join(sets)} WHERE run_id = %s AND tenant_id = %s",
                params,
            )


def _run_row_to_dict(r: tuple) -> dict[str, Any]:
    items_raw = r[4]
    return {
        "run_id": r[0],
        "run_name": r[1],
        "file_name": r[2],
        "input_type": r[3],
        "input_items": json.loads(items_raw) if isinstance(items_raw, str) else (items_raw or []),
        "status": r[5],
        "output_blob_key": r[6],
        "error": r[7],
        "created_at": str(r[8]),
        "updated_at": str(r[9]),
        "execution_status": r[10],
        "test_phase": r[11],
        "module": r[12],
        "description": r[13],
    }


def update_run_execution(
    *, run_id: str, tenant_id: str, execution_status: str, environment_id: str | None = None
) -> None:
    """
    Independent from update_run()'s generation-pipeline `status` — a run stays
    'completed' (exported) while execution_status separately progresses
    not_executed -> pending -> running -> passed/failed/error, so re-running
    execution never conflicts with the generation lifecycle. See migration 007.
    environment_id (migration 008) is stamped once, on the triggering call — which
    Workday environment this execution ran against.
    """
    if environment_id is not None:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE test_automation.runs SET execution_status = %s, environment_id = %s "
                    "WHERE run_id = %s AND tenant_id = %s",
                    [execution_status, environment_id, run_id, tenant_id],
                )
        return
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE test_automation.runs SET execution_status = %s WHERE run_id = %s AND tenant_id = %s",
                [execution_status, run_id, tenant_id],
            )


_REPORT_SELECT_COLS = (
    "r.run_id, r.file_name, r.run_name, r.test_phase, r.module, r.environment_id, "
    "e.name AS environment_name, r.execution_status, r.updated_at, "
    "COUNT(sc.scenario_id) AS total, "
    "COUNT(sc.scenario_id) FILTER (WHERE sc.execution_status = 'passed') AS passed, "
    "COUNT(sc.scenario_id) FILTER (WHERE sc.execution_status = 'failed') AS failed, "
    "COUNT(sc.scenario_id) FILTER (WHERE sc.execution_status = 'error') AS error, "
    "COUNT(sc.scenario_id) FILTER (WHERE sc.execution_status IN ('pending', 'running')) AS pending"
)
_REPORT_GROUP_BY = (
    "r.run_id, r.file_name, r.run_name, r.test_phase, r.module, r.environment_id, "
    "e.name, r.execution_status, r.updated_at"
)


def _report_row_to_dict(r: tuple, *, with_tenant: bool = False) -> dict[str, Any]:
    offset = 1 if with_tenant else 0
    d = {
        "run_id": r[offset + 0], "file_name": r[offset + 1], "run_name": r[offset + 2],
        "test_phase": r[offset + 3], "module": r[offset + 4],
        "environment_id": r[offset + 5], "environment_name": r[offset + 6],
        "execution_status": r[offset + 7], "updated_at": str(r[offset + 8]),
        "scenario_counts": {
            "total": r[offset + 9], "passed": r[offset + 10], "failed": r[offset + 11],
            "error": r[offset + 12], "pending": r[offset + 13],
        },
    }
    if with_tenant:
        d["tenant_id"] = r[0]
    return d


def list_executed_runs_with_counts(
    *,
    tenant_id: str,
    environment_id: str | None = None,
    test_phase: str | None = None,
    module: str | None = None,
    since: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Reporting-dashboard rollup — one row per run that has actually been executed
    (execution_status != 'not_executed'), with per-scenario pass/fail/error/pending
    counts computed in the same query so the dashboard doesn't need an N+1 fetch.
    See functions/test_automation/handler.py's _reports_dashboard."""
    where = ["r.tenant_id = %s", "r.execution_status != 'not_executed'"]
    params: list[Any] = [tenant_id]
    if environment_id:
        where.append("r.environment_id = %s")
        params.append(environment_id)
    if test_phase:
        where.append("r.test_phase = %s")
        params.append(test_phase)
    if module:
        where.append("r.module = %s")
        params.append(module)
    if since:
        where.append("r.updated_at >= %s")
        params.append(since)
    params.append(limit)

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT {_REPORT_SELECT_COLS}
                FROM test_automation.runs r
                LEFT JOIN test_automation.scenarios sc ON sc.run_id = r.run_id
                LEFT JOIN test_automation.environments e ON e.environment_id = r.environment_id
                WHERE {' AND '.join(where)}
                GROUP BY {_REPORT_GROUP_BY}
                ORDER BY r.updated_at DESC
                LIMIT %s
                """,
                params,
            )
            rows = cur.fetchall()
    return [_report_row_to_dict(r) for r in rows]


def list_executed_runs_with_counts_all_tenants(
    *,
    environment_id: str | None = None,
    test_phase: str | None = None,
    module: str | None = None,
    since: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Same rollup as list_executed_runs_with_counts, minus the tenant_id filter —
    super-admin-only cross-client view (functions/test_automation/handler.py's
    _reports_dashboard, ?all=true branch). tenant_id is returned per row instead of
    filtered on; the caller maps it to a client name via listTenants() the same way
    AdminPanel.tsx's ClientsTab already does, rather than joining Cosmos here."""
    where = ["r.execution_status != 'not_executed'"]
    params: list[Any] = []
    if environment_id:
        where.append("r.environment_id = %s")
        params.append(environment_id)
    if test_phase:
        where.append("r.test_phase = %s")
        params.append(test_phase)
    if module:
        where.append("r.module = %s")
        params.append(module)
    if since:
        where.append("r.updated_at >= %s")
        params.append(since)
    params.append(limit)

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT r.tenant_id, {_REPORT_SELECT_COLS}
                FROM test_automation.runs r
                LEFT JOIN test_automation.scenarios sc ON sc.run_id = r.run_id
                LEFT JOIN test_automation.environments e ON e.environment_id = r.environment_id
                WHERE {' AND '.join(where)}
                GROUP BY r.tenant_id, {_REPORT_GROUP_BY}
                ORDER BY r.updated_at DESC
                LIMIT %s
                """,
                params,
            )
            rows = cur.fetchall()
    return [_report_row_to_dict(r, with_tenant=True) for r in rows]


# ── Environments (migration 008) ────────────────────────────────────────────────
# A named Workday tenant (URL + credential, credential itself lives in Key Vault —
# see functions/common/keyvault.py) nested under one Lumina client tenant_id. One
# client can have several: sandbox, preview, a production mirror, etc.

_ENV_COLS = (
    "environment_id, tenant_id, name, is_active, nightly_enabled, nightly_run_id, "
    "created_at, updated_at"
)


def create_environment(*, tenant_id: str, name: str) -> str:
    environment_id = str(uuid.uuid4())
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO test_automation.environments (environment_id, tenant_id, name) "
                "VALUES (%s, %s, %s)",
                [environment_id, tenant_id, name],
            )
    return environment_id


def list_environments(*, tenant_id: str, include_inactive: bool = False) -> list[dict[str, Any]]:
    where = "WHERE tenant_id = %s" + ("" if include_inactive else " AND is_active = true")
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT {_ENV_COLS} FROM test_automation.environments {where} ORDER BY created_at",
                [tenant_id],
            )
            rows = cur.fetchall()
    return [_environment_row_to_dict(r) for r in rows]


def list_nightly_environments_all_tenants() -> list[dict[str, Any]]:
    """Cross-tenant — the nightly timer's sweep (same reasoning as
    list_stale_executing_scenarios). Every active environment with nightly turned on
    and a regression run chosen."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT {_ENV_COLS} FROM test_automation.environments
                WHERE is_active = true AND nightly_enabled = true AND nightly_run_id IS NOT NULL
                ORDER BY tenant_id, created_at
                """
            )
            rows = cur.fetchall()
    return [_environment_row_to_dict(r) for r in rows]


def get_environment(*, environment_id: str, tenant_id: str) -> dict[str, Any] | None:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT {_ENV_COLS} FROM test_automation.environments "
                "WHERE environment_id = %s AND tenant_id = %s",
                [environment_id, tenant_id],
            )
            row = cur.fetchone()
    return _environment_row_to_dict(row) if row else None


def update_environment(
    *,
    environment_id: str,
    tenant_id: str,
    name: str | None = None,
    is_active: bool | None = None,
    nightly_enabled: bool | None = None,
    nightly_run_id: str | None = None,
) -> None:
    """Partial update — only fields explicitly passed (non-None) are changed.
    nightly_run_id can't be cleared via this signature (None means "leave alone",
    matching update_run's convention) — pass an empty string to clear it."""
    sets: list[str] = []
    params: list[Any] = []
    if name is not None:
        sets.append("name = %s")
        params.append(name)
    if is_active is not None:
        sets.append("is_active = %s")
        params.append(is_active)
    if nightly_enabled is not None:
        sets.append("nightly_enabled = %s")
        params.append(nightly_enabled)
    if nightly_run_id is not None:
        sets.append("nightly_run_id = %s")
        params.append(nightly_run_id or None)
    if not sets:
        return
    sets.append("updated_at = NOW()")
    params.extend([environment_id, tenant_id])
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE test_automation.environments SET {', '.join(sets)} "
                "WHERE environment_id = %s AND tenant_id = %s",
                params,
            )


def _environment_row_to_dict(r: tuple) -> dict[str, Any]:
    return {
        "environment_id": r[0],
        "tenant_id": r[1],
        "name": r[2],
        "is_active": r[3],
        "nightly_enabled": r[4],
        "nightly_run_id": r[5],
        "created_at": str(r[6]),
        "updated_at": str(r[7]),
    }


# ── Scenarios ─────────────────────────────────────────────────────────────────

def replace_scenarios(*, run_id: str, tenant_id: str, scenarios: list[dict]) -> list[dict[str, Any]]:
    """Delete-then-insert the scenario set for a run. Returns inserted rows with new scenario_ids."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM test_automation.runs WHERE run_id = %s AND tenant_id = %s",
                [run_id, tenant_id],
            )
            if not cur.fetchone():
                raise PermissionError("run not found or access denied")

            cur.execute("DELETE FROM test_automation.scenarios WHERE run_id = %s", [run_id])

            inserted: list[dict[str, Any]] = []
            for position, sc in enumerate(scenarios):
                scenario_id = str(uuid.uuid4())
                cur.execute(
                    """
                    INSERT INTO test_automation.scenarios
                      (scenario_id, run_id, tenant_id, source_ref, scenario_type,
                       title, description, preconditions, position)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    [
                        scenario_id, run_id, tenant_id,
                        sc.get("source_ref"), sc["scenario_type"], sc["title"],
                        sc.get("description"), json.dumps(sc.get("preconditions") or []), position,
                    ],
                )
                inserted.append({**sc, "scenario_id": scenario_id})
    return inserted


_SCENARIO_COLS = (
    "scenario_id, source_ref, scenario_type, title, description, preconditions, "
    "execution_status, execution_started_at, execution_completed_at"
)


def list_scenarios(*, run_id: str, tenant_id: str) -> list[dict[str, Any]]:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT {_SCENARIO_COLS}
                FROM test_automation.scenarios
                WHERE run_id = %s AND tenant_id = %s
                ORDER BY position
                """,
                [run_id, tenant_id],
            )
            rows = cur.fetchall()
    return [_scenario_row_to_dict(r) for r in rows]


def get_scenario(*, scenario_id: str, tenant_id: str) -> dict[str, Any] | None:
    """Single scenario lookup, scoped by tenant — used by the execution worker,
    which only ever has one scenario_id per queue message (see execution/handler.py)."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT {_SCENARIO_COLS}, run_id
                FROM test_automation.scenarios
                WHERE scenario_id = %s AND tenant_id = %s
                """,
                [scenario_id, tenant_id],
            )
            row = cur.fetchone()
    if not row:
        return None
    d = _scenario_row_to_dict(row[:-1])
    d["run_id"] = row[-1]
    return d


def _scenario_row_to_dict(r: tuple) -> dict[str, Any]:
    pre_raw = r[5]
    return {
        "scenario_id": r[0],
        "source_ref": r[1],
        "scenario_type": r[2],
        "title": r[3],
        "description": r[4],
        "preconditions": json.loads(pre_raw) if isinstance(pre_raw, str) else (pre_raw or []),
        "execution_status": r[6],
        "execution_started_at": str(r[7]) if r[7] else None,
        "execution_completed_at": str(r[8]) if r[8] else None,
    }


def update_scenario_execution(
    *,
    scenario_id: str,
    tenant_id: str,
    execution_status: str,
    queued: bool = False,
    started: bool = False,
    completed: bool = False,
) -> None:
    sets = ["execution_status = %s"]
    params: list[Any] = [execution_status]
    if queued:
        sets.append("execution_queued_at = NOW()")
    if started:
        sets.append("execution_started_at = NOW()")
    if completed:
        sets.append("execution_completed_at = NOW()")
    params.extend([scenario_id, tenant_id])
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE test_automation.scenarios SET {', '.join(sets)} "
                "WHERE scenario_id = %s AND tenant_id = %s",
                params,
            )


def list_stale_executing_scenarios(*, stale_before_minutes: int = 40, limit: int = 200) -> list[dict[str, Any]]:
    """Cross-tenant — a platform-maintenance sweep, not a caller-scoped query (mirrors
    list_executed_runs_with_counts_all_tenants's reasoning). Finds scenarios stuck in
    pending/running whose execution never called back in time — either the execution
    container was killed mid-scenario (confirmed live: Container Apps Job executions
    with status "Stopped"), or its queue message was never picked up at all. Staleness
    is COALESCE(execution_started_at, execution_queued_at) — the former if the container
    did start, the latter (migration 010) if it never got that far — compared against a
    threshold well past the Container Apps Job's own replicaTimeout (1800s), so a
    genuinely still-running execution is never mistaken for a stuck one.
    See functions/test_automation/handler.py's reconcile_stale_executions()."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT sc.scenario_id, sc.run_id, sc.tenant_id,
                       COALESCE(sc.execution_started_at, sc.execution_queued_at) AS stale_since
                FROM test_automation.scenarios sc
                WHERE sc.execution_status IN ('pending', 'running')
                  AND COALESCE(sc.execution_started_at, sc.execution_queued_at)
                      < NOW() - (%s || ' minutes')::interval
                ORDER BY stale_since
                LIMIT %s
                """,
                [stale_before_minutes, limit],
            )
            rows = cur.fetchall()
    return [
        {"scenario_id": r[0], "run_id": r[1], "tenant_id": r[2], "stale_since": str(r[3]) if r[3] else None}
        for r in rows
    ]


# ── Steps ─────────────────────────────────────────────────────────────────────

_ui_target_column_ready = False


def _ensure_ui_target_column(cur) -> None:
    """Adds steps.ui_target if it's missing (idempotent: ADD COLUMN IF NOT EXISTS). Runs
    once per process, before the first query that reads or writes the column, so the
    column exists without a manual migration step. Mirrors migrations/013."""
    global _ui_target_column_ready
    if _ui_target_column_ready:
        return
    cur.execute("ALTER TABLE test_automation.steps ADD COLUMN IF NOT EXISTS ui_target TEXT")
    _ui_target_column_ready = True


def replace_steps(*, run_id: str, tenant_id: str, steps: list[dict]) -> list[dict[str, Any]]:
    """
    Delete-then-insert every step for every scenario belonging to this run
    (each item in `steps` must carry its `scenario_id`). Returns inserted
    rows with new step_ids.
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            _ensure_ui_target_column(cur)
            cur.execute(
                "SELECT 1 FROM test_automation.runs WHERE run_id = %s AND tenant_id = %s",
                [run_id, tenant_id],
            )
            if not cur.fetchone():
                raise PermissionError("run not found or access denied")

            cur.execute(
                """
                DELETE FROM test_automation.steps
                WHERE scenario_id IN (
                  SELECT scenario_id FROM test_automation.scenarios WHERE run_id = %s
                )
                """,
                [run_id],
            )

            inserted: list[dict[str, Any]] = []
            for st in steps:
                step_id = str(uuid.uuid4())
                cur.execute(
                    """
                    INSERT INTO test_automation.steps
                      (step_id, scenario_id, tenant_id, step_number, action, expected_result, test_data, ui_target)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    [
                        step_id, st["scenario_id"], tenant_id,
                        st["step_number"], st["action"], st["expected_result"], st.get("test_data"),
                        st.get("ui_target"),
                    ],
                )
                inserted.append({**st, "step_id": step_id})
    return inserted


_STEP_COLS = (
    "s.step_id, s.scenario_id, s.step_number, s.action, s.expected_result, s.test_data, "
    "s.execution_status, s.execution_result, s.last_executed_at, s.ui_target"
)


def list_steps(*, run_id: str, tenant_id: str) -> list[dict[str, Any]]:
    with get_connection() as conn:
        with conn.cursor() as cur:
            _ensure_ui_target_column(cur)
            cur.execute(
                f"""
                SELECT {_STEP_COLS}
                FROM test_automation.steps s
                JOIN test_automation.scenarios sc ON sc.scenario_id = s.scenario_id
                WHERE sc.run_id = %s AND s.tenant_id = %s
                ORDER BY sc.position, s.step_number
                """,
                [run_id, tenant_id],
            )
            rows = cur.fetchall()
    return [_step_row_to_dict(r) for r in rows]


def list_steps_for_scenario(*, scenario_id: str, tenant_id: str) -> list[dict[str, Any]]:
    """Steps for exactly one scenario — the execution worker's unit of work
    (one Chromium session per scenario, see execution/handler.py)."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            _ensure_ui_target_column(cur)
            cur.execute(
                f"""
                SELECT {_STEP_COLS}
                FROM test_automation.steps s
                WHERE s.scenario_id = %s AND s.tenant_id = %s
                ORDER BY s.step_number
                """,
                [scenario_id, tenant_id],
            )
            rows = cur.fetchall()
    return [_step_row_to_dict(r) for r in rows]


def _step_row_to_dict(r: tuple) -> dict[str, Any]:
    result_raw = r[7]
    return {
        "step_id": r[0], "scenario_id": r[1], "step_number": r[2],
        "action": r[3], "expected_result": r[4], "test_data": r[5],
        "execution_status": r[6],
        "execution_result": json.loads(result_raw) if isinstance(result_raw, str) else result_raw,
        "last_executed_at": str(r[8]) if r[8] else None,
        "ui_target": r[9],
    }


def update_step_execution(
    *,
    step_id: str,
    tenant_id: str,
    execution_status: str,
    execution_result: dict | None = None,
) -> None:
    sets = ["execution_status = %s", "last_executed_at = NOW()"]
    params: list[Any] = [execution_status]
    if execution_result is not None:
        sets.append("execution_result = %s")
        params.append(json.dumps(execution_result))
    params.extend([step_id, tenant_id])
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE test_automation.steps SET {', '.join(sets)} "
                "WHERE step_id = %s AND tenant_id = %s",
                params,
            )
