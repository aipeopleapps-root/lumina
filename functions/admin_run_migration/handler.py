"""
One-off admin utility: run a raw SQL migration file against the `platform`
Postgres database.

Exists because the Postgres Flexible Server is VNet-private
(publicNetworkAccess: Disabled) — nothing outside the VNet (a laptop, Cloud
Shell) can open a direct psql connection to it. This Function App is already
VNet-integrated (see bicep/modules/compute.bicep), so routing schema changes
through an HTTP call to it is the only practical way to apply migrations/*.sql
post-deploy, mirroring what migrations/apply.sh did for AWS via the RDS Data
API. Admin-only; statements run in one transaction (all-or-nothing).
"""

from __future__ import annotations

import json
import logging
import os

from common import tenant_from_event, TenantError, http
from common.db import get_connection

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))


def _split_statements(sql: str) -> list[str]:
    # Strip both full-line and trailing inline `--` comments before splitting on
    # ';' — a naive split alone breaks on comments that contain a literal ';'
    # (e.g. "-- FK to swimlanes; NULL = unassigned"). Assumes no '--' appears
    # inside a string/dollar-quoted literal in these migration files (true for
    # all of migrations/*.sql as of this writing).
    lines = [ln.split("--", 1)[0] for ln in sql.splitlines()]
    stripped = "\n".join(lines)
    return [s.strip() for s in stripped.split(";") if s.strip()]


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("super_admin", "project_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")
    sql = body.get("sql") or ""
    if not sql.strip():
        return http.bad_request("missing 'sql' in request body")

    statements = _split_statements(sql)
    executed = 0
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                for stmt in statements:
                    cur.execute(stmt)
                    executed += 1
    except Exception as e:
        log.exception("migration failed after %d/%d statements", executed, len(statements))
        return http.bad_request(f"migration failed after {executed}/{len(statements)} statements: {e}")

    log.info("migration applied: %d statements (triggered by %s)", executed, ctx.user_id)
    return http.ok({"statements_executed": executed})
