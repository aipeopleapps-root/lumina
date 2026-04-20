"""
Generate presigned S3 upload URL

Input:
{
  "filename": "workbook.xlsx"
}

Output:
{
  "url": "https://s3...",
  "key": "tenants/acme/uploads/abc-123/workbook.xlsx",
  "content_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
}
"""

import json
import logging
import os
import uuid
from urllib.parse import quote

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

    body = json.loads(event.get("body", "{}"))
    filename = body.get("filename", "").strip()

    if not filename:
        return http.bad_request("Missing filename")

    # Determine content type from extension
    ext = filename.lower().split(".")[-1]
    content_type_map = {
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
        "pdf": "application/pdf",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }
    content_type = content_type_map.get(ext, "application/octet-stream")

    # Generate unique upload path
    upload_id = str(uuid.uuid4())
    s3_key = f"tenants/{ctx.tenant_id}/uploads/{upload_id}/{filename}"

    # Generate presigned URL with ContentType parameter
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

    return http.ok({
        "url": presigned,
        "key": s3_key,
        "content_type": content_type
    })
