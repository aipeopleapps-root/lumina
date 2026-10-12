"""
Admin: list all tenants from Cosmos `config` container with user + document counts.
"""

from __future__ import annotations

import logging
import os

from common import tenant_from_event, TenantError, config, graph, vectors, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("super_admin", "project_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        tenants = _list_tenants()
        user_counts = _graph_user_counts()
        doc_counts = _doc_counts([t["tenant_id"] for t in tenants])

        for t in tenants:
            tid = t["tenant_id"]
            t["user_count"] = user_counts.get(tid, 0)
            t["document_count"] = doc_counts.get(tid, 0)

        # Active first, then archived; within each group newest first
        tenants.sort(key=lambda x: (x["status"] != "active", x.get("created_at", "")), reverse=False)

        return http.ok({"tenants": tenants})

    except Exception as e:
        log.error("Failed to list tenants: %s", e, exc_info=True)
        return http.server_error(f"Failed to list tenants: {e}")


def _list_tenants() -> list[dict]:
    items = config.scan_prefix("TENANT#", "METADATA")
    return [
        {
            "tenant_id": item.get("tenant_id", item["pk"].removeprefix("TENANT#")),
            "name": item.get("name", ""),
            "industry": item.get("industry", ""),
            "region": item.get("region", ""),
            "status": item.get("status", "active"),
            "created_at": item.get("created_at", ""),
        }
        for item in items
    ]


def _graph_user_counts() -> dict[str, int]:
    tenant_attr = graph.tenant_attr()
    counts: dict[str, int] = {}
    try:
        for u in graph.list_users():
            tid = u.get(tenant_attr) or ""
            if tid:
                counts[tid] = counts.get(tid, 0) + 1
    except Exception as e:
        # Broad except, matching the AWS original's intent: a Graph hiccup
        # here should degrade to zero user counts, not fail the whole
        # tenant listing (graph.GraphError alone would miss e.g. a raw
        # requests/network exception from the underlying call).
        log.warning("Could not fetch Entra user counts: %s", e)
    return counts


def _doc_counts(tenant_ids: list[str]) -> dict[str, int]:
    # Same full-partition-scan pattern already used by change_impact/sow_validate —
    # no leaner "distinct doc_id" projection exists in cosmos_vectors.py yet.
    counts: dict[str, int] = {}
    for tid in tenant_ids:
        try:
            doc_ids = {item["doc_id"] for item in vectors.query_all(tid) if item.get("doc_id")}
            counts[tid] = len(doc_ids)
        except Exception as e:
            log.warning("Could not count docs for tenant %s: %s", tid, e)
            counts[tid] = 0
    return counts
