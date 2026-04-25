"""
Publish or unpublish a document — controls client visibility.
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
_VECTOR_TABLE = os.environ["VECTOR_TABLE_NAME"]


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

    table = _dynamodb.Table(_VECTOR_TABLE)

    # Find all chunk keys for this doc
    query_kwargs = dict(
        KeyConditionExpression=(
            Key("tenant_id").eq(ctx.tenant_id)
            & Key("chunk_id").begins_with(doc_id + "#")
        ),
        ProjectionExpression="tenant_id,chunk_id",
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
        return http.bad_request("Document not found")

    # Update published flag on every chunk
    for chunk in all_chunks:
        table.update_item(
            Key={"tenant_id": chunk["tenant_id"], "chunk_id": chunk["chunk_id"]},
            UpdateExpression="SET published = :p",
            ExpressionAttributeValues={":p": published},
        )

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
