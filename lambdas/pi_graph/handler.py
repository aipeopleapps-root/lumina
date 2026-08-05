"""
Process Intelligence — graph read/patch endpoints.

GET  /process-intelligence/{process_id}/status
  Role: consultant | admin
  Returns current parse_status + confidence + warnings.

GET  /process-intelligence/{process_id}/graph
  Role: consultant | admin
  Returns full parsed graph (swimlanes, steps, connectors).
  Only available when parse_status in {needs_review, ready}.

PATCH /process-intelligence/{process_id}/graph
  Role: consultant | admin
  Body: { step_patches?: [...], lane_patches?: [...], connector_patches?: [...] }
  Applies corrections; advances needs_review → ready.

POST /process-intelligence/{process_id}/recommendations
  Role: consultant | admin
  Generates the grouped AI-intervention recommendation list for the As-Is
  Process Flow tab. Returns { process_id, recommendations }.

GET /process-intelligence/{process_id}/recommendations
  Role: consultant | admin
  Returns the last-generated recommendation list (or { recommendations: null }).

POST /process-intelligence/{process_id}/tobe
  Role: consultant | admin
  Body: { selected_intervention_ids: string[], additional_directions?: string }
  Generates the Agentic Workflow graph from the selected recommendations
  ("Apply & Generate"), plus a set of proposed AI agents.
  Returns { process_id, tobe, proposed_agents }.

GET /process-intelligence/{process_id}/tobe
  Role: consultant | admin
  Refetches the last-generated agentic workflow graph + agents without
  regenerating. Returns { process_id, tobe, proposed_agents }.
"""

from __future__ import annotations

import json
import logging
import os

import boto3

from common import tenant_from_event, TenantError, audit_events, bedrock, vectors, http
from common.tenant import TenantContext
from common.pi_aurora import (
    get_process_graph_status,
    get_full_graph,
    patch_graph,
    store_tobe_graph,
    get_tobe_graph,
    update_tobe_status,
    store_recommendations,
    get_recommendations,
    create_agents,
    list_agents,
    search_grounding_corpus,
)

import schemas

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_lambda_client = boto3.client("lambda")
_WORKER_FUNCTION_ARN = os.environ.get("PI_GRAPH_WORKER_FUNCTION_ARN", "")

_GRAPH_READABLE = {"needs_review", "ready"}

_RECS_SYSTEM = """You are a Workday AI transformation architect. You will receive an as-is process graph \
with AI opportunity classifications, plus relevant Workday AI capability context retrieved from the knowledge base.

Your job is NOT to redesign the process yet — it is to propose a short list of grouped AI interventions a \
consultant can review and select from before any redesign happens. Each intervention should consolidate one \
or more related as-is steps (usually steps that are adjacent or share a workflow purpose, such as several \
manual review/validation/approval steps in a row) into a single proposed AI-driven capability.

Use the capability context to ground intervention titles in real Workday AI capabilities where possible. \
Do NOT use the deprecated "Illuminate" brand — use "Sana" or generic "AI agent" language.

Return a single JSON object with this exact structure:

{
  "intro": "1-2 sentence narrative summarizing the overall opportunity across the process",
  "interventions": [
    {
      "intervention_id": "string, e.g. int_01",
      "title": "string — concise, e.g. 'Automated Record Validation and Exception Flagging'",
      "impact": "medium|high",
      "description": "1-2 sentences: what this intervention does and why it matters",
      "replaces_step_ids": ["step_id", "step_id", ...]
    }
  ]
}

Rules:
1. Only include steps currently classified sana_agent, workday_native, or partial_ai — never propose \
   replacing a human_only step.
2. Group related consecutive steps into one intervention where it makes sense; a single step can also be \
   its own intervention if it stands alone.
3. Every step_id in replaces_step_ids must exist in the as-is graph you were given.
4. Do not let any step_id appear in more than one intervention.
5. Produce between 3 and 8 interventions depending on process size — do not force interventions for a tiny \
   process, and do not split a large process into more than 8.
6. impact should reflect scale/frequency/risk reduction, not just automation feasibility — "high" is reserved \
   for interventions that remove significant manual effort or a real error/risk source."""

