-- Process Intelligence — recent-processes home page.
-- Apply after 011_pi_demo_generation.sql.
--
-- Existing idx_pi_graphs_tenant is single-column; a "recent processes for this
-- tenant, newest first" query (backing the new Recent Processes list that
-- replaces the old silent localStorage-based resume) benefits from a
-- composite index instead of a tenant-filtered scan + sort.
CREATE INDEX IF NOT EXISTS idx_pi_graphs_tenant_created ON pi.process_graphs (tenant_id, created_at DESC);
