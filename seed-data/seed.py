"""
Simplified seed script - creates users and uploads pre-made sample data.
"""

import os
import sys
import uuid
from pathlib import Path
from datetime import datetime, timezone
import struct

# Load environment variables
from dotenv import load_dotenv
load_dotenv()

# Set required env vars
os.environ['EMBEDDING_MODEL_ID'] = 'amazon.titan-embed-text-v2:0'
os.environ['GENERATION_MODEL_ID'] = 'us.anthropic.claude-sonnet-4-6'
os.environ['EMBEDDING_DIM'] = '1024'
os.environ['DB_NAME'] = 'platform'
os.environ['POWERTOOLS_SERVICE_NAME'] = 'workday-ai-platform'
os.environ['LOG_LEVEL'] = 'INFO'

import boto3

# Add lambdas to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lambdas"))
from common import bedrock

# AWS clients
_cognito = boto3.client("cognito-idp", region_name=os.environ["AWS_REGION"])
_s3 = boto3.client("s3", region_name=os.environ["AWS_REGION"])
_rds_data = boto3.client("rds-data", region_name=os.environ["AWS_REGION"])
_dynamodb = boto3.resource("dynamodb", region_name=os.environ["AWS_REGION"])

# Config from .env
USER_POOL_ID = os.environ["USER_POOL_ID"]
DOCS_BUCKET = os.environ["DOCS_BUCKET"]
VECTOR_TABLE_NAME = os.environ["VECTOR_TABLE_NAME"]
DB_CLUSTER_ARN = os.environ["DB_CLUSTER_ARN"]
DB_SECRET_ARN = os.environ["DB_SECRET_ARN"]

DEFAULT_PASSWORD = "TempPass123!"

TENANTS = [
    {"id": "acme", "name": "Acme Corp"},
    {"id": "globex", "name": "Globex"},
]


def _exec_sql(sql: str):
    """Execute SQL via RDS Data API."""
    return _rds_data.execute_statement(
        resourceArn=DB_CLUSTER_ARN,
        secretArn=DB_SECRET_ARN,
        database="platform",
        sql=sql,
    )


