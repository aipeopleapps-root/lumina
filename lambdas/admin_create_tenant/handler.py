"""
Admin: Create new tenant

Input:
{
  "tenant_id": "newcorp",
  "name": "New Corporation",
  "industry": "Healthcare",
  "region": "North America"
}

Output:
{
  "tenant_id": "newcorp",
  "message": "Tenant created successfully"
}
"""

import json
import logging
import os
import uuid

import boto3

from common import tenant_from_event, TenantError, http, db

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_dynamodb = boto3.resource("dynamodb")
_cognito = boto3.client("cognito-idp")
_CONFIG_TABLE = os.environ["CONFIG_TABLE_NAME"]
_USER_POOL_ID = os.environ.get("USER_POOL_ID", "")


def handler(event, context):
    # Verify admin role
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("admin", "project_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    tenant_id = (body.get("tenant_id") or "").strip().lower()
    name = (body.get("name") or "").strip()
    industry = body.get("industry")
    region = body.get("region")
    folder_template = body.get("folder_structure_template", "standard_workday")

    if not tenant_id or not name:
        return http.bad_request("tenant_id and name are required")

    # Validate tenant_id format (alphanumeric, dashes, underscores)
    if not tenant_id.replace("-", "").replace("_", "").isalnum():
        return http.bad_request("tenant_id must be alphanumeric (dashes/underscores allowed)")

    try:
        # 1. Create tenant record in DynamoDB config table
        config_table = _dynamodb.Table(_CONFIG_TABLE)
        config_table.put_item(
            Item={
                "pk": f"TENANT#{tenant_id}",
                "sk": "METADATA",
                "tenant_id": tenant_id,
                "name": name,
                "industry": industry or "",
                "region": region or "",
                "status": "active",
                "created_at": context.aws_request_id,
            },
            ConditionExpression="attribute_not_exists(pk)"
        )

        # 2. Create tenant schema in Aurora
        with db.get_connection() as conn:
            with conn.cursor() as cur:
                schema_name = f"t_{tenant_id}"
                
                # Create schema
                cur.execute(f"CREATE SCHEMA IF NOT EXISTS {schema_name}")
                
                # Create audit table in tenant schema
                cur.execute(f"""
                    CREATE TABLE IF NOT EXISTS {schema_name}.audit (
                        id SERIAL PRIMARY KEY,
                        kind VARCHAR(50),
                        prompt TEXT,
                        response TEXT,
                        model_id VARCHAR(100),
                        latency_ms INTEGER,
                        retrieved_chunks JSONB,
                        created_at TIMESTAMP DEFAULT NOW()
                    )
                """)
                
                # Insert into admin.tenants
                cur.execute("""
                    INSERT INTO admin.tenants (tenant_id, name, industry, region, status, folder_structure_template)
                    VALUES (%s, %s, %s, %s, 'active', %s)
                    ON CONFLICT (tenant_id) DO UPDATE
                    SET name = EXCLUDED.name,
                        industry = EXCLUDED.industry,
                        region = EXCLUDED.region,
                        folder_structure_template = EXCLUDED.folder_structure_template,
                        updated_at = NOW()
                """, (tenant_id, name, industry, region, folder_template))
                
            conn.commit()

        # 3. Log admin action
        log.info(
            "Admin %s created tenant %s (%s)",
            ctx.user_id,
            tenant_id,
            name
        )

        return http.ok({
            "tenant_id": tenant_id,
            "name": name,
            "message": "Tenant created successfully"
        })

    except Exception as e:
        log.error("Failed to create tenant: %s", e, exc_info=True)
        return http.error(f"Failed to create tenant: {str(e)}")
