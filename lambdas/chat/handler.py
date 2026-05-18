"""
Chat handler - RAG-based coach for client questions.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from decimal import Decimal

from common import (
    tenant_from_event,
    TenantError,
    bedrock,
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
_HR_POLICY_PROMPT_PATH = Path(__file__).parent / "hr_policy_prompt.md"
_HR_POLICY_PROMPT = _HR_POLICY_PROMPT_PATH.read_text(encoding="utf-8")

TOP_K = 6
MAX_HISTORY_TURNS = 6


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        ctx.require_role("client", "consultant", "admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    user_message = (body.get("message") or "").strip()
    if not user_message:
        return http.bad_request("message is required")

    history = body.get("history") or []
    if not isinstance(history, list):
        return http.bad_request("history must be a list")
    history = _sanitize_history(history)

    module_filter = body.get("module")
    doc_id_filter = body.get("doc_id")
    mode = (body.get("mode") or "").strip().lower()

    # HR Policy Advisor mode — scoped retrieval + specialist prompt
    if mode == "hr_advisor":
        system_prompt = _HR_POLICY_PROMPT
        doc_type_filter = "hr_policy"
        module_filter = None  # policy mode searches all hr_policy docs
        doc_id_filter = None
    else:
        system_prompt = _SYSTEM_PROMPT
        doc_type_filter = None

    retrieval_query = _build_retrieval_query(user_message, history)

    with audit.Timer() as t:
        query_vector = bedrock.embed(retrieval_query)
        hits = vectors.search(
            ctx, query_vector, top_k=TOP_K,
            doc_type=doc_type_filter, module=module_filter, doc_id=doc_id_filter,
        )

        context_block = _render_context(hits)
        messages = [
            *history,
            {
                "role": "user",
                "content": (
                    f"<retrieved_context>\n{context_block}\n</retrieved_context>\n\n"
                    f"Question: {user_message}"
                ),
            },
        ]
        answer = bedrock.generate(
            system_prompt, messages, max_tokens=1500, temperature=0.2
        )

    # Convert Decimal to float for JSON serialization
    citations = [
        {
            "source_name": h.get("source_name"),
            "doc_type": h.get("doc_type"),
            "module": h.get("module"),
            "chunk_index": int(h.get("chunk_index")) if h.get("chunk_index") is not None else None,
            "excerpt": _short_excerpt(h.get("text", "")),
            "score": float(h.get("score")) if isinstance(h.get("score"), Decimal) else h.get("score"),
        }
        for h in hits
    ]

    try:
        audit.write_audit(
            ctx,
            audit.AuditRecord(
                kind="chat",
                prompt=user_message[:8000],
                response=answer[:16000],
                retrieved_chunks=[
                    {
                        "doc_id": h["doc_id"],
                        "chunk_index": int(h["chunk_index"]) if h.get("chunk_index") is not None else None,
                        "score": float(h.get("score")) if isinstance(h.get("score"), Decimal) else h.get("score")
                    }
                    for h in hits
                ],
                model_id=_GENERATION_MODEL_ID,
                latency_ms=t.elapsed_ms,
            ),
        )
    except Exception as e:
        log.error("failed to write audit log (non-fatal): %s", e)

    audit_events.write(
        ctx,
        "ai.chat",
        ip=audit_events.get_ip(event),
        resource_type="chat",
        details={
            "model_id": _GENERATION_MODEL_ID,
            "latency_ms": t.elapsed_ms,
            "citations": len(citations),
            "message_preview": user_message[:200],
        },
    )

    return http.ok({
        "answer": answer,
        "citations": citations,
        "model_id": _GENERATION_MODEL_ID,
        "latency_ms": t.elapsed_ms,
    })


def _sanitize_history(history: list[dict]) -> list[dict]:
    clean: list[dict] = []
    for turn in history[-MAX_HISTORY_TURNS * 2 :]:
        if not isinstance(turn, dict):
            continue
        role = turn.get("role")
        content = turn.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            clean.append({"role": role, "content": content[:4000]})
    return clean


def _build_retrieval_query(user_message: str, history: list[dict]) -> str:
    last_user = next(
        (h["content"] for h in reversed(history) if h["role"] == "user"), None
    )
    if last_user:
        return f"{last_user}\n\n{user_message}"
    return user_message


def _render_context(hits: list[dict]) -> str:
    if not hits:
        return "(no relevant documents found for this tenant)"
    parts: list[str] = []
    for i, h in enumerate(hits, start=1):
        parts.append(
            f"[{i}] source=\"{h.get('source_name')}\" "
            f"type={h.get('doc_type')} "
            f"module={h.get('module')} "
            f"chunk={h.get('chunk_index')}\n"
            f"{h.get('text', '')}"
        )
    return "\n\n".join(parts)


def _short_excerpt(text: str, *, max_chars: int = 240) -> str:
    t = text.strip().replace("\n", " ")
    if len(t) <= max_chars:
        return t
    return t[: max_chars - 1].rsplit(" ", 1)[0] + "…"
