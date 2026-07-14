"""
Process Intelligence — parse trigger + async parse worker.

Trigger:  POST /process-intelligence/{process_id}/parse
  Role: consultant | admin
  Updates parse_status → 'parsing', invokes worker async.
  Returns: { process_id, status: "parsing" }

Worker:   direct Lambda invocation (InvocationType=Event)
  Downloads .vsdx from S3, parses OpenXML, classifies via Bedrock,
  stores full graph in Aurora.
"""

from __future__ import annotations

import io
import json
import logging
import os
import time
import uuid
import zipfile
import xml.etree.ElementTree as ET

import boto3

from common import tenant_from_event, TenantError, bedrock, audit_events, http
from common.tenant import TenantContext
from common.pi_aurora import (
    get_process_graph_status,
    update_parse_status,
    store_graph,
)

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_s3 = boto3.client("s3")
_lambda_client = boto3.client("lambda")
_BUCKET = os.environ["DOCS_BUCKET"]
_WORKER_FUNCTION_ARN = os.environ.get("PI_PARSE_WORKER_FUNCTION_ARN", "")

_NS = "http://schemas.microsoft.com/office/visio/2012/main"
_TAG = lambda name: f"{{{_NS}}}{name}"  # noqa: E731

# Statuses from which re-parse is allowed
_REPARSEABLE = {"uploading", "needs_review", "failed", "ready"}

_CLASSIFY_SYSTEM = """You are a Workday process intelligence specialist. \
You will receive a list of shapes and connectors extracted from a Visio swimlane \
diagram for a Workday implementation process.

Classify the diagram and return a JSON object with this exact structure:
{
  "swimlanes": [
    {
      "shape_id": "string",
      "label": "human-readable lane name",
      "persona": "normalized persona (e.g. HR Business Partner, Employee, IT, Manager, Payroll Specialist)",
      "position": 0
    }
  ],
  "steps": [
    {
      "shape_id": "string",
      "label": "cleaned, normalized step label (fix typos, keep concise)",
      "step_type": "manual|system|decision|approval|wait",
      "systems_touched": ["Workday", "ServiceNow"],
      "lane_shape_id": "parent group shape_id or null if unassigned",
      "ai_opportunity": "sana_agent|workday_native|partial_ai|human_only",
      "ai_rationale": "1-2 sentence explanation naming the specific Sana agent or why human involvement is required",
      "parse_confidence": 0.95
    }
  ],
  "overall_confidence": 0.87,
  "warnings": [
    {"shape_id": "string", "field": "step_type", "message": "reason confidence is low"}
  ]
}

Rules:
- step_type: 'system' if automated/system-driven; 'decision' if a diamond/Yes-No branch;
  'approval' if requires explicit approval; 'wait' if a delay/wait state; else 'manual'
- systems_touched: extract Workday module names or other system names from the label.
  Common: Workday HCM, Workday Payroll, ServiceNow, DocuSign, Greenhouse, etc.
  Return empty array [] if none mentioned.
- ai_opportunity: assess the automation potential of each step using CURRENT Workday AI terminology.
  Workday's AI brand is now "Sana" (Illuminate is retired). Sana agents include: Talent Acquisition Agent,
  Payroll Agent, Self-Service Agent, Talent Mobility Agent, and others embedded in HCM/Finance.
    'sana_agent'      — A specific Sana agent can autonomously execute this step end-to-end, OR
                        the Self-Service Agent handles it conversationally/as self-service.
                        Use this for: automated approvals, data entry, notifications, screening,
                        payroll actions, candidate routing, employee self-service queries, PTO requests,
                        benefit lookups, and any step a named Workday agent can run without human input.
    'workday_native'  — Standard Workday Business Process Framework automation handles this without
                        additional AI (rule-based routing, automatic calculations, system updates).
    'partial_ai'      — A Sana agent can assist or pre-populate but a human decision is still required
                        (complex approvals, exceptions, judgment calls with AI-prepared context).
    'human_only'      — Requires irreplaceable human judgment, relationship, or physical action.
- ai_rationale: specific, actionable 1-2 sentence explanation referencing the step's actual content.
  For sana_agent: name the specific Sana agent (e.g. "Talent Acquisition Agent", "Self-Service Agent",
  "Payroll Agent") and exactly what it would do for this step. Do NOT say "Illuminate".
  For human_only: explain what makes automation inappropriate here.
- parse_confidence per step: 1.0 = certain, 0.7 = some ambiguity, <0.7 = flag as warning
- overall_confidence: weighted average of step confidences
- warnings: only for steps where parse_confidence < 0.7"""


# ── Trigger handler (API Gateway) ─────────────────────────────────────────────

def handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    process_id = (event.get("pathParameters") or {}).get("process_id", "")
    if not process_id:
        return http.bad_request("process_id path parameter is required")

    # Verify ownership and get s3_key
    graph_meta = get_process_graph_status(
        process_id=process_id, tenant_id=ctx.tenant_id
    )
    if not graph_meta:
        return http.bad_request("process graph not found")

    if graph_meta["parse_status"] not in _REPARSEABLE:
        return http.bad_request(
            f"cannot re-parse a graph with status '{graph_meta['parse_status']}'"
        )

    s3_key = graph_meta["source_file_s3_key"]

    update_parse_status(
        process_id=process_id,
        tenant_id=ctx.tenant_id,
        status="parsing",
    )

    if not _WORKER_FUNCTION_ARN:
        log.error("PI_PARSE_WORKER_FUNCTION_ARN not configured")
        return http.server_error("parse worker not configured")

    worker_payload = {
        "process_id": process_id,
        "tenant_id":  ctx.tenant_id,
        "user_id":    ctx.user_id,
        "role":       ctx.role,
        "email":      ctx.email,
        "domain":     graph_meta["domain"],
        "source_name": graph_meta["source_name"],
        "s3_key":     s3_key,
        "ip":         audit_events.get_ip(event),
    }

    _lambda_client.invoke(
        FunctionName=_WORKER_FUNCTION_ARN,
        InvocationType="Event",
        Payload=json.dumps(worker_payload).encode(),
    )

    log.info(
        "pi_parse triggered process_id=%s tenant=%s domain=%s",
        process_id, ctx.tenant_id, graph_meta["domain"],
    )

    return http.ok({"process_id": process_id, "status": "parsing"})


# ── Worker handler (direct Lambda invocation) ─────────────────────────────────

def worker_handler(event: dict, context: object) -> None:
    process_id  = event["process_id"]
    tenant_id   = event["tenant_id"]
    domain      = event["domain"]
    source_name = event["source_name"]
    s3_key      = event["s3_key"]
    ip          = event.get("ip", "unknown")

    ctx = TenantContext(
        tenant_id=tenant_id,
        user_id=event.get("user_id", ""),
        role=event.get("role", "consultant"),
        email=event.get("email", ""),
    )

    t0 = time.time()
    try:
        # 1. Download .vsdx from S3
        obj = _s3.get_object(Bucket=_BUCKET, Key=s3_key)
        vsdx_bytes = obj["Body"].read()

        # 2. Parse Visio XML structure
        raw = _parse_vsdx(vsdx_bytes)
        if not raw["steps"] and not raw["groups"]:
            raise ValueError("No shapes found in diagram — file may be empty or malformed")

        # 3. Classify with Bedrock
        classified = _classify_with_bedrock(domain, raw)

        swimlanes  = classified["swimlanes"]
        steps      = classified["steps"]
        connectors = raw["connectors"]
        warnings   = classified.get("warnings", [])
        overall_conf = classified.get("overall_confidence", 0.85)

        # Preserve raw position data — Bedrock response doesn't include it
        raw_positions = {
            s["shape_id"]: (s.get("position_x"), s.get("position_y"))
            for s in raw["steps"]
        }

        # Normalise: assign stable IDs, map shape_id → step_id
        shape_to_step: dict[str, str] = {}
        for i, step in enumerate(steps):
            sid = f"s{i+1:03d}"
            shape_to_step[step["shape_id"]] = sid
            step["step_id"] = sid

        for i, lane in enumerate(swimlanes):
            lane["lane_id"] = f"lane{i+1:02d}"
            lane["position"] = i

        lane_shape_to_id = {
            lane["shape_id"]: lane["lane_id"] for lane in swimlanes
        }

        # Build normalised steps for Aurora
        aurora_steps = []
        for step in steps:
            pos = raw_positions.get(step["shape_id"], (None, None))
            aurora_steps.append({
                "step_id":            step["step_id"],
                "lane_id":            lane_shape_to_id.get(step.get("lane_shape_id", ""), None),
                "label":              step["label"],
                "step_type":          step.get("step_type"),
                "systems_touched":    step.get("systems_touched", []),
                "ai_opportunity":     step.get("ai_opportunity"),
                "ai_rationale":       step.get("ai_rationale"),
                "avg_cycle_time_hrs": None,
                "notes":              None,
                "position_x":         pos[0],
                "position_y":         pos[1],
                "parse_confidence":   step.get("parse_confidence", 1.0),
            })

        aurora_lanes = [
            {
                "lane_id":  lane["lane_id"],
                "label":    lane["label"],
                "persona":  lane.get("persona"),
                "position": lane["position"],
            }
            for lane in swimlanes
        ]

        # Map connector shape_ids → stable step_ids
        aurora_connectors = []
        for conn in connectors:
            from_id = shape_to_step.get(conn["from"])
            to_id   = shape_to_step.get(conn["to"])
            if from_id and to_id:
                aurora_connectors.append({
                    "from":             from_id,
                    "to":               to_id,
                    "condition":        conn.get("condition"),
                    "parse_confidence": conn.get("parse_confidence", 1.0),
                })

        # Convert warnings: replace shape_id → step_id
        aurora_warnings = []
        for w in warnings:
            step_id = shape_to_step.get(w.get("shape_id", ""), w.get("shape_id", ""))
            aurora_warnings.append({
                "field":   w.get("field", "unknown"),
                "item_id": step_id,
                "message": w.get("message", ""),
            })

        latency_ms = int((time.time() - t0) * 1000)

        # 4. Store in Aurora (also updates parse_status)
        store_graph(
            process_id=process_id,
            tenant_id=tenant_id,
            swimlanes=aurora_lanes,
            steps=aurora_steps,
            connectors=aurora_connectors,
            parse_confidence=overall_conf,
            parse_warnings=aurora_warnings,
        )

        audit_events.write(
            ctx,
            "pi.parse.complete",
            ip=ip,
            resource_type="process_graph",
            resource_id=process_id,
            resource_name=source_name,
            details={
                "domain":        domain,
                "steps":         len(aurora_steps),
                "lanes":         len(aurora_lanes),
                "connectors":    len(aurora_connectors),
                "warnings":      len(aurora_warnings),
                "confidence":    overall_conf,
                "latency_ms":    latency_ms,
            },
        )

        log.info(
            "pi_parse done process_id=%s tenant=%s steps=%d lanes=%d latency=%dms",
            process_id, tenant_id, len(aurora_steps), len(aurora_lanes), latency_ms,
        )

    except Exception as exc:
        log.exception("pi_parse worker error process_id=%s: %s", process_id, exc)
        update_parse_status(
            process_id=process_id,
            tenant_id=tenant_id,
            status="failed",
            parse_error=str(exc),
        )


