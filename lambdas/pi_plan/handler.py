"""
Process Intelligence — AI Planning Assistant.

GET  /process-intelligence/{process_id}/plan
  Role: consultant | admin
  Returns the current plan (tasks + chat_history), or an empty shape if none
  exists yet.

POST /process-intelligence/{process_id}/plan
  Role: consultant | admin
  Body: EITHER
    { instruction: string, project_start_date?: "YYYY-MM-DD" }
      — an AI Planning Assistant chat message / "Update plan with natural
        language" edit. Bedrock returns relative durations/dependencies
        (never absolute dates — see _schedule_tasks), which this handler
        schedules into concrete dates before persisting.
    OR
    { tasks: [...] }
      — a direct save of manually-edited tasks (add/delete/date change from
        the table UI). No Bedrock call; tasks are persisted as given.
  Returns: { process_id, plan_id, tasks, chat_history }
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import date, datetime, timedelta, timezone

from common import tenant_from_event, TenantError, audit_events, bedrock, http
from common.pi_aurora import get_process_graph_status, list_agents, get_plan, upsert_plan

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_PLAN_SYSTEM = """You are an AI transformation planning assistant helping a consultant build an implementation \
plan for a Workday AI agent rollout. You will receive the process domain, the proposed AI agents already \
defined for this process, the current task list (may be empty on a first message), the conversation history, \
and a new instruction from the consultant.

Respond with a single JSON object:
{
  "reply": "1-3 sentence conversational reply describing what you changed or, on the first message, a short plan overview",
  "tasks": [
    {
      "task_id": "string, e.g. t1, t2 (stable — reuse existing task_ids for unchanged/edited tasks, only mint new ids for new tasks)",
      "phase": "string, e.g. 'Phase 1: Discovery & Requirements' (group related tasks under the same phase string)",
      "name": "string — concise task name",
      "duration_days": <integer >= 0 — 0 only for milestones>,
      "depends_on": ["task_id", ...],
      "is_milestone": <boolean>,
      "is_phase_header": false
    }
  ]
}

CRITICAL: never include absolute dates anywhere — durations and dependencies only. Scheduling is computed \
separately. Do not include phase-header summary rows yourself (is_phase_header must always be false in your \
output) — those are synthesized automatically from your tasks' `phase` field.

Rules:
1. On a first message (empty current task list), build a full phased plan: typically Discovery & Requirements, \
   Data & Infrastructure, Agent Development (one task per proposed agent), Testing & Validation, and Rollout — \
   adapt phases to what's actually relevant given the agents and domain provided. Include a "Review" milestone \
   (is_milestone=true, duration_days=0) at the end of each phase, depending on that phase's last task.
2. On a follow-up instruction, apply ONLY the requested change to the existing task list — keep all other \
   tasks' task_id, phase, name, and dependencies unchanged unless the instruction requires touching them.
