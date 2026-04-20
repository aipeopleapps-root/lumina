"""
OpenSearch Serverless wrapper — all reads and writes go through this module.

Every public function takes a TenantContext and enforces the tenant_id
filter. There is no way to query the collection without a tenant scope.
"""

from __future__ import annotations

import logging
import os
import uuid
from typing import Any

import boto3
from opensearchpy import AWSV4SignerAuth, OpenSearch, RequestsHttpConnection

from .tenant import TenantContext

log = logging.getLogger(__name__)

_ENDPOINT = os.environ["AOSS_ENDPOINT"].replace("https://", "")
_INDEX = os.environ["AOSS_INDEX"]
_EMBEDDING_DIM = int(os.environ.get("EMBEDDING_DIM", "1024"))
_REGION = os.environ.get("AWS_REGION", "us-east-1")

_credentials = boto3.Session().get_credentials()
_auth = AWSV4SignerAuth(_credentials, _REGION, "aoss")

_client = OpenSearch(
    hosts=[{"host": _ENDPOINT, "port": 443}],
    http_auth=_auth,
    use_ssl=True,
    verify_certs=True,
    connection_class=RequestsHttpConnection,
    timeout=30,
)


def ensure_index() -> None:
    """Create the k-NN index if it does not already exist. Idempotent."""
    if _client.indices.exists(index=_INDEX):
        return
    _client.indices.create(
        index=_INDEX,
        body={
            "settings": {"index": {"knn": True}},
            "mappings": {
                "properties": {
                    "tenant_id": {"type": "keyword"},
                    "doc_id": {"type": "keyword"},
                    "doc_type": {"type": "keyword"},  # workbook | bp-workbook | integration | kb
                    "module": {"type": "keyword"},    # HCM | Absence | Payroll | ...
                    "source_name": {"type": "keyword"},
                    "chunk_index": {"type": "integer"},
                    "text": {"type": "text"},
                    "embedding": {
                        "type": "knn_vector",
                        "dimension": _EMBEDDING_DIM,
                        "method": {
                            "name": "hnsw",
                            "space_type": "cosinesimil",
                            "engine": "faiss",
                        },
                    },
                    "created_at": {"type": "date"},
                }
            },
        },
    )
    log.info("created vector index %s", _INDEX)


def index_chunks(ctx: TenantContext, chunks: list[dict[str, Any]]) -> int:
    """
    Bulk-index chunks. Every chunk has the caller's tenant_id stamped on it
    here — callers cannot forge a different tenant_id.
    """
    if not chunks:
        return 0

    actions = []
    for c in chunks:
        doc = {
            # FORCE tenant_id from context. Any tenant_id in the input is ignored.
            "tenant_id": ctx.tenant_id,
            "doc_id": c["doc_id"],
            "doc_type": c.get("doc_type", "unknown"),
            "module": c.get("module"),
            "source_name": c.get("source_name"),
            "chunk_index": c["chunk_index"],
            "text": c["text"],
            "embedding": c["embedding"],
            "created_at": c.get("created_at"),
        }
        # AOSS requires _id to be auto-generated on bulk (no custom _id).
        actions.append({"index": {"_index": _INDEX}})
        actions.append(doc)

    resp = _client.bulk(body=actions, refresh=False)
    if resp.get("errors"):
        failed = [item for item in resp["items"] if "error" in item.get("index", {})]
        log.error("bulk index had %d failures; first: %s", len(failed), failed[:1])
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
    k-NN search scoped to the caller's tenant. Returns a list of hit dicts
    with text + metadata + score. The tenant filter is non-negotiable —
    it is AND-ed into every query here.
    """
    filters: list[dict[str, Any]] = [ctx.opensearch_filter()]
    if doc_type:
        filters.append({"term": {"doc_type": doc_type}})
    if module:
        filters.append({"term": {"module": module}})

    body = {
        "size": top_k,
        "query": {
            "bool": {
                "filter": filters,
                "must": [
                    {
                        "knn": {
                            "embedding": {
                                "vector": query_vector,
                                "k": top_k,
                            }
                        }
                    }
                ],
            }
        },
        "_source": ["tenant_id", "doc_id", "doc_type", "module", "source_name", "chunk_index", "text"],
    }
    resp = _client.search(index=_INDEX, body=body)
    hits = []
    for h in resp.get("hits", {}).get("hits", []):
        src = h["_source"]
        # Defense in depth: verify what came back really does belong to
        # the caller. This should never fail — if it does, we stop.
        if src.get("tenant_id") != ctx.tenant_id:
            log.error(
                "AOSS returned cross-tenant hit: expected=%s got=%s id=%s",
                ctx.tenant_id, src.get("tenant_id"), h.get("_id"),
            )
            raise RuntimeError("tenant isolation violated at AOSS layer")
        hits.append({**src, "score": h["_score"]})
    return hits
