"""
Publish or unpublish a document — controls client visibility.
Requires consultant or admin role.
"""

import json
import logging
import os

from common import tenant_from_event, TenantError, audit_events, vectors, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
    except TenantError as e:
        return http.forbidden(str(e))

    if ctx.role not in ("consultant", "admin"):
        return http.forbidden("Only consultants and admins can publish documents")

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    doc_id = body.get("doc_id")
    if not doc_id:
        return http.bad_request("doc_id is required")

    published = bool(body.get("published", True))

    # Find all chunks for this doc
    all_chunks = vectors.query_by_prefix(ctx.tenant_id, doc_id + "#")

    if not all_chunks:
        return http.bad_request("Document not found")

    # Update published flag on every chunk
    for chunk in all_chunks:
        vectors.update_item(ctx.tenant_id, chunk["chunk_id"], {"published": published})

    log.info(
        "doc_id=%s published=%s chunks_updated=%d tenant=%s",
        doc_id, published, len(all_chunks), ctx.tenant_id,
    )

    action = "document.publish" if published else "document.unpublish"
    audit_events.write(
        ctx,
        action,
        ip=audit_events.get_ip(event),
        resource_type="document",
        resource_id=doc_id,
        details={"chunks_updated": len(all_chunks)},
    )

    return http.ok({"published": published, "chunks_updated": len(all_chunks)})
