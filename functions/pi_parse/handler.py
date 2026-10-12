"""
Process Intelligence — parse trigger + async parse worker.

Trigger:  POST /process-intelligence/{process_id}/parse
  Role: consultant | admin
  Updates parse_status → 'parsing', enqueues a 'pi_parse' job on the shared
  Storage Queue.
  Returns: { process_id, status: "parsing" }

Worker:   queue-triggered (wired in Phase 7), dispatched by job_type
  Downloads the source file from Blob and extracts diagram structure —
  .vsdx via OpenXML parsing, .png/.jpg/.pdf via Claude document/vision
  understanding — then classifies AI opportunities and stores the full
  graph in Aurora.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import posixpath
import re
import time
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

from common import tenant_from_event, TenantError, ai, audit_events, blob, queue, http
from common.tenant import TenantContext
from common.pi_aurora import (
    get_process_graph_status,
    update_parse_status,
    store_graph,
)

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

# Statuses from which re-parse is allowed
_REPARSEABLE = {"uploading", "needs_review", "failed", "ready"}

_IMAGE_PARSE_SYSTEM = """You are a process diagram analyst. You will receive an image or PDF document containing a process flow diagram — it may be a swimlane / cross-functional flowchart, a simple flowchart, or a hand-drawn diagram.

Extract the full diagram structure and return a single JSON object with this exact format:
{
  "groups": [
    {"shape_id": "g1", "label": "swimlane name", "position_x": 0, "position_y": 0}
  ],
  "steps": [
    {
      "shape_id": "s1",
      "label": "step label text",
      "parent_group_id": "g1",
      "position_x": 0,
      "position_y": 0
    }
  ],
  "connectors": [
    {"from": "s1", "to": "s2", "condition": "Yes"}
  ]
}

Rules:
- groups = swimlane rows or columns. Use "g1", "g2"... as shape_ids. Empty array if no swimlanes.
- steps = process boxes, decisions, tasks, approvals. Use "s1", "s2"... as shape_ids.
  - Read ALL text in each shape carefully, capturing the full label.
  - parent_group_id = the shape_id of the swimlane this step belongs to (null if no swimlanes).
  - position_x = column index left-to-right, 0-based.
  - position_y = row index top-to-bottom within the lane, 0-based.
- connectors = every arrow between steps.
  - condition = text label on the arrow if present (e.g. "Yes", "No", "Approved", "Rejected"), else null.
  - Use the shape_ids you assigned above — never reference labels.
