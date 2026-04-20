-- Admin schema for cross-tenant management
CREATE SCHEMA IF NOT EXISTS admin;

-- Tenant registry
CREATE TABLE IF NOT EXISTS admin.tenants (
  tenant_id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  industry VARCHAR(100),
  region VARCHAR(100),
  status VARCHAR(20) DEFAULT 'active',
  go_live_date DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB
);

-- User registry (cross-tenant view)
CREATE TABLE IF NOT EXISTS admin.users (
  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(200) UNIQUE NOT NULL,
  tenant_id VARCHAR(50) REFERENCES admin.tenants(tenant_id),
  role VARCHAR(50),
  cognito_sub VARCHAR(100) UNIQUE,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  created_by VARCHAR(200),
  metadata JSONB
);

-- Admin audit log
CREATE TABLE IF NOT EXISTS admin.admin_audit (
  id SERIAL PRIMARY KEY,
  admin_user_email VARCHAR(200),
  action VARCHAR(100),
  target_type VARCHAR(50),
  target_id VARCHAR(200),
  details JSONB,
  timestamp TIMESTAMP DEFAULT NOW()
);

-- Insert existing tenants
INSERT INTO admin.tenants (tenant_id, name, status)
VALUES 
  ('acme', 'Acme Corporation', 'active'),
  ('globex', 'Globex Industries', 'active')
ON CONFLICT (tenant_id) DO NOTHING;

-- Insert existing users (we'll get cognito_sub later)
INSERT INTO admin.users (email, tenant_id, role, status)
VALUES
  ('consultant-acme@example.com', 'acme', 'consultant', 'active'),
  ('client-acme@example.com', 'acme', 'client', 'active'),
  ('consultant-globex@example.com', 'globex', 'consultant', 'active'),
  ('client-globex@example.com', 'globex', 'client', 'active')
ON CONFLICT (email) DO NOTHING;
