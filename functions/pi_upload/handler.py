"""
Process Intelligence — upload endpoint.

POST /process-intelligence/upload
  Headers: Authorization: Bearer <jwt>, X-Client-Tenant: <tenant_id>
  Body: { "filename": str, "domain": str, "source_name": str (optional) }
  Role: consultant | admin

Creates the pi.process_graphs record (status=uploading), generates a
SAS Blob PUT URL for the diagram file (.vsdx, .png, .jpg/.jpeg, or .pdf).
The frontend PUTs the file, then calls
POST /process-intelligence/{process_id}/parse to trigger parsing.

Returns: { process_id, upload_url, s3_key }
"""

from __future__ import annotations

import json
import logging
import os
import uuid

from common import tenant_from_event, TenantError, audit_events, blob, http
from common.pi_aurora import create_process_graph

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

ALLOWED_EXTENSIONS = {".vsdx", ".png", ".jpg", ".jpeg", ".pdf"}
VALID_DOMAINS = {
    "recruiting", "onboarding", "self_service",
    "payroll", "job_architecture", "performance",
}


def handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    try:
        body = json.loads(event.get("body") or "{}")
    except Exception:
        return http.bad_request("invalid JSON body")

    filename    = (body.get("filename") or "").strip()
    domain      = (body.get("domain") or "").strip().lower()
    source_name = (body.get("source_name") or filename).strip()

    # ── Validate ──────────────────────────────────────────────────────────────
    if not filename:
        return http.bad_request("filename is required")

    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        return http.bad_request(
            f"unsupported file type '{ext}'; accepted types: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
        )

    if domain not in VALID_DOMAINS:
        return http.bad_request(
            f"domain must be one of: {', '.join(sorted(VALID_DOMAINS))}"
        )

    # ── Build blob key ────────────────────────────────────────────────────────
    file_uuid = str(uuid.uuid4())
    s3_key = f"tenants/{ctx.tenant_id}/process-intelligence/{file_uuid}/{filename}"

    # ── Create Aurora record ──────────────────────────────────────────────────
    try:
        process_id = create_process_graph(
            tenant_id=ctx.tenant_id,
            uploaded_by=ctx.user_id,
            domain=domain,
            s3_key=s3_key,
            source_name=source_name,
        )
    except Exception as exc:
        log.exception("Failed to create process graph record")
        return http.server_error(f"database error: {exc}")

    # ── Generate SAS PUT URL ──────────────────────────────────────────────────
    try:
        upload_url = blob.generate_upload_sas(
            s3_key, "application/octet-stream", expires_in=300  # 5 minutes
        )
    except Exception as exc:
        log.exception("Failed to generate SAS URL")
        return http.server_error(f"storage error: {exc}")

    audit_events.write(
        ctx,
        "pi.upload.initiated",
        resource_type="process_graph",
        resource_id=process_id,
        resource_name=source_name,
        details={"domain": domain, "s3_key": s3_key},
    )

    return http.ok({
        "process_id": process_id,
        "upload_url": upload_url,
        "s3_key":     s3_key,
    })
