-- Test Automation Suite — requirements/user-stories/config-workbook/BPW ->
-- user stories -> test scenarios -> test steps, with a 3-sheet Excel export.
-- Apply after 005_pi_recommendations_agents_plans.sql.
--
-- Follows Process Intelligence's established pattern (shared schema +
-- tenant_id column on every table, not schema-per-tenant) rather than
-- inventing a new convention — see pi.process_graphs/pi.agents.
--
-- steps.execution_status/execution_result/last_executed_at exist for a
-- FUTURE feature (executing steps against a live Workday tenant via
-- Playwright) that is NOT being built in this migration — nothing writes
-- anything but the default today. They're here so that feature is an
-- additive change (new route + a queue worker doing
-- `UPDATE test_automation.steps SET execution_status=... WHERE step_id=%s
-- AND tenant_id=%s`, identical in shape to pi.agents.lld_status) rather than
-- a schema migration later.

CREATE SCHEMA IF NOT EXISTS test_automation;

-- ── Runs (root entity) ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS test_automation.runs (
  run_id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        TEXT        NOT NULL,
  user_id          TEXT        NOT NULL,
  run_name         TEXT,
  file_name        TEXT        NOT NULL,
  input_type       TEXT        NOT NULL,     -- requirements|user_stories|config_workbook|bpw
  input_items      JSONB       NOT NULL DEFAULT '[]',
                   -- parsed stage-1 content (requirements/user_stories/config_items/bpw_steps
                   -- + bpw_context) — transient input material, no independent status/FK need,
                   -- same reasoning pi.process_graphs/pi.agents use JSONB for variable-shape data
  status           TEXT        NOT NULL DEFAULT 'parsing',
  output_blob_key  TEXT,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ta_runs_input_type_chk CHECK (input_type IN (
    'requirements', 'user_stories', 'config_workbook', 'bpw'
  )),
  CONSTRAINT ta_runs_status_chk CHECK (status IN (
    'parsing', 'generating_stories', 'needs_review',
    'generating_scenarios', 'scenarios_ready',
    'generating_steps', 'steps_ready',
    'exporting', 'completed', 'failed'
  ))
);

CREATE INDEX IF NOT EXISTS idx_ta_runs_tenant ON test_automation.runs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ta_runs_tenant_user ON test_automation.runs (tenant_id, user_id);

-- ── Scenarios ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS test_automation.scenarios (
  scenario_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         UUID        NOT NULL REFERENCES test_automation.runs (run_id) ON DELETE CASCADE,
  tenant_id      TEXT        NOT NULL,        -- redundant with run_id's parent, present directly
                                               -- for tenant-scoped queries without a join —
                                               -- same reasoning pi.agents.tenant_id uses
  source_ref     TEXT,                        -- the story/config-item/process this came from
  scenario_type  TEXT        NOT NULL,        -- Positive|Negative
  title          TEXT        NOT NULL,
  description    TEXT,
  preconditions  JSONB       NOT NULL DEFAULT '[]',
  position       INTEGER     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ta_scenarios_type_chk CHECK (scenario_type IN ('Positive', 'Negative'))
);

CREATE INDEX IF NOT EXISTS idx_ta_scenarios_run ON test_automation.scenarios (run_id);
CREATE INDEX IF NOT EXISTS idx_ta_scenarios_tenant ON test_automation.scenarios (tenant_id);

-- ── Steps ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS test_automation.steps (
  step_id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id        UUID        NOT NULL REFERENCES test_automation.scenarios (scenario_id) ON DELETE CASCADE,
  tenant_id          TEXT        NOT NULL,
  step_number        INTEGER     NOT NULL,
  action             TEXT        NOT NULL,
  expected_result    TEXT        NOT NULL,
  test_data          TEXT,
  -- Reserved for future Playwright execution — see file header. Not used yet.
  execution_status   TEXT        NOT NULL DEFAULT 'not_executed',
  execution_result   JSONB,
  last_executed_at   TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ta_steps_execution_status_chk CHECK (execution_status IN (
    'not_executed', 'pending', 'running', 'passed', 'failed', 'error'
  ))
);

CREATE INDEX IF NOT EXISTS idx_ta_steps_scenario ON test_automation.steps (scenario_id);
CREATE INDEX IF NOT EXISTS idx_ta_steps_tenant ON test_automation.steps (tenant_id);
