"""
Upload-url handler.

Input (POST /upload-url):
  {
    "filename": "Globex_Absence_Config_v3.xlsx"
  }

Returns a presigned S3 PUT URL scoped to the caller's tenant prefix.
The frontend uploads the file directly to S3 using this URL, then
calls /ingest with the resulting s3_key.

Output:
  {
    "url": "https://bucket.s3.amazonaws.com/...",
    "key": "tenants/{tenant_id}/uploads/{uuid}/{filename}",
    "expires_in": 300
  }
"""

from __future__ import annotations

import json
import logging
import os
import uuid

import boto3

from common import tenant_from_event, TenantError, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_s3 = boto3.client("s3")
_BUCKET = os.environ["DOCS_BUCKET"]
_EXPIRES_IN = 300  # 5 minutes


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
    except TenantError as e:
        return http.forbidden(str(e))

    # Consultants and admins can upload; clients cannot.
    try:
        ctx.require_role("consultant", "admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    filename = body.get("filename") or "upload"
    # Sanitize the filename — no path separators or parent references.
    filename = filename.replace("/", "_").replace("\\", "_").replace("..", "")

    # Build the S3 key under the tenant's uploads prefix. We use a UUID
    # subdir so concurrent uploads don't collide.
    upload_id = str(uuid.uuid4())
    s3_key = ctx.s3_key("uploads", upload_id, filename)

    # Determine content type
    content_type = "application/octet-stream"
    if filename.lower().endswith(('.xlsx', '.xlsm')):
        content_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    elif filename.lower().endswith('.pdf'):
        content_type = "application/pdf"
    elif filename.lower().endswith('.docx'):
        content_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

    # Generate a presigned PUT URL. The returned URL grants the bearer
    # exactly one PUT to this key with no auth required. Expiry is short.
    presigned = _s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": _BUCKET, 
            "Key": s3_key,
            "ContentType": content_type,
        },
        ExpiresIn=_EXPIRES_IN,
        HttpMethod="PUT",
    )

    log.info(
        "issued presigned PUT for tenant=%s key=%s", ctx.tenant_id, s3_key
    )

    return http.ok({
        "url": presigned,
        "key": s3_key,
        "expires_in": _EXPIRES_IN,
        "content_type": content_type,
    })
