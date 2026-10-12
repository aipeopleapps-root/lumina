-- Test Automation Suite — stale-execution reconciliation support.
-- Apply after 009_test_automation_run_config.sql.
--
-- execution_started_at (migration 007) is only set once the execution
-- container's first internal PATCH lands (started=True) — a scenario whose
-- queue message was picked up but whose container died before that first
-- callback (or was never dequeued at all) has NO timestamp to judge
-- staleness by. execution_queued_at closes that gap: set once, synchronously,
-- at the moment _trigger_execute enqueues the scenario — independent of
-- whether the container ever actually started. Reconciliation staleness is
-- COALESCE(execution_started_at, execution_queued_at), so a scenario that
-- did start uses its real start time, and one that never started at all
-- still has a timestamp to compare against.

ALTER TABLE test_automation.scenarios
  ADD COLUMN IF NOT EXISTS execution_queued_at TIMESTAMPTZ;
