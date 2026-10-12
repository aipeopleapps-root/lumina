-- Test Automation Suite — Workday execution rollup columns.
-- Apply after 006_test_automation_schema.sql.
--
-- Adds scenario- and run-level execution rollups on top of the per-step
-- execution_status/execution_result/last_executed_at columns 006 already
-- reserved. Execution is an INDEPENDENT lifecycle from the existing
-- generation-pipeline `runs.status` column (parsing -> ... -> completed) —
-- a run stays 'completed' (exported) forever while its `execution_status`
-- separately progresses not_executed -> pending -> running -> passed/
-- failed/error, potentially re-run multiple times without disturbing the
-- generation state. Same 6-value CHECK vocabulary as
-- test_automation.steps.execution_status for consistency.

ALTER TABLE test_automation.scenarios
  ADD COLUMN IF NOT EXISTS execution_status TEXT NOT NULL DEFAULT 'not_executed',
  ADD COLUMN IF NOT EXISTS execution_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS execution_completed_at TIMESTAMPTZ;

ALTER TABLE test_automation.scenarios
  DROP CONSTRAINT IF EXISTS ta_scenarios_execution_status_chk;
ALTER TABLE test_automation.scenarios
  ADD CONSTRAINT ta_scenarios_execution_status_chk CHECK (execution_status IN (
    'not_executed', 'pending', 'running', 'passed', 'failed', 'error'
  ));

ALTER TABLE test_automation.runs
  ADD COLUMN IF NOT EXISTS execution_status TEXT NOT NULL DEFAULT 'not_executed';

ALTER TABLE test_automation.runs
  DROP CONSTRAINT IF EXISTS ta_runs_execution_status_chk;
ALTER TABLE test_automation.runs
  ADD CONSTRAINT ta_runs_execution_status_chk CHECK (execution_status IN (
    'not_executed', 'pending', 'running', 'passed', 'failed', 'error'
  ));
