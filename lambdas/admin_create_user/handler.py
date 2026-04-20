"""
Admin: Create new user

Input:
{
  "email": "user@example.com",
  "tenant_id": "acme",
  "role": "consultant",
  "temporary_password": "TempPass123!"
}

Output:
{
  "user_id": "uuid",
  "email": "user@example.com",
  "message": "User created successfully"
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

_cognito = boto3.client("cognito-idp")
_USER_POOL_ID = os.environ.get("USER_POOL_ID", "")


def handler(event, context):
    # Verify admin role
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    email = (body.get("email") or "").strip().lower()
    tenant_id = (body.get("tenant_id") or "").strip().lower()
    role = (body.get("role") or "").strip().lower()
    temp_password = body.get("temporary_password") or "TempPass123!"

    if not email or not tenant_id or not role:
        return http.bad_request("email, tenant_id, and role are required")

    if role not in ("consultant", "client", "admin"):
        return http.bad_request("role must be: consultant, client, or admin")

    try:
        # 1. Create Cognito user
        response = _cognito.admin_create_user(
            UserPoolId=_USER_POOL_ID,
            Username=email,
            UserAttributes=[
                {"Name": "email", "Value": email},
                {"Name": "email_verified", "Value": "true"},
                {"Name": "custom:tenant_id", "Value": tenant_id},
                {"Name": "custom:role", "Value": role},
            ],
            TemporaryPassword=temp_password,
            MessageAction="SUPPRESS",  # Don't send email
        )

        cognito_sub = response["User"]["Username"]

        # 2. Insert into admin.users table
        with db.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO admin.users (email, tenant_id, role, cognito_sub, created_by, status)
                    VALUES (%s, %s, %s, %s, %s, 'active')
                    ON CONFLICT (email) DO UPDATE
                    SET tenant_id = EXCLUDED.tenant_id,
                        role = EXCLUDED.role,
                        cognito_sub = EXCLUDED.cognito_sub
                    RETURNING user_id
                """, (email, tenant_id, role, cognito_sub, ctx.user_email))
                
                user_id = cur.fetchone()[0]
                
            conn.commit()

        log.info(
            "Admin %s created user %s (tenant=%s, role=%s)",
            ctx.user_email,
            email,
            tenant_id,
            role
        )

        return http.ok({
            "user_id": str(user_id),
            "email": email,
            "tenant_id": tenant_id,
            "role": role,
            "temporary_password": temp_password,
            "message": "User created successfully"
        })

    except _cognito.exceptions.UsernameExistsException:
        return http.bad_request(f"User {email} already exists")
    except Exception as e:
        log.error("Failed to create user: %s", e, exc_info=True)
        return http.error(f"Failed to create user: {str(e)}")
