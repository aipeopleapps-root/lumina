-- Add Process Intelligence client-fit fields to admin.tenants.
-- These are used for Mode 2 pattern re-ranking and the de-identification gate.

ALTER TABLE admin.tenants
  ADD COLUMN IF NOT EXISTS size_band             VARCHAR(20),
  ADD COLUMN IF NOT EXISTS change_readiness      VARCHAR(20),
  ADD COLUMN IF NOT EXISTS workday_release_train VARCHAR(20),
  -- Hard gate: nothing crosses into the shared corpus until this is TRUE.
  -- Default FALSE. Must be flipped manually after a human de-identification review.
  ADD COLUMN IF NOT EXISTS de_identified         BOOLEAN NOT NULL DEFAULT FALSE;

-- Soft constraints via check — adjust if new values are added to the domain.
ALTER TABLE admin.tenants
  DROP CONSTRAINT IF EXISTS tenants_size_band_chk,
  DROP CONSTRAINT IF EXISTS tenants_change_readiness_chk;

ALTER TABLE admin.tenants
  ADD CONSTRAINT tenants_size_band_chk
    CHECK (size_band IS NULL OR size_band IN ('smb','mid_market','enterprise')),
  ADD CONSTRAINT tenants_change_readiness_chk
    CHECK (change_readiness IS NULL OR change_readiness IN ('incremental','moderate','bold'));
