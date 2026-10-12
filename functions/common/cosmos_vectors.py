"""
Cosmos DB-based vector storage with brute-force cosine similarity search.
Same approach as the DynamoDB implementation it replaces — no native
vector index, in-Lambda (in-Function) scoring.
"""

from __future__ import annotations

import base64
import logging
import os
import struct
import uuid
from typing import Any

from azure.cosmos import CosmosClient
from azure.identity import DefaultAzureCredential

from .tenant import TenantContext

log = logging.getLogger(__name__)

_BATCH_SIZE = 100

_client: CosmosClient | None = None

# Cosmos document `id` forbids '/', '\', '?', '#' — but chunk_id values are
# built as "{doc_id}#{chunk_index}" (composite-key convention, same as
# cosmos_config.py's pk/sk sk values). Point operations (read_item/
# delete_item) build a resource URL from `id`, where an un-sanitized '#'
# gets interpreted as a URL fragment delimiter and silently truncates the
# lookup — confirmed live: delete_item succeeded with no error but deleted
# nothing, because it was actually looking up "{doc_id}" instead of
# "{doc_id}#{chunk_index}". Batch upsert (index_chunks) doesn't hit this,
# since it sends the id in the request body, not a URL — which is why
# indexing worked while delete/publish silently didn't.
_ID_ILLEGAL_CHARS = str.maketrans({c: "_" for c in "/\\?#"})


def _sanitize_id(raw: str) -> str:
    return raw.translate(_ID_ILLEGAL_CHARS)


def _container():
    global _client
    if _client is None:
        endpoint = os.environ["COSMOS_ENDPOINT"]
        _client = CosmosClient(endpoint, credential=DefaultAzureCredential())
    database = _client.get_database_client(os.environ.get("COSMOS_DATABASE", "lumina"))
    return database.get_container_client(os.environ.get("VECTOR_CONTAINER_NAME", "vectors"))


def ensure_index() -> None:
    """No-op — the container is created by Bicep."""
    pass


def index_chunks(ctx: TenantContext, chunks: list[dict[str, Any]]) -> int:
    """Batch write chunks to Cosmos with tenant isolation."""
    if not chunks:
        return 0

    container = _container()
    docs = []
    for c in chunks:
        embedding_b64 = _pack_vector(c["embedding"])
        docs.append({
            "id": _sanitize_id(f"{c['doc_id']}#{c['chunk_index']}"),
            "tenant_id": ctx.tenant_id,
            "chunk_id": f"{c['doc_id']}#{c['chunk_index']}",
            "doc_id": c["doc_id"],
            "doc_type": c.get("doc_type", "unknown"),
            "module": c.get("module"),
            "source_name": c.get("source_name"),
            "chunk_index": c["chunk_index"],
            "text": c["text"],
            "embedding": embedding_b64,
            "created_at": c.get("created_at"),
            "s3_key": c.get("s3_key"),
            "folder_path": c.get("folder_path", "/"),
            "published": c.get("published", False),
        })

    # All docs in one index_chunks() call share ctx.tenant_id as partition
    # key, so the transactional batch API's same-partition requirement is a
    # natural fit. Batches are capped at 100 operations per Cosmos limits.
    for start in range(0, len(docs), _BATCH_SIZE):
        batch = docs[start:start + _BATCH_SIZE]
        operations = [("upsert", (doc,)) for doc in batch]
        container.execute_item_batch(operations, partition_key=ctx.tenant_id)

    return len(chunks)


def search(
    ctx: TenantContext,
    query_vector: list[float],
    *,
    top_k: int = 6,
    doc_type: str | None = None,
    module: str | None = None,
    doc_id: str | None = None,
    doc_ids: list[str] | None = None,
) -> list[dict[str, Any]]:
    """
    Cosine similarity search over tenant's chunks.
    Reads all chunks for this tenant partition and ranks by similarity.
    """
    container = _container()
    items = list(container.query_items(
        query="SELECT * FROM c WHERE c.tenant_id = @tenant_id",
        parameters=[{"name": "@tenant_id", "value": ctx.tenant_id}],
        partition_key=ctx.tenant_id,
    ))

    # Filter by doc_type and module if specified
    if doc_type:
        items = [i for i in items if i.get("doc_type") == doc_type]
    if module:
        items = [i for i in items if i.get("module") == module]
    if doc_id:
        items = [i for i in items if i.get("doc_id") == doc_id]
    elif doc_ids:
        doc_ids_set = set(doc_ids)
        items = [i for i in items if i.get("doc_id") in doc_ids_set]

    # Calculate cosine similarity for each item
    scored = []
    for item in items:
        emb_b64 = item.get("embedding")
        if not emb_b64:
            continue

        embedding = _unpack_vector(emb_b64)
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
                "Cosmos returned cross-tenant hit: expected=%s got=%s",
                ctx.tenant_id, r.get("tenant_id")
            )
            raise RuntimeError("tenant isolation violated at Cosmos layer")

    return results


