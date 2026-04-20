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
    log.info(f"Download URL request event: {json.dumps(event)}")
    
    try:
        ctx = tenant_from_event(event)
    except TenantError as e:
        log.error(f"Auth failed: {e}")
        return http.forbidden(str(e))
    
    try:
        body = json.loads(event.get("body") or "{}")
        log.info(f"Parsed body: {body}")
    except json.JSONDecodeError as e:
        log.error(f"JSON decode failed: {e}")
        return http.bad_request("invalid JSON body")
    
    s3_key = body.get("s3_key")
    log.info(f"s3_key from body: {s3_key}")
    
    if not s3_key:
        log.error("s3_key missing from request")
        return http.bad_request("s3_key is required")
    
    # Verify the key belongs to this tenant (security check)
    expected_prefix = f"tenants/{ctx.tenant_id}/"
    if not s3_key.startswith(expected_prefix):
        log.error(f"Key {s3_key} doesn't start with {expected_prefix}")
        return http.forbidden("Access denied to this document")
    
    # Generate presigned GET URL
    try:
        presigned = _s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": _BUCKET, "Key": s3_key},
            ExpiresIn=_EXPIRES_IN,
            HttpMethod="GET",
        )
        
        log.info(f"Successfully generated download URL for tenant={ctx.tenant_id} key={s3_key}")
        
        return http.ok({
            "url": presigned,
            "expires_in": _EXPIRES_IN
        })
        
    except Exception as e:
        log.error(f"Failed to generate download URL: {e}", exc_info=True)
        return http.error("Failed to generate download URL")
