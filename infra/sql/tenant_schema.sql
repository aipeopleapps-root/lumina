-- Per-tenant schema bootstrap.
-- Run this once per tenant after CDK deploy, BEFORE seeding documents.
-- The seed script does this automatically via the RDS Data API.
--
-- Usage (templated): replace {{SCHEMA}} with t_acme, t_globex, etc.

CREATE SCHEMA IF NOT EXISTS "{{SCHEMA}}";

-- Registry of ingested documents (source-of-truth metadata).
-- Vector chunks live in OpenSearch; this table tracks the logical doc.
CREATE TABLE IF NOT EXISTS "{{SCHEMA}}".documents (
  doc_id        UUID PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  doc_type      TEXT NOT NULL,                -- config-workbook | bp-workbook | integration | kb
  module        TEXT,                          -- HCM | Absence | Payroll | ...
  source_name   TEXT NOT NULL,
  s3_key        TEXT NOT NULL,
  uploaded_by   TEXT,
  chunks_count  INTEGER DEFAULT 0,
  version       INTEGER DEFAULT 1,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT documents_tenant_matches CHECK (tenant_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_documents_module ON "{{SCHEMA}}".documents (module);
CREATE INDEX IF NOT EXISTS idx_documents_type   ON "{{SCHEMA}}".documents (doc_type);

-- Append-only audit log of AI interactions. Used for explainability and
-- for the "why did the model say that" trace the demo will show.
CREATE TABLE IF NOT EXISTS "{{SCHEMA}}".audit_log (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,                 -- chat | analyze | ingest
  prompt        TEXT,
  response      TEXT,
  retrieved     JSONB,                         -- [{doc_id, chunk_index, score}]
  model_id      TEXT,
  latency_ms    INTEGER,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON "{{SCHEMA}}".audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_kind    ON "{{SCHEMA}}".audit_log (kind);

-- Findings persistence — each analyze run writes a row, so the UI can
-- show "past reviews" without re-running the model.
CREATE TABLE IF NOT EXISTS "{{SCHEMA}}".findings (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  doc_id        UUID NOT NULL REFERENCES "{{SCHEMA}}".documents(doc_id),
  findings_json JSONB NOT NULL,
  model_id      TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_findings_doc ON "{{SCHEMA}}".findings (doc_id, created_at DESC);