- Include every visible step; do not omit any.
- Respond with raw JSON only — no preamble, no markdown fences."""

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


# ── Trigger handler (API) ─────────────────────────────────────────────────────

def handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin")
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

    queue.enqueue_job("pi_parse", worker_payload)

    log.info(
        "pi_parse triggered process_id=%s tenant=%s domain=%s",
        process_id, ctx.tenant_id, graph_meta["domain"],
    )

    return http.ok({"process_id": process_id, "status": "parsing"})


# ── Worker handler (queue-triggered, dispatched by job_type) ─────────────────

def worker_handler(payload: dict) -> None:
    process_id  = payload["process_id"]
    tenant_id   = payload["tenant_id"]
    domain      = payload["domain"]
    source_name = payload["source_name"]
    s3_key      = payload["s3_key"]
    ip          = payload.get("ip", "unknown")

    ctx = TenantContext(
        tenant_id=tenant_id,
        user_id=payload.get("user_id", ""),
        role=payload.get("role", "consultant"),
        email=payload.get("email", ""),
    )

    t0 = time.time()
    try:
        # 1. Download file from Blob
        file_bytes = blob.get_object_bytes(s3_key)

        # 2. Parse — route by magic bytes (PNG/JPEG/PDF) or fall back to VSDX
        image_mime = _detect_image_mime(file_bytes)
        if image_mime:
            raw = _parse_image(file_bytes, image_mime)
            image_parse = True
        elif _detect_pdf(file_bytes):
            raw = _parse_pdf(file_bytes)
            image_parse = True
        else:
            raw = _parse_vsdx(file_bytes)
            image_parse = False

        if not raw["steps"] and not raw["groups"]:
            raise ValueError("No shapes found in diagram — file may be empty or unreadable")

        # 3. Classify
        classified = _classify(domain, raw)

        swimlanes  = classified["swimlanes"]
        steps      = classified["steps"]
        connectors = raw["connectors"]
        warnings   = classified.get("warnings", [])
        # Image-extracted structure is inherently less precise than XML parsing
        overall_conf = min(classified.get("overall_confidence", 0.85), 0.65 if image_parse else 1.0)

        # Preserve raw position data — the classifier response doesn't include it
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
                "parse_mode":    "image" if image_parse else "vsdx",
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


# ── Image detection + parsing ─────────────────────────────────────────────────

def _detect_image_mime(data: bytes) -> str | None:
    """Return MIME type if bytes look like a supported image, else None."""
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return "image/png"
    if data[:2] == b'\xff\xd8':
        return "image/jpeg"
    return None


def _parse_image(data: bytes, mime_type: str) -> dict:
    """
    Extract process diagram structure from a PNG/JPEG using vision understanding.
    Returns the same {groups, steps, connectors} shape as _parse_vsdx.
    """
    b64 = base64.b64encode(data).decode("utf-8")
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": mime_type, "data": b64},
                },
                {
                    "type": "text",
                    "text": "Extract the complete process diagram structure from this image. Return the JSON as instructed.",
                },
            ],
        }
    ]

    raw_text = ai.generate(
        system=_IMAGE_PARSE_SYSTEM,
        messages=messages,
        max_tokens=4000,
        temperature=0.0,
    ).strip()

    # Strip accidental code fences
    if raw_text.startswith("```"):
        raw_text = raw_text.strip("`")
        if raw_text.lower().startswith("json"):
            raw_text = raw_text[4:].lstrip()

    result = json.loads(raw_text)

    groups = result.get("groups", [])
    steps  = result.get("steps", [])
    connectors = [
        {
            "from":             c["from"],
            "to":               c["to"],
            "condition":        c.get("condition"),
            "parse_confidence": 0.7,
        }
        for c in result.get("connectors", [])
        if c.get("from") and c.get("to")
    ]

    return {"groups": groups, "steps": steps, "connectors": connectors}


def _detect_pdf(data: bytes) -> bool:
    return data[:4] == b'%PDF'


def _parse_pdf(data: bytes) -> dict:
    """
    Extract process diagram structure from a PDF using native document
    understanding (no local rendering/rasterization needed). Returns the same
    {groups, steps, connectors} shape as _parse_vsdx/_parse_image.
    """
    b64 = base64.b64encode(data).decode("utf-8")
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "type": "document",
                    "source": {"type": "base64", "media_type": "application/pdf", "data": b64},
                },
                {
                    "type": "text",
                    "text": "Extract the complete process diagram structure from this PDF. Return the JSON as instructed.",
                },
            ],
        }
    ]

    raw_text = ai.generate(
        system=_IMAGE_PARSE_SYSTEM,
        messages=messages,
        max_tokens=4000,
        temperature=0.0,
    ).strip()

    if raw_text.startswith("```"):
        raw_text = raw_text.strip("`")
        if raw_text.lower().startswith("json"):
            raw_text = raw_text[4:].lstrip()

    result = json.loads(raw_text)

    groups = result.get("groups", [])
    steps  = result.get("steps", [])
    connectors = [
        {
            "from":             c["from"],
            "to":               c["to"],
            "condition":        c.get("condition"),
            "parse_confidence": 0.7,
        }
        for c in result.get("connectors", [])
        if c.get("from") and c.get("to")
    ]

    return {"groups": groups, "steps": steps, "connectors": connectors}


# ── Visio XML parser ─────────────────────────────────────────────────────────
#
# Real-world .vsdx swimlane/BPMN exports (confirmed against a Workday-style
# fixture — see functions/tests/test_pi_vsdx_parser.py) nest shapes 2+ levels
# deep and split a single logical node's text across several child shapes
# (e.g. a process code on one child, the description on another). Lane
# membership is NOT expressed by XML nesting either — lane "containers" are
# decorative background shapes; every real node sits at the same tree depth
# as the lanes and is assigned to one by comparing absolute page position
# against each lane's Y-band. This module never assumes a fixed nesting
# depth, a fixed namespace, or a fixed Master ID → meaning mapping; every one
# of those is resolved per-file.

# Local-name tag/attribute matching — deliberately namespace-agnostic rather
# than binding to one hardcoded namespace URI. Visio versions/templates vary
# (2012/main vs older 2003/core), and a single package can mix the default
# Visio namespace with the OOXML relationships namespace on `r:id` attributes
# — stripping the "{uri}" prefix before comparing local names sidesteps all
# of that without needing per-file namespace detection.
def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _children(elem: ET.Element, local_name: str) -> list[ET.Element]:
    return [c for c in elem if _local(c.tag) == local_name]


def _child(elem: ET.Element, local_name: str) -> ET.Element | None:
    for c in elem:
        if _local(c.tag) == local_name:
            return c
    return None


def _attr_local(elem: ET.Element, local_name: str) -> str | None:
    """Read an attribute by local name regardless of its namespace prefix —
    needed for pages.xml's `<Rel r:id="rId1" />`, where the attribute itself
    is namespaced."""
    for k, v in elem.attrib.items():
        if _local(k) == local_name:
            return v
    return None


_GEOMETRY_CELLS = {"PinX", "PinY", "Width", "Height", "Angle", "LocPinX", "LocPinY"}


@dataclass
class _ShapeNode:
    id: str
    type: str
    master: str | None
    mastershape: str | None
    elem: ET.Element
    cells: dict[str, float] = field(default_factory=dict)
    properties: dict[str, str] = field(default_factory=dict)
    children: list["_ShapeNode"] = field(default_factory=list)
    abs_x: float = 0.0
    abs_y: float = 0.0


def _build_shape_tree(shapes_elem: ET.Element) -> list[_ShapeNode]:
    """Recursively parse every <Shape>, at every depth, retaining the
    parent/child structure — needed for both text merging and coordinate
    composition. Does not flatten."""
    nodes = []
    for shape_elem in _children(shapes_elem, "Shape"):
        cells: dict[str, float] = {}
        for cell in _children(shape_elem, "Cell"):
            n, v = cell.get("N"), cell.get("V")
            if n in _GEOMETRY_CELLS and v is not None:
                try:
                    cells[n] = float(v)
                except ValueError:
                    pass
        nested = _child(shape_elem, "Shapes")
        node = _ShapeNode(
            id=shape_elem.get("ID", ""),
            type=shape_elem.get("Type", ""),
            # `Master` looks up visio/masters/masters.xml's page-level Master
            # ID → name table. `MasterShape` is a *different* reference — an
            # internal part ID within a master's own definition — and must
            # never be resolved against that same masters.xml table. It's
            # still stored (not resolved) as a signal that a leaf is a
            # decorative sub-component of its parent's compound master
            # (a lane's own fill/label sub-shapes both carry one) rather
            # than independent content — see _classify_tree's generic-leaf
            # fallback, which must not treat a lane's own name label as a
            # freestanding task.
            master=shape_elem.get("Master"),
            mastershape=shape_elem.get("MasterShape"),
            cells=cells,
            properties=_shape_properties(shape_elem),
            elem=shape_elem,
            children=_build_shape_tree(nested) if nested is not None else [],
        )
        nodes.append(node)
    return nodes


def _shape_properties(shape_elem: ET.Element) -> dict[str, str]:
    """Visio Shape Data (a <Section N="Property"> the shape's master
    defines) — e.g. an EC_Task master carries an explicit process-code field
    separate from its human-readable name. Reading this directly, when
    present, is unambiguous; _extract_code_label() falls back to merging
    descendant shape text only when a shape has no such structured data."""
    props: dict[str, str] = {}
    for section in _children(shape_elem, "Section"):
        if section.get("N") != "Property":
            continue
        for row in _children(section, "Row"):
            row_name = row.get("N") or ""
            for cell in _children(row, "Cell"):
                if cell.get("N") == "Value":
                    v = cell.get("V")
                    if v:
                        props[row_name] = v
    return props


def _shape_own_text(node: _ShapeNode) -> str:
    """A single shape's own <Text> content — direct text, child element
    tails, and nested <cp>/<pp>/<tp>/<fld> run/paragraph nodes some Visio
    versions emit — NOT descendant shapes' text. See _all_descendant_text()
    for the recursive version used to merge a composite node's full label."""
    text_elem = _child(node.elem, "Text")
    if text_elem is None:
        return ""
    parts = []
    if text_elem.text:
        parts.append(text_elem.text.strip())
    for child in text_elem:
        if child.text:
            parts.append(child.text.strip())
        if child.tail:
            parts.append(child.tail.strip())
    return " ".join(p for p in parts if p)


