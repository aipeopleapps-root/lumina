"""
Aurora helpers for the Process Intelligence module.

All functions operate on the `pi` schema. Tenant isolation is enforced
by always filtering on tenant_id — never query without it.

Uses common.db.get_connection() (RDS Data API with transactions).
Column ordering in SELECT queries is documented inline so callers can map
tuples → dicts without relying on column metadata from the Data API.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from .db import get_connection

# ── Grounding corpus ──────────────────────────────────────────────────────────
# Exception to the file-level "always filter on tenant_id" rule: this table is
# deliberately shared/non-tenant-scoped (curated ASOR/Sana product docs every
# tenant's Agentic Workflow generation should be able to cite).

def search_grounding_corpus(query_embedding: list[float], *, top_k: int = 5) -> list[dict]:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT source_document, chunk_text
                FROM pi.grounding_corpus
                ORDER BY embedding <=> %s::vector
                LIMIT %s
                """,
                [query_embedding, top_k],
            )
            rows = cur.fetchall()
    return [{"source_document": r[0], "chunk_text": r[1]} for r in rows]


# ── Process graphs ────────────────────────────────────────────────────────────

def create_process_graph(
    *,
    tenant_id: str,
    uploaded_by: str,
    domain: str,
    s3_key: str,
    source_name: str,
) -> str:
    """Insert a new process graph record with status='uploading'. Returns process_id."""
    process_id = str(uuid.uuid4())
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO pi.process_graphs
                  (process_id, tenant_id, uploaded_by, domain,
                   source_file_s3_key, source_name, parse_status)
                VALUES (%s, %s, %s, %s, %s, %s, 'uploading')
                """,
                [process_id, tenant_id, uploaded_by, domain, s3_key, source_name],
            )
    return process_id


def get_process_graph_status(*, process_id: str, tenant_id: str) -> dict | None:
    """
    Returns {process_id, parse_status, parse_confidence, parse_warnings, parse_error,
             domain, source_name, source_file_s3_key, created_at, updated_at}
    or None if not found / wrong tenant.
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT process_id, parse_status, parse_confidence,
                       parse_warnings, parse_error, domain, source_name,
                       source_file_s3_key, created_at, updated_at
                FROM pi.process_graphs
                WHERE process_id = %s AND tenant_id = %s
                """,
                [process_id, tenant_id],
            )
            row = cur.fetchone()
    if not row:
        return None
    # Column order: 0-process_id, 1-parse_status, 2-parse_confidence,
    #               3-parse_warnings, 4-parse_error, 5-domain,
    #               6-source_name, 7-source_file_s3_key, 8-created_at, 9-updated_at
    warnings_raw = row[3]
    return {
        "process_id":         row[0],
        "parse_status":       row[1],
        "parse_confidence":   row[2],
        "parse_warnings":     json.loads(warnings_raw) if isinstance(warnings_raw, str) else (warnings_raw or []),
        "parse_error":        row[4],
        "domain":             row[5],
        "source_name":        row[6],
        "source_file_s3_key": row[7],
        "created_at":         str(row[8]),
        "updated_at":         str(row[9]),
    }


def update_parse_status(
    *,
    process_id: str,
    tenant_id: str,
    status: str,
    parse_confidence: float | None = None,
    parse_warnings: list | None = None,
    parse_error: str | None = None,
) -> None:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE pi.process_graphs
                SET parse_status     = %s,
                    parse_confidence = %s,
                    parse_warnings   = %s,
                    parse_error      = %s,
                    updated_at       = NOW()
                WHERE process_id = %s AND tenant_id = %s
                """,
                [
                    status,
                    parse_confidence,
                    json.dumps(parse_warnings or []),
                    parse_error,
                    process_id,
                    tenant_id,
                ],
            )


# ── Full graph read/write ─────────────────────────────────────────────────────

