"""
Process Intelligence — per-agent Low-Level Design document generation.

Trigger: POST /process-intelligence/{process_id}/agents/{agent_id}/lld
  Role: consultant | admin
  Sets lld_status='generating', enqueues a 'pi_agent_lld' job on the shared
  Storage Queue.
  Returns: { agent_id, status: "generating" }

Poll:    GET /process-intelligence/{process_id}/agents/{agent_id}/lld
  Role: consultant | admin
  Returns: { agent_id, lld_status, lld_markdown, lld_error }

Worker:  queue-triggered (wired in Phase 7), dispatched by job_type
  Generates the full markdown design document via the AI module and stores it
  directly on the pi.agents row (no separate job record — the agent row
  itself is the job record, same pattern as pi_parse's status-on-row model).

This is the single largest AI generation in the app (long-form markdown,
not JSON) — always async, since an 8000-token completion can comfortably
exceed a synchronous HTTP request's timeout.
"""

from __future__ import annotations

import json
import logging
import os

from common import tenant_from_event, TenantError, ai, audit_events, queue, http
from common.tenant import TenantContext
from common.pi_aurora import get_agent, get_process_graph_status, update_agent_lld

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_LLD_SYSTEM = """You are a senior AI solutions architect writing a formal Low-Level Design (LLD) document for a \
single proposed AI agent within a Workday transformation program. You will receive the agent's name, \
description, proposed model, tools, kind (conversational or workspace), the process domain, and the specific \
as-is process steps this agent replaces or touches.

Ground the design in how this would actually be BUILT on the Workday platform, not a generic AI-agent \
architecture that could belong to any vendor. Every agent is built one of two ways — decide which one this \
agent is and be explicit about it, don't hedge:
- **Native Sana Agent** — this agent maps to (or closely extends) an existing Sana capability category (e.g. \
  a Talent Acquisition Agent, Payroll Agent, Self-Service Agent, Talent Mobility Agent). It's configured and \
  extended using the **Sana Developer Agent** tooling rather than built from scratch — describe specifically \
  what gets configured through it (triggers, tool bindings, guardrails) versus what's inherited from the base \
  Sana capability.
- **Custom agent on Workday Extend + LLM** — this agent doesn't map to an existing Sana category, or its kind \
  is "workspace" (a document/dashboard a human reviews, not a conversational exchange) — these are typically \
  built as a custom **Workday Extend** application (Extend owns the UI, custom data objects, and orchestration \
  logic) that calls out to the given LLM for the generative/reasoning step (drafting, summarizing, or \
  synthesizing across the data Extend has assembled). Be specific about the division of labor: what Extend's \
  data model and screens handle versus what's delegated to the LLM call, and roughly where in the Extend \
  orchestration flow that call happens.

Do NOT use the deprecated "Illuminate" brand — use "Sana", "Workday Extend", and "Sana Developer Agent" \
by name wherever they apply. Never describe an agent's underlying platform in generic terms ("a cloud AI \
service", "the agent platform") when one of the two real paths above applies.

Write the FULL document directly as markdown (no JSON, no preamble, no meta-commentary — output starts with \
the first heading and ends with the last line of content). Use this exact structure:

# Agent Design: {agent name}
### Low-Level Design Document

## 1. Agent Overview
- **Objective**: ...
- **Role**: ...
- **Value Proposition**: ...

## 2. Interface Specification
### Inputs
- `field_name` (Type): description
(3-6 realistic input fields grounded in the process steps this agent touches)

### Outputs
- `field_name` (Type): description
(2-5 realistic output fields)

### Triggers
- **Event Type**: Event-driven | Scheduled | Manual
- **Frequency**: ...
- **Source**: ...
- **Payload**: ...

## 3. Architecture & Components
### Platform & Build Approach
- **Build Approach**: Native Sana Agent | Custom Agent (Workday Extend + LLM) — pick one, justify it in \
  1-2 sentences against the agent's actual description and kind.
- If Native Sana Agent: **Base Capability** (which Sana category this extends) and **Sana Developer Agent \
  Configuration** (what's configured through it — triggers, tool bindings, guardrails — versus inherited \
  from the base capability).
- If Custom Agent (Workday Extend + LLM): **Extend App Scope** (the custom data objects, screens, and \
  orchestration logic Extend owns) and **LLM Integration Point** (exactly where in the Extend flow the LLM \
  is called, what it's given as input, and what it returns).

### Model Configuration
- **Model**: {the given model}
- **Temperature**: a specific value with a one-line justification
- **Max Tokens**: a specific value
- **System Prompt**: 2-3 sentences describing what the system prompt must enforce

### Prompting Strategy
- **Prompt Template**: ...
- **Few-shot Examples**: ...
- **Chain-of-Thought**: ...

### Memory & Context
- **Memory Type**: ...
- **Retrieval Strategy**: ...
- **Context Window Management**: ...
- **State Persistence**: ...

### Tools & Function Calls
A markdown table with columns: Tool Name | Purpose | API/Endpoint | Auth Method | Input Schema | Output Schema.
Include one row per tool given, plus any implied supporting tools (e.g. an exception/escalation tool).

## 4. Integration Logic
### Protocol
- **Integration Pattern**: ...
- **Authentication**: ...
- **Error Handling**: ...

### Data Flow
A numbered list (1., 2., 3., ...) walking through trigger → tool calls → model processing → output delivery.

### Security Considerations
- **API Key Management**: ...
- **Encryption**: ...
- **PII Handling**: ...

## 5. Risk & Controls (Trustworthy AI)
### Guardrails
- **Input validation rules**: ...
- **Output validation rules**: ...
- **Content filtering requirements**: ...
- **Hallucination prevention measures**: ...

### Human-in-the-Loop
- **Review Triggers**: ...
- **Escalation criteria**: ...
- **Override mechanisms**: ...

### Monitoring & Observability
- **Key metrics to track**: ...
- **Alerting thresholds**: ...
- **Logging requirements**: ...

## 6. Implementation Checklist
- [ ] Define and test System Prompt
(6-10 concrete, ordered checklist items covering prompt design, tool wiring, guardrail testing, monitoring \
setup, and rollout)

Ground every section in the specific agent and process context you were given — do not write generic \
placeholder content. Be concrete: name real field names, plausible endpoint paths, and specific metrics."""