def _all_descendant_text(node: _ShapeNode) -> list[str]:
    """Every text-bearing shape in this subtree's own words, in document
    order — a shape's own text first, then each child's (recursively). A
    composite logical node (e.g. a Task group whose code and description
    live on two separate leaf children) needs every one of these, not just
    the first hit."""
    out = []
    own = _shape_own_text(node)
    if own:
        out.append(own)
    for child in node.children:
        out.extend(_all_descendant_text(child))
    return out


_CODE_RE = re.compile(r"^[A-Za-z]{1,8}-?\d[\w-]*$")


def _looks_like_code(text: str) -> bool:
    """A short, space-free, digit-bearing token (e.g. "HR-020-010-110")
    reads as a process/reference code rather than a description."""
    t = text.strip()
    return bool(t) and " " not in t and len(t) <= 24 and bool(_CODE_RE.match(t))


def _extract_code_label(node: _ShapeNode) -> tuple[str | None, str]:
    """Resolve a classified node's code + label. Prefers Visio Shape Data
    when the master defines it (unambiguous); otherwise merges every
    descendant shape's text and heuristically splits a code-shaped token
    from the rest."""
    code: str | None = None
    label: str | None = None
    for key, val in node.properties.items():
        if not val:
            continue
        kl = key.lower()
        if code is None and ("code" in kl or kl.endswith("id")):
            code = val
        elif label is None and ("name" in kl or "text" in kl or "label" in kl or "desc" in kl):
            label = val
    if label:
        return code, label

    texts = _all_descendant_text(node)
    if not texts:
        return code, f"(unlabeled {node.type or 'shape'} {node.id})"
    if len(texts) > 1 and code is None:
        code_idx = next((i for i, t in enumerate(texts) if _looks_like_code(t)), None)
        if code_idx is not None:
            code = texts.pop(code_idx)
    label = max(texts, key=len) if texts else f"(unlabeled {node.type or 'shape'} {node.id})"
    return code, label


