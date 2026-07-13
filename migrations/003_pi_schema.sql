-- Process Intelligence module schema.
-- Apply after 002_add_assignments.sql.
-- Requires Aurora PostgreSQL 16+ with pgvector extension available.

-- Enable pgvector (safe to re-run; pgvector 0.5+ ships with Aurora PostgreSQL 15.4+/16+)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS pi;

-- ── Process graphs ──────────────────────────────────────────────────────────
-- One row per uploaded Visio file. Central record for the module.
CREATE TABLE IF NOT EXISTS pi.process_graphs (
  process_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           TEXT        NOT NULL,             -- maps to client tenant_id
  uploaded_by         TEXT        NOT NULL,             -- Cognito sub of uploading consultant
  domain              TEXT        NOT NULL,             -- recruiting|onboarding|self_service|payroll|job_architecture|performance
  source_file_s3_key  TEXT        NOT NULL,
  source_name         TEXT        NOT NULL,
  parse_status        TEXT        NOT NULL DEFAULT 'uploading',
                                                        -- uploading|parsing|needs_review|ready|failed
  parse_confidence    REAL,                             -- 0.0–1.0 overall parse confidence
  parse_warnings      JSONB,                            -- [{field, message}] low-confidence items needing review
  parse_error         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pi_graphs_domain_chk CHECK (domain IN (
    'recruiting','onboarding','self_service','payroll','job_architecture','performance'
  )),
  CONSTRAINT pi_graphs_status_chk CHECK (parse_status IN (
    'uploading','parsing','needs_review','ready','failed'
  ))
);

CREATE INDEX IF NOT EXISTS idx_pi_graphs_tenant ON pi.process_graphs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_pi_graphs_status ON pi.process_graphs (parse_status);

-- ── Swimlanes ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pi.swimlanes (
  process_id  UUID    NOT NULL REFERENCES pi.process_graphs (process_id) ON DELETE CASCADE,
  lane_id     TEXT    NOT NULL,
  label       TEXT    NOT NULL,
  persona     TEXT,
  position    INTEGER NOT NULL DEFAULT 0,    -- display order
  PRIMARY KEY (process_id, lane_id)
);

-- ── Steps ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pi.steps (
  process_id          UUID    NOT NULL REFERENCES pi.process_graphs (process_id) ON DELETE CASCADE,
  step_id             TEXT    NOT NULL,
  lane_id             TEXT,                             -- FK to swimlanes; NULL = unassigned
  label               TEXT    NOT NULL,
  step_type           TEXT,                             -- manual|system|decision|approval|wait
  systems_touched     JSONB   NOT NULL DEFAULT '[]',
  avg_cycle_time_hrs  REAL,
  notes               TEXT,
  position_x          REAL,
  position_y          REAL,
  parse_confidence    REAL    NOT NULL DEFAULT 1.0,     -- per-step parse confidence
  PRIMARY KEY (process_id, step_id),
  CONSTRAINT pi_steps_type_chk CHECK (step_type IS NULL OR step_type IN (
    'manual','system','decision','approval','wait'
  ))
);

CREATE INDEX IF NOT EXISTS idx_pi_steps_lane ON pi.steps (process_id, lane_id);

-- ── Connectors (directed edges) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pi.connectors (
  id               SERIAL  PRIMARY KEY,
  process_id       UUID    NOT NULL REFERENCES pi.process_graphs (process_id) ON DELETE CASCADE,
  from_step_id     TEXT    NOT NULL,
  to_step_id       TEXT    NOT NULL,
  condition_label  TEXT,                                -- branch label for decision outputs
  parse_confidence REAL    NOT NULL DEFAULT 1.0
);

CREATE INDEX IF NOT EXISTS idx_pi_conn_process ON pi.connectors (process_id);

-- ── Capability ledger ────────────────────────────────────────────────────────
-- Shared across all tenants. Admin-maintained. Seeded manually (Phase 0 content work).
CREATE TABLE IF NOT EXISTS pi.capability_ledger (
  capability_id       UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT    NOT NULL,
  domain              TEXT    NOT NULL,
  capability_type     TEXT    NOT NULL,
                                -- illuminate_agent|digital_employee|extend_accelerator|deloitte_accelerator
  description         TEXT    NOT NULL,
  replaces_step_types JSONB   NOT NULL DEFAULT '[]',    -- step types this can replace
  workday_release_min TEXT,                             -- e.g. '2026R1'; NULL = no release constraint
  confidence          TEXT    NOT NULL DEFAULT 'ga',    -- ga|limited_ga|roadmap
  source_url          TEXT,
  last_verified       DATE    NOT NULL DEFAULT CURRENT_DATE,
  embedding           vector(1024),                     -- for similarity retrieval
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pi_cap_domain_chk CHECK (domain IN (
    'recruiting','onboarding','self_service','payroll','job_architecture','performance','all'
  )),
  CONSTRAINT pi_cap_type_chk CHECK (capability_type IN (
    'illuminate_agent','digital_employee','extend_accelerator','deloitte_accelerator'
  )),
  CONSTRAINT pi_cap_confidence_chk CHECK (confidence IN ('ga','limited_ga','roadmap'))
);