def store_graph(
    *,
    process_id: str,
    tenant_id: str,
    swimlanes: list[dict],
    steps: list[dict],
    connectors: list[dict],
    parse_confidence: float,
    parse_warnings: list[dict],
) -> None:
    """
    Atomically replace swimlane/step/connector rows for a process graph.
    Called by the parse worker after a successful parse.
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            # Delete existing rows (CASCADE from process_graphs handles steps/connectors
            # but we have separate tables, so delete explicitly for clarity)
            cur.execute(
                "DELETE FROM pi.connectors WHERE process_id = %s", [process_id]
            )
            cur.execute(
                "DELETE FROM pi.steps WHERE process_id = %s", [process_id]
            )
            cur.execute(
                "DELETE FROM pi.swimlanes WHERE process_id = %s", [process_id]
            )

            # Insert swimlanes
            for lane in swimlanes:
                cur.execute(
                    """
                    INSERT INTO pi.swimlanes (process_id, lane_id, label, persona, position)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    [
                        process_id,
                        lane["lane_id"],
                        lane["label"],
                        lane.get("persona"),
                        lane.get("position", 0),
                    ],
                )

            # Insert steps
            for step in steps:
                cur.execute(
                    """
                    INSERT INTO pi.steps
                      (process_id, step_id, lane_id, label, step_type,
                       systems_touched, ai_opportunity, ai_rationale,
                       avg_cycle_time_hrs, notes,
                       position_x, position_y, parse_confidence)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    [
                        process_id,
                        step["step_id"],
                        step.get("lane_id"),
                        step["label"],
                        step.get("step_type"),
                        json.dumps(step.get("systems_touched") or []),
                        step.get("ai_opportunity"),
                        step.get("ai_rationale"),
                        step.get("avg_cycle_time_hrs"),
                        step.get("notes"),
                        step.get("position_x"),
                        step.get("position_y"),
                        step.get("parse_confidence", 1.0),
                    ],
                )

            # Insert connectors
            for conn_edge in connectors:
                cur.execute(
                    """
                    INSERT INTO pi.connectors
                      (process_id, from_step_id, to_step_id,
                       condition_label, parse_confidence)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    [
                        process_id,
                        conn_edge["from"],
                        conn_edge["to"],
                        conn_edge.get("condition"),
                        conn_edge.get("parse_confidence", 1.0),
                    ],
                )

            # Update process graph status
            cur.execute(
                """
                UPDATE pi.process_graphs
                SET parse_status     = %s,
                    parse_confidence = %s,
                    parse_warnings   = %s,
                    parse_error      = NULL,
                    updated_at       = NOW()
                WHERE process_id = %s AND tenant_id = %s
                """,
                [
                    "needs_review" if parse_warnings else "ready",
                    parse_confidence,
                    json.dumps(parse_warnings),
                    process_id,
                    tenant_id,
                ],
            )


def get_full_graph(*, process_id: str, tenant_id: str) -> dict | None:
    """
    Returns the complete process graph (header + swimlanes + steps + connectors),
    or None if not found / wrong tenant.
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            # Header
            cur.execute(
                """
                SELECT process_id, tenant_id, domain, source_name,
                       source_file_s3_key, parse_status, parse_confidence,
                       parse_warnings, created_at
                FROM pi.process_graphs
                WHERE process_id = %s AND tenant_id = %s
                """,
                [process_id, tenant_id],
            )
            header = cur.fetchone()
            if not header:
                return None

            # Swimlanes
            cur.execute(
                """
                SELECT lane_id, label, persona, position
                FROM pi.swimlanes WHERE process_id = %s ORDER BY position
                """,
                [process_id],
            )
            lanes = [
                {"lane_id": r[0], "label": r[1], "persona": r[2], "position": r[3]}
                for r in cur.fetchall()
            ]

            # Steps
            cur.execute(
                """
                SELECT step_id, lane_id, label, step_type, systems_touched,
                       ai_opportunity, ai_rationale,
                       avg_cycle_time_hrs, notes, position_x, position_y,
                       parse_confidence
                FROM pi.steps WHERE process_id = %s ORDER BY step_id
                """,
                [process_id],
            )
            steps = [
                {
                    "step_id":            r[0],
                    "lane_id":            r[1],
                    "label":              r[2],
                    "type":               r[3],
                    "systems_touched":    json.loads(r[4]) if r[4] else [],
                    "ai_opportunity":     r[5],
                    "ai_rationale":       r[6],
                    "avg_cycle_time_hrs": r[7],
                    "notes":              r[8],
                    "position_x":         r[9],
                    "position_y":         r[10],
                    "parse_confidence":   r[11],
                }
                for r in cur.fetchall()
            ]

            # Connectors — include serial id so patches can reference it
            cur.execute(
                """
                SELECT id, from_step_id, to_step_id, condition_label, parse_confidence
                FROM pi.connectors WHERE process_id = %s ORDER BY id
                """,
                [process_id],
            )
            connectors = [
                {
                    "connector_id":     r[0],
                    "from":             r[1],
                    "to":               r[2],
                    "condition":        r[3],
                    "parse_confidence": r[4],
                }
                for r in cur.fetchall()
            ]

    warnings_raw = header[7]
    return {
        "process_id":       header[0],
        "tenant_id":        header[1],
        "domain":           header[2],
        "source_name":      header[3],
        "source_file_s3_key": header[4],
        "parse_status":     header[5],
        "parse_confidence": header[6],
        "parse_warnings":   json.loads(warnings_raw) if isinstance(warnings_raw, str) else (warnings_raw or []),
        "created_at":       str(header[8]),
        "swimlanes":        lanes,
        "steps":            steps,
        "connectors":       connectors,
    }


def store_tobe_graph(*, process_id: str, tenant_id: str, tobe_graph: dict) -> None:
    """Persist a Bedrock-generated to-be graph against a process record."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM pi.process_graphs WHERE process_id = %s AND tenant_id = %s",
                [process_id, tenant_id],
            )
            if not cur.fetchone():
                raise PermissionError("process graph not found or access denied")
            cur.execute(
                """
                UPDATE pi.process_graphs
                SET tobe_graph = %s, updated_at = NOW()
                WHERE process_id = %s AND tenant_id = %s
                """,
                [json.dumps(tobe_graph), process_id, tenant_id],
            )