def _normalize_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


# Scaffolding masters describe the swimlane *chrome* (row backgrounds, phase
# dividers, the list controls used to add/reorder lanes) rather than a real
# process element — skipped, but still traversed into for descendants.
_SCAFFOLD_PATTERNS = ("phaselist", "swimlanelist", "separator", "pool")

# Ordered, first-match-wins. Checked against the shape's resolved Master
# name (case/punctuation-insensitive, tolerant of "Integration Node" and
# "EC_IntegrationNode" alike) and, when there's no Master at all, against
# its bare Type attribute — covering hand-built or template-less .vsdx files
# that classify shapes structurally instead of via a masters.xml lookup.
_ROLE_PATTERNS: list[tuple[str, str]] = [
    ("lane", "lane"), ("swimlane", "lane"),
    ("decision", "decision"), ("diamond", "decision"),
    ("startevent", "start"),
    ("endevent", "end"),
    ("integrationnode", "subprocess"), ("subprocess", "subprocess"), ("reference", "subprocess"),
    ("dynamicconnector", "connector"), ("connector", "connector"),
    ("task", "task"), ("activity", "task"), ("process", "task"),
]


def _classify_role(node: _ShapeNode, master_names: dict[str, str]) -> str | None:
    name = master_names.get(node.master, "") if node.master else ""
    if not name:
        name = node.type or ""
    norm = _normalize_name(name)
    if not norm:
        return None
    if norm in ("start",):
        return "start"
    if norm in ("end",):
        return "end"
    for pat in _SCAFFOLD_PATTERNS:
        if pat in norm:
            return "scaffold"
    for pat, role in _ROLE_PATTERNS:
        if pat in norm:
            return role
    return None


def _resolve_pin(node: _ShapeNode, parent_origin: tuple[float, float]) -> tuple[float, float]:
    """A shape's PinX/PinY are expressed in its immediate parent group's
    local coordinate space, not the page's — composing through every
    ancestor is what turns that into an absolute page position. Only
    translation is composed (no rotation): axis-aligned swimlane/BPMN
    diagrams, the target use case here, don't rotate group containers, and
    a partial rotation-aware transform would misplace nodes worse than
    leaving it out."""
    px, py = node.cells.get("PinX"), node.cells.get("PinY")
    if px is None or py is None:
        return parent_origin
    return (parent_origin[0] + px, parent_origin[1] + py)


