"""
One-off script: embed and load the curated ASOR/Sana corpus markdown files
under corpus/pi_capabilities/ into the shared pi.grounding_corpus table.

Not a Lambda — run locally with AWS credentials for the target account.
Reuses the existing chunking strategy (lambdas/common/chunking.py) and the
Titan embedding model already used elsewhere in the app, so retrieval quality
matches the rest of the RAG pipeline.

Usage:
    python scripts/seed_pi_grounding_corpus.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import boto3

REPO_ROOT = Path(__file__).resolve().parent.parent
CORPUS_DIR = REPO_ROOT / "corpus" / "pi_capabilities"

# bedrock.py reads these at import time.
os.environ.setdefault("EMBEDDING_MODEL_ID", "amazon.titan-embed-text-v2:0")
os.environ.setdefault("EMBEDDING_DIM", "1024")
os.environ.setdefault("GENERATION_MODEL_ID", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")
# common/__init__.py eagerly imports every module (dynamo_vectors, audit, etc.) which
# read their own env vars at import time even though this script never calls them.
os.environ.setdefault("VECTOR_TABLE_NAME", "unused-not-called-by-this-script")
os.environ.setdefault("AUDIT_TABLE_NAME", "unused-not-called-by-this-script")
os.environ.setdefault("CONFIG_TABLE_NAME", "unused-not-called-by-this-script")
os.environ.setdefault(
    "DB_CLUSTER_ARN",
    "arn:aws:rds:us-east-1:893361712185:cluster:workdayaiplatformstack-db5d02a0a9-7gp0sv8iihlx",
)
os.environ.setdefault(
    "DB_SECRET_ARN",
    "arn:aws:secretsmanager:us-east-1:893361712185:secret:DbSecret685A0FA5-42pEl7lNn5Jt-BiFLe8",
)
os.environ.setdefault("DB_NAME", "platform")

sys.path.insert(0, str(REPO_ROOT / "lambdas"))
from common import chunking, bedrock  # noqa: E402

DB_CLUSTER_ARN = os.environ.get(
    "DB_CLUSTER_ARN",
    "arn:aws:rds:us-east-1:893361712185:cluster:workdayaiplatformstack-db5d02a0a9-7gp0sv8iihlx",
)
DB_SECRET_ARN = os.environ.get(
    "DB_SECRET_ARN",
    "arn:aws:secretsmanager:us-east-1:893361712185:secret:DbSecret685A0FA5-42pEl7lNn5Jt-BiFLe8",
)
DATABASE = os.environ.get("DATABASE", "platform")
REGION = os.environ.get("REGION", "us-east-1")

_rds_data = boto3.client("rds-data", region_name=REGION)


def _vector_literal(vec: list[float]) -> str:
    return "[" + ",".join(repr(float(x)) for x in vec) + "]"


def _insert_chunk(source_document: str, chunk_index: int, chunk_text: str, embedding: list[float]) -> None:
    _rds_data.execute_statement(
        resourceArn=DB_CLUSTER_ARN,
        secretArn=DB_SECRET_ARN,
        database=DATABASE,
        sql="""
            INSERT INTO pi.grounding_corpus (source_document, chunk_index, chunk_text, embedding)
            VALUES (:source_document, :chunk_index, :chunk_text, :embedding::vector)
        """,
        parameters=[
            {"name": "source_document", "value": {"stringValue": source_document}},
            {"name": "chunk_index", "value": {"longValue": chunk_index}},
            {"name": "chunk_text", "value": {"stringValue": chunk_text}},
            # No typeHint: a plain string param, cast to ::vector by the SQL itself.
            # (Do NOT rely on auto JSON-detection here — see db.py fix for why.)
            {"name": "embedding", "value": {"stringValue": _vector_literal(embedding)}},
        ],
    )


def main() -> None:
    md_files = sorted(CORPUS_DIR.glob("*.md"))
    if not md_files:
        print(f"No .md files found in {CORPUS_DIR}", file=sys.stderr)
        sys.exit(1)

    total_chunks = 0
    for path in md_files:
        source_document = path.name
        text = path.read_text(encoding="utf-8")
        chunks = chunking.chunk_text_document(
            text, doc_type="pi_capability", source_name=source_document, module="process_intelligence"
        )
        print(f"{source_document}: {len(chunks)} chunks")
        for c in chunks:
            embedding = bedrock.embed(c["text"])
            _insert_chunk(source_document, c["chunk_index"], c["text"], embedding)
        total_chunks += len(chunks)

    print(f"Done. Inserted {total_chunks} chunks from {len(md_files)} documents.")


if __name__ == "__main__":
    main()
