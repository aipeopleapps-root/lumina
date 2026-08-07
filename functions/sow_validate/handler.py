"""
SOW Validator: cross-references a Statement of Work against all uploaded
project documents to surface deliverable gaps, scope risks, and missing evidence.

POST /sow/validate  { "sow_doc_id": "..." }
"""

from __future__ import annotations

import json
import logging
import os
import time

from common import tenant_from_event, TenantError, ai, vectors, audit_events, http

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_MODEL_ID = os.environ["GENERATION_MODEL_ID"]

MAX_SOW_CHARS = 25_000
MAX_EVIDENCE_CHARS = 35_000

_SYSTEM_PROMPT = """You are a Workday delivery assurance expert reviewing a Statement of Work (SOW)
against actual project documentation.

Your task:
1. Extract every deliverable, milestone, obligation, and out-of-scope boundary from the SOW
2. For each one, check the project documents for supporting evidence
3. Assign a traffic light:
   - green: clearly evidenced in project docs
   - yellow: partially evidenced or ambiguous
   - red: no evidence found — a gap, risk, or missing artefact
4. Return a JSON assessment

Return this exact JSON structure (no preamble, no markdown):
{
  "summary": "2-3 sentence executive summary of overall SOW compliance and key risks",
  "findings": [
    {
      "traffic_light": "green" | "yellow" | "red",
      "deliverable": "The specific commitment, deliverable, or boundary extracted from the SOW",
      "detail": "What the project docs show (or fail to show) about this commitment",
      "evidence": ["direct quote or document/section reference supporting your assessment"],
      "recommendation": "Specific action for the team — or 'No action required' if green"
    }
  ]
}

Be concrete. Quote from both the SOW and project documents where possible.
Prioritise surfacing gaps and risks — these are most valuable to the consultant.
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

    sow_doc_id = (body.get("sow_doc_id") or "").strip()
    if not sow_doc_id:
        return http.bad_request("sow_doc_id is required")

    # Load SOW chunks
    sow_chunks = _load_chunks_by_doc(ctx.tenant_id, sow_doc_id)
    if not sow_chunks:
        return http.bad_request("SOW document not found or has no indexed content")

    sow_name = sow_chunks[0].get("source_name", "Statement of Work")
    sow_text = _join_chunks(sow_chunks, MAX_SOW_CHARS)

    # Load all other tenant documents as evidence
    other_chunks = _load_other_chunks(ctx.tenant_id, sow_doc_id)
    evidence_text = _format_evidence(other_chunks, MAX_EVIDENCE_CHARS)

    user_prompt = (
        f'<sow name="{sow_name}">\n{sow_text}\n</sow>\n\n'
        f"<project_documents>\n"
        f"{evidence_text or '(no project documents uploaded yet — all findings will be red)'}"
        f"\n</project_documents>\n\n"
        "Analyse the SOW against the project documents and return your JSON findings."
    )

    t0 = time.time()
    try:
        result = ai.generate_json(_SYSTEM_PROMPT, user_prompt, max_tokens=4096, temperature=0.1)
    except ValueError as e:
        log.error("SOW validate model output error: %s", e)
        return http.server_error(f"Model output error: {e}")
    except Exception as e:
        log.error("SOW validate AI error: %s", e, exc_info=True)
        return http.server_error(f"AI generation failed: {e}")

    latency_ms = int((time.time() - t0) * 1000)

    audit_events.write(
        ctx,
        "ai.sow_validate",
        ip=audit_events.get_ip(event),
        resource_type="document",
        resource_id=sow_doc_id,
        details={
            "model_id": _MODEL_ID,
            "latency_ms": latency_ms,
            "findings_count": len(result.get("findings", [])),
            "sow_name": sow_name,
        },
    )

    log.info(
        "sow_validate tenant=%s doc=%s findings=%d latency=%dms",
        ctx.tenant_id, sow_doc_id, len(result.get("findings", [])), latency_ms,
    )

    return http.ok({
        "sow_name": sow_name,
        "sow_doc_id": sow_doc_id,
        "findings": result.get("findings", []),
        "summary": result.get("summary", ""),
        "model_id": _MODEL_ID,
        "latency_ms": latency_ms,
    })


def _load_chunks_by_doc(tenant_id: str, doc_id: str) -> list[dict]:
    return vectors.query_by_doc_id(tenant_id, doc_id)


def _load_other_chunks(tenant_id: str, exclude_doc_id: str) -> list[dict]:
    return [c for c in vectors.query_all(tenant_id) if c.get("doc_id") != exclude_doc_id]


def _join_chunks(chunks: list[dict], max_chars: int) -> str:
    parts: list[str] = []
    total = 0
    for c in chunks:
        text = c.get("text", "")
        if total + len(text) > max_chars:
            parts.append("...(truncated)")
            break
        parts.append(text)
        total += len(text)
    return "\n\n".join(parts)


def _format_evidence(chunks: list[dict], max_chars: int) -> str:
    by_doc: dict[str, list[dict]] = {}
    for c in chunks:
        by_doc.setdefault(c.get("doc_id", "unknown"), []).append(c)

    parts: list[str] = []
    total = 0
    for doc_chunks in by_doc.values():
        doc_chunks.sort(key=lambda x: int(x.get("chunk_index", 0)))
        name = doc_chunks[0].get("source_name", "unknown")
        doc_text = "\n".join(c.get("text", "") for c in doc_chunks[:12])
        section = f"=== {name} ===\n{doc_text}"
        if total + len(section) > max_chars:
            break
        parts.append(section)
        total += len(section)
    return "\n\n".join(parts)
