-- Test Automation Suite — multi-environment support.
-- Apply after 007_test_automation_execution.sql.
--
-- An "environment" is a named Workday tenant (URL + service-account credential) nested under
-- one Lumina client tenant_id — e.g. client 'yellow-bank' might have environments 'Sandbox',
-- 'Preview', 'Prod Mirror'. Distinct from Lumina's own tenant_id, which stays the
-- client-isolation boundary everywhere else (see functions/common/tenant.py). The actual
-- credential lives in Key Vault, re-keyed by (tenant_id, environment_id) —
-- functions/common/keyvault.py and functions/admin_tenant_credentials/handler.py. This table
-- is just the registry: which environments exist, and which one (if any) is the nightly
-- regression suite for that environment.

CREATE TABLE IF NOT EXISTS test_automation.environments (
  environment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  nightly_enabled BOOLEAN NOT NULL DEFAULT false,
  -- Which existing run's scenarios get re-executed nightly — no regeneration, just re-running
  -- the execution stage against live Workday. No FK constraint: runs can belong to a different
  -- schema-per-tenant world in principle, and the app validates this at read time same as
  -- other cross-referenced ids in this codebase (e.g. scenarios.run_id already does).
  nightly_run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ta_environments_tenant_idx ON test_automation.environments (tenant_id);

-- Which environment a given execution ran against. Scenarios/steps don't need their own copy —
-- they join through run_id, and the execution container gets environment_id directly in its
-- queue message rather than via a lookup (see execution-worker/runner.py).
ALTER TABLE test_automation.runs
  ADD COLUMN IF NOT EXISTS environment_id UUID;
