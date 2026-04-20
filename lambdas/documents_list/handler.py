"""
List documents for a tenant

Returns all documents uploaded by this tenant with metadata
"""

import json
import logging
import os
from collections import defaultdict

import boto3

from common import tenant_from_event, TenantError, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_dynamodb = boto3.resource("dynamodb")
_VECTOR_TABLE = os.environ["VECTOR_TABLE_NAME"]


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        table = _dynamodb.Table(_VECTOR_TABLE)
        
        # Query all chunks for this tenant
        response = table.query(
            KeyConditionExpression="tenant_id = :tid",
            ExpressionAttributeValues={":tid": ctx.tenant_id},
            ProjectionExpression="doc_id,source_name,doc_type,module,created_at,s3_key"
        )
        
        # Group by doc_id to get unique documents
        docs_map = {}
        for item in response.get("Items", []):
            doc_id = item.get("doc_id")
            if doc_id and doc_id not in docs_map:
                docs_map[doc_id] = {
                    "doc_id": doc_id,
                    "source_name": item.get("source_name", "Unknown"),
                    "doc_type": item.get("doc_type", "unknown"),
                    "module": item.get("module", "unknown"),
                    "uploaded_at": str(item.get("created_at", "")),
                    "s3_key": item.get("s3_key", ""),
                    "chunk_count": 0
                }
        
        # Count chunks per document
        for item in response.get("Items", []):
            doc_id = item.get("doc_id")
            if doc_id in docs_map:
                docs_map[doc_id]["chunk_count"] += 1
        
        # Convert to list and sort by upload date (newest first)
        documents = sorted(
            docs_map.values(),
            key=lambda x: x.get("uploaded_at", ""),
            reverse=True
        )
        
        return http.ok({"documents": documents})
        
    except Exception as e:
        log.error("Failed to list documents: %s", e, exc_info=True)
        return http.error(f"Failed to list documents: {str(e)}")
