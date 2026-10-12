"""
Firm-wide knowledge base for RFP Reimagine — Deloitte's own past RFP excerpts, proposal
content, and case studies, retrieved by industry rather than by client tenant.

Deliberately a separate module/container from cosmos_vectors.py's `vectors` container, not an
extension of it: `vectors` is tenant-isolated (client documents, one partition per tenant_id,
enforced isolation is the whole point). This is the opposite shape — every consultant across
every client engagement in a given industry shares the same knowledge, and there is no tenant_id
to scope by at all. Reusing `vectors` would mean either faking a tenant_id (confusing, and risks
a future bug that leaks this content into `assert_belongs_to`-style tenant-isolation logic that
assumes `vectors` is always per-client) or bypassing the isolation checks that module exists to
enforce. A separate container with the query shape this actually needs (retrieve by industry) is
cleaner.

Same brute-force cosine-similarity approach as cosmos_vectors.py — consistent with this
migration's locked-in vector-store decision (no native Cosmos vector index yet).
"""

from __future__ import annotations

import base64
import logging
import os
import struct
from typing import Any

from azure.cosmos import CosmosClient
from azure.identity import DefaultAzureCredential

log = logging.getLogger(__name__)

_BATCH_SIZE = 100

_client: CosmosClient | None = None

# Cosmos document `id` forbids '/', '\', '?', '#' — chunk_id is built as
# "{source_name}#{chunk_index}", and delete_source's point-delete builds a
# resource URL from the stored id, where an un-sanitized '#' gets
# interpreted as a URL fragment delimiter and silently truncates the lookup
# (same failure mode found and fixed in cosmos_vectors.py/cosmos_config.py —
# confirmed live: delete_source's delete_item calls "succeeded" with no
# error but deleted nothing).
_ID_ILLEGAL_CHARS = str.maketrans({c: "_" for c in "/\\?#"})


def _sanitize_id(raw: str) -> str:
    return raw.translate(_ID_ILLEGAL_CHARS)


def _container():
    global _client
    if _client is None:
        endpoint = os.environ["COSMOS_ENDPOINT"]
        _client = CosmosClient(endpoint, credential=DefaultAzureCredential())
    database = _client.get_database_client(os.environ.get("COSMOS_DATABASE", "lumina"))
    return database.get_container_client(
        os.environ.get("INDUSTRY_KNOWLEDGE_CONTAINER_NAME", "industry_knowledge")
    )


def index_chunks(industry: str, source_name: str, chunks: list[dict[str, Any]]) -> int:
    """
    Batch-write chunks of a firm-knowledge document (a past RFP, proposal, or case study)
    into the industry's partition. `chunks` is the same shape chunking.py already produces
    for client documents (text/chunk_index/embedding), reused here rather than inventing a
    parallel chunking format — plus admin-set tags (`app`, `module`, and the accuracy-oriented
    fields below, all optional on each chunk dict) that scope and rank retrieval.
    """
    if not chunks:
        return 0

    container = _container()
    docs = []
    for c in chunks:
        chunk_id = f"{source_name}#{c['chunk_index']}"
        docs.append({
            "id": _sanitize_id(chunk_id),
            "industry": industry,
            "chunk_id": chunk_id,
            "source_name": source_name,
            "doc_type": c.get("doc_type", "rfp_excerpt"),
            "apps": c.get("apps") or [],
            "module": c.get("module") or "",
            "chunk_index": c["chunk_index"],
            "text": c["text"],
            "embedding": _pack_vector(c["embedding"]),
            "created_at": c.get("created_at"),
            "s3_key": c.get("s3_key", ""),
            "source_url": c.get("source_url", ""),
            "effective_date": c.get("effective_date"),
            "is_current": c.get("is_current", True),
            "is_canonical": c.get("is_canonical", False),
            "aliases": c.get("aliases") or "",
            "region": c.get("region") or "",
            "reviewed": c.get("reviewed", False),
            "client_facing": c.get("client_facing", False),
        })

    for start in range(0, len(docs), _BATCH_SIZE):
        batch = docs[start:start + _BATCH_SIZE]
        operations = [("upsert", (doc,)) for doc in batch]
        container.execute_item_batch(operations, partition_key=industry)

    return len(chunks)