_TOBE_SYSTEM = """You are a Workday AI transformation architect. You will receive an as-is process graph \
with AI opportunity classifications, the specific AI interventions the consultant selected to apply (with any \
additional directions they gave), plus relevant Workday AI capability context retrieved from the knowledge base.

Use the capability context to name specific Sana agents accurately (e.g. Talent Acquisition Agent, \
Payroll Agent, Self-Service Agent, Talent Mobility Agent). Do NOT use the deprecated "Illuminate" brand.

Redesign the process for the AI-enabled future state, applying ONLY the selected interventions (plus any \
additional directions given), and return a single JSON object with this exact structure:

{
  "transformation_summary": "2-3 sentence narrative: which Sana agents take over which steps, what the net effect is",
  "ai_stats": {
    "steps_automated": <integer — steps fully handled by a Sana agent>,
    "steps_assisted": <integer — steps where Sana assists but human decides>,
    "steps_unchanged": <integer — human_only steps kept as-is>,
    "cycle_time_reduction_pct": <integer 0-85, realistic estimate>
  },
  "swimlanes": [
    {"lane_id": "string", "label": "string", "persona": "string or null", "position": 0}
  ],
  "steps": [
    {
      "step_id": "string",
      "lane_id": "string matching a swimlane lane_id",
      "label": "string — prefix: ⚡ for sana_agent, 🔄 for workday_native, 🤖 for partial_ai, no prefix for human_only",
      "step_type": "system|manual|decision|approval|wait",
      "ai_opportunity": "sana_agent|workday_native|partial_ai|human_only",
      "systems_touched": [],
      "transformation_note": "Name the specific Sana agent and what it does here (omit for human_only unchanged steps)"
    }
  ],
  "connectors": [
    {"from": "step_id", "to": "step_id", "condition": "string or null"}
  ],
  "proposed_agents": [
    {
      "name": "string — a specific agent name, e.g. 'Document AI Agent', 'Validation Agent'",
      "description": "1-2 sentences: what this agent does end to end",
      "model": "string — a plausible model choice for this agent's task, e.g. 'Claude Sonnet 4.5' or 'GPT-4o'",
      "tools": [{"name": "string, e.g. 'PDF Parser'", "purpose": "short phrase"}],
      "replaces_step_ids": ["step_id", ...],
      "stages": [
        {
          "stage": "Detect|Plan|Nudge|Insight|Action|Learning Loop",
          "label": "string — short stage title specific to this agent, e.g. 'Hiring Need Trigger'",
          "description": "string — one sentence, 'The AI Agent ...' phrasing",
          "builtOn": "Sana Core|Sana Enterprise|Developer Agent|Workday Self-Service Agent|Conversational Scheduling|ASOR-native (1P)|Custom cloud tooling",
          "agentType": "1P|3P|External",
          "executionMode": "Ambient|Delegate",
          "groundingRef": "string — must exactly match a [source_document] tag from <workday_ai_capabilities>, or null if nothing relevant was retrieved for this stage"
        }
      ],
      "maturity": {
        "position": "number 0-1 — where this agent sits on AI Assisted (0) -> AI Augmented (0.5) -> AI Powered (1)",
        "note": "string or null — caveat, e.g. dependency on a system going live"
      },
      "humanRoles": [
        {"tier": "Human Led|Human Guided|Human Supervised", "description": "string"}
      ]
    }
  ]
}

Transformation rules:
1. sana_agent steps → move to a new "Sana AI" lane (lane_id="ai_lane", position=0, persona="Sana Agent").
   Prefix label ⚡. Include the specific agent name in transformation_note.
   If consecutive sana_agent steps have no human steps between them, merge them into one step.
2. workday_native steps → keep in original lane, prefix label 🔄. Automated — no human action.
3. partial_ai steps → keep in original lane, prefix label 🤖. Human still decides; Sana prepares context.
4. human_only steps → keep exactly as-is, no prefix, no transformation_note.
5. Create the "Sana AI" lane only if ≥1 sana_agent step exists; place it at position 0 (top).
6. Preserve ALL decision steps and their branching connectors exactly.
7. Do NOT duplicate steps — each as-is step maps to exactly one to-be step (or is merged).
8. Keep original step_ids for unchanged steps. Use "tobe_001", "tobe_002"… for moved/merged steps.
9. ALL connectors must reference valid step_ids in your steps array — validate before returning.
10. Every step must be reachable in the flow. No orphaned steps.
11. proposed_agents: create one agent per distinct group of consolidated sana_agent/workday_native/partial_ai \
    steps (typically one agent per selected intervention, occasionally merging two very related interventions \
    into one agent if that better reflects how a single agent would actually be built). Every step_id across \
    all proposed_agents must exist in your steps array. Do not propose an agent for human_only steps.
12. Every proposed_agent's "stages" must map its own work onto the six fixed stages above (Detect/Plan/Nudge/ \
    Insight/Action/Learning Loop) — this is a shared vocabulary, not a mandatory checklist: omit a stage the \
    agent genuinely doesn't use rather than inventing filler content for it. Do not invent new stage names.
13. "builtOn" must be chosen from the enumerated tool catalog first; fall back to "Custom cloud tooling" ONLY \
    if nothing in that catalog fits the stage's actual mechanism — this fallback is a visible signal that the \
    stage needs custom build effort, so never pick it just because a more specific tool wasn't explicitly named \
    in the capability context.
14. "groundingRef" must name a document that actually appears as a [source_document] tag in the \
    <workday_ai_capabilities> block you were given. If nothing relevant was retrieved for a given stage, set \
    groundingRef to null — never fabricate a citation to a document you were not shown.
15. "maturity.position" and "humanRoles" should reflect this specific agent's actual automation depth — do not \
    default every agent to the same position or role tier; vary it based on how much of the stage sequence is \
    genuinely autonomous (Ambient, no groundingRef gaps, high builtOn confidence) versus human-dependent."""