CREATE INDEX IF NOT EXISTS idx_pi_cap_domain      ON pi.capability_ledger (domain);
CREATE INDEX IF NOT EXISTS idx_pi_cap_confidence  ON pi.capability_ledger (confidence);
-- IVFFlat index for cosine similarity; lists=10 suitable for ledger size < 10k rows.
-- Recreate with higher lists count if corpus exceeds ~5k entries.
CREATE INDEX IF NOT EXISTS idx_pi_cap_embedding
  ON pi.capability_ledger USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);

-- ── Pattern library ──────────────────────────────────────────────────────────
-- Reusable redesign patterns for Mode 2. Admin-maintained. Seeded manually.
CREATE TABLE IF NOT EXISTS pi.pattern_library (
  pattern_id                 UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name                       TEXT    NOT NULL,
  description                TEXT    NOT NULL,
  applies_when               TEXT    NOT NULL,          -- natural language rule for when to surface
  before_example_ref         JSONB,                     -- {process_id, step_ids}
  after_example_ref          JSONB,                     -- {process_id, step_ids}
  client_fit_notes           TEXT,
  suitable_change_readiness  JSONB   NOT NULL DEFAULT '["incremental","moderate","bold"]',
  avoid_for_industries       JSONB   NOT NULL DEFAULT '[]',
  times_used                 INTEGER NOT NULL DEFAULT 0,
  times_edited_by_consultant INTEGER NOT NULL DEFAULT 0,
  embedding                  vector(1024),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pi_pat_embedding
  ON pi.pattern_library USING ivfflat (embedding vector_cosine_ops) WITH (lists = 5);

-- ── Anti-pattern log ─────────────────────────────────────────────────────────
-- Populated from rejections with reason codes. Starts empty.
CREATE TABLE IF NOT EXISTS pi.anti_pattern_log (
  id               SERIAL  PRIMARY KEY,
  description      TEXT    NOT NULL,
  domain           TEXT,
  reason           TEXT    NOT NULL,
  de_identified_context TEXT,
  source_generation_id  UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Gold-standard examples ───────────────────────────────────────────────────
-- Promoted manually after de-identification review. Starts empty.
CREATE TABLE IF NOT EXISTS pi.gold_standard_examples (
  example_id       UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  process_id       UUID    REFERENCES pi.process_graphs (process_id) ON DELETE SET NULL,
  domain           TEXT    NOT NULL,
  output_mode      INTEGER NOT NULL CHECK (output_mode IN (1, 2)),
  client_industry  TEXT,
  client_size_band TEXT,
  change_readiness TEXT,
  approved_by      TEXT    NOT NULL,                    -- Cognito sub of approving consultant
  embedding        vector(1024),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Generation runs ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pi.generation_runs (
  generation_id    UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  process_id       UUID    NOT NULL REFERENCES pi.process_graphs (process_id) ON DELETE CASCADE,
  tenant_id        TEXT    NOT NULL,
  output_mode      INTEGER NOT NULL CHECK (output_mode IN (1, 2)),
  status           TEXT    NOT NULL DEFAULT 'pending',
                                -- pending|running|done|failed
  output_s3_key    TEXT,                                -- rendered SVG path
  rationale_s3_key TEXT,                               -- markdown rationale path
  output_json      JSONB,                               -- annotations / pattern applications
  retrieval_trace  JSONB,                               -- {capability_ids[], pattern_ids[]} used
  error            TEXT,
  model_id         TEXT,
  latency_ms       INTEGER,
  approved         BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by      TEXT,
  approved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pi_gen_status_chk CHECK (status IN ('pending','running','done','failed'))
);

CREATE INDEX IF NOT EXISTS idx_pi_gen_process ON pi.generation_runs (process_id);
CREATE INDEX IF NOT EXISTS idx_pi_gen_status  ON pi.generation_runs (status);