def _child_origin(node: _ShapeNode, abs_pin: tuple[float, float]) -> tuple[float, float]:
    loc_x = node.cells.get("LocPinX", 0.0) or 0.0
    loc_y = node.cells.get("LocPinY", 0.0) or 0.0
    return (abs_pin[0] - loc_x, abs_pin[1] - loc_y)


def _register_subtree(node: _ShapeNode, node_id: str, id_to_node_id: dict[str, str]) -> None:
    """Every shape inside a matched logical node's subtree resolves back to
    that node's own id — needed because Visio connects a Dynamic connector
    to a specific *child* shape inside a group (its visual connection
    point), not to the group's own top-level ID."""
    id_to_node_id[node.id] = node_id
    for child in node.children:
        _register_subtree(child, node_id, id_to_node_id)


def _classify_tree(
    node: _ShapeNode,
    master_names: dict[str, str],
    parent_origin: tuple[float, float],
    lanes: list[dict],
    nodes: list[dict],
    id_to_node_id: dict[str, str],
    shape_by_id: dict[str, _ShapeNode],
    text_bearing_count: list[int],
    is_top_level: bool = False,
) -> None:
    abs_pin = _resolve_pin(node, parent_origin)
    node.abs_x, node.abs_y = abs_pin
    shape_by_id[node.id] = node
    if _shape_own_text(node):
        text_bearing_count[0] += 1

    role = _classify_role(node, master_names)

    # Neither a Master nor a Type attribute resolved this shape to a known
    # role — some .vsdx files (hand-built ones especially) carry no
    # masters.xml and no Type hints at all, just plain shapes with text.
    # Two narrow, well-scoped structural fallbacks, rather than dropping
    # the shape silently:
    if role is None:
        if not node.children:
            # A leaf with real text but no name signal is still a genuine
            # process step — UNLESS it's a decorative sub-component of its
            # parent's own compound master (identified by MasterShape,
            # never Master): a lane's own fill/label sub-shapes both carry
            # one, and the label's text was already consumed as the lane's
            # `name` one level up. A leaf with no text is correctly ignored
            # either way (pure decoration — a background rectangle).
            if _shape_own_text(node) and not node.mastershape:
                role = "task"
        elif is_top_level:
            # A page-root container that _classify_role already failed to
            # match by name — the only case reaching here — is treated as a
            # lane. Every real lane in a named template resolves via
            # _classify_role before this point; this only fires for
            # templates that never named their lane masters at all.
            role = "lane"

    if role == "lane":
        texts = _all_descendant_text(node)
        name = texts[0] if texts else f"Lane {node.id}"
        height = node.cells.get("Height")
        y_band = (abs_pin[1] - height / 2, abs_pin[1] + height / 2) if height is not None else None
        lanes.append({"id": node.id, "name": name, "y": abs_pin[1], "y_band": y_band})
        # Still descend — a different template might nest tasks inside the
        # lane shape itself, even though this fixture doesn't.
        child_origin = _child_origin(node, abs_pin)
        for child in node.children:
            _classify_tree(child, master_names, child_origin, lanes, nodes, id_to_node_id, shape_by_id, text_bearing_count)
        return

    if role in ("task", "decision", "start", "end", "subprocess"):
        code, label = _extract_code_label(node)
        nodes.append({
            "id": node.id, "type": role, "label": label, "code": code,
            "x": abs_pin[0], "y": abs_pin[1], "lane": None,
        })
        _register_subtree(node, node.id, id_to_node_id)
        return  # a matched node's own subtree is fully consumed above

    if role == "connector":
        return  # resolved later, from the page's <Connects> section

    # Scaffolding or unrecognised — no node of our own, but the real content
    # may be nested one level further down.
    child_origin = _child_origin(node, abs_pin)
    for child in node.children:
        _classify_tree(child, master_names, child_origin, lanes, nodes, id_to_node_id, shape_by_id, text_bearing_count)


def _assign_lanes(nodes: list[dict], lanes: list[dict]) -> None:
    if not lanes:
        return
    for n in nodes:
        y = n["y"]
        band_match = next(
            (l for l in lanes if l["y_band"] and l["y_band"][0] - 1e-6 <= y <= l["y_band"][1] + 1e-6),
            None,
        )
        n["lane"] = (band_match or min(lanes, key=lambda l: abs(l["y"] - y)))["id"]


