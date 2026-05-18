"""
Test Script Generator — async multi-document, split output.

POST /test-scripts/generate  → validates, stores job record, invokes worker async
                               returns { job_id, status: "processing" } in < 1 s

worker_handler (direct Lambda invocation) → does the actual Bedrock generation,
   updates the job record in DynamoDB with { status: "done", result: {...} }

GET /test-scripts/status/{jobId}  → separate Lambda (test_scripts_status)
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
from common.tenant import TenantContext

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_s3 = boto3.client("s3")
_dynamodb = boto3.resource("dynamodb")
_lambda_client = boto3.client("lambda")
_BUCKET = os.environ["DOCS_BUCKET"]
_VECTOR_TABLE = os.environ["VECTOR_TABLE_NAME"]
_MODEL_ID = os.environ["GENERATION_MODEL_ID"]
_WORKER_FUNCTION_ARN = os.environ.get("GENERATE_TESTS_WORKER_FUNCTION_ARN", "")

MAX_CHARS_PER_DOC = 12_000
MAX_TOTAL_CHARS = 60_000

_SYSTEM_PROMPT = """You are a senior Workday QA architect generating formal test scripts.

You will receive one or more source documents. Each is tagged as either:
- [FUNCTIONAL]: configuration workbooks, business process documents, HR policies, training materials
- [INTEGRATION]: integration design documents (IDDs), interface specs, API/connector documentation

Generate test cases in TWO categories:

## FUNCTIONAL SCENARIO TESTS
- Derive from ALL documents (both FUNCTIONAL and INTEGRATION context)
- Focus on end-to-end business scenarios and user acceptance tests
- Test the system from the user and business process perspective
- Reference actual field values, workflow steps, and configuration from the documents
- Generate 8–15 cases
- IDs: TC-FUNC-001, TC-FUNC-002, ...

## INTEGRATION TESTS
- Derive ONLY from [INTEGRATION] tagged documents
- Focus on technical data flows, trigger conditions, API/connector calls, error handling, and system-to-system validation
- Test boundary conditions, transformation rules, and error scenarios
- Generate 4–8 cases per integration document (if any)
- If NO [INTEGRATION] documents are provided, return an empty array
- IDs: TC-INT-001, TC-INT-002, ...

Return ONLY this exact JSON (no preamble, no markdown fences):
{
  "functional_tests": [
    {
      "id": "TC-FUNC-001",
      "name": "Concise test name",
      "module": "e.g. HCM Core, Payroll, Benefits, Absence, Security",
      "priority": "High",
      "scenario": "Brief business scenario description",
      "prerequisites": ["Prerequisite 1"],
      "steps": [
        {"step": 1, "action": "Navigate to...", "expected": "Screen displays..."}
      ],
      "expected_result": "Overall expected outcome",
      "test_data": "Specific data values needed or N/A"
    }
  ],
  "integration_tests": [
    {
      "id": "TC-INT-001",
      "name": "Concise test name",
      "module": "Integration module name",
      "interface": "Source System → Target System",
      "trigger": "What triggers this integration (e.g. Hire event, scheduled, manual)",
      "priority": "High",
      "prerequisites": ["Prerequisite 1"],
      "steps": [
        {"step": 1, "action": "Trigger...", "expected": "System sends..."}
      ],
      "expected_result": "Overall expected outcome",
      "error_scenarios": ["Empty file: integration should log error and send alert"],
      "test_data": "Specific data values or N/A"
    }
  ]
}