def create_schemas():
    """Create tenant schemas in Aurora."""
    print("\n📊 Creating database schemas...")
    for t in TENANTS:
        schema = f"t_{t['id']}"
        print(f"  Creating schema: {schema}")
        _exec_sql(f"CREATE SCHEMA IF NOT EXISTS {schema}")
        _exec_sql(f"""
            CREATE TABLE IF NOT EXISTS {schema}.audit (
                id SERIAL PRIMARY KEY,
                kind TEXT,
                prompt TEXT,
                response TEXT,
                model_id TEXT,
                latency_ms INTEGER,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)
    print("✅ Schemas created")


def _create_cognito_user(email: str, role: str, tenant_id: str):
    """Create a single Cognito user and set a permanent password."""
    print(f"  Creating: {email} ({role})")
    try:
        _cognito.admin_create_user(
            UserPoolId=USER_POOL_ID,
            Username=email,
            UserAttributes=[
                {"Name": "email", "Value": email},
                {"Name": "email_verified", "Value": "true"},
                {"Name": "custom:tenant_id", "Value": tenant_id},
                {"Name": "custom:role", "Value": role},
            ],
            TemporaryPassword=DEFAULT_PASSWORD,
            MessageAction="SUPPRESS",
        )
        _cognito.admin_set_user_password(
            UserPoolId=USER_POOL_ID,
            Username=email,
            Password=DEFAULT_PASSWORD,
            Permanent=True,
        )
    except _cognito.exceptions.UsernameExistsException:
        print(f"    (already exists)")


def create_platform_tenant():
    """Ensure a 'platform' tenant record exists for admin users."""
    table = _dynamodb.Table(VECTOR_TABLE_NAME.replace("vectors", "config"))
    try:
        table.put_item(
            Item={
                "pk": "TENANT#platform",
                "sk": "METADATA",
                "tenant_id": "platform",
                "name": "The Mitre (Platform)",
                "status": "active",
            },
            ConditionExpression="attribute_not_exists(pk)",
        )
        print("  Created platform tenant record")
    except Exception:
        print("  Platform tenant already exists")


def create_users():
    """Create Cognito users for all roles."""
    print("\n👥 Creating users...")

    # Per-tenant consultant + client users
    for t in TENANTS:
        tid = t["id"]
        _create_cognito_user(f"consultant-{tid}@example.com", "consultant", tid)
        _create_cognito_user(f"client-{tid}@example.com", "client", tid)

    # Platform-level admin users (tenant_id = "platform")
    _create_cognito_user("project-admin@example.com", "project_admin", "platform")
    _create_cognito_user("security-admin@example.com", "security_admin", "platform")
    _create_cognito_user("admin@example.com", "admin", "platform")

    print("✅ Users created")


def seed_kb():
    """Seed knowledge base with sample passages."""
    print("\n📚 Seeding knowledge base...")
    
    table = _dynamodb.Table(VECTOR_TABLE_NAME)
    
    passages = [
        {
            "module": "Absence",
            "source": "Workday Best Practices",
            "text": "Eligibility rules should use Workday's built-in security groups rather than custom condition rules. Over-reliance on custom conditions leads to maintenance burden and upgrade issues.",
        },
        {
            "module": "Absence",
            "source": "Workday Best Practices",
            "text": "Accrual frequency should align with payroll frequency. Monthly accruals on a bi-weekly payroll create reconciliation complexity.",
        },
        {
            "module": "HCM",
            "source": "Workday Best Practices",
            "text": "Keep supervisory org structures aligned with actual management hierarchies. Matrix structures should be captured through additional organization types.",
        },
    ]
    
    for t in TENANTS:
        tid = t["id"]
        print(f"  Seeding for tenant: {tid}")
        
        for i, p in enumerate(passages):
            doc_id = str(uuid.uuid4())
            embedding = bedrock.embed(p["text"])
            
            table.put_item(Item={
                "tenant_id": tid,
                "chunk_id": f"{doc_id}#0",
                "doc_id": doc_id,
                "doc_type": "kb",
                "module": p["module"],
                "source_name": p["source"],
                "chunk_index": 0,
                "text": p["text"],
                "embedding": struct.pack(f"{len(embedding)}f", *embedding),
                "created_at": datetime.now(timezone.utc).isoformat(),
            })
            
            print(f"    ✅ Seeded passage {i+1}/{len(passages)}")
    
    print("✅ KB seeded")


if __name__ == "__main__":
    print("🚀 Starting simplified seed process...\n")
    print(f"User Pool: {USER_POOL_ID}")
    print(f"Docs Bucket: {DOCS_BUCKET}")
    print(f"Vector Table: {VECTOR_TABLE_NAME}")
    
    try:
        create_schemas()
        create_platform_tenant()
        create_users()
        seed_kb()
        
        print("\n✅ Seeding complete!")
        print(f"\n📧 Login credentials (all use password: {DEFAULT_PASSWORD})")
        print(f"   admin@example.com              — Admin (full access)")
        print(f"   project-admin@example.com      — Project Admin (clients + assignments)")
        print(f"   security-admin@example.com     — Security Admin (users + audit log)")
        print(f"   consultant-acme@example.com    — Consultant (acme)")
        print(f"   consultant-globex@example.com  — Consultant (globex)")
        print(f"   client-acme@example.com        — Client (acme)")
        print(f"   client-globex@example.com      — Client (globex)")
        print(f"\n💡 Next steps:")
        print(f"   1. Go to ../frontend directory")
        print(f"   2. Copy .env.example to .env.local and fill in the values")
        print(f"   3. Run: npm install && npm run dev")
        print(f"   4. Open http://localhost:5173")
        
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
