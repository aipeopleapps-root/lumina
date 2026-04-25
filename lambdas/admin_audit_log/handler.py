"""
Security Admin: query the audit log across all tenants.

GET /admin/audit-log?limit=50&tenant_id=acme&kind=chat
"""

from __future__ import annotations

import logging
import os

import boto3
from boto3.dynamodb.conditions import Key, Attr

from common import tenant_from_event, TenantError, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_VECTOR_TABLE = os.environ["VECTOR_TABLE_NAME"]


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("security_admin", "admin")
    except TenantError as e:
        return http.forbidden(str(e))

    qs = event.get("queryStringParameters") or {}
    limit = min(int(qs.get("limit", 50)), 200)
    filter_tenant = (qs.get("tenant_id") or "").strip().lower()
    filter_kind = (qs.get("kind") or "").strip().lower()

    # Audit log is stored in Aurora per-tenant schema.
    # We use a cross-tenant query via the admin schema.
    try:
        import psycopg2
        from common import db
        with db.get_connection() as conn:
            with conn.cursor() as cur:
                conditions = []
                params: list = []

                if filter_tenant:
                    conditions.append("tenant_id = %s")
                    params.append(filter_tenant)
                if filter_kind:
                    conditions.append("kind = %s")
                    params.append(filter_kind)

                where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
                cur.execute(f"""
                    SELECT tenant_id, user_id, kind, model_id, latency_ms,
                           LEFT(prompt, 300) AS prompt_preview,
                           LEFT(response, 300) AS response_preview,
                           created_at
                    FROM admin.audit_log
                    {where}
                    ORDER BY created_at DESC
                    LIMIT %s
                """, params + [limit])

                rows = cur.fetchall()
                cols = [d[0] for d in cur.description]
                entries = [
                    {cols[i]: (v.isoformat() if hasattr(v, "isoformat") else v)
                     for i, v in enumerate(row)}
                    for row in rows
                ]

        return http.ok({"entries": entries, "count": len(entries)})

    except Exception as e:
        log.error("Failed to read audit log: %s", e, exc_info=True)
        return http.server_error(f"Failed to read audit log: {e}")
