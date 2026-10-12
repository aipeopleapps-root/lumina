-- Test Automation Suite — run configuration fields (Build tab journey).
-- Apply after 008_test_automation_environments.sql.
--
-- run_name already exists (migration 006) but no UI has ever set it — this
-- migration doesn't touch it, just gives it a purpose. test_phase/module are
-- nullable (existing rows stay valid); the fixed value sets are enforced at
-- the API layer (functions/test_automation/handler.py._create_run), same
-- set-membership pattern as admin_create_user._VALID_ROLES — the CHECK
-- constraints here are a second line of defense, not the primary gate.

ALTER TABLE test_automation.runs
  ADD COLUMN IF NOT EXISTS test_phase TEXT,
  ADD COLUMN IF NOT EXISTS module TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT;

ALTER TABLE test_automation.runs
  ADD CONSTRAINT ta_runs_test_phase_chk CHECK (test_phase IS NULL OR test_phase IN (
    'SIT', 'UAT', 'Regression', 'Parallel', 'Production Validation'
  ));

ALTER TABLE test_automation.runs
  ADD CONSTRAINT ta_runs_module_chk CHECK (module IS NULL OR module IN (
    'HCM', 'Payroll', 'Absence', 'Recruiting', 'Benefits'
  ));