# Score adjustments applied on top of raw cosine similarity — see
# admin_industry_docs/handler.py's _upload() docstring for the reasoning.
# A penalty rather than hard exclusion for superseded content: it should
# lose to a current document on the same topic, but still surface (with the
# is_current=False flag visible to the caller) if it's the only match rather
# than silently vanishing.
_SUPERSEDED_PENALTY = 0.5
_CANONICAL_BOOST = 1.15


def doc_apps(item: dict[str, Any]) -> list[str]:
    """A document's tagged apps, normalized. Documents used to carry a single
    `app` string; multi-app tagging replaced that with an `apps` list, but
    older chunks indexed before this change still only have the singular
    field on disk (no backfill migration run) — fall back to wrapping it so
    old and new documents filter identically without a data migration."""
    apps = item.get("apps")
    if apps:
        return apps
    legacy = item.get("app")
    return [legacy] if legacy else []


def _row_to_result(item: dict[str, Any], score: float) -> dict[str, Any]:
    is_current = item.get("is_current", True)
    is_canonical = item.get("is_canonical", False)
    adjusted = score
    if not is_current:
        adjusted *= _SUPERSEDED_PENALTY
    if is_canonical:
        adjusted *= _CANONICAL_BOOST
    return {
        "industry": item["industry"],
        "source_name": item.get("source_name"),
        "doc_type": item.get("doc_type"),
        "apps": doc_apps(item),
        "module": item.get("module") or "",
        "chunk_index": item.get("chunk_index"),
        "text": item.get("text"),
        "score": adjusted,
        "raw_score": score,
        "s3_key": item.get("s3_key", ""),
        "source_url": item.get("source_url", ""),
        "effective_date": item.get("effective_date"),
        "is_current": is_current,
        "is_canonical": is_canonical,
        "aliases": item.get("aliases") or "",
        "region": item.get("region") or "",
        "reviewed": item.get("reviewed", False),
        "client_facing": item.get("client_facing", False),
    }


def search(industry: str, query_vector: list[float], *, top_k: int = 6, app: str | None = None) -> list[dict[str, Any]]:
    """
    Cosine similarity search over one industry's firm-knowledge chunks.

    `app` optionally restricts results to chunks tagged for one platform app
    (e.g. "rfp-reimagine") — callers should always pass their own app id once
    more than one app populates a given industry, so e.g. Blueprint Match
    content never bleeds into RFP Reimagine's retrieval just because both
    happen to be tagged with the same industry. A document can be tagged for
    several apps at once (see doc_apps) — this matches if the caller's app
    is any one of them. Untagged legacy chunks (no apps at all) are excluded
    whenever a filter is given.
    """
    container = _container()
    items = list(container.query_items(
        query="SELECT * FROM c WHERE c.industry = @industry",
        parameters=[{"name": "@industry", "value": industry}],
        partition_key=industry,
    ))

    scored = []
    for item in items:
        if app and app not in doc_apps(item):
            continue
        emb_b64 = item.get("embedding")
        if not emb_b64:
            continue
        score = _cosine_similarity(query_vector, _unpack_vector(emb_b64))
        scored.append(_row_to_result(item, score))

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:top_k]


