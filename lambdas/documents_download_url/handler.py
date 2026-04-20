"""
Generate presigned download URL for a document
"""

import json
import logging
import os

import boto3

from common import tenant_from_event, TenantError, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_s3 = boto3.client("s3")
_BUCKET = os.environ["DOCS_BUCKET_NAME"]
_EXPIRES_IN = 3600  # 1 hour


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    s3_key = body.get("s3_key")
    if not s3_key:
        return http.bad_request("s3_key is required")
    
    # Verify the key belongs to this tenant (security check)
    expected_prefix = f"tenants/{ctx.tenant_id}/"
    if not s3_key.startswith(expected_prefix):
        return http.forbidden("Access denied to this document")
    
    # Generate presigned GET URL
    try:
        presigned = _s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": _BUCKET, "Key": s3_key},
            ExpiresIn=_EXPIRES_IN,
            HttpMethod="GET",
        )
        
        log.info("Issued download URL for tenant=%s key=%s", ctx.tenant_id, s3_key)
        
        return http.ok({
            "url": presigned,
            "expires_in": _EXPIRES_IN
        })
        
    except Exception as e:
        log.error("Failed to generate download URL: %s", e)
        return http.error("Failed to generate download URL")