# ── GET /process-intelligence/{process_id}/status ────────────────────────────

def status_handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    process_id = (event.get("pathParameters") or {}).get("process_id", "")
    if not process_id:
        return http.bad_request("process_id path parameter is required")

    meta = get_process_graph_status(process_id=process_id, tenant_id=ctx.tenant_id)
    if not meta:
        return http.bad_request("process graph not found")

    return http.ok({
        "process_id":       meta["process_id"],
        "parse_status":     meta["parse_status"],
        "parse_confidence": meta["parse_confidence"],
        "parse_warnings":   meta["parse_warnings"],
        "parse_error":      meta["parse_error"],
        "domain":           meta["domain"],
        "source_name":      meta["source_name"],
        "created_at":       meta["created_at"],
        "updated_at":       meta["updated_at"],
    })


# ── GET /process-intelligence/{process_id}/graph ─────────────────────────────

def graph_get_handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    process_id = (event.get("pathParameters") or {}).get("process_id", "")
    if not process_id:
        return http.bad_request("process_id path parameter is required")

    graph = get_full_graph(process_id=process_id, tenant_id=ctx.tenant_id)
    if not graph:
        return http.bad_request("process graph not found")

    if graph["parse_status"] not in _GRAPH_READABLE:
        return http.bad_request(
            f"graph is not yet available (status: {graph['parse_status']})"
        )

    return http.ok(graph)


# ── PATCH /process-intelligence/{process_id}/graph ───────────────────────────

def graph_patch_handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    process_id = (event.get("pathParameters") or {}).get("process_id", "")
    if not process_id:
        return http.bad_request("process_id path parameter is required")

    try:
        body = json.loads(event.get("body") or "{}")
    except Exception:
        return http.bad_request("invalid JSON body")

    step_patches      = body.get("step_patches") or []
    lane_patches      = body.get("lane_patches") or []
    connector_patches = body.get("connector_patches") or []

    if not step_patches and not lane_patches and not connector_patches:
        return http.bad_request("at least one of step_patches, lane_patches, or connector_patches is required")

    try:
        patch_graph(
            process_id=process_id,
            tenant_id=ctx.tenant_id,
            step_patches=step_patches,
            lane_patches=lane_patches,
            connector_patches=connector_patches,
        )
    except PermissionError as exc:
        return http.forbidden(str(exc))
    except Exception as exc:
        log.exception("patch_graph error process_id=%s: %s", process_id, exc)
        return http.server_error(f"patch error: {exc}")

    audit_events.write(
        ctx,
        "pi.graph.patched",
        resource_type="process_graph",
        resource_id=process_id,
        resource_name=process_id,
        details={
            "step_patches":      len(step_patches),
            "lane_patches":      len(lane_patches),
            "connector_patches": len(connector_patches),
        },
    )

    return http.ok({"process_id": process_id, "patched": True})