def _build_edges(
    connects_elem: ET.Element | None,
    id_to_node_id: dict[str, str],
    shape_by_id: dict[str, _ShapeNode],
) -> list[dict]:
    """Edges are a flat list of <Connect> rows, not nesting — a 1-D Dynamic
    connector shape has one row for its Begin point and one for its End
    point, together giving (source, target). Some hand-built/simplified
    .vsdx files skip the mediating connector shape entirely and connect two
    node shapes directly; both patterns are handled here without assuming
    either is "the" format."""
    if connects_elem is None:
        return []

    by_from: dict[str, list[ET.Element]] = {}
    for row in _children(connects_elem, "Connect"):
        frm = row.get("FromSheet")
        if frm:
            by_from.setdefault(frm, []).append(row)

    edges: list[dict] = []
    seen: set[tuple[str, str]] = set()

    for frm, rows in by_from.items():
        resolved_frm = id_to_node_id.get(frm)

        if resolved_frm == frm:
            # `frm` is itself a real node (no mediating connector shape) —
            # each row is a complete edge on its own.
            for row in rows:
                to = id_to_node_id.get(row.get("ToSheet") or "")
                if to and (frm, to) not in seen:
                    seen.add((frm, to))
                    edges.append({"from": frm, "to": to, "label": None})
            continue

        # `frm` is a connector shape's ID: pair its Begin-point row with its
        # End-point row to get (source node, target node).
        begin_to = end_to = None
        leftover: list[str] = []
        for row in rows:
            to = id_to_node_id.get(row.get("ToSheet") or "")
            if not to:
                continue
            cell = row.get("FromCell") or ""
            if cell.startswith("Begin"):
                begin_to = to
            elif cell.startswith("End"):
                end_to = to
            else:
                leftover.append(to)
        if begin_to is None and leftover:
            begin_to = leftover.pop(0)
        if end_to is None and leftover:
            end_to = leftover.pop(0)
        if begin_to and end_to and (begin_to, end_to) not in seen:
            seen.add((begin_to, end_to))
            connector_shape = shape_by_id.get(frm)
            label = _shape_own_text(connector_shape) if connector_shape else ""
            edges.append({"from": begin_to, "to": end_to, "label": label or None})

    return edges


def _load_master_names(zf: zipfile.ZipFile, names: set[str]) -> dict[str, str]:
    """Master ID -> Name/NameU, i.e. what each shape *means*. Absent
    entirely in some minimal/hand-built .vsdx packages (no swimlane
    template involved) — callers must tolerate an empty map and fall back
    to each shape's own Type attribute."""
    path = "visio/masters/masters.xml"
    if path not in names:
        return {}
    root = ET.fromstring(zf.read(path))
    out = {}
    for master in _children(root, "Master"):
        mid = master.get("ID")
        if mid:
            out[mid] = master.get("NameU") or master.get("Name") or ""
    return out


def _resolve_primary_page(zf: zipfile.ZipFile, names: set[str]) -> tuple[str, str]:
    """Resolve the primary page's actual XML part path and title via
    visio/pages/pages.xml + its .rels — page part filenames are NOT
    guaranteed to be "page1.xml" (that's a relationship target, resolved
    per-file, not a filename convention to assume). Falls back to scanning
    for any visio/pages/page*.xml part when pages.xml itself is absent
    (seen in minimal/hand-built .vsdx packages that skip it)."""
    pages_path = "visio/pages/pages.xml"
    rels_path = "visio/pages/_rels/pages.xml.rels"
    if pages_path in names and rels_path in names:
        try:
            pages_root = ET.fromstring(zf.read(pages_path))
            rels_root = ET.fromstring(zf.read(rels_path))
            rel_targets = {r.get("Id"): r.get("Target") for r in _children(rels_root, "Relationship")}
            for page in _children(pages_root, "Page"):
                rel = _child(page, "Rel")
                rid = _attr_local(rel, "id") if rel is not None else None
                target = rel_targets.get(rid) if rid else None
                if not target:
                    continue
                part_path = posixpath.normpath(posixpath.join("visio/pages", target))
                if part_path in names:
                    title = page.get("NameU") or page.get("Name") or "Page 1"
                    return part_path, title
        except ET.ParseError:
            pass

    page_files = sorted(
        (n for n in names if n.startswith("visio/pages/page") and n.endswith(".xml")),
        key=lambda n: int("".join(c for c in n if c.isdigit()) or "0"),
    )
    if page_files:
        return page_files[0], "Page 1"
    return "", ""


