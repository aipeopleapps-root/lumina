"""
Weekly Status Report Generator: synthesises all project documents and
recent activity into a structured exec-ready report with drill-down detail.

POST /status-report/generate
Body: { "week_ending": "2025-07-04" }  # optional, defaults to today
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone, timedelta

from common import tenant_from_event, TenantError, ai, audit_events, vectors, blob, http

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_MODEL_ID = os.environ["GENERATION_MODEL_ID"]

MAX_DOC_CHARS = 40_000
MAX_ACTIVITY_ITEMS = 30

_SYSTEM_PROMPT = """You are a senior Workday project delivery lead writing a weekly status report.

You will be given:
- Project documents (config workbooks, BPDs, SOWs, test scripts, etc.)
- Recent project activity (what was uploaded, analysed, published this week)

Your task: generate a structured status report that works at TWO levels:
1. Executive summary — 3 sentences maximum, suitable for a C-suite slide
2. Full detail — specific, evidence-based, actionable

Return ONLY this exact JSON (no preamble, no markdown):
{
  "week_ending": "DD Mon YYYY",
  "overall_status": "green" | "yellow" | "red",
  "overall_status_reason": "One sentence explaining the RAG status",
  "exec_summary": "2-3 sentences. What is the state of the project? Is it on track? What is the single most important thing the exec needs to know?",
  "highlights": [
    "Specific achievement or milestone completed this week",
    "Another key highlight — reference actual documents or deliverables",
    "3-5 highlights total"
  ],
  "workstreams": [
    {
      "name": "Workstream name (e.g. HCM Core, Payroll, Benefits, Testing, Data Migration, Integrations, Training)",
      "status": "green" | "yellow" | "red",
      "summary": "One sentence — what is the state of this workstream?",
      "completed_this_week": ["Specific item completed"],
      "in_progress": ["Specific item underway with percentage or milestone"],
      "risks": ["Specific risk for this workstream — only if real"],
      "detail": "2-3 sentences of detail for anyone who wants to drill in"
    }
  ],
  "decisions_needed": [
    {
      "decision": "Specific decision required",
      "owner": "Role or team responsible",
      "deadline": "Date or timeframe",
      "impact_if_delayed": "What breaks if this slips"
    }
  ],
  "key_risks": [
    {
      "severity": "high" | "medium",
      "risk": "Specific risk description",
      "mitigation": "What is being done or should be done"
    }
  ],
  "upcoming_milestones": [
    {
      "milestone": "Specific milestone name",
      "due": "Date or week",
      "status": "on_track" | "at_risk" | "delayed"
    }
  ],
  "next_week_focus": [
    "Specific focus item for next week"
  ]
}

