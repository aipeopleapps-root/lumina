"""
Process Intelligence — recent processes for the Process Intelligence home page.

GET /process-intelligence
  Role: consultant | admin
  Returns { processes: [{process_id, source_name, domain, parse_status,
                          created_at, agent_count}] }, newest first.

Backs the Recent Processes panel that replaced the previous silent
localStorage-based single-process resume — that mechanism keyed only on
tenant, was never cleared on logout, and could silently drop a consultant
into another consultant's (or their own stale) in-flight analysis with no
confirmation UI. This route makes reopening a process an explicit,
informed choice instead.
"""

from __future__ import annotations

import logging
import os

from common import tenant_from_event, TenantError, http
from common.pi_aurora import list_processes

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))


def handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    try:
        processes = list_processes(tenant_id=ctx.tenant_id, limit=20)
    except Exception as exc:
        log.exception("list_processes error tenant_id=%s: %s", ctx.tenant_id, exc)
        return http.server_error(f"Failed to load processes: {exc}")

    return http.ok({"processes": processes})