# ── Shared helpers ────────────────────────────────────────────────────────────

def _build_as_is(graph: dict) -> dict:
    return {
        "swimlanes": graph["swimlanes"],
        "steps": [
            {
                "step_id":        s["step_id"],
                "lane_id":        s["lane_id"],
                "label":          s["label"],
                "step_type":      s["type"],
                "systems_touched": s["systems_touched"],
                "ai_opportunity": s["ai_opportunity"],
                "ai_rationale":   s["ai_rationale"],
            }
            for s in graph["steps"]
        ],
        "connectors": [
            {"from": c["from"], "to": c["to"], "condition": c.get("condition")}
            for c in graph["connectors"]
        ],
    }


def _kb_block(ctx, graph: dict, process_id: str, extra_query: str = "") -> str:
    """RAG: retrieve relevant Workday AI capability content from the knowledge base.

    Merges two sources: the tenant's own uploaded "kb" documents (DynamoDB,
    consultant-curated per-client context) and the shared, curated ASOR/Sana
    grounding corpus (Aurora pgvector, admin-maintained, not tenant-scoped) —
    the latter is what lets generation cite a real, specific product document
    per stage instead of a vague "capability ledger" reference.
    """
    blocks: list[str] = []
    try:
        step_labels = ", ".join(s["label"] for s in graph["steps"][:10])
        query = (
            f"Workday Sana AI agents capabilities for {graph['domain']} process. "
            f"Steps include: {step_labels}. {extra_query}"
            f"Which specific Sana agents apply and what can they automate?"
        )
        qv = bedrock.embed(query)

        kb_hits = vectors.search(ctx, qv, top_k=5, doc_type="kb")
        if kb_hits:
            blocks.extend(
                f"[{h.get('source_name', 'knowledge base')}]\n{h['text']}"
                for h in kb_hits
            )
            log.info("RAG: retrieved %d tenant kb chunks for process_id=%s", len(kb_hits), process_id)

        grounding_hits = search_grounding_corpus(qv, top_k=5)
        if grounding_hits:
            blocks.extend(
                f"[{h['source_document']}]\n{h['chunk_text']}"
                for h in grounding_hits
            )
            log.info("RAG: retrieved %d grounding corpus chunks for process_id=%s", len(grounding_hits), process_id)
    except Exception as exc:
        log.warning("RAG retrieval failed (non-fatal): %s", exc)

    kb_text = "\n\n".join(blocks)
    return (
        f"<workday_ai_capabilities>\n{kb_text}\n</workday_ai_capabilities>\n\n"
        if kb_text else
        "<workday_ai_capabilities>No capability documents indexed yet — use general Workday Sana knowledge.</workday_ai_capabilities>\n\n"
    )


# ── POST/GET /process-intelligence/{process_id}/recommendations ─────────────

def recommendations_post_handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    process_id = (event.get("pathParameters") or {}).get("process_id", "")
    if not process_id:
        return http.bad_request("process_id path parameter is required")

    try:
        graph = get_full_graph(process_id=process_id, tenant_id=ctx.tenant_id)
    except Exception as exc:
        log.exception("get_full_graph error process_id=%s: %s", process_id, exc)
        return http.server_error(f"Failed to load process graph: {exc}")
    if not graph:
        return http.bad_request("process graph not found")

    if graph["parse_status"] not in _GRAPH_READABLE:
        return http.bad_request(
            f"graph not ready for recommendations (status: {graph['parse_status']})"
        )

    as_is = _build_as_is(graph)
    kb_block = _kb_block(ctx, graph, process_id)
    user_prompt = kb_block + "<as_is_process>\n" + json.dumps(as_is, indent=2) + "\n</as_is_process>"

    try:
        recommendations = bedrock.generate_json(
            system=_RECS_SYSTEM,
            user_prompt=user_prompt,
            max_tokens=4096,
        )
    except Exception as exc:
        log.exception("recommendations bedrock error process_id=%s: %s", process_id, exc)
        return http.server_error(f"AI generation failed: {exc}")

    try:
        store_recommendations(process_id=process_id, tenant_id=ctx.tenant_id, recommendations=recommendations)
    except Exception as exc:
        log.exception("store_recommendations error process_id=%s: %s", process_id, exc)
        return http.server_error(f"Failed to store recommendations: {exc}")

    audit_events.write(
        ctx,
        "pi.recommendations.generated",
        resource_type="process_graph",
        resource_id=process_id,
        resource_name=process_id,
        details={"intervention_count": len(recommendations.get("interventions", []))},
    )

    return http.ok({"process_id": process_id, "recommendations": recommendations})


