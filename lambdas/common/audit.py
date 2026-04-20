"""
Audit logging — every AI response records the tenant, user, prompt,
retrieved chunks, and final response. Used for explainability and for
showing "why did the model say that".
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, asdict
from typing import Any

import boto3

from .tenant import TenantContext

log = logging.getLogger(__name__)

_rds = boto3.client("rds-data")
_DB_CLUSTER_ARN = os.environ["DB_CLUSTER_ARN"]
_DB_SECRET_ARN = os.environ["DB_SECRET_ARN"]
_DB_NAME = os.environ["DB_NAME"]


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
        _rds.execute_statement(
            resourceArn=_DB_CLUSTER_ARN,
            secretArn=_DB_SECRET_ARN,
            database=_DB_NAME,
            sql=(
                f'INSERT INTO "{schema}".audit_log '
                "(tenant_id, user_id, kind, prompt, response, retrieved, model_id, latency_ms, created_at) "
                "VALUES (:tenant, :user, :kind, :prompt, :response, :retrieved::jsonb, :model, :latency, NOW())"
            ),
            parameters=[
                {"name": "tenant", "value": {"stringValue": ctx.tenant_id}},
                {"name": "user", "value": {"stringValue": ctx.user_id}},
                {"name": "kind", "value": {"stringValue": record.kind}},
                {"name": "prompt", "value": {"stringValue": record.prompt[:8000]}},
                {"name": "response", "value": {"stringValue": record.response[:16000]}},
                {"name": "retrieved", "value": {"stringValue": json.dumps(record.retrieved_chunks)[:32000]}},
                {"name": "model", "value": {"stringValue": record.model_id}},
                {"name": "latency", "value": {"longValue": record.latency_ms}},
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
