"""
Delete a document: removes all DynamoDB chunks and the S3 object.
Requires consultant or admin role.
"""

import json
import logging
import os

import boto3
from boto3.dynamodb.conditions import Key

from common import tenant_from_event, TenantError, audit_events, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_dynamodb = boto3.resource("dynamodb")
_s3 = boto3.client("s3")
_VECTOR_TABLE = os.environ["VECTOR_TABLE_NAME"]
_BUCKET = os.environ["DOCS_BUCKET_NAME"]


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
    except TenantError as e:
        return http.forbidden(str(e))

    if ctx.role not in ("consultant", "admin"):
        return http.forbidden("Only consultants and admins can delete documents")

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    doc_id = body.get("doc_id")
    if not doc_id:
        return http.bad_request("doc_id is required")

    table = _dynamodb.Table(_VECTOR_TABLE)

    # Find all chunks for this doc_id (chunk_id = "{doc_id}#{chunk_index}")
    query_kwargs = dict(
        KeyConditionExpression=(
            Key("tenant_id").eq(ctx.tenant_id)
            & Key("chunk_id").begins_with(doc_id + "#")
        ),
        ProjectionExpression="tenant_id,chunk_id,s3_key",
    )

    all_chunks = []
    while True:
        resp = table.query(**query_kwargs)
        all_chunks.extend(resp.get("Items", []))
        last_key = resp.get("LastEvaluatedKey")
        if not last_key:
            break
        query_kwargs["ExclusiveStartKey"] = last_key

    if not all_chunks:
        return http.bad_request("Document not found or already deleted")

    # Verify tenant ownership via s3_key prefix
    s3_key = all_chunks[0].get("s3_key", "")
    expected_prefix = f"tenants/{ctx.tenant_id}/"
    if s3_key and not s3_key.startswith(expected_prefix):
        return http.forbidden("Access denied to this document")

    # Batch delete chunks from DynamoDB (max 25 per batch)
    with table.batch_writer() as batch:
        for chunk in all_chunks:
            batch.delete_item(Key={
                "tenant_id": chunk["tenant_id"],
                "chunk_id": chunk["chunk_id"],
            })

    log.info("Deleted %d chunks for doc_id=%s tenant=%s", len(all_chunks), doc_id, ctx.tenant_id)

    # Delete S3 object if present
    if s3_key:
        try:
            _s3.delete_object(Bucket=_BUCKET, Key=s3_key)
            log.info("Deleted S3 object %s", s3_key)
        except Exception as e:
            log.warning("S3 delete failed for %s: %s", s3_key, e)

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