def _parse_vsdx_structure(data: bytes) -> dict:
    """
    Parse a .vsdx ZIP package into a normalized, engine-agnostic structure:
      {
        "page": "...",
        "lanes": [{"id", "name", "y_band"}],
        "nodes": [{"id", "type", "label", "code", "lane", "x", "y"}],
        "edges": [{"from", "to", "label"}],
      }
    `type` is one of task | decision | start | end | subprocess.
    """
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = set(zf.namelist())
        page_path, page_title = _resolve_primary_page(zf, names)
        if not page_path:
            raise ValueError("No Visio page XML found in .vsdx file")
        page_xml = zf.read(page_path)
        master_names = _load_master_names(zf, names)

    root = ET.fromstring(page_xml)
    shapes_elem = _child(root, "Shapes")
    connects_elem = _child(root, "Connects")

    shape_tree = _build_shape_tree(shapes_elem) if shapes_elem is not None else []

    lanes: list[dict] = []
    nodes: list[dict] = []
    id_to_node_id: dict[str, str] = {}
    shape_by_id: dict[str, _ShapeNode] = {}
    text_bearing_count = [0]
    total_shapes = [0]

    def _count_all(n: _ShapeNode) -> None:
        total_shapes[0] += 1
        for c in n.children:
            _count_all(c)

    for top in shape_tree:
        _count_all(top)
        _classify_tree(top, master_names, (0.0, 0.0), lanes, nodes, id_to_node_id, shape_by_id, text_bearing_count, is_top_level=True)

    _assign_lanes(nodes, lanes)
    edges = _build_edges(connects_elem, id_to_node_id, shape_by_id)

    if total_shapes[0] and text_bearing_count[0] == 0:
        raise ValueError(
            f"0 of {total_shapes[0]} shapes have resolvable text after recursive "
            f"traversal — the file may use an unrecognised Visio schema variant"
        )

    return {
        "page": page_title,
        "lanes": [{"id": l["id"], "name": l["name"], "y_band": l["y_band"]} for l in lanes],
        "nodes": nodes,
        "edges": edges,
    }


def _parse_vsdx(data: bytes) -> dict:
    """
    Adapts _parse_vsdx_structure()'s normalized {lanes, nodes, edges} into
    the {groups, steps, connectors} shape _classify() and worker_handler()
    already consume, so the AI-classification step and Aurora storage need
    no changes — only extraction was broken, not the downstream contract.
    """
    structure = _parse_vsdx_structure(data)

    groups = [
        {
            "shape_id": lane["id"],
            "label": lane["name"],
            "position_x": None,
            "position_y": lane["y_band"][0] if lane["y_band"] else None,
        }
        for lane in structure["lanes"]
    ]

    steps = [
        {
            "shape_id": n["id"],
            # Fold the process code into the label (there's no dedicated
            # column for it downstream) rather than discarding it — still
            # visible to the AI classifier and to a human reviewer.
            "label": f'{n["code"]}: {n["label"]}' if n.get("code") else n["label"],
            "parent_group_id": n["lane"],
            "position_x": n["x"],
            "position_y": n["y"],
        }
        for n in structure["nodes"]
    ]

    connectors = [
        {
            "from": e["from"],
            "to": e["to"],
            "condition": e["label"],
            "parse_confidence": 1.0,
        }
        for e in structure["edges"]
    ]

    return {"groups": groups, "steps": steps, "connectors": connectors}


# ── AI classification ─────────────────────────────────────────────────────────

def _classify(domain: str, raw: dict) -> dict:
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
        result = ai.generate_json(_CLASSIFY_SYSTEM, prompt, max_tokens=4000, temperature=0.0)
    except Exception as exc:
        log.warning("AI classification failed, using structural heuristics: %s", exc)
        result = _heuristic_classify(raw)

    return result


def _heuristic_classify(raw: dict) -> dict:
    """Fallback classifier when the AI service is unavailable — purely structural."""
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
            opp, rationale = "workday_native", "System-driven step likely handled natively by Workday; full classification requires the AI service."
        elif "notify" in label_lower or "email" in label_lower or "alert" in label_lower:
            stype = "system"
            opp, rationale = "sana_agent", "Notification steps are strong candidates for Self-Service Agent automation via Sana."
        else:
            stype = "manual"
            opp, rationale = "partial_ai", "Manual step; AI opportunity requires full classification via the AI service."
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
             "message": "classified by structural heuristics; AI service unavailable"}
            for s in classified_steps
        ],
    }
