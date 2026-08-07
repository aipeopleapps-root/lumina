"""
Analyze handler - produces structured findings from workbooks.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from common import (
    tenant_from_event,
    TenantError,
    ai,
    vectors,
    audit,
    audit_events,
    http,
)

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_GENERATION_MODEL_ID = os.environ["GENERATION_MODEL_ID"]
_PROMPT_PATH = Path(__file__).parent / "prompt.md"
_SYSTEM_PROMPT = _PROMPT_PATH.read_text(encoding="utf-8")
_DELIVERY_REVIEW_PROMPT_PATH = Path(__file__).parent / "prompt_delivery_review.md"
_DELIVERY_REVIEW_PROMPT = _DELIVERY_REVIEW_PROMPT_PATH.read_text(encoding="utf-8")


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        ctx.require_role("consultant", "admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    doc_id = body.get("doc_id")
    mode = body.get("mode", "standard")
    focus = body.get("focus") or "all"
    if not doc_id:
        return http.bad_request("doc_id is required")
    if mode not in ("standard", "delivery_review"):
        return http.bad_request(f"invalid mode: {mode}")
    if mode == "standard" and focus not in ("risks", "anti-patterns", "best-practices", "all"):
        return http.bad_request(f"invalid focus: {focus}")

    system_prompt = _DELIVERY_REVIEW_PROMPT if mode == "delivery_review" else _SYSTEM_PROMPT

    doc_chunks = _load_doc_chunks(ctx, doc_id)
    if not doc_chunks:
        return http.bad_request(f"no chunks found for doc_id {doc_id}")

    module = next((c.get("module") for c in doc_chunks if c.get("module")), None)

    kb_context: list[dict] = []
    if module:
        query_text = _summarize_for_query(doc_chunks)
        qv = ai.embed(query_text)
        kb_context = vectors.search(
            ctx, qv, top_k=6, doc_type="kb", module=module,
        )

    doc_text = _render_doc_for_prompt(doc_chunks, max_chars=30000)
    kb_text = _render_kb_for_prompt(kb_context, max_chars=6000)

    user_prompt = (
        f"<focus>{focus}</focus>\n\n"
        f"<workbook source=\"{doc_chunks[0].get('source_name', 'unknown')}\" "
        f"module=\"{module or 'unknown'}\">\n{doc_text}\n</workbook>\n\n"
        f"<curated_best_practices>\n{kb_text or '(none available)'}\n</curated_best_practices>\n\n"
        "Produce your findings as specified."
    )

    with audit.Timer() as t:
        try:
            result = ai.generate_json(
                system_prompt, user_prompt, max_tokens=3000, temperature=0.1
            )
        except ValueError as e:
            log.exception("analyze model output was not valid JSON")
            return http.server_error(f"model output error: {e}")

    result["doc_id"] = doc_id
    result["model_id"] = _GENERATION_MODEL_ID

    audit.write_audit(
        ctx,
        audit.AuditRecord(
            kind="analyze",
            prompt=user_prompt[:8000],
            response=json.dumps(result)[:16000],
            retrieved_chunks=[
                {"doc_id": c["doc_id"], "chunk_index": c["chunk_index"], "score": c.get("score")}
                for c in kb_context
            ],
            model_id=_GENERATION_MODEL_ID,
            latency_ms=t.elapsed_ms,
        ),
    )

    audit_events.write(
        ctx,
        "ai.analyze",
        ip=audit_events.get_ip(event),
        resource_type="document",
        resource_id=doc_id,
        details={
            "model_id": _GENERATION_MODEL_ID,
            "latency_ms": t.elapsed_ms,
            "mode": mode,
            "focus": focus,
        },
    )

    return http.ok(result)


def _load_doc_chunks(ctx, doc_id: str) -> list[dict]:
    """Load all chunks for a doc, sorted by chunk_index (tenant-partition-scoped)."""
    return vectors.query_by_doc_id(ctx.tenant_id, doc_id)


def _summarize_for_query(chunks: list[dict]) -> str:
    head = chunks[0] if chunks else {}
    parts = [
        f"module: {head.get('module') or ''}",
        f"doc_type: {head.get('doc_type') or ''}",
        f"source: {head.get('source_name') or ''}",
    ]
    if chunks:
        parts.append(chunks[0].get("text", "")[:1500])
    return "\n".join(parts)


def _render_doc_for_prompt(chunks: list[dict], *, max_chars: int) -> str:
    out: list[str] = []
    total = 0
    for c in chunks:
        piece = f"--- chunk {c['chunk_index']} ---\n{c['text']}\n"
        if total + len(piece) > max_chars:
            out.append(f"--- (truncated after {len(out)} chunks) ---")
            break
        out.append(piece)
        total += len(piece)
    return "\n".join(out)


def _render_kb_for_prompt(hits: list[dict], *, max_chars: int) -> str:
    out: list[str] = []
    total = 0
    for h in hits:
        piece = (
            f"[KB: {h.get('source_name', 'unknown')} module={h.get('module', '?')}]\n"
            f"{h['text']}\n"
        )
        if total + len(piece) > max_chars:
            break
        out.append(piece)
        total += len(piece)
    return "\n".join(out)