def recommendations_get_handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    process_id = (event.get("pathParameters") or {}).get("process_id", "")
    if not process_id:
        return http.bad_request("process_id path parameter is required")

    try:
        recommendations = get_recommendations(process_id=process_id, tenant_id=ctx.tenant_id)
    except Exception as exc:
        log.exception("get_recommendations error process_id=%s: %s", process_id, exc)
        return http.server_error(f"Failed to load recommendations: {exc}")
    return http.ok({"process_id": process_id, "recommendations": recommendations})


# ── POST /process-intelligence/{process_id}/tobe ("Apply & Generate") ───────
#
# Async trigger+worker+poll, same pattern as pi_parse/pi_agent_lld — required
# because the richer schema + validate-with-retry loop can legitimately run
# 30-45s, which exceeds API Gateway HTTP API's hard, non-configurable 29s
# Lambda-proxy integration timeout. The trigger below only does cheap
# validation/lookups and returns immediately; PiGraphWorkerFn (this same code
# asset, handler.tobe_worker_handler) does the actual generation.

def tobe_handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    process_id = (event.get("pathParameters") or {}).get("process_id", "")
    if not process_id:
        return http.bad_request("process_id path parameter is required")

    try:
        body = json.loads(event.get("body") or "{}")
    except Exception:
        return http.bad_request("invalid JSON body")

    selected_intervention_ids = body.get("selected_intervention_ids") or []
    additional_directions = (body.get("additional_directions") or "").strip()

    try:
        graph = get_full_graph(process_id=process_id, tenant_id=ctx.tenant_id)
    except Exception as exc:
        log.exception("get_full_graph error process_id=%s: %s", process_id, exc)
        return http.server_error(f"Failed to load process graph: {exc}")
    if not graph:
        return http.bad_request("process graph not found")

    if graph["parse_status"] not in _GRAPH_READABLE:
        return http.bad_request(
            f"graph not ready for to-be generation (status: {graph['parse_status']})"
        )

    update_tobe_status(process_id=process_id, tenant_id=ctx.tenant_id, status="generating")

    if not _WORKER_FUNCTION_ARN:
        log.error("PI_GRAPH_WORKER_FUNCTION_ARN not configured")
        return http.server_error("Agentic workflow worker not configured")

    worker_payload = {
        "process_id":                process_id,
        "tenant_id":                 ctx.tenant_id,
        "user_id":                   ctx.user_id,
        "role":                      ctx.role,
        "email":                     ctx.email,
        "selected_intervention_ids": selected_intervention_ids,
        "additional_directions":     additional_directions,
    }
    _lambda_client.invoke(
        FunctionName=_WORKER_FUNCTION_ARN,
        InvocationType="Event",
        Payload=json.dumps(worker_payload).encode(),
    )

    log.info("tobe generation triggered process_id=%s", process_id)
    return http.ok({"process_id": process_id, "tobe_status": "generating"})


# ── Worker (direct Lambda invocation) ────────────────────────────────────────

