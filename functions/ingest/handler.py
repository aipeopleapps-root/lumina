"""
Ingest handler - parses, chunks, embeds, and indexes documents.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone

from common import (
    tenant_from_event,
    TenantError,
    ai,
    vectors,
    chunking,
    audit_events,
    blob,
    http,
)

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        ctx.require_role("consultant", "super_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    s3_key = body.get("s3_key") or ""
    if not s3_key.startswith(ctx.s3_prefix()):
        log.error(
            "rejected ingest: key %s not under tenant prefix %s",
            s3_key, ctx.s3_prefix(),
        )
        return http.forbidden("s3_key is not under caller's tenant prefix")

    doc_type = body.get("doc_type", "unknown")
    module = body.get("module")
    doc_id = body.get("doc_id")
    folder_path = body.get("folder_path", "/")
    source_name = body.get("source_name") or s3_key.rsplit("/", 1)[-1]
    if not doc_id:
        return http.bad_request("doc_id is required")

    data = blob.get_object_bytes(s3_key)

    ext = source_name.lower().rsplit(".", 1)[-1]
    _PROCESS_DIAGRAM_EXTS = {"vsdx", "png", "jpg", "jpeg"}
    if ext in _PROCESS_DIAGRAM_EXTS:
        # Visual process diagrams: store metadata only, no text extraction.
        # Always normalise doc_type so they surface correctly in the Workspace.
        doc_type = "process-diagram"
        chunks = [{
            "text": source_name,
            "doc_type": doc_type,
            "source_name": source_name,
            "module": module or "",
            "chunk_index": 0,
        }]
    elif ext in ("xlsx", "xlsm"):
        chunks = chunking.chunk_xlsx_workbook(
            data, doc_type=doc_type, source_name=source_name, module=module
        )
    elif ext == "pdf":
        chunks = chunking.chunk_pdf(
            data, doc_type=doc_type, source_name=source_name, module=module
        )
    elif ext == "docx":
        chunks = chunking.chunk_docx(
            data, doc_type=doc_type, source_name=source_name, module=module
        )
    elif ext in ("txt", "md"):
        chunks = chunking.chunk_text_document(
            data.decode("utf-8", errors="replace"),
            doc_type=doc_type, source_name=source_name, module=module
        )
    else:
        return http.bad_request(f"unsupported file extension: {ext}")

    if not chunks:
        return http.bad_request("no content extracted from file")

    now_iso = datetime.now(timezone.utc).isoformat()
    vectors.ensure_index()

    for c in chunks:
        c["embedding"] = ai.embed(c["text"])
        c["doc_id"] = doc_id
        c["created_at"] = now_iso
        c["s3_key"] = s3_key
        c["folder_path"] = folder_path
        c["published"] = False

    indexed = vectors.index_chunks(ctx, chunks)

    log.info(
        "ingested %d chunks for tenant=%s doc_id=%s source=%s",
        indexed, ctx.tenant_id, doc_id, source_name,
    )

    audit_events.write(
        ctx,
        "document.upload",
        ip=audit_events.get_ip(event),
        resource_type="document",
        resource_id=doc_id,
        resource_name=source_name,
        details={"doc_type": doc_type, "module": module, "chunks_indexed": indexed, "folder_path": folder_path},
    )

    return http.ok({
        "doc_id": doc_id,
        "chunks_indexed": indexed,
        "source_name": source_name,
        "doc_type": doc_type,
        "module": module,
    })
