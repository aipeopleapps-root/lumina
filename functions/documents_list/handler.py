"""
List documents for a tenant

Returns all documents uploaded by this tenant with metadata
"""

import logging
import os

from common import tenant_from_event, TenantError, vectors, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        all_items = vectors.query_all(ctx.tenant_id)

        log.info("Fetched %d chunks for tenant=%s", len(all_items), ctx.tenant_id)

        # Only consultants and admins see unpublished documents
        is_client = ctx.role not in ("consultant", "admin", "project_admin", "security_admin")
        if is_client:
            all_items = [i for i in all_items if i.get("published")]

        # Deduplicate by doc_id (keep first chunk seen per doc)
        docs_map = {}
        for item in all_items:
            doc_id = item.get("doc_id")
            if doc_id and doc_id not in docs_map:
                docs_map[doc_id] = {
                    "doc_id": doc_id,
                    "source_name": item.get("source_name", "Unknown"),
                    "doc_type": item.get("doc_type", "unknown"),
                    "module": item.get("module", "unknown"),
                    "uploaded_at": str(item.get("created_at", "")),
                    "s3_key": item.get("s3_key", ""),
                    "folder_path": item.get("folder_path", "/"),
                    "chunk_count": 0,
                    "published": bool(item.get("published", False)),
                }

        # Count chunks per document
        for item in all_items:
            doc_id = item.get("doc_id")
            if doc_id in docs_map:
                docs_map[doc_id]["chunk_count"] += 1

        documents = sorted(
            docs_map.values(),
            key=lambda x: x.get("uploaded_at", ""),
            reverse=True,
        )

        return http.ok({"documents": documents})

    except Exception as e:
        log.error("Failed to list documents: %s", e, exc_info=True)
        return http.error(f"Failed to list documents: {str(e)}")
