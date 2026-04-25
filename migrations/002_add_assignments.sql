-- Consultant-to-client assignment table
CREATE TABLE IF NOT EXISTS admin.consultant_assignments (
  id            SERIAL PRIMARY KEY,
  consultant_sub VARCHAR(100) NOT NULL,
  consultant_email VARCHAR(200),
  client_tenant_id VARCHAR(50) NOT NULL REFERENCES admin.tenants(tenant_id) ON DELETE CASCADE,
  assigned_by   VARCHAR(200),
  assigned_at   TIMESTAMP DEFAULT NOW(),
  UNIQUE (consultant_sub, client_tenant_id)
);

-- Extend roles allowed in users table
ALTER TABLE admin.users
  DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE admin.users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('client','consultant','project_admin','security_admin','admin'));