Rules:
- Be specific — reference actual document names, deliverable IDs, dates from the project docs
- Overall status: green = on track, yellow = minor risks or delays, red = significant issues requiring exec attention
- Only include workstreams that are active based on the evidence
- decisions_needed should only contain real blocking decisions, not hypotheticals
- 3-5 highlights, 3-5 next_week_focus items
- If evidence is thin, say so honestly rather than making things up
"""


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "admin", "project_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    # Week ending — default to this Friday
    week_ending_str = (body.get("week_ending") or "").strip()
    if week_ending_str:
        try:
            week_ending = datetime.strptime(week_ending_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            return http.bad_request("week_ending must be YYYY-MM-DD")
    else:
        today = datetime.now(timezone.utc)
        days_until_friday = (4 - today.weekday()) % 7
        week_ending = today + timedelta(days=days_until_friday)

    week_ending_label = week_ending.strftime("%-d %b %Y")

    # Load all project documents
    doc_chunks = vectors.query_all(ctx.tenant_id)
    doc_context = _format_doc_context(doc_chunks, MAX_DOC_CHARS)

    # Load recent audit activity
    activity_summary = _load_recent_activity(ctx.tenant_id, days=14)

    user_prompt = (
        f"Generate a weekly status report for the week ending {week_ending_label}.\n\n"
        f"<project_documents>\n"
        f"{doc_context or '(no project documents uploaded yet)'}"
        f"\n</project_documents>\n\n"
        f"<recent_activity>\n{activity_summary}\n</recent_activity>\n\n"
        "Synthesise the above into the structured status report JSON."
    )

    t0 = time.time()
    try:
        result = ai.generate_json(_SYSTEM_PROMPT, user_prompt, max_tokens=4096, temperature=0.2)
    except ValueError as e:
        log.error("status_report model output error: %s", e)
        return http.server_error(f"Model output error: {e}")
    except Exception as e:
        log.error("status_report AI error: %s", e, exc_info=True)
        return http.server_error(f"AI generation failed: {e}")

    latency_ms = int((time.time() - t0) * 1000)

    # Save formatted text version to Blob + index as draft doc
    doc_id = str(uuid.uuid4())
    report_name = f"Weekly Status Report — {week_ending_label}.txt"
    s3_key = f"tenants/{ctx.tenant_id}/generated/{doc_id}/{report_name}"
    report_text = _format_report_text(result, week_ending_label)

    blob.put_object(s3_key, report_text.encode("utf-8"), "text/plain")

    # Index as a single chunk (report is one coherent document)
    now_iso = datetime.now(timezone.utc).isoformat()
    chunk = {
        "doc_id": doc_id,
        "chunk_index": 0,
        "source_name": report_name,
        "doc_type": "status-report",
        "module": "project-management",
        "folder_path": "/Project Management",
        "s3_key": s3_key,
        "published": False,
        "created_at": now_iso,
        "text": report_text[:8000],  # truncate for embedding
    }
    try:
        chunk["embedding"] = ai.embed(chunk["text"])
    except Exception as e:
        log.warning("status_report embedding failed (non-fatal): %s", e)
        chunk["embedding"] = []
    vectors.index_chunks(ctx, [chunk])

    audit_events.write(
        ctx,
        "ai.status_report",
        ip=audit_events.get_ip(event),
        resource_type="document",
        resource_id=doc_id,
        resource_name=report_name,
        details={
            "model_id": _MODEL_ID,
            "latency_ms": latency_ms,
            "week_ending": week_ending_label,
            "overall_status": result.get("overall_status"),
            "workstream_count": len(result.get("workstreams", [])),
        },
    )

    log.info(
        "status_report tenant=%s week=%s status=%s latency=%dms",
        ctx.tenant_id, week_ending_label, result.get("overall_status"), latency_ms,
    )

    return http.ok({
        "doc_id": doc_id,
        "report_name": report_name,
        "week_ending": week_ending_label,
        "overall_status": result.get("overall_status", "yellow"),
        "overall_status_reason": result.get("overall_status_reason", ""),
        "exec_summary": result.get("exec_summary", ""),
        "highlights": result.get("highlights", []),
        "workstreams": result.get("workstreams", []),
        "decisions_needed": result.get("decisions_needed", []),
        "key_risks": result.get("key_risks", []),
        "upcoming_milestones": result.get("upcoming_milestones", []),
        "next_week_focus": result.get("next_week_focus", []),
        "model_id": _MODEL_ID,
        "latency_ms": latency_ms,
    })


def _format_doc_context(chunks: list[dict], max_chars: int) -> str:
    by_doc: dict[str, list[dict]] = {}
    for c in chunks:
        by_doc.setdefault(c.get("doc_id", "?"), []).append(c)

    parts, total = [], 0
    for doc_chunks in by_doc.values():
        doc_chunks.sort(key=lambda x: int(x.get("chunk_index", 0)))
        name = doc_chunks[0].get("source_name", "unknown")
        doc_type = doc_chunks[0].get("doc_type", "")
        text = "\n".join(c.get("text", "") for c in doc_chunks[:8])
        section = f"[{doc_type}] {name}\n{text}"
        if total + len(section) > max_chars:
            break
        parts.append(section)
        total += len(section)
    return "\n\n---\n\n".join(parts)


def _load_recent_activity(tenant_id: str, days: int = 14) -> str:
    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        items = audit_events.query_recent(tenant_id, cutoff, limit=MAX_ACTIVITY_ITEMS)
        if not items:
            return "(no recent activity in the last 14 days)"

        lines = []
        for item in items:
            ts = item.get("event_ts", "")[:19].replace("T", " ")
            action = item.get("action", "")
            resource = item.get("resource_name", "")
            user = item.get("user_email", "")
            details_raw = item.get("details") or "{}"
            try:
                details = json.loads(details_raw) if isinstance(details_raw, str) else (details_raw or {})
            except json.JSONDecodeError:
                details = {}
            extra = ""
            if action == "ai.analyze":
                extra = f" — {details.get('findings_count', 0)} findings"
            elif action == "ai.sow_validate":
                extra = f" — {details.get('findings_count', 0)} SOW findings"
            elif action == "ai.generate_tests":
                extra = f" — {details.get('test_count', 0)} test cases"
            elif action == "document.publish":
                extra = " (published to client)"
            lines.append(f"{ts}  {action}  {resource}{extra}  [{user}]")

        return "\n".join(lines)
    except Exception as e:
        log.warning("Failed to load audit activity: %s", e)
        return "(could not load recent activity)"


def _format_report_text(r: dict, week_ending: str) -> str:
    status_icon = {"green": "●", "yellow": "◐", "red": "○"}.get(r.get("overall_status", "yellow"), "◐")
    lines = [
        f"WEEKLY STATUS REPORT — Week Ending {week_ending}",
        f"Overall Status: {status_icon} {r.get('overall_status', '').upper()}  —  {r.get('overall_status_reason', '')}",
        "",
        "EXECUTIVE SUMMARY",
        r.get("exec_summary", ""),
        "",
        "HIGHLIGHTS",
    ]
    for h in r.get("highlights", []):
        lines.append(f"  • {h}")

    lines += ["", "WORKSTREAMS"]
    for ws in r.get("workstreams", []):
        s = {"green": "●", "yellow": "◐", "red": "○"}.get(ws.get("status", ""), "◐")
        lines += [f"\n  {s} {ws.get('name', '')}  —  {ws.get('summary', '')}"]
        for item in ws.get("completed_this_week", []):
            lines.append(f"    ✓ {item}")
        for item in ws.get("in_progress", []):
            lines.append(f"    → {item}")
        if ws.get("detail"):
            lines.append(f"    {ws['detail']}")

    if r.get("decisions_needed"):
        lines += ["", "DECISIONS NEEDED"]
        for d in r["decisions_needed"]:
            lines.append(f"  • {d.get('decision')}  |  Owner: {d.get('owner')}  |  By: {d.get('deadline')}")
            lines.append(f"    Impact if delayed: {d.get('impact_if_delayed', '')}")

    if r.get("key_risks"):
        lines += ["", "KEY RISKS"]
        for risk in r["key_risks"]:
            lines.append(f"  [{risk.get('severity', '').upper()}] {risk.get('risk', '')}")
            lines.append(f"    Mitigation: {risk.get('mitigation', '')}")

    if r.get("upcoming_milestones"):
        lines += ["", "UPCOMING MILESTONES"]
        for m in r["upcoming_milestones"]:
            icon = {"on_track": "✓", "at_risk": "⚠", "delayed": "✗"}.get(m.get("status", ""), "→")
            lines.append(f"  {icon} {m.get('milestone')}  —  {m.get('due')}")

    if r.get("next_week_focus"):
        lines += ["", "NEXT WEEK FOCUS"]
        for f in r["next_week_focus"]:
            lines.append(f"  • {f}")

    return "\n".join(lines)