# ── Visio XML parser ─────────────────────────────────────────────────────────

def _parse_vsdx(data: bytes) -> dict:
    """
    Parse a .vsdx ZIP package. Returns:
      {groups: [...], steps: [...], connectors: [...]}
    where groups = top-level Group shapes (candidate swimlanes)
    and   steps  = leaf shapes (candidate process steps).
    """
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        # Collect all pages; parse page1 first, then additional pages
        page_files = sorted(
            [n for n in zf.namelist() if n.startswith("visio/pages/page") and n.endswith(".xml")],
            key=lambda n: int("".join(c for c in n if c.isdigit()) or "0"),
        )
        if not page_files:
            raise ValueError("No Visio page XML found in .vsdx file")

        # Parse first page (primary diagram page)
        page_xml = zf.read(page_files[0])

    root = ET.fromstring(page_xml)
    shapes_elem = root.find(_TAG("Shapes"))
    connects_elem = root.find(_TAG("Connects"))

    groups: list[dict] = []
    steps: list[dict] = []

    if shapes_elem is not None:
        _walk_shapes(shapes_elem, groups, steps, parent_group_id=None, depth=0)

    connectors: list[dict] = []
    if connects_elem is not None:
        for conn in connects_elem.findall(_TAG("Connect")):
            from_id = conn.get("FromSheet")
            to_id   = conn.get("ToSheet")
            if from_id and to_id:
                connectors.append({
                    "from":             from_id,
                    "to":               to_id,
                    "condition":        conn.get("FromCell"),  # branch label
                    "parse_confidence": 1.0,
                })

    # Deduplicate connectors (Visio sometimes emits two Connect elements per edge)
    seen_edges: set[tuple] = set()
    unique_connectors = []
    for c in connectors:
        edge = (c["from"], c["to"])
        if edge not in seen_edges:
            seen_edges.add(edge)
            unique_connectors.append(c)

    return {"groups": groups, "steps": steps, "connectors": unique_connectors}


def _walk_shapes(
    shapes_elem: ET.Element,
    groups: list[dict],
    steps: list[dict],
    parent_group_id: str | None,
    depth: int,
) -> None:
    for shape in shapes_elem.findall(_TAG("Shape")):
        shape_id   = shape.get("ID", "")
        shape_type = shape.get("Type", "")
        text       = _get_text(shape)
        pin_x, pin_y = _get_pin(shape)

        nested_shapes = shape.find(_TAG("Shapes"))
        has_children  = nested_shapes is not None and len(list(nested_shapes)) > 0

        if shape_type == "Group" and depth == 0 and has_children:
            # Top-level Group: treat as swimlane candidate
            groups.append({
                "shape_id": shape_id,
                "label":    text or f"Lane {len(groups)+1}",
                "position_x": pin_x,
                "position_y": pin_y,
            })
            # Recurse into child shapes as steps in this lane
            _walk_shapes(nested_shapes, groups, steps, parent_group_id=shape_id, depth=depth + 1)

        elif shape_type not in ("Group",) and text:
            # Leaf shape with text: process step candidate
            steps.append({
                "shape_id":        shape_id,
                "label":           text,
                "parent_group_id": parent_group_id,
                "position_x":      pin_x,
                "position_y":      pin_y,
            })
            # Some shapes may still have nested shapes (e.g. label sub-shapes); skip them

        elif shape_type == "Group" and depth > 0 and has_children:
            # Nested group inside a lane — treat as a sub-process step for now
            steps.append({
                "shape_id":        shape_id,
                "label":           text or f"Sub-process {shape_id}",
                "parent_group_id": parent_group_id,
                "position_x":      pin_x,
                "position_y":      pin_y,
            })


