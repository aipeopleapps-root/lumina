#!/bin/bash

SECRET_ARN="arn:aws:secretsmanager:us-east-1:893361712185:secret:DbSecret685A0FA5-42pEl7lNn5Jt-BiFLe8"
DB_CLUSTER_ARN="arn:aws:rds:us-east-1:893361712185:cluster:workdayaiplatformstack-db5d02a0a9-7gp0sv8iihlx"
REGION="us-east-1"

echo "Creating admin schema..."
aws rds-data execute-statement \
  --resource-arn "$DB_CLUSTER_ARN" \
  --secret-arn "$SECRET_ARN" \
  --database "platform" \
  --sql "CREATE SCHEMA IF NOT EXISTS admin" \
  --region $REGION

echo "Creating admin.tenants table..."
aws rds-data execute-statement \
  --resource-arn "$DB_CLUSTER_ARN" \
  --secret-arn "$SECRET_ARN" \
  --database "platform" \
  --sql "CREATE TABLE IF NOT EXISTS admin.tenants (
    tenant_id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    industry VARCHAR(100),
    region VARCHAR(100),
    status VARCHAR(20) DEFAULT 'active',
    go_live_date DATE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    metadata JSONB
  )" \
  --region $REGION

echo "Creating admin.users table..."
aws rds-data execute-statement \
  --resource-arn "$DB_CLUSTER_ARN" \
  --secret-arn "$SECRET_ARN" \
  --database "platform" \
  --sql "CREATE TABLE IF NOT EXISTS admin.users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(200) UNIQUE NOT NULL,
    tenant_id VARCHAR(50) REFERENCES admin.tenants(tenant_id),
    role VARCHAR(50),
    cognito_sub VARCHAR(100) UNIQUE,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW(),
    created_by VARCHAR(200),
    metadata JSONB
  )" \
  --region $REGION

echo "Creating admin.admin_audit table..."
aws rds-data execute-statement \
  --resource-arn "$DB_CLUSTER_ARN" \
  --secret-arn "$SECRET_ARN" \
  --database "platform" \
  --sql "CREATE TABLE IF NOT EXISTS admin.admin_audit (
    id SERIAL PRIMARY KEY,
    admin_user_email VARCHAR(200),
    action VARCHAR(100),
    target_type VARCHAR(50),
    target_id VARCHAR(200),
    details JSONB,
    timestamp TIMESTAMP DEFAULT NOW()
  )" \
  --region $REGION

echo "Inserting existing tenants..."
aws rds-data execute-statement \
  --resource-arn "$DB_CLUSTER_ARN" \
  --secret-arn "$SECRET_ARN" \
  --database "platform" \
  --sql "INSERT INTO admin.tenants (tenant_id, name, status)
         VALUES ('acme', 'Acme Corporation', 'active')
         ON CONFLICT (tenant_id) DO NOTHING" \
  --region $REGION

aws rds-data execute-statement \
  --resource-arn "$DB_CLUSTER_ARN" \
  --secret-arn "$SECRET_ARN" \
  --database "platform" \
  --sql "INSERT INTO admin.tenants (tenant_id, name, status)
         VALUES ('globex', 'Globex Industries', 'active')
         ON CONFLICT (tenant_id) DO NOTHING" \
  --region $REGION

echo "Inserting existing users..."
aws rds-data execute-statement \
  --resource-arn "$DB_CLUSTER_ARN" \
  --secret-arn "$SECRET_ARN" \
  --database "platform" \
  --sql "INSERT INTO admin.users (email, tenant_id, role, status)
         VALUES ('consultant-acme@example.com', 'acme', 'consultant', 'active')
         ON CONFLICT (email) DO NOTHING" \
  --region $REGION

aws rds-data execute-statement \
  --resource-arn "$DB_CLUSTER_ARN" \
  --secret-arn "$SECRET_ARN" \
  --database "platform" \
  --sql "INSERT INTO admin.users (email, tenant_id, role, status)
         VALUES ('client-acme@example.com', 'acme', 'client', 'active')
         ON CONFLICT (email) DO NOTHING" \
  --region $REGION

aws rds-data execute-statement \
  --resource-arn "$DB_CLUSTER_ARN" \
  --secret-arn "$SECRET_ARN" \
  --database "platform" \
  --sql "INSERT INTO admin.users (email, tenant_id, role, status)
         VALUES ('consultant-globex@example.com', 'globex', 'consultant', 'active')
         ON CONFLICT (email) DO NOTHING" \
  --region $REGION

aws rds-data execute-statement \
  --resource-arn "$DB_CLUSTER_ARN" \
  --secret-arn "$SECRET_ARN" \
  --database "platform" \
  --sql "INSERT INTO admin.users (email, tenant_id, role, status)
         VALUES ('client-globex@example.com', 'globex', 'client', 'active')
         ON CONFLICT (email) DO NOTHING" \
  --region $REGION

echo ""
echo "✅ Migration completed successfully!"
