-- Process Intelligence — real grounding corpus for Agentic Workflow generation,
-- plus the richer per-agent schema (six-stage taxonomy, tool/agent-type
-- classification, maturity, human roles) it produces.
-- Apply after 005_pi_recommendations_agents_plans.sql.

-- ── Grounding corpus ──────────────────────────────────────────────────────────
-- Curated, admin-maintained Workday ASOR/Sana product docs. Deliberately NOT
-- tenant-scoped (no tenant_id column) — this is shared context every tenant's
-- Agentic Workflow generation should be able to cite, unlike the per-tenant
-- DynamoDB "kb" bucket used for consultant-uploaded client documents.
-- pgvector extension already enabled by migration 003.
CREATE TABLE IF NOT EXISTS pi.grounding_corpus (
  chunk_id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_document  TEXT        NOT NULL,   -- e.g. 'asor-functional_whitepaper-2-enus.pdf'
  chunk_index      INTEGER     NOT NULL,
  chunk_text       TEXT        NOT NULL,
  embedding        vector(1024) NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pi_grounding_embedding
  ON pi.grounding_corpus USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
CREATE INDEX IF NOT EXISTS idx_pi_grounding_source ON pi.grounding_corpus (source_document);

-- ── Per-agent metadata ────────────────────────────────────────────────────────
-- Six-stage taxonomy mapping (Detect/Plan/Nudge/Insight/Action/Learning Loop),
-- tool/agent-type/execution-mode classification, maturity position, and human
-- roles for each proposed agent — single JSONB blob, same pattern already used
-- for process_graphs.tobe_graph/recommendations.
ALTER TABLE pi.agents ADD COLUMN IF NOT EXISTS agentic_metadata JSONB;
