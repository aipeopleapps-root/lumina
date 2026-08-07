"""
Generate SAS upload URL for Blob Storage

Input:
{
  "filename": "workbook.xlsx"
}

Output:
{
  "url": "https://....blob.core.windows.net/docs/...",
  "key": "tenants/acme/uploads/abc-123/workbook.xlsx",
  "content_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
}
"""

import json
import logging
import os
import uuid

from common import tenant_from_event, TenantError, blob, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

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

    # Generate SAS URL for a client-side PUT
    sas_url = blob.generate_upload_sas(s3_key, content_type, expires_in=_EXPIRES_IN)

    return http.ok({
        "url": sas_url,
        "key": s3_key,
        "content_type": content_type
    })
