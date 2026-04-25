"""
Admin: List all tenants with stats

Output:
{
  "tenants": [
    {
      "tenant_id": "acme",
      "name": "Acme Corporation",
      "industry": "Manufacturing",
      "status": "active",
      "user_count": 2,
      "document_count": 5,
      "created_at": "2026-04-18"
    }
  ]
}
"""

import json
import logging
import os
from decimal import Decimal

import boto3

from common import tenant_from_event, TenantError, http, db

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_dynamodb = boto3.resource("dynamodb")
_CONFIG_TABLE = os.environ["CONFIG_TABLE_NAME"]
_VECTOR_TABLE = os.environ["VECTOR_TABLE_NAME"]


def handler(event, context):
    # Verify admin role
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("admin", "project_admin", "security_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        # Get all tenants from Aurora
        with db.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT 
                        t.tenant_id,
                        t.name,
                        t.industry,
                        t.region,
                        t.status,
                        t.created_at,
                        COUNT(DISTINCT u.user_id) as user_count
                    FROM admin.tenants t
                    LEFT JOIN admin.users u ON t.tenant_id = u.tenant_id
                    GROUP BY t.tenant_id, t.name, t.industry, t.region, t.status, t.created_at
                    ORDER BY t.created_at DESC
                """)
                
                rows = cur.fetchall()

        # Get document counts from DynamoDB
        vector_table = _dynamodb.Table(_VECTOR_TABLE)
        
        tenants = []
        for row in rows:
            tenant_id, name, industry, region, status, created_at, user_count = row
            
            # Count unique documents for this tenant
            try:
                response = vector_table.query(
                    KeyConditionExpression="tenant_id = :tid",
                    ExpressionAttributeValues={":tid": tenant_id},
                    ProjectionExpression="doc_id",
                    Select="SPECIFIC_ATTRIBUTES"
                )
                
                unique_docs = len(set(item.get("doc_id") for item in response.get("Items", [])))
            except Exception as e:
                log.warning(f"Failed to count docs for {tenant_id}: {e}")
                unique_docs = 0

            tenants.append({
                "tenant_id": tenant_id,
                "name": name,
                "industry": industry or "",
                "region": region or "",
                "status": status,
                "user_count": int(user_count),
                "document_count": unique_docs,
                "created_at": str(created_at) if created_at else ""
            })

        return http.ok({"tenants": tenants})

    except Exception as e:
        log.error("Failed to list tenants: %s", e, exc_info=True)
        return http.error(f"Failed to list tenants: {str(e)}")