def tobe_worker_handler(event: dict, context: object) -> None:
    process_id = event["process_id"]
    tenant_id = event["tenant_id"]
    selected_intervention_ids = event.get("selected_intervention_ids") or []
    additional_directions = (event.get("additional_directions") or "").strip()

    ctx = TenantContext(
        tenant_id=tenant_id,
        user_id=event.get("user_id", ""),
        role=event.get("role", "consultant"),
        email=event.get("email", ""),
    )

    try:
        graph = get_full_graph(process_id=process_id, tenant_id=tenant_id)
        if not graph:
            raise ValueError("process graph not found")

        as_is = _build_as_is(graph)

        stored_recs = get_recommendations(process_id=process_id, tenant_id=tenant_id) or {}
        all_interventions = stored_recs.get("interventions", [])
        if selected_intervention_ids:
            selected = [i for i in all_interventions if i.get("intervention_id") in selected_intervention_ids]
        else:
            selected = all_interventions

        kb_block = _kb_block(ctx, graph, process_id)
        selection_block = (
            "<selected_interventions>\n" + json.dumps(selected, indent=2) + "\n</selected_interventions>\n\n"
            if selected else
            "<selected_interventions>None selected — apply your own judgment based on the as-is AI opportunity "
            "classifications.</selected_interventions>\n\n"
        )
        directions_block = (
            f"<additional_directions>{additional_directions}</additional_directions>\n\n"
            if additional_directions else ""
        )
        user_prompt = (
            kb_block + selection_block + directions_block +
            "<as_is_process>\n" + json.dumps(as_is, indent=2) + "\n</as_is_process>"
        )

        tobe = schemas.validate_with_retry(
            system=_TOBE_SYSTEM,
            user_prompt=user_prompt,
            max_tokens=8000,
        )

        store_tobe_graph(process_id=process_id, tenant_id=tenant_id, tobe_graph=tobe)
        proposed_agents = create_agents(
            process_id=process_id,
            tenant_id=tenant_id,
            agents=tobe.get("proposed_agents", []),
        )
        update_tobe_status(process_id=process_id, tenant_id=tenant_id, status="done")

        audit_events.write(
            ctx,
            "pi.tobe.generated",
            resource_type="process_graph",
            resource_id=process_id,
            resource_name=process_id,
            details={
                "steps_automated": tobe.get("ai_stats", {}).get("steps_automated"),
                "agent_count": len(proposed_agents),
            },
        )
        log.info("tobe worker done process_id=%s agent_count=%d", process_id, len(proposed_agents))

    except Exception as exc:
        log.error("tobe worker error process_id=%s: %s", process_id, exc, exc_info=True)
        update_tobe_status(process_id=process_id, tenant_id=tenant_id, status="failed", error=str(exc))


# ── GET /process-intelligence/{process_id}/tobe (poll / refetch) ────────────

def tobe_get_handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    process_id = (event.get("pathParameters") or {}).get("process_id", "")
    if not process_id:
        return http.bad_request("process_id path parameter is required")

    try:
        tobe_row = get_tobe_graph(process_id=process_id, tenant_id=ctx.tenant_id)
        proposed_agents = list_agents(process_id=process_id, tenant_id=ctx.tenant_id)
    except Exception as exc:
        log.exception("get_tobe_graph/list_agents error process_id=%s: %s", process_id, exc)
        return http.server_error(f"Failed to load agentic workflow: {exc}")

    return http.ok({
        "process_id":      process_id,
        "tobe":            tobe_row["tobe_graph"],
        "tobe_status":     tobe_row["tobe_status"],
        "tobe_error":      tobe_row["tobe_error"],
        "proposed_agents": proposed_agents,
    })


# ── Dispatcher (single Lambda for all graph/recommendations/tobe routes) ────

def handler(event: dict, context: object) -> dict:
    """
    Single Lambda entry point dispatching by path + HTTP method.

    Routes:
      GET   .../{process_id}/status           → status_handler
      GET   .../{process_id}/graph            → graph_get_handler
      PATCH .../{process_id}/graph            → graph_patch_handler
      POST  .../{process_id}/recommendations  → recommendations_post_handler
      GET   .../{process_id}/recommendations  → recommendations_get_handler
      POST  .../{process_id}/tobe             → tobe_handler
      GET   .../{process_id}/tobe             → tobe_get_handler
    """
    method   = (event.get("requestContext") or {}).get("http", {}).get("method", "").upper()
    raw_path = event.get("rawPath") or event.get("path") or ""

    if raw_path.endswith("/status"):
        return status_handler(event, context)

    if raw_path.endswith("/recommendations"):
        return recommendations_post_handler(event, context) if method == "POST" else recommendations_get_handler(event, context)

    if raw_path.endswith("/tobe"):
        return tobe_handler(event, context) if method == "POST" else tobe_get_handler(event, context)

    if method == "GET":
        return graph_get_handler(event, context)

    if method == "PATCH":
        return graph_patch_handler(event, context)

    return http.bad_request(f"unsupported method {method} on this route")