def get_tobe_graph(*, process_id: str, tenant_id: str) -> dict:
    """Returns {"tobe_graph": dict|None, "tobe_status": str|None, "tobe_error": str|None}."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT tobe_graph, tobe_status, tobe_error FROM pi.process_graphs "
                "WHERE process_id = %s AND tenant_id = %s",
                [process_id, tenant_id],
            )
            row = cur.fetchone()
    if not row:
        return {"tobe_graph": None, "tobe_status": None, "tobe_error": None}
    raw = row[0]
    return {
        "tobe_graph": json.loads(raw) if isinstance(raw, str) else raw,
        "tobe_status": row[1],
        "tobe_error": row[2],
    }


def update_tobe_status(*, process_id: str, tenant_id: str, status: str, error: str | None = None) -> None:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE pi.process_graphs
                SET tobe_status = %s, tobe_error = %s, updated_at = NOW()
                WHERE process_id = %s AND tenant_id = %s
                """,
                [status, error, process_id, tenant_id],
            )


def patch_graph(
    *,
    process_id: str,
    tenant_id: str,
    step_patches: list[dict] | None = None,
    lane_patches: list[dict] | None = None,
    connector_patches: list[dict] | None = None,
) -> None:
    """
    Apply consultant corrections to a parsed graph.
    Each patch dict must include the primary key field(s) plus the fields to update.
    After patching, if status was 'needs_review', set to 'ready'.
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            # Verify ownership
            cur.execute(
                "SELECT 1 FROM pi.process_graphs WHERE process_id = %s AND tenant_id = %s",
                [process_id, tenant_id],
            )
            if not cur.fetchone():
                raise PermissionError("process graph not found or access denied")

            for patch in step_patches or []:
                step_id = patch.get("step_id")
                if not step_id:
                    continue
                if "lane_id" in patch:
                    cur.execute(
                        "UPDATE pi.steps SET lane_id=%s WHERE process_id=%s AND step_id=%s",
                        [patch["lane_id"], process_id, step_id],
                    )
                if "step_type" in patch:
                    cur.execute(
                        "UPDATE pi.steps SET step_type=%s WHERE process_id=%s AND step_id=%s",
                        [patch["step_type"], process_id, step_id],
                    )
                if "label" in patch:
                    cur.execute(
                        "UPDATE pi.steps SET label=%s WHERE process_id=%s AND step_id=%s",
                        [patch["label"], process_id, step_id],
                    )
                if "systems_touched" in patch:
                    cur.execute(
                        "UPDATE pi.steps SET systems_touched=%s WHERE process_id=%s AND step_id=%s",
                        [patch["systems_touched"], process_id, step_id],
                    )
                if "ai_opportunity" in patch:
                    cur.execute(
                        "UPDATE pi.steps SET ai_opportunity=%s WHERE process_id=%s AND step_id=%s",
                        [patch["ai_opportunity"], process_id, step_id],
                    )

            for patch in lane_patches or []:
                lane_id = patch.get("lane_id")
                if not lane_id:
                    continue
                if "label" in patch:
                    cur.execute(
                        "UPDATE pi.swimlanes SET label=%s WHERE process_id=%s AND lane_id=%s",
                        [patch["label"], process_id, lane_id],
                    )
                if "persona" in patch:
                    cur.execute(
                        "UPDATE pi.swimlanes SET persona=%s WHERE process_id=%s AND lane_id=%s",
                        [patch["persona"], process_id, lane_id],
                    )

            for patch in connector_patches or []:
                conn_id = patch.get("connector_id")
                if conn_id and "condition_label" in patch:
                    cur.execute(
                        "UPDATE pi.connectors SET condition_label=%s WHERE id=%s AND process_id=%s",
                        [patch["condition_label"], conn_id, process_id],
                    )

            # Advance status: needs_review → ready once consultant has reviewed
            cur.execute(
                """
                UPDATE pi.process_graphs
                SET parse_status = CASE WHEN parse_status='needs_review' THEN 'ready' ELSE parse_status END,
                    updated_at   = NOW()
                WHERE process_id = %s AND tenant_id = %s
                """,
                [process_id, tenant_id],
            )


# ── Recommendations ───────────────────────────────────────────────────────────

def store_recommendations(*, process_id: str, tenant_id: str, recommendations: dict) -> None:
    """Persist a Bedrock-generated intervention list against a process record."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM pi.process_graphs WHERE process_id = %s AND tenant_id = %s",
                [process_id, tenant_id],
            )
            if not cur.fetchone():
                raise PermissionError("process graph not found or access denied")
            cur.execute(
                """
                UPDATE pi.process_graphs
                SET recommendations = %s, updated_at = NOW()
                WHERE process_id = %s AND tenant_id = %s
                """,
                [json.dumps(recommendations), process_id, tenant_id],
            )