def _get_text(shape: ET.Element) -> str:
    text_elem = shape.find(_TAG("Text"))
    if text_elem is None:
        return ""
    # Text content may be in child <cp> or directly
    parts = []
    if text_elem.text:
        parts.append(text_elem.text.strip())
    for child in text_elem:
        if child.tail:
            parts.append(child.tail.strip())
    return " ".join(p for p in parts if p)


def _get_pin(shape: ET.Element) -> tuple[float | None, float | None]:
    x, y = None, None
    for cell in shape.findall(_TAG("Cell")):
        n = cell.get("N", "")
        v = cell.get("V")
        if v is None:
            continue
        try:
            if n == "PinX":
                x = float(v)
            elif n == "PinY":
                y = float(v)
        except ValueError:
            pass
    return x, y


# ── Bedrock classification ────────────────────────────────────────────────────

def _classify_with_bedrock(domain: str, raw: dict) -> dict:
    groups    = raw["groups"]
    steps     = raw["steps"]

    # Build prompt describing all shapes
    lines = [f"Domain: {domain}", "", "Group shapes (potential swimlanes):"]
    for g in groups:
        lines.append(f'  shape_id="{g["shape_id"]}" label="{g["label"]}"')

    lines += ["", "Step shapes:"]
    for s in steps:
        parent = s.get("parent_group_id") or "none"
        lines.append(
            f'  shape_id="{s["shape_id"]}" label="{s["label"]}" '
            f'parent_group="{parent}" '
            f'position=({s["position_x"]}, {s["position_y"]})'
        )

    lines += ["", "Connector edges (from_id → to_id):"]
    for c in raw["connectors"]:
        lines.append(f'  {c["from"]} → {c["to"]}')

    prompt = "\n".join(lines)

    try:
        result = bedrock.generate_json(_CLASSIFY_SYSTEM, prompt, max_tokens=4000, temperature=0.0)
    except Exception as exc:
        log.warning("Bedrock classification failed, using structural heuristics: %s", exc)
        result = _heuristic_classify(raw)

    return result


def _heuristic_classify(raw: dict) -> dict:
    """Fallback classifier when Bedrock is unavailable — purely structural."""
    swimlanes = [
        {
            "shape_id": g["shape_id"],
            "label":    g["label"],
            "persona":  g["label"],
            "position": i,
        }
        for i, g in enumerate(raw["groups"])
    ]

    classified_steps = []
    for s in raw["steps"]:
        label_lower = s["label"].lower()
        if "?" in s["label"] or "decision" in label_lower or "approve" in label_lower:
            stype = "decision"
            opp, rationale = "partial_ai", "Approval logic may be AI-assisted; human sign-off still required pending full classification."
        elif "wait" in label_lower or "hold" in label_lower:
            stype = "wait"
            opp, rationale = "workday_native", "Wait states are typically handled by Workday's built-in Business Process Framework timers."
        elif "workday" in label_lower or "system" in label_lower:
            stype = "system"
            opp, rationale = "workday_native", "System-driven step likely handled natively by Workday; full classification requires Bedrock."
        elif "notify" in label_lower or "email" in label_lower or "alert" in label_lower:
            stype = "system"
            opp, rationale = "sana_agent", "Notification steps are strong candidates for Self-Service Agent automation via Sana."
        else:
            stype = "manual"
            opp, rationale = "partial_ai", "Manual step; AI opportunity requires full classification via Bedrock."
        classified_steps.append({
            "shape_id":        s["shape_id"],
            "label":           s["label"],
            "step_type":       stype,
            "systems_touched": [],
            "ai_opportunity":  opp,
            "ai_rationale":    rationale,
            "lane_shape_id":   s.get("parent_group_id"),
            "parse_confidence": 0.6,
        })

    return {
        "swimlanes":          swimlanes,
        "steps":              classified_steps,
        "overall_confidence": 0.6,
        "warnings": [
            {"shape_id": s["shape_id"], "field": "step_type",
             "message": "classified by structural heuristics; Bedrock unavailable"}
            for s in classified_steps
        ],
    }
