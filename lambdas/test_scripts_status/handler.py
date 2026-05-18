"""
GET /test-scripts/status/{jobId}

Polls the status of an async test-script generation job stored in DynamoDB.
Returns:
  { job_id, status: "processing" }
  { job_id, status: "done", doc_id, source_name, functional_count, integration_count, ... }
  { job_id, status: "error", error: "..." }
"""

from __future__ import annotations

import json
import logging
import os

import boto3

from common import tenant_from_event, TenantError, http

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_dynamodb = boto3.resource("dynamodb")
_VECTOR_TABLE = os.environ["VECTOR_TABLE_NAME"]


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

    table = _dynamodb.Table(_VECTOR_TABLE)
    resp = table.get_item(
        Key={
            "tenant_id": ctx.tenant_id,
            "chunk_id": f"job#{job_id}",
        }
    )
    item = resp.get("Item")
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