# ── Trigger handler (API) ─────────────────────────────────────────────────────

def handler(event: dict, context: object) -> dict:
    method = (event.get("requestContext") or {}).get("http", {}).get("method", "").upper()
    if method == "GET":
        return poll_handler(event, context)
    return trigger_handler(event, context)


def trigger_handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    path_params = event.get("pathParameters") or {}
    process_id = path_params.get("process_id", "")
    agent_id = path_params.get("agent_id", "")
    if not process_id or not agent_id:
        return http.bad_request("process_id and agent_id path parameters are required")

    try:
        agent = get_agent(agent_id=agent_id, tenant_id=ctx.tenant_id)
        process_meta = get_process_graph_status(process_id=process_id, tenant_id=ctx.tenant_id)
    except Exception as exc:
        log.exception("agent/process lookup error agent_id=%s process_id=%s: %s", agent_id, process_id, exc)
        return http.server_error(f"Failed to load agent: {exc}")
    if not agent or agent.get("process_id") != process_id:
        return http.bad_request("agent not found")
    if not process_meta:
        return http.bad_request("process graph not found")

    update_agent_lld(agent_id=agent_id, tenant_id=ctx.tenant_id, status="generating")

    worker_payload = {
        "process_id": process_id,
        "agent_id":   agent_id,
        "tenant_id":  ctx.tenant_id,
        "user_id":    ctx.user_id,
        "role":       ctx.role,
        "email":      ctx.email,
        "domain":     process_meta["domain"],
        "ip":         audit_events.get_ip(event),
    }

    queue.enqueue_job("pi_agent_lld", worker_payload)

    log.info("pi_agent_lld triggered process_id=%s agent_id=%s", process_id, agent_id)
    return http.ok({"agent_id": agent_id, "status": "generating"})


# ── Poll handler (API) ────────────────────────────────────────────────────────

def poll_handler(event: dict, context: object) -> dict:
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin")
    except TenantError as exc:
        return http.forbidden(str(exc))

    path_params = event.get("pathParameters") or {}
    agent_id = path_params.get("agent_id", "")
    if not agent_id:
        return http.bad_request("agent_id path parameter is required")

    try:
        agent = get_agent(agent_id=agent_id, tenant_id=ctx.tenant_id)
    except Exception as exc:
        log.exception("get_agent error agent_id=%s: %s", agent_id, exc)
        return http.server_error(f"Failed to load agent: {exc}")
    if not agent:
        return http.bad_request("agent not found")

    return http.ok({
        "agent_id":     agent["agent_id"],
        "lld_status":   agent["lld_status"],
        "lld_markdown": agent["lld_markdown"],
        "lld_error":    agent["lld_error"],
    })


# ── Worker handler (queue-triggered, dispatched by job_type) ─────────────────

def worker_handler(payload: dict) -> None:
    process_id = payload["process_id"]
    agent_id   = payload["agent_id"]
    tenant_id  = payload["tenant_id"]
    domain     = payload.get("domain", "")
    ip         = payload.get("ip", "unknown")

    ctx = TenantContext(
        tenant_id=tenant_id,
        user_id=payload.get("user_id", ""),
        role=payload.get("role", "consultant"),
        email=payload.get("email", ""),
    )

    try:
        agent = get_agent(agent_id=agent_id, tenant_id=tenant_id)
        if not agent:
            raise ValueError(f"agent {agent_id} not found")

        user_prompt = (
            f"<process_domain>{domain}</process_domain>\n\n"
            "<agent>\n" + json.dumps({
                "name":              agent["name"],
                "description":       agent["description"],
                "model":             agent["model"],
                "tools":             agent["tools"],
                "replaces_step_ids": agent["replaces_step_ids"],
                "kind":              agent.get("kind") or "workspace",
            }, indent=2) + "\n</agent>"
        )

        markdown = ai.generate(
            system=_LLD_SYSTEM,
            messages=[{"role": "user", "content": user_prompt}],
            max_tokens=8000,
            temperature=0.2,
        )

        if not markdown or not markdown.strip():
            raise ValueError("empty LLD document generated")

        update_agent_lld(agent_id=agent_id, tenant_id=tenant_id, status="done", markdown=markdown)

        audit_events.write(
            ctx,
            "pi.agent_lld.generated",
            ip=ip,
            resource_type="pi_agent",
            resource_id=agent_id,
            resource_name=agent["name"],
            details={"process_id": process_id, "markdown_chars": len(markdown)},
        )
        log.info("pi_agent_lld worker done agent_id=%s chars=%d", agent_id, len(markdown))

    except Exception as exc:
        log.error("pi_agent_lld worker error agent_id=%s: %s", agent_id, exc, exc_info=True)
        update_agent_lld(agent_id=agent_id, tenant_id=tenant_id, status="failed", error=str(exc))