def put_item(item: dict[str, Any]) -> None:
    """
    Raw upsert of a pre-built item (e.g. an async job record) that already
    carries `tenant_id` and `chunk_id` — unlike `index_chunks`, this makes no
    assumptions about chunk shape (embedding, doc_id, etc.).
    """
    doc = dict(item)
    doc.setdefault("id", _sanitize_id(doc["chunk_id"]))
    _container().upsert_item(doc)


def get_item(tenant_id: str, chunk_id: str) -> dict[str, Any] | None:
    """Point read of one chunk (job-status polling, single-chunk lookups)."""
    from azure.cosmos import exceptions

    try:
        return _container().read_item(item=_sanitize_id(chunk_id), partition_key=tenant_id)
    except exceptions.CosmosResourceNotFoundError:
        return None


def update_item(tenant_id: str, chunk_id: str, updates: dict[str, Any]) -> None:
    """Partial update via read-modify-write (mirrors cosmos_config.update_item)."""
    item = get_item(tenant_id, chunk_id)
    if item is None:
        raise KeyError(f"no chunk tenant_id={tenant_id!r} chunk_id={chunk_id!r}")
    item.update(updates)
    _container().upsert_item(item)


def delete_item(tenant_id: str, chunk_id: str) -> None:
    from azure.cosmos import exceptions

    try:
        _container().delete_item(item=_sanitize_id(chunk_id), partition_key=tenant_id)
    except exceptions.CosmosResourceNotFoundError:
        pass


def query_all(tenant_id: str) -> list[dict[str, Any]]:
    """All chunks for a tenant (partition-scoped) — used for full-document scans
    (documents_list, change_impact, sow_validate) rather than similarity search."""
    return list(_container().query_items(
        query="SELECT * FROM c WHERE c.tenant_id = @tenant_id",
        parameters=[{"name": "@tenant_id", "value": tenant_id}],
        partition_key=tenant_id,
    ))


def query_by_doc_id(tenant_id: str, doc_id: str) -> list[dict[str, Any]]:
    """
    All chunks of one document, sorted by chunk_index. Replaces the DynamoDB
    doc_id-index GSI query (tenant_id is already known here, so this is a
    partition-scoped query rather than the GSI's cross-tenant-then-filter shape).
    """
    items = list(_container().query_items(
        query="SELECT * FROM c WHERE c.tenant_id = @tenant_id AND c.doc_id = @doc_id",
        parameters=[
            {"name": "@tenant_id", "value": tenant_id},
            {"name": "@doc_id", "value": doc_id},
        ],
        partition_key=tenant_id,
    ))
    items.sort(key=lambda x: x.get("chunk_index", 0))
    return items


def query_by_prefix(tenant_id: str, chunk_id_prefix: str) -> list[dict[str, Any]]:
    """Chunks whose chunk_id starts with a prefix (e.g. '<doc_id>#')."""
    return list(_container().query_items(
        query=(
            "SELECT * FROM c WHERE c.tenant_id = @tenant_id "
            "AND STARTSWITH(c.chunk_id, @prefix)"
        ),
        parameters=[
            {"name": "@tenant_id", "value": tenant_id},
            {"name": "@prefix", "value": chunk_id_prefix},
        ],
        partition_key=tenant_id,
    ))


def _pack_vector(vec: list[float]) -> str:
    """Pack float vector as base64-encoded binary (Cosmos documents are JSON, no raw bytes)."""
    return base64.b64encode(struct.pack(f"{len(vec)}f", *vec)).decode("ascii")


def _unpack_vector(data: str) -> list[float]:
    """Unpack base64-encoded binary vector back to floats."""
    raw = base64.b64decode(data)
    count = len(raw) // 4  # 4 bytes per float
    return list(struct.unpack(f"{count}f", raw))


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two vectors."""
    dot = sum(x * y for x, y in zip(a, b))
    mag_a = sum(x * x for x in a) ** 0.5
    mag_b = sum(x * x for x in b) ** 0.5

    if mag_a == 0 or mag_b == 0:
        return 0.0

    return dot / (mag_a * mag_b)