Rules:
- Each test must be specific, executable, and reference actual values from the documents
- Functional tests: think like a business user verifying their processes work correctly
- Integration tests: think like a technical QA engineer verifying data flows correctly
- Cover both happy-path and key error/edge cases
"""


# ── API Gateway entry point ────────────────────────────────────────────────────

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

    source_doc_ids = body.get("source_doc_ids") or []
    if not source_doc_ids and body.get("source_doc_id"):
        source_doc_ids = [body["source_doc_id"]]

    if not source_doc_ids:
        return http.bad_request("source_doc_ids is required")
    if not isinstance(source_doc_ids, list) or len(source_doc_ids) > 20:
        return http.bad_request("source_doc_ids must be a list of up to 20 doc IDs")

    job_id = str(uuid.uuid4())
    table = _dynamodb.Table(_VECTOR_TABLE)

    table.put_item(Item={
        "tenant_id": ctx.tenant_id,
        "chunk_id": f"job#{job_id}",
        "doc_type": "_job",
        "job_type": "generate_tests",
        "status": "processing",
        "source_doc_ids": source_doc_ids,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "ttl": int(time.time()) + 3600,
    })

    worker_payload = {
        "job_id": job_id,
        "tenant_id": ctx.tenant_id,
        "user_id": ctx.user_id,
        "role": ctx.role,
        "email": ctx.email,
        "source_doc_ids": source_doc_ids,
        "ip": audit_events.get_ip(event),
    }

    if not _WORKER_FUNCTION_ARN:
        log.error("GENERATE_TESTS_WORKER_FUNCTION_ARN not configured")
        return http.server_error("Worker function not configured")

    _lambda_client.invoke(
        FunctionName=_WORKER_FUNCTION_ARN,
        InvocationType="Event",
        Payload=json.dumps(worker_payload).encode(),
    )

    log.info("generate_tests job=%s tenant=%s docs=%d enqueued", job_id, ctx.tenant_id, len(source_doc_ids))
    return http.ok({"job_id": job_id, "status": "processing"})


# ── Worker entry point (direct Lambda invocation, async) ──────────────────────

def worker_handler(event, context):
    job_id = event["job_id"]
    tenant_id = event["tenant_id"]
    source_doc_ids = event["source_doc_ids"]
    ip = event.get("ip", "unknown")

    ctx = TenantContext(
        tenant_id=tenant_id,
        user_id=event.get("user_id", ""),
        role=event.get("role", "consultant"),
        email=event.get("email", ""),
    )

    table = _dynamodb.Table(_VECTOR_TABLE)

    try:
        result = _generate(ctx, source_doc_ids, table)

        audit_events.write(
            ctx,
            "ai.generate_tests",
            ip=ip,
            resource_type="document",
            resource_id=result["doc_id"],
            resource_name=result["source_name"],
            details={
                "source_doc_ids": source_doc_ids,
                "doc_count": result.get("doc_count", len(source_doc_ids)),
                "functional_count": result["functional_count"],
                "integration_count": result["integration_count"],
                "model_id": _MODEL_ID,
                "latency_ms": result["latency_ms"],
            },
        )

        table.update_item(
            Key={"tenant_id": tenant_id, "chunk_id": f"job#{job_id}"},
            UpdateExpression="SET #s = :s, #r = :r",
            ExpressionAttributeNames={"#s": "status", "#r": "result"},
            ExpressionAttributeValues={":s": "done", ":r": json.dumps(result)},
        )
        log.info(
            "worker done job=%s tenant=%s functional=%d integration=%d latency=%dms",
            job_id, tenant_id, result["functional_count"], result["integration_count"], result["latency_ms"],
        )

    except Exception as e:
        log.error("worker error job=%s: %s", job_id, e, exc_info=True)
        table.update_item(
            Key={"tenant_id": tenant_id, "chunk_id": f"job#{job_id}"},
            UpdateExpression="SET #s = :s, #e = :e",
            ExpressionAttributeNames={"#s": "status", "#e": "error"},
            ExpressionAttributeValues={":s": "error", ":e": str(e)},
        )


# ── Core generation logic (shared) ────────────────────────────────────────────

def _generate(ctx: TenantContext, source_doc_ids: list[str], table) -> dict:
    chars_per_doc = min(MAX_CHARS_PER_DOC, MAX_TOTAL_CHARS // max(len(source_doc_ids), 1))

    docs: list[dict] = []
    for doc_id in source_doc_ids:
        chunks = _load_chunks_by_doc(table, ctx.tenant_id, doc_id)
        if not chunks:
            log.warning("doc %s not found for tenant %s", doc_id, ctx.tenant_id)
            continue
        name = chunks[0].get("source_name", "Document")
        text = _join_chunks(chunks, chars_per_doc)
        is_integration = _is_integration_doc(chunks[0])
        docs.append({"name": name, "text": text, "is_integration": is_integration})

    if not docs:
        raise ValueError("No valid source documents found")

    doc_blocks = []
    for d in docs:
        tag = "INTEGRATION" if d["is_integration"] else "FUNCTIONAL"
        doc_blocks.append(f'<document type="{tag}" name="{d["name"]}">\n{d["text"]}\n</document>')

    has_integration = any(d["is_integration"] for d in docs)
    doc_names = [d["name"] for d in docs]

    user_prompt = (
        f"Generate test scripts from the following {len(docs)} document(s).\n\n"
        + "\n\n".join(doc_blocks)
        + "\n\n"
        + ("NOTE: Integration documents are included — generate both functional and integration tests.\n"
           if has_integration else
           "NOTE: No integration documents — return an empty array for integration_tests.\n")
    )

    t0 = time.time()
    result_json = bedrock.generate_json(_SYSTEM_PROMPT, user_prompt, max_tokens=6000, temperature=0.1)
    latency_ms = int((time.time() - t0) * 1000)

    functional_tests = result_json.get("functional_tests", [])
    integration_tests = result_json.get("integration_tests", [])
    total = len(functional_tests) + len(integration_tests)

    if total == 0:
        raise ValueError("No test cases were generated")

    now = datetime.now(timezone.utc)
    doc_text = _format_test_script(doc_names, functional_tests, integration_tests, now)

    if len(docs) == 1:
        base_name = docs[0]["name"].rsplit(".", 1)[0]
        script_name = f"Test Scripts — {base_name}.txt"
    else:
        date_str = now.strftime("%d %b %Y")
        script_name = f"Test Scripts — {len(docs)} documents — {date_str}.txt"

    new_doc_id = str(uuid.uuid4())
    first_chunks = _load_chunks_by_doc(table, ctx.tenant_id, source_doc_ids[0])
    source_module = first_chunks[0].get("module", "unknown") if first_chunks else "unknown"
    source_folder = first_chunks[0].get("folder_path", "/") if first_chunks else "/"
    s3_key = f"tenants/{ctx.tenant_id}/generated/{new_doc_id}/{script_name}"

    _s3.put_object(
        Bucket=_BUCKET,
        Key=s3_key,
        Body=doc_text.encode("utf-8"),
        ContentType="text/plain",
    )

    all_chunks = _chunk_tests(
        functional_tests, integration_tests,
        new_doc_id, script_name, source_module, source_folder, s3_key, now.isoformat(),
    )
    for c in all_chunks:
        c["embedding"] = bedrock.embed(c["text"])

    vectors.index_chunks(ctx, all_chunks)

    return {
        "doc_id": new_doc_id,
        "source_name": script_name,
        "functional_count": len(functional_tests),
        "integration_count": len(integration_tests),
        "total_count": total,
        "test_count": total,
        "test_type": "functional+integration" if has_integration else "functional",
        "latency_ms": latency_ms,
        "doc_count": len(docs),
    }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _is_integration_doc(chunk: dict) -> bool:
    module = (chunk.get("module") or "").lower()
    folder = (chunk.get("folder_path") or "").lower()
    doc_type = (chunk.get("doc_type") or "").lower()
    return "integration" in module or "integration" in folder or "integration" in doc_type


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


def _format_test_script(
    doc_names: list[str],
    functional_tests: list[dict],
    integration_tests: list[dict],
    now: datetime,
) -> str:
    sep = "═" * 64
    thin = "─" * 64
    lines = [
        "TEST SCRIPTS",
        thin,
        f"Source Documents: {', '.join(doc_names)}",
        f"Generated:        {now.strftime('%d %b %Y %H:%M UTC')}",
        f"Functional Tests: {len(functional_tests)}",
        f"Integration Tests: {len(integration_tests)}",
        f"Total:            {len(functional_tests) + len(integration_tests)}",
        "",
    ]

    if functional_tests:
        lines += [sep, f"PART 1: FUNCTIONAL SCENARIO TESTS  ({len(functional_tests)} cases)", sep, ""]
        for tc in functional_tests:
            lines += _format_functional(tc)

    if integration_tests:
        lines += [sep, f"PART 2: INTEGRATION TESTS  ({len(integration_tests)} cases)", sep, ""]
        for tc in integration_tests:
            lines += _format_integration(tc)

    lines.append(sep)
    return "\n".join(lines)


def _format_functional(tc: dict) -> list[str]:
    lines = [
        f"{tc.get('id', 'TC-FUNC-001')}  {tc.get('name', '')}",
        f"Module: {tc.get('module', '')}  |  Priority: {tc.get('priority', '')}",
        f"Scenario: {tc.get('scenario', '')}",
        "",
    ]
    prereqs = tc.get("prerequisites", [])
    if prereqs:
        lines.append("PREREQUISITES:")
        for p in prereqs:
            lines.append(f"  • {p}")
        lines.append("")
    for s in tc.get("steps", []):
        lines.append(f"  {s.get('step')}. {s.get('action', '')}")
        lines.append(f"     Expected: {s.get('expected', '')}")
    lines += [
        "",
        f"EXPECTED RESULT: {tc.get('expected_result', '')}",
        f"TEST DATA: {tc.get('test_data', 'N/A')}",
        "",
        "RESULT:  [ ] Pass   [ ] Fail   [ ] Blocked",
        "TESTER: ___________________________   DATE: ___________",
        "",
    ]
    return lines


def _format_integration(tc: dict) -> list[str]:
    lines = [
        f"{tc.get('id', 'TC-INT-001')}  {tc.get('name', '')}",
        f"Module: {tc.get('module', '')}  |  Priority: {tc.get('priority', '')}",
        f"Interface: {tc.get('interface', '')}",
        f"Trigger:   {tc.get('trigger', '')}",
        "",
    ]
    prereqs = tc.get("prerequisites", [])
    if prereqs:
        lines.append("PREREQUISITES:")
        for p in prereqs:
            lines.append(f"  • {p}")
        lines.append("")
    for s in tc.get("steps", []):
        lines.append(f"  {s.get('step')}. {s.get('action', '')}")
        lines.append(f"     Expected: {s.get('expected', '')}")
    lines.append("")
    errors = tc.get("error_scenarios", [])
    if errors:
        lines.append("ERROR SCENARIOS:")
        for e in errors:
            lines.append(f"  • {e}")
        lines.append("")
    lines += [
        f"EXPECTED RESULT: {tc.get('expected_result', '')}",
        f"TEST DATA: {tc.get('test_data', 'N/A')}",
        "",
        "RESULT:  [ ] Pass   [ ] Fail   [ ] Blocked",
        "TESTER: ___________________________   DATE: ___________",
        "",
    ]
    return lines


def _chunk_tests(
    functional_tests: list[dict],
    integration_tests: list[dict],
    doc_id: str,
    source_name: str,
    module: str,
    folder_path: str,
    s3_key: str,
    created_at: str,
) -> list[dict]:
    chunks = []
    idx = 0
    for tc in functional_tests:
        steps_text = "\n".join(
            f"Step {s.get('step')}: {s.get('action')} → {s.get('expected')}"
            for s in tc.get("steps", [])
        )
        text = (
            f"{tc.get('id')} — {tc.get('name')}\n"
            f"Type: Functional | Module: {tc.get('module')} | Priority: {tc.get('priority')}\n"
            f"Scenario: {tc.get('scenario', '')}\n"
            f"{steps_text}\n"
            f"Expected: {tc.get('expected_result')}\n"
            f"Test Data: {tc.get('test_data', 'N/A')}"
        )
        chunks.append(_make_chunk(doc_id, idx, source_name, module, folder_path, s3_key, created_at, text))
        idx += 1

    for tc in integration_tests:
        steps_text = "\n".join(
            f"Step {s.get('step')}: {s.get('action')} → {s.get('expected')}"
            for s in tc.get("steps", [])
        )
        errors_text = "; ".join(tc.get("error_scenarios", []))
        text = (
            f"{tc.get('id')} — {tc.get('name')}\n"
            f"Type: Integration | Module: {tc.get('module')} | Priority: {tc.get('priority')}\n"
            f"Interface: {tc.get('interface', '')} | Trigger: {tc.get('trigger', '')}\n"
            f"{steps_text}\n"
            f"Expected: {tc.get('expected_result')}\n"
            f"Error Scenarios: {errors_text or 'N/A'}\n"
            f"Test Data: {tc.get('test_data', 'N/A')}"
        )
        chunks.append(_make_chunk(doc_id, idx, source_name, module, folder_path, s3_key, created_at, text))
        idx += 1

    return chunks


def _make_chunk(
    doc_id: str, chunk_index: int, source_name: str,
    module: str, folder_path: str, s3_key: str, created_at: str, text: str,
) -> dict:
    return {
        "doc_id": doc_id,
        "chunk_index": chunk_index,
        "source_name": source_name,
        "doc_type": "test-script",
        "module": module,
        "folder_path": folder_path,
        "s3_key": s3_key,
        "published": False,
        "created_at": created_at,
        "text": text,
    }
