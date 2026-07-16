-- Process Intelligence — AI Recommendations, Agentic Workflow agents, Planning Assistant.
-- Apply after 004_alter_admin_tenants.sql.

-- ── Backfill columns lambdas/common/pi_aurora.py already assumes but that no
--    prior migration ever added (store_tobe_graph/get_tobe_graph write/read
--    pi.process_graphs.tobe_graph; get_full_graph selects pi.steps.ai_opportunity
--    and ai_rationale). Idempotent — safe even if a live cluster already has them
--    from manual intervention.
ALTER TABLE pi.process_graphs ADD COLUMN IF NOT EXISTS tobe_graph JSONB;
ALTER TABLE pi.steps          ADD COLUMN IF NOT EXISTS ai_opportunity TEXT;
ALTER TABLE pi.steps          ADD COLUMN IF NOT EXISTS ai_rationale   TEXT;

-- ── Recommendations ──────────────────────────────────────────────────────────
-- Last-generated grouped-intervention list for the As-Is tab's "AI
-- Recommendations" panel. Regenerable — one JSONB blob per process, same
-- single-column pattern as tobe_graph.
ALTER TABLE pi.process_graphs ADD COLUMN IF NOT EXISTS recommendations JSONB;
-- shape: { "intro": "string", "interventions": [
--   { "intervention_id": "string", "title": "string", "impact": "medium|high",
--     "description": "string", "replaces_step_ids": ["step_id", ...] }
-- ] }

-- ── Agents (Agentic Workflow tab: "Proposed AI Agents") ─────────────────────
CREATE TABLE IF NOT EXISTS pi.agents (
  agent_id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  process_id         UUID        NOT NULL REFERENCES pi.process_graphs (process_id) ON DELETE CASCADE,
  tenant_id          TEXT        NOT NULL,
  name               TEXT        NOT NULL,             -- e.g. "Document AI Agent"
  description        TEXT,
  model              TEXT,                              -- display string, e.g. "Claude Sonnet 4.5"
  tools              JSONB       NOT NULL DEFAULT '[]', -- [{name, purpose}]
  replaces_step_ids  JSONB       NOT NULL DEFAULT '[]', -- as-is step_ids this agent consolidates
  position           INTEGER     NOT NULL DEFAULT 0,    -- display order in the sidebar list
  lld_status         TEXT        NOT NULL DEFAULT 'not_generated',
                                                        -- not_generated|generating|done|failed
  lld_markdown       TEXT,
  lld_error          TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pi_agents_lld_status_chk CHECK (lld_status IN (
    'not_generated','generating','done','failed'
  ))
);

CREATE INDEX IF NOT EXISTS idx_pi_agents_process ON pi.agents (process_id);
CREATE INDEX IF NOT EXISTS idx_pi_agents_tenant  ON pi.agents (tenant_id);

-- ── Plans (AI Planning Assistant) ────────────────────────────────────────────
-- One active plan per process — regenerated/edited in place, not versioned.
CREATE TABLE IF NOT EXISTS pi.plans (
  plan_id       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  process_id    UUID        NOT NULL REFERENCES pi.process_graphs (process_id) ON DELETE CASCADE,
  tenant_id     TEXT        NOT NULL,
  tasks         JSONB       NOT NULL DEFAULT '[]',
                -- [{ task_id, phase, name, start_date, end_date,
                --    dependencies: [task_id,...], is_milestone, is_phase_header }]
  chat_history  JSONB       NOT NULL DEFAULT '[]',
                -- [{ role: "user"|"assistant", content: "string", ts: "iso8601" }]
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (process_id)
);

CREATE INDEX IF NOT EXISTS idx_pi_plans_tenant ON pi.plans (tenant_id);
