"""
GET /test-scripts/status/{jobId}

Polls the status of an async test-script generation job stored in the Cosmos
`vectors` container. Returns:
  { job_id, status: "processing" }
  { job_id, status: "done", doc_id, source_name, functional_count, integration_count, ... }
  { job_id, status: "error", error: "..." }
"""

from __future__ import annotations

import json
import logging
import os

from common import tenant_from_event, TenantError, vectors, http

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "admin")
    except TenantError as e:
        return http.forbidden(str(e))

    path_params = event.get("pathParameters") or {}
    job_id = (path_params.get("jobId") or "").strip()
    if not job_id:
        return http.bad_request("jobId path parameter is required")

    item = vectors.get_item(ctx.tenant_id, f"job#{job_id}")
    if not item:
        return {"statusCode": 404, "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"}, "body": json.dumps({"error": "job not found"})}

    status = item.get("status", "processing")

    if status == "done":
        try:
            result = json.loads(item.get("result", "{}"))
        except (json.JSONDecodeError, TypeError):
            result = {}
        return http.ok({"job_id": job_id, "status": "done", **result})

    if status == "error":
        return http.ok({"job_id": job_id, "status": "error", "error": item.get("error", "Unknown error")})

    return http.ok({"job_id": job_id, "status": "processing"})
