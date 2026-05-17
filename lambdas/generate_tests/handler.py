"""
Test Script Generator: reads a config workbook or project document and
generates SIT/UAT test scripts, saves them to S3, and indexes them in
DynamoDB as a draft document ready for consultant review and publishing.

POST /test-scripts/generate
Body: { "source_doc_id": "...", "test_type": "sit" | "uat" | "both" }
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key

from common import tenant_from_event, TenantError, bedrock, audit_events, http
from common import dynamo_vectors as vectors

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_s3 = boto3.client("s3")
_dynamodb = boto3.resource("dynamodb")
_BUCKET = os.environ["DOCS_BUCKET"]
_VECTOR_TABLE = os.environ["VECTOR_TABLE_NAME"]
_MODEL_ID = os.environ["GENERATION_MODEL_ID"]

MAX_SOURCE_CHARS = 30_000

_SYSTEM_PROMPT = """You are a senior Workday QA architect generating formal test scripts.

Given a Workday configuration document, generate comprehensive test cases.

Return ONLY this exact JSON structure (no preamble, no markdown):
{
  "test_cases": [
    {
      "id": "TC-XXX-001",
      "name": "Concise test case name",
      "type": "SIT" | "UAT",
      "module": "Module name (e.g. HCM Core, Payroll, Benefits, Absence, Security)",
      "priority": "High" | "Medium" | "Low",
      "prerequisites": ["Prerequisite 1", "Prerequisite 2"],
      "steps": [
        {"step": 1, "action": "Navigate to...", "expected": "Screen displays..."},
        {"step": 2, "action": "Enter...", "expected": "Field accepts..."}
      ],
      "expected_result": "Overall expected outcome",
      "test_data": "Any specific data values needed (or 'N/A')"
    }
  ]
}

