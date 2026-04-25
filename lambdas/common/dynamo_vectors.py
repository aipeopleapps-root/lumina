"""
DynamoDB-based vector storage with cosine similarity search.
Replaces OpenSearch Serverless for free-tier compatibility.
"""

from __future__ import annotations

import json
import logging
import os
import struct
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import Binary

from .tenant import TenantContext

log = logging.getLogger(__name__)

_dynamodb = boto3.resource("dynamodb")
_TABLE_NAME = os.environ["VECTOR_TABLE_NAME"]
_table = _dynamodb.Table(_TABLE_NAME)


def ensure_index():
    """No-op for DynamoDB - table is created by CDK."""
    pass


def index_chunks(ctx: TenantContext, chunks: list[dict[str, Any]]) -> int:
    """Batch write chunks to DynamoDB with tenant isolation."""
    if not chunks:
        return 0

    with _table.batch_writer() as batch:
        for c in chunks:
            # Pack embedding as binary to save space
            embedding_bytes = _pack_vector(c["embedding"])
            
            item = {
                "tenant_id": ctx.tenant_id,
                "chunk_id": f"{c['doc_id']}#{c['chunk_index']}",
                "doc_id": c["doc_id"],
                "doc_type": c.get("doc_type", "unknown"),
                "module": c.get("module"),
                "source_name": c.get("source_name"),
                "chunk_index": c["chunk_index"],
                "text": c["text"],
                "embedding": embedding_bytes,
                "created_at": c.get("created_at"),
                "s3_key": c.get("s3_key"),
            }
            batch.put_item(Item=item)
    
    return len(chunks)


def search(
    ctx: TenantContext,
    query_vector: list[float],
    *,
    top_k: int = 6,
    doc_type: str | None = None,
    module: str | None = None,
) -> list[dict[str, Any]]:
    """
    Cosine similarity search over tenant's chunks.
    Scans all chunks for this tenant and ranks by similarity.
    """
    # Query all chunks for this tenant
    response = _table.query(
        KeyConditionExpression=Key("tenant_id").eq(ctx.tenant_id)
    )
    
    items = response.get("Items", [])
    
    # Filter by doc_type and module if specified
    if doc_type:
        items = [i for i in items if i.get("doc_type") == doc_type]
    if module:
        items = [i for i in items if i.get("module") == module]
    
    # Calculate cosine similarity for each item
    scored = []
    for item in items:
        emb_bytes = item.get("embedding")
        if not emb_bytes:
            continue
        
        embedding = _unpack_vector(emb_bytes)
        score = _cosine_similarity(query_vector, embedding)
        
        scored.append({
            "tenant_id": item["tenant_id"],
            "doc_id": item["doc_id"],
            "doc_type": item.get("doc_type"),
            "module": item.get("module"),
            "source_name": item.get("source_name"),
            "chunk_index": item.get("chunk_index"),
            "text": item.get("text"),
            "score": score,
        })
    
    # Sort by score descending and take top_k
    scored.sort(key=lambda x: x["score"], reverse=True)
    results = scored[:top_k]
    
    # Verify tenant isolation
    for r in results:
        if r.get("tenant_id") != ctx.tenant_id:
            log.error(
                "DynamoDB returned cross-tenant hit: expected=%s got=%s",
                ctx.tenant_id, r.get("tenant_id")
            )
            raise RuntimeError("tenant isolation violated at DynamoDB layer")
    
    return results


def _pack_vector(vec: list[float]) -> bytes:
    """Pack float vector as binary (saves ~75% space vs JSON)."""
    return struct.pack(f"{len(vec)}f", *vec)


def _unpack_vector(data: bytes | Binary) -> list[float]:
    """Unpack binary vector back to floats."""
    # Handle DynamoDB Binary type
    if isinstance(data, Binary):
        data = bytes(data)
    
    count = len(data) // 4  # 4 bytes per float
    return list(struct.unpack(f"{count}f", data))


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two vectors."""
    dot = sum(x * y for x, y in zip(a, b))
    mag_a = sum(x * x for x in a) ** 0.5
    mag_b = sum(x * x for x in b) ** 0.5
    
    if mag_a == 0 or mag_b == 0:
        return 0.0
    
    return dot / (mag_a * mag_b)