3. Every depends_on task_id must reference a task_id present in your returned tasks array (existing or new).
4. Keep task names specific and actionable, grounded in the actual agents/domain given — not generic filler."""


# ── GET /process-intelligence/{process_id}/plan ──────────────────────────────

def get_handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    process_id = (event.get("pathParameters") or {}).get("process_id", "")
    if not process_id:
        return http.bad_request("process_id path parameter is required")

    plan = get_plan(process_id=process_id, tenant_id=ctx.tenant_id)
    if not plan:
        return http.ok({"process_id": process_id, "plan_id": None, "tasks": [], "chat_history": []})

    return http.ok({"process_id": process_id, **plan})


# ── POST /process-intelligence/{process_id}/plan ─────────────────────────────

def post_handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    process_id = (event.get("pathParameters") or {}).get("process_id", "")
    if not process_id:
        return http.bad_request("process_id path parameter is required")

    try:
        body = json.loads(event.get("body") or "{}")
    except Exception:
        return http.bad_request("invalid JSON body")

    instruction = (body.get("instruction") or "").strip()
    direct_tasks = body.get("tasks")

    if direct_tasks is not None:
        existing = get_plan(process_id=process_id, tenant_id=ctx.tenant_id)
        chat_history = existing["chat_history"] if existing else []
        try:
            plan = upsert_plan(
                process_id=process_id, tenant_id=ctx.tenant_id,
                tasks=direct_tasks, chat_history=chat_history,
            )
        except PermissionError as exc:
            return http.forbidden(str(exc))
        return http.ok({"process_id": process_id, **plan})

    if not instruction:
        return http.bad_request("either 'instruction' or 'tasks' is required")

    process_meta = get_process_graph_status(process_id=process_id, tenant_id=ctx.tenant_id)
    if not process_meta:
        return http.bad_request("process graph not found")

    agents = list_agents(process_id=process_id, tenant_id=ctx.tenant_id)
    existing = get_plan(process_id=process_id, tenant_id=ctx.tenant_id)
    current_tasks = existing["tasks"] if existing else []
    chat_history = existing["chat_history"] if existing else []

    user_prompt = (
        f"<process_domain>{process_meta['domain']}</process_domain>\n\n"
        "<proposed_agents>\n" + json.dumps(
            [{"name": a["name"], "description": a["description"]} for a in agents], indent=2
        ) + "\n</proposed_agents>\n\n"
        "<current_tasks>\n" + json.dumps(current_tasks, indent=2) + "\n</current_tasks>\n\n"
        "<chat_history>\n" + json.dumps(chat_history[-10:], indent=2) + "\n</chat_history>\n\n"
        f"<instruction>{instruction}</instruction>"
    )

    try:
        result = bedrock.generate_json(system=_PLAN_SYSTEM, user_prompt=user_prompt, max_tokens=4096)
    except Exception as exc:
        log.exception("plan bedrock error process_id=%s: %s", process_id, exc)
        return http.server_error(f"AI generation failed: {exc}")

    raw_tasks = result.get("tasks", [])
    reply = result.get("reply", "")

    project_start_raw = body.get("project_start_date")
    try:
        project_start = (
            datetime.strptime(project_start_raw, "%Y-%m-%d").date()
            if project_start_raw else datetime.now(timezone.utc).date()
        )
    except ValueError:
        project_start = datetime.now(timezone.utc).date()

    scheduled_tasks = _schedule_tasks(raw_tasks, project_start)

    now_iso = datetime.now(timezone.utc).isoformat()
    new_chat_history = chat_history + [
        {"role": "user", "content": instruction, "ts": now_iso},
        {"role": "assistant", "content": reply, "ts": now_iso},
    ]

    try:
        plan = upsert_plan(
            process_id=process_id, tenant_id=ctx.tenant_id,
            tasks=scheduled_tasks, chat_history=new_chat_history,
        )
    except PermissionError as exc:
        return http.forbidden(str(exc))

    audit_events.write(
        ctx,
        "pi.plan.updated",
        resource_type="process_graph",
        resource_id=process_id,
        resource_name=process_id,
        details={"task_count": len(scheduled_tasks)},
    )

    return http.ok({"process_id": process_id, **plan})


# ── Scheduling: relative durations/dependencies → concrete dates ────────────
# The model is deliberately never trusted with absolute date arithmetic
# (a known LLM weak spot, and a visibly-wrong Gantt bar is immediately
# noticeable) — this backend pass computes dates deterministically instead.

def _schedule_tasks(raw_tasks: list[dict], project_start: date) -> list[dict]:
    by_id = {t["task_id"]: t for t in raw_tasks if t.get("task_id")}
    scheduled: dict[str, dict] = {}

    def schedule_one(task_id: str, visiting: set[str]) -> dict:
        if task_id in scheduled:
            return scheduled[task_id]
        if task_id in visiting:
            # Cycle — break it by treating this task as having no dependencies.
            t = by_id[task_id]
            start = project_start
            duration = max(int(t.get("duration_days") or 0), 0)
            end = start if duration <= 1 else start + timedelta(days=duration - 1)
            row = _row(t, start, end)
            scheduled[task_id] = row
            return row

        t = by_id.get(task_id)
        if not t:
            return None
        visiting.add(task_id)

        deps = [d for d in (t.get("depends_on") or []) if d in by_id and d != task_id]
        if deps:
            dep_ends = []
            for d in deps:
                dep_row = schedule_one(d, visiting)
                if dep_row:
                    dep_ends.append(datetime.strptime(dep_row["end_date"], "%Y-%m-%d").date())
            start = (max(dep_ends) + timedelta(days=1)) if dep_ends else project_start
        else:
            start = project_start

        duration = max(int(t.get("duration_days") or 0), 0)
        end = start if duration <= 1 else start + timedelta(days=duration - 1)

        row = _row(t, start, end)
        scheduled[task_id] = row
        visiting.discard(task_id)
        return row

    for task_id in by_id:
        schedule_one(task_id, set())

    real_tasks = list(scheduled.values())

    # Synthesize phase-header summary rows from each distinct `phase` value.
    phases: dict[str, list[dict]] = {}
    for t in real_tasks:
        phases.setdefault(t["phase"], []).append(t)

    phase_headers = []
    for phase_name, tasks in phases.items():
        starts = [datetime.strptime(t["start_date"], "%Y-%m-%d").date() for t in tasks]
        ends = [datetime.strptime(t["end_date"], "%Y-%m-%d").date() for t in tasks]
        phase_headers.append({
            "task_id": f"phase_{uuid.uuid4().hex[:8]}",
            "phase": phase_name,
            "name": phase_name,
            "start_date": min(starts).isoformat(),
            "end_date": max(ends).isoformat(),
            "dependencies": [],
            "is_milestone": False,
            "is_phase_header": True,
        })

    # Order: phase header, then its tasks, in first-seen phase order.
    ordered: list[dict] = []
    seen_phases: list[str] = []
    for t in real_tasks:
        if t["phase"] not in seen_phases:
            seen_phases.append(t["phase"])
    header_by_phase = {h["phase"]: h for h in phase_headers}
    for phase_name in seen_phases:
        ordered.append(header_by_phase[phase_name])
        ordered.extend(phases[phase_name])

    return ordered


def _row(t: dict, start: date, end: date) -> dict:
    return {
        "task_id":         t["task_id"],
        "phase":           t.get("phase") or "Unphased",
        "name":            t.get("name") or t["task_id"],
        "start_date":      start.isoformat(),
        "end_date":        end.isoformat(),
        "dependencies":    t.get("depends_on") or [],
        "is_milestone":    bool(t.get("is_milestone")),
        "is_phase_header": False,
    }


# ── Dispatcher ─────────────────────────────────────────────────────────────────

def handler(event: dict, context: object) -> dict:
    method = (event.get("requestContext") or {}).get("http", {}).get("method", "").upper()
    if method == "GET":
        return get_handler(event, context)
    if method == "POST":
        return post_handler(event, context)
    return http.bad_request(f"unsupported method {method} on this route")