def get_recommendations(*, process_id: str, tenant_id: str) -> dict | None:
    """Return the stored recommendation list, or None if not yet generated."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT recommendations FROM pi.process_graphs WHERE process_id = %s AND tenant_id = %s",
                [process_id, tenant_id],
            )
            row = cur.fetchone()
    if not row or not row[0]:
        return None
    raw = row[0]
    return json.loads(raw) if isinstance(raw, str) else raw


# ── Agents ─────────────────────────────────────────────────────────────────────

def create_agents(*, process_id: str, tenant_id: str, agents: list[dict]) -> list[dict]:
    """
    Replace the agent set for a process (delete-then-insert). Called each time
    the agentic workflow is (re)generated — discards any prior agents and their
    generated LLD docs. Returns the inserted rows including their new agent_ids.
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM pi.process_graphs WHERE process_id = %s AND tenant_id = %s",
                [process_id, tenant_id],
            )
            if not cur.fetchone():
                raise PermissionError("process graph not found or access denied")

            cur.execute("DELETE FROM pi.agents WHERE process_id = %s", [process_id])

            inserted: list[dict] = []
            for position, agent in enumerate(agents):
                agent_id = str(uuid.uuid4())
                # stages/maturity/humanRoles from the Agentic Workflow schema — bundled
                # into one JSONB blob, same pattern as process_graphs.tobe_graph.
                agentic_metadata = {
                    "stages":     agent.get("stages") or [],
                    "maturity":   agent.get("maturity"),
                    "humanRoles": agent.get("humanRoles") or [],
                }
                cur.execute(
                    """
                    INSERT INTO pi.agents
                      (agent_id, process_id, tenant_id, name, description,
                       model, tools, replaces_step_ids, position, agentic_metadata)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    [
                        agent_id,
                        process_id,
                        tenant_id,
                        agent["name"],
                        agent.get("description"),
                        agent.get("model"),
                        json.dumps(agent.get("tools") or []),
                        json.dumps(agent.get("replaces_step_ids") or []),
                        position,
                        json.dumps(agentic_metadata),
                    ],
                )
                inserted.append({
                    "agent_id":          agent_id,
                    "name":              agent["name"],
                    "description":       agent.get("description"),
                    "model":             agent.get("model"),
                    "tools":             agent.get("tools") or [],
                    "replaces_step_ids": agent.get("replaces_step_ids") or [],
                    "lld_status":        "not_generated",
                    "lld_markdown":      None,
                    "lld_error":         None,
                    "agentic_metadata":  agentic_metadata,
                })
            return inserted


def list_agents(*, process_id: str, tenant_id: str) -> list[dict]:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT agent_id, name, description, model, tools,
                       replaces_step_ids, lld_status, lld_markdown, lld_error,
                       agentic_metadata
                FROM pi.agents
                WHERE process_id = %s AND tenant_id = %s
                ORDER BY position
                """,
                [process_id, tenant_id],
            )
            rows = cur.fetchall()
    return [_agent_row_to_dict(r) for r in rows]


