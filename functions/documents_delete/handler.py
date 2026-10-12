"""
Delete a document: removes all Cosmos chunks and the Blob object.
Requires consultant or admin role.
"""

import json
import logging
import os

from common import tenant_from_event, TenantError, audit_events, vectors, blob, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
    except TenantError as e:
        return http.forbidden(str(e))

    if ctx.role not in ("consultant", "super_admin"):
        return http.forbidden("Only consultants and admins can delete documents")

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    doc_id = body.get("doc_id")
    if not doc_id:
        return http.bad_request("doc_id is required")

    # Find all chunks for this doc_id (chunk_id = "{doc_id}#{chunk_index}")
    all_chunks = vectors.query_by_prefix(ctx.tenant_id, doc_id + "#")

    if not all_chunks:
        return http.bad_request("Document not found or already deleted")

    # Verify tenant ownership via s3_key prefix
    s3_key = all_chunks[0].get("s3_key", "")
    expected_prefix = f"tenants/{ctx.tenant_id}/"
    if s3_key and not s3_key.startswith(expected_prefix):
        return http.forbidden("Access denied to this document")

    for chunk in all_chunks:
        vectors.delete_item(chunk["tenant_id"], chunk["chunk_id"])

    log.info("Deleted %d chunks for doc_id=%s tenant=%s", len(all_chunks), doc_id, ctx.tenant_id)

    # Delete blob object if present
    if s3_key:
        try:
            blob.delete_object(s3_key)
            log.info("Deleted blob object %s", s3_key)
        except Exception as e:
            log.warning("Blob delete failed for %s: %s", s3_key, e)

    audit_events.write(
        ctx,
        "document.delete",
        ip=audit_events.get_ip(event),
        resource_type="document",
        resource_id=doc_id,
        resource_name=s3_key.rsplit("/", 1)[-1] if s3_key else doc_id,
        details={"chunks_removed": len(all_chunks), "s3_key": s3_key},
    )

    return http.ok({"deleted": True, "chunks_removed": len(all_chunks)})