Rules:
- Generate 8-15 test cases covering the most important configuration areas
- SIT: focus on technical integration, data flow, system behaviour
- UAT: focus on business process, user journeys, real scenarios
- Each test must be specific and executable — not generic
- Reference actual values/settings from the source document where possible
- Cover both happy-path and key error/edge cases
- ID format: TC-SIT-001 or TC-UAT-001 with sequential numbers
"""


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    source_doc_id = (body.get("source_doc_id") or "").strip()
    test_type = (body.get("test_type") or "both").strip().lower()

    if not source_doc_id:
        return http.bad_request("source_doc_id is required")
    if test_type not in ("sit", "uat", "both"):
        return http.bad_request("test_type must be sit, uat, or both")

    table = _dynamodb.Table(_VECTOR_TABLE)

    # Load source document
    source_chunks = _load_chunks_by_doc(table, ctx.tenant_id, source_doc_id)
    if not source_chunks:
        return http.bad_request("Source document not found or has no indexed content")

    source_name = source_chunks[0].get("source_name", "Document")
    source_module = source_chunks[0].get("module", "unknown")
    source_folder = source_chunks[0].get("folder_path", "/")
    source_text = _join_chunks(source_chunks, MAX_SOURCE_CHARS)

    type_label = test_type.upper() if test_type != "both" else "SIT & UAT"
    user_prompt = (
        f"Generate {type_label} test scripts for the following Workday configuration document.\n\n"
        f'<document name="{source_name}">\n{source_text}\n</document>\n\n'
        + (f"Generate only {test_type.upper()} test cases.\n" if test_type != "both" else
           "Generate a mix of SIT and UAT test cases.\n")
    )

    t0 = time.time()
    try:
        result = bedrock.generate_json(_SYSTEM_PROMPT, user_prompt, max_tokens=4096, temperature=0.1)
    except ValueError as e:
        log.error("generate_tests model output error: %s", e)
        return http.server_error(f"Model output error: {e}")
    except Exception as e:
        log.error("generate_tests Bedrock error: %s", e, exc_info=True)
        return http.server_error(f"AI generation failed: {e}")

    latency_ms = int((time.time() - t0) * 1000)
    test_cases = result.get("test_cases", [])

    if not test_cases:
        return http.server_error("No test cases were generated")

    # Format as plain-text document
    doc_text = _format_test_script(source_name, type_label, test_cases)

    # Save to S3
    new_doc_id = str(uuid.uuid4())
    script_name = f"Test Scripts — {source_name} — {type_label}.txt"
    s3_key = f"tenants/{ctx.tenant_id}/generated/{new_doc_id}/{script_name}"

    _s3.put_object(
        Bucket=_BUCKET,
        Key=s3_key,
        Body=doc_text.encode("utf-8"),
        ContentType="text/plain",
    )

    # Chunk, embed, index in DynamoDB as draft
    now_iso = datetime.now(timezone.utc).isoformat()
    chunks = _chunk_test_script(test_cases, new_doc_id, script_name, source_module, source_folder, s3_key, now_iso)

    try:
        for c in chunks:
            c["embedding"] = bedrock.embed(c["text"])
    except Exception as e:
        log.error("generate_tests embedding error: %s", e, exc_info=True)
        return http.server_error(f"Embedding failed: {e}")

    indexed = vectors.index_chunks(ctx, chunks)

    audit_events.write(
        ctx,
        "ai.generate_tests",
        ip=audit_events.get_ip(event),
        resource_type="document",
        resource_id=new_doc_id,
        resource_name=script_name,
        details={
            "source_doc_id": source_doc_id,
            "source_name": source_name,
            "test_type": test_type,
            "test_count": len(test_cases),
            "model_id": _MODEL_ID,
            "latency_ms": latency_ms,
        },
    )

    log.info(
        "generate_tests tenant=%s source=%s type=%s cases=%d latency=%dms",
        ctx.tenant_id, source_name, test_type, len(test_cases), latency_ms,
    )

    return http.ok({
        "doc_id": new_doc_id,
        "source_name": script_name,
        "test_count": len(test_cases),
        "test_type": test_type,
        "latency_ms": latency_ms,
    })


# ── Helpers ──────────────────────────────────────────────────────────────────

def _load_chunks_by_doc(table, tenant_id: str, doc_id: str) -> list[dict]:
    resp = table.query(
        IndexName="doc_id-index",
        KeyConditionExpression=Key("doc_id").eq(doc_id),
    )
    items = [i for i in resp.get("Items", []) if i.get("tenant_id") == tenant_id]
    items.sort(key=lambda x: int(x.get("chunk_index", 0)))
    return items


def _join_chunks(chunks: list[dict], max_chars: int) -> str:
    parts, total = [], 0
    for c in chunks:
        text = c.get("text", "")
        if total + len(text) > max_chars:
            parts.append("...(truncated)")
            break
        parts.append(text)
        total += len(text)
    return "\n\n".join(parts)


def _format_test_script(source_name: str, type_label: str, test_cases: list[dict]) -> str:
    lines = [
        f"TEST SCRIPTS — {type_label}",
        f"Source Document: {source_name}",
        f"Generated: {datetime.now(timezone.utc).strftime('%d %b %Y %H:%M UTC')}",
        f"Total Test Cases: {len(test_cases)}",
        "",
    ]
    sep = "═" * 60

    for tc in test_cases:
        lines += [
            sep,
            f"{tc.get('id', 'TC-001')}  {tc.get('name', '')}",
            f"Type: {tc.get('type', '')}  |  Module: {tc.get('module', '')}  |  Priority: {tc.get('priority', '')}",
            "",
        ]
        prereqs = tc.get("prerequisites", [])
        if prereqs:
            lines.append("PREREQUISITES:")
            for p in prereqs:
                lines.append(f"  • {p}")
            lines.append("")

        steps = tc.get("steps", [])
        if steps:
            lines.append("TEST STEPS:")
            for s in steps:
                lines.append(f"  {s.get('step', '')}. {s.get('action', '')}")
                lines.append(f"     Expected: {s.get('expected', '')}")
            lines.append("")

        lines += [
            f"EXPECTED RESULT: {tc.get('expected_result', '')}",
            f"TEST DATA: {tc.get('test_data', 'N/A')}",
            "",
            "RESULT:  [ ] Pass   [ ] Fail   [ ] Blocked",
            "TESTER: ___________________________   DATE: ___________",
            "NOTES: ",
            "",
        ]

    lines.append(sep)
    return "\n".join(lines)


def _chunk_test_script(
    test_cases: list[dict],
    doc_id: str,
    source_name: str,
    module: str,
    folder_path: str,
    s3_key: str,
    created_at: str,
) -> list[dict]:
    """One chunk per test case for fine-grained retrieval."""
    chunks = []
    for i, tc in enumerate(test_cases):
        steps_text = "\n".join(
            f"Step {s.get('step')}: {s.get('action')} → {s.get('expected')}"
            for s in tc.get("steps", [])
        )
        prereqs_text = "; ".join(tc.get("prerequisites", []))
        text = (
            f"{tc.get('id')} — {tc.get('name')}\n"
            f"Type: {tc.get('type')} | Module: {tc.get('module')} | Priority: {tc.get('priority')}\n"
            f"Prerequisites: {prereqs_text or 'None'}\n"
            f"{steps_text}\n"
            f"Expected: {tc.get('expected_result')}\n"
            f"Test Data: {tc.get('test_data', 'N/A')}"
        )
        chunks.append({
            "doc_id": doc_id,
            "chunk_index": i,
            "source_name": source_name,
            "doc_type": "test-script",
            "module": module,
            "folder_path": folder_path,
            "s3_key": s3_key,
            "published": False,
            "created_at": created_at,
            "text": text,
        })
    return chunks