def get_agent(*, agent_id: str, tenant_id: str) -> dict | None:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT agent_id, process_id, name, description, model, tools,
                       replaces_step_ids, lld_status, lld_markdown, lld_error,
                       agentic_metadata
                FROM pi.agents
                WHERE agent_id = %s AND tenant_id = %s
                """,
                [agent_id, tenant_id],
            )
            row = cur.fetchone()
    if not row:
        return None
    agent = _agent_row_to_dict(
        (row[0], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9], row[10])
    )
    agent["process_id"] = row[1]
    return agent


def _agent_row_to_dict(r: tuple) -> dict:
    tools_raw = r[4]
    replaces_raw = r[5]
    metadata_raw = r[9] if len(r) > 9 else None
    return {
        "agent_id":          r[0],
        "name":              r[1],
        "description":       r[2],
        "model":             r[3],
        "tools":             json.loads(tools_raw) if isinstance(tools_raw, str) else (tools_raw or []),
        "replaces_step_ids": json.loads(replaces_raw) if isinstance(replaces_raw, str) else (replaces_raw or []),
        "lld_status":        r[6],
        "lld_markdown":      r[7],
        "lld_error":         r[8],
        "agentic_metadata":  json.loads(metadata_raw) if isinstance(metadata_raw, str) else metadata_raw,
    }


def update_agent_lld(
    *,
    agent_id: str,
    tenant_id: str,
    status: str,
    markdown: str | None = None,
    error: str | None = None,
) -> None:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE pi.agents
                SET lld_status = %s, lld_markdown = %s, lld_error = %s, updated_at = NOW()
                WHERE agent_id = %s AND tenant_id = %s
                """,
                [status, markdown, error, agent_id, tenant_id],
            )


# ── Plans ──────────────────────────────────────────────────────────────────────

def get_plan(*, process_id: str, tenant_id: str) -> dict | None:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT plan_id, tasks, chat_history
                FROM pi.plans
                WHERE process_id = %s AND tenant_id = %s
                """,
                [process_id, tenant_id],
            )
            row = cur.fetchone()
    if not row:
        return None
    return _plan_row_to_dict(row)


def upsert_plan(*, process_id: str, tenant_id: str, tasks: list[dict], chat_history: list[dict]) -> dict:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM pi.process_graphs WHERE process_id = %s AND tenant_id = %s",
                [process_id, tenant_id],
            )
            if not cur.fetchone():
                raise PermissionError("process graph not found or access denied")

            plan_id = str(uuid.uuid4())
            cur.execute(
                """
                INSERT INTO pi.plans (plan_id, process_id, tenant_id, tasks, chat_history)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (process_id) DO UPDATE
                SET tasks = EXCLUDED.tasks, chat_history = EXCLUDED.chat_history, updated_at = NOW()
                """,
                [plan_id, process_id, tenant_id, json.dumps(tasks), json.dumps(chat_history)],
            )
            cur.execute(
                "SELECT plan_id, tasks, chat_history FROM pi.plans WHERE process_id = %s AND tenant_id = %s",
                [process_id, tenant_id],
            )
            row = cur.fetchone()
    return _plan_row_to_dict(row)


def _plan_row_to_dict(r: tuple) -> dict:
    tasks_raw = r[1]
    chat_raw = r[2]
    return {
        "plan_id":       r[0],
        "tasks":         json.loads(tasks_raw) if isinstance(tasks_raw, str) else (tasks_raw or []),
        "chat_history":  json.loads(chat_raw) if isinstance(chat_raw, str) else (chat_raw or []),
    }
