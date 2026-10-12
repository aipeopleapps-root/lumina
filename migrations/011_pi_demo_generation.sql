-- Process Intelligence — agent kind classification + unified demo generation.
-- Apply after 010_test_automation_execution_reconciliation.sql.
--
-- kind classifies each proposed agent as conversational (genuine back-and-forth,
-- a human decides at each step) or workspace (output is a document/dashboard a
-- human reviews). demo_profile holds the richer per-agent content needed to
-- render a demo — persona, currentState steps, the six-stage agentic workflow
-- taxonomy, humanRoles, maturity, and the actual transcript/dashboard content —
-- as a single JSONB blob, same pattern as the existing `tools`/`replaces_step_ids`
-- columns on this table. It's generated lazily (only once a consultant confirms
-- a demo batch), so it stays NULL for agents that never get a demo.
ALTER TABLE pi.agents ADD COLUMN IF NOT EXISTS kind TEXT;
ALTER TABLE pi.agents ADD CONSTRAINT pi_agents_kind_chk
  CHECK (kind IS NULL OR kind IN ('conversational', 'workspace'));
ALTER TABLE pi.agents ADD COLUMN IF NOT EXISTS demo_profile JSONB;

-- Demo generation produces one HTML artifact per process (every confirmed agent
-- in one file), so its status lives on pi.process_graphs — same single-row-per-
-- process convention already used for tobe_graph/recommendations, not a new table.
ALTER TABLE pi.process_graphs ADD COLUMN IF NOT EXISTS demo_status TEXT NOT NULL DEFAULT 'not_generated';
ALTER TABLE pi.process_graphs ADD CONSTRAINT pi_graphs_demo_status_chk
  CHECK (demo_status IN ('not_generated', 'generating', 'done', 'failed'));
ALTER TABLE pi.process_graphs ADD COLUMN IF NOT EXISTS demo_blob_key TEXT;
ALTER TABLE pi.process_graphs ADD COLUMN IF NOT EXISTS demo_error TEXT;
ALTER TABLE pi.process_graphs ADD COLUMN IF NOT EXISTS demo_agent_ids JSONB;
ALTER TABLE pi.process_graphs ADD COLUMN IF NOT EXISTS demo_theme JSONB;