def search_all_industries(query_vector: list[float], *, top_k: int = 6, app: str | None = None) -> list[dict[str, Any]]:
    """
    Cross-partition variant of `search()` for apps whose content isn't
    meaningfully scoped by client industry — e.g. Ask Stuey's firm-wide
    product/pricing/proposal collateral, which applies the same regardless
    of which industry a consultant happens to be uploading it under. Every
    other consumer (RFP Reimagine, Blueprint Match) should keep using
    `search()` — cross-partition queries are more expensive and would
    silently blend unrelated industries' content together for those.
    """
    container = _container()
    items = list(container.query_items(
        query="SELECT * FROM c",
        enable_cross_partition_query=True,
    ))

    scored = []
    for item in items:
        if app and app not in doc_apps(item):
            continue
        emb_b64 = item.get("embedding")
        if not emb_b64:
            continue
        score = _cosine_similarity(query_vector, _unpack_vector(emb_b64))
        scored.append(_row_to_result(item, score))

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:top_k]


def query_all(industry: str) -> list[dict[str, Any]]:
    """All chunks for an industry (e.g. for an admin content-management view)."""
    return list(_container().query_items(
        query="SELECT * FROM c WHERE c.industry = @industry",
        parameters=[{"name": "@industry", "value": industry}],
        partition_key=industry,
    ))


def list_industries() -> list[str]:
    """Distinct industries with any indexed content — cross-partition, admin/UI use only
    (e.g. showing which industries already have knowledge vs. are empty)."""
    items = list(_container().query_items(
        query="SELECT DISTINCT VALUE c.industry FROM c",
        enable_cross_partition_query=True,
    ))
    return items


def delete_source(industry: str, source_name: str) -> int:
    """Delete every chunk belonging to one uploaded source document."""
    container = _container()
    items = list(container.query_items(
        query="SELECT c.id FROM c WHERE c.industry = @industry AND c.source_name = @source",
        parameters=[
            {"name": "@industry", "value": industry},
            {"name": "@source", "value": source_name},
        ],
        partition_key=industry,
    ))
    for item in items:
        container.delete_item(item=item["id"], partition_key=industry)
    return len(items)


def get_source_chunks(industry: str, source_name: str) -> list[dict[str, Any]]:
    """Every full raw chunk item for one source document — the admin
    metadata-edit flow (admin_industry_docs/handler.py's _update_metadata)
    reads these, mutates the fields that changed, and writes them back via
    save_chunks. Unlike search()/query_all(), returns the raw Cosmos item
    (including the packed `embedding` string) rather than a search-result
    shape, since the caller may need to replace the embedding too."""
    container = _container()
    return list(container.query_items(
        query="SELECT * FROM c WHERE c.industry = @industry AND c.source_name = @source",
        parameters=[
            {"name": "@industry", "value": industry},
            {"name": "@source", "value": source_name},
        ],
        partition_key=industry,
    ))


def save_chunks(chunks: list[dict[str, Any]]) -> None:
    """Upserts already-loaded chunk items back as-is — the write half of
    get_source_chunks, for the metadata-edit flow. Unlike index_chunks, does
    not set chunk_index/created_at/etc.; the caller already has a complete,
    valid item (it came from get_source_chunks) and only mutated specific
    fields."""
    container = _container()
    for item in chunks:
        container.upsert_item(item)


def pack_vector(vec: list[float]) -> str:
    """Public entry point for _pack_vector — used by the metadata-edit flow
    to re-embed a chunk after an aliases change (aliases are folded into the
    embedded text itself, unlike the other tag fields, which are read at
    retrieval/prompt time and don't require touching the vector)."""
    return _pack_vector(vec)


def _pack_vector(vec: list[float]) -> str:
    return base64.b64encode(struct.pack(f"{len(vec)}f", *vec)).decode("ascii")


def _unpack_vector(data: str) -> list[float]:
    raw = base64.b64decode(data)
    count = len(raw) // 4
    return list(struct.unpack(f"{count}f", raw))


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    mag_a = sum(x * x for x in a) ** 0.5
    mag_b = sum(x * x for x in b) ** 0.5
    if mag_a == 0 or mag_b == 0:
        return 0.0
    return dot / (mag_a * mag_b)
