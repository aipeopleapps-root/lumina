"""
Audit logging — every AI response records the tenant, user, prompt,
retrieved chunks, and final response. Used for explainability and for
showing "why did the model say that".
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import Any

from .db import get_connection
from .tenant import TenantContext

log = logging.getLogger(__name__)


@dataclass
class AuditRecord:
    kind: str  # 'chat' | 'analyze' | 'ingest'
    prompt: str
    response: str
    retrieved_chunks: list[dict[str, Any]]
    model_id: str
    latency_ms: int


def write_audit(ctx: TenantContext, record: AuditRecord) -> None:
    """
    Append an audit row to the tenant's schema. Never blocks the response —
    any failure is logged but not raised.
    """
    schema = ctx.pg_schema()
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f'INSERT INTO "{schema}".audit_log '
                    "(tenant_id, user_id, kind, prompt, response, retrieved, model_id, latency_ms, created_at) "
                    "VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s, %s, NOW())",
                    [
                        ctx.tenant_id,
                        ctx.user_id,
                        record.kind,
                        record.prompt[:8000],
                        record.response[:16000],
                        json.dumps(record.retrieved_chunks)[:32000],
                        record.model_id,
                        record.latency_ms,
                    ],
                )
    except Exception:  # pragma: no cover
        log.exception("failed to write audit log (non-fatal)")


class Timer:
    """Context manager that measures elapsed wall-clock time in ms."""
    def __enter__(self):
        self.start = time.monotonic()
        return self
    def __exit__(self, *_):
        self.elapsed_ms = int((time.monotonic() - self.start) * 1000)
