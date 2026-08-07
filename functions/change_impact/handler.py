"""
Change Impact Advisor: given a proposed change description, analyses all
tenant project documents and returns a structured impact assessment across
Workday modules (HCM, Payroll, Benefits, Integrations, Compliance, etc.)

POST /change-impact  { "change_description": "..." }
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

MAX_CONTEXT_CHARS = 40_000

_SYSTEM_PROMPT = """You are a senior Workday solution architect assessing the impact of a proposed change.

Given:
- A description of the proposed change
- The client's project documents (config workbooks, BPDs, SOWs, test scripts, etc.)

Your task:
1. Identify every Workday module and integration area that could be affected
2. For each affected area, rate the impact severity and describe the specific effect
3. Call out the top risks and any actions the team must take

Return ONLY this exact JSON (no preamble, no markdown):
{
  "summary": "2-3 sentence plain-English summary of the overall impact and urgency",
  "impacts": [
    {
      "module": "Name of the module or area (e.g. Payroll, Benefits, HCM Core, Integrations, Security, Reporting)",
      "severity": "high" | "medium" | "low" | "none",
      "impact": "Specific description of how this module is affected",
      "actions": ["Concrete action item 1", "Concrete action item 2"]
    }
  ],
  "risks": [
    "Top risk 1 — be specific and actionable",
    "Top risk 2"
  ],
  "recommendation": "One clear recommendation on how to proceed"
}

Rules:
- Only include modules that are genuinely affected — omit modules with severity "none"
- Be specific: reference actual config details from the documents where possible
- If documents provide insufficient context for a module, say so in the impact field
- Prioritise high-severity items first in the impacts array
- risks should be the 2-4 most important risks, not an exhaustive list
"""


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("client", "consultant", "admin", "project_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    change_description = (body.get("change_description") or "").strip()
    if not change_description:
        return http.bad_request("change_description is required")
    if len(change_description) > 2000:
        return http.bad_request("change_description must be under 2000 characters")

    chunks = _load_all_chunks(ctx.tenant_id)
    context_text = _format_context(chunks, MAX_CONTEXT_CHARS)

    user_prompt = (
        f"<proposed_change>\n{change_description}\n</proposed_change>\n\n"
        f"<project_documents>\n"
        f"{context_text or '(no project documents uploaded — base your assessment on general Workday knowledge)'}"
        f"\n</project_documents>\n\n"
        "Assess the impact of this proposed change and return your JSON."
    )

    t0 = time.time()
    try:
        result = ai.generate_json(_SYSTEM_PROMPT, user_prompt, max_tokens=2048, temperature=0.1)
    except ValueError as e:
        log.error("change_impact model output error: %s", e)
        return http.server_error(f"Model output error: {e}")
    except Exception as e:
        log.error("change_impact AI error: %s", e, exc_info=True)
        return http.server_error(f"AI generation failed: {e}")

    latency_ms = int((time.time() - t0) * 1000)

    audit_events.write(
        ctx,
        "ai.change_impact",
        ip=audit_events.get_ip(event),
        resource_type="tenant",
        resource_id=ctx.tenant_id,
        details={
            "model_id": _MODEL_ID,
            "latency_ms": latency_ms,
            "impacts_count": len(result.get("impacts", [])),
            "change_preview": change_description[:120],
        },
    )

    log.info(
        "change_impact tenant=%s impacts=%d latency=%dms",
        ctx.tenant_id, len(result.get("impacts", [])), latency_ms,
    )

    return http.ok({
        "change": change_description,
        "summary": result.get("summary", ""),
        "impacts": result.get("impacts", []),
        "risks": result.get("risks", []),
        "recommendation": result.get("recommendation", ""),
        "model_id": _MODEL_ID,
        "latency_ms": latency_ms,
    })


def _load_all_chunks(tenant_id: str) -> list[dict]:
    return vectors.query_all(tenant_id)


def _format_context(chunks: list[dict], max_chars: int) -> str:
    by_doc: dict[str, list[dict]] = {}
    for c in chunks:
        by_doc.setdefault(c.get("doc_id", "unknown"), []).append(c)

    parts: list[str] = []
    total = 0
    for doc_chunks in by_doc.values():
        doc_chunks.sort(key=lambda x: int(x.get("chunk_index", 0)))
        name = doc_chunks[0].get("source_name", "unknown")
        doc_text = "\n".join(c.get("text", "") for c in doc_chunks[:10])
        section = f"=== {name} ===\n{doc_text}"
        if total + len(section) > max_chars:
            break
        parts.append(section)
        total += len(section)
    return "\n\n".join(parts)
