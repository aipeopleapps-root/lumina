"""
Bootstrap handler — called as a CDK Custom Resource on every deploy.
Creates demo tenants, demo users, and consultant→client assignments.
All operations are idempotent (safe to re-run).

Demo users created:
  admin@platform.com          admin         tenant: platform
  project-admin@platform.com  project_admin tenant: platform
  security-admin@platform.com security_admin tenant: platform
  consultant@platform.com     consultant    tenant: platform
  client@acme.com             client        tenant: acme
  client@globex.com           client        tenant: globex
"""

from __future__ import annotations

import json
import logging
import os

import boto3
from boto3.dynamodb.conditions import Key

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_cognito = boto3.client("cognito-idp")
_dynamodb = boto3.resource("dynamodb")

USER_POOL_ID   = os.environ["USER_POOL_ID"]
CONFIG_TABLE   = os.environ["CONFIG_TABLE_NAME"]
DEMO_PASSWORD  = "Mitre2025!"

TENANTS = [
    {"id": "platform", "name": "The Mitre (Platform)"},
    {"id": "acme",     "name": "Acme Corp"},
    {"id": "globex",   "name": "Globex Industries"},
]

USERS = [
    {"email": "admin@platform.com",          "role": "admin",          "tenant_id": "platform"},
    {"email": "project-admin@platform.com",  "role": "project_admin",  "tenant_id": "platform"},
    {"email": "security-admin@platform.com", "role": "security_admin", "tenant_id": "platform"},
    {"email": "consultant@platform.com",     "role": "consultant",     "tenant_id": "platform"},
    {"email": "client@acme.com",             "role": "client",         "tenant_id": "acme"},
    {"email": "client@globex.com",           "role": "client",         "tenant_id": "globex"},
]

# Consultant is assigned to all client tenants for the demo
CONSULTANT_EMAIL = "consultant@platform.com"
CLIENT_TENANTS   = ["acme", "globex"]


def handler(event, context):
    """CloudFormation Custom Resource entry point."""
    request_type = event.get("RequestType", "Create")
    log.info("Bootstrap %s", request_type)

    # We only act on Create / Update — Delete is a no-op
    if request_type == "Delete":
        return _respond(event, "SUCCESS", {})

    try:
        _delete_stale_users()
        _ensure_tenants()
        subs = _ensure_users()
        _ensure_assignments(subs)
        log.info("Bootstrap complete")
        return _respond(event, "SUCCESS", {"Message": "Bootstrap complete"})
    except Exception as exc:
        log.exception("Bootstrap failed")
        return _respond(event, "FAILED", {}, str(exc))


def _delete_stale_users():
    """Delete any Cognito user whose email is not in the canonical USERS list."""
    canonical = {u["email"] for u in USERS}
    paginator = _cognito.get_paginator("list_users")
    for page in paginator.paginate(UserPoolId=USER_POOL_ID):
        for u in page.get("Users", []):
            attrs = {a["Name"]: a["Value"] for a in u.get("Attributes", [])}
            email = attrs.get("email", u["Username"]).lower()
            if email not in canonical:
                try:
                    _cognito.admin_delete_user(UserPoolId=USER_POOL_ID, Username=u["Username"])
                    log.info("Deleted stale user %s", email)
                except Exception as exc:
                    log.warning("Could not delete %s: %s", email, exc)


def _ensure_tenants():
    table = _dynamodb.Table(CONFIG_TABLE)
    for t in TENANTS:
        try:
            table.put_item(
                Item={
                    "pk": f"TENANT#{t['id']}",
                    "sk": "METADATA",
                    "tenant_id": t["id"],
                    "name": t["name"],
                    "status": "active",
                },
                ConditionExpression="attribute_not_exists(pk)",
            )
            log.info("Created tenant %s", t["id"])
        except _dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
            log.info("Tenant %s already exists", t["id"])


def _ensure_users() -> dict[str, str]:
    """Create/update all demo users. Returns {email: cognito_sub}."""
    subs: dict[str, str] = {}
    for u in USERS:
        sub = _upsert_user(u["email"], u["role"], u["tenant_id"])
        subs[u["email"]] = sub
    return subs


def _upsert_user(email: str, role: str, tenant_id: str) -> str:
    """Create user if missing, update attributes if present. Returns Cognito sub."""
    try:
        resp = _cognito.admin_create_user(
            UserPoolId=USER_POOL_ID,
            Username=email,
            UserAttributes=[
                {"Name": "email",                  "Value": email},
                {"Name": "email_verified",          "Value": "true"},
                {"Name": "custom:tenant_id",        "Value": tenant_id},
                {"Name": "custom:role",             "Value": role},
            ],
            TemporaryPassword=DEMO_PASSWORD,
            MessageAction="SUPPRESS",
        )
        sub = next(
            a["Value"] for a in resp["User"]["Attributes"] if a["Name"] == "sub"
        )
        log.info("Created user %s (%s)", email, role)
    except _cognito.exceptions.UsernameExistsException:
        # User exists — update attributes to ensure role/tenant are current
        _cognito.admin_update_user_attributes(
            UserPoolId=USER_POOL_ID,
            Username=email,
            UserAttributes=[
                {"Name": "custom:tenant_id", "Value": tenant_id},
                {"Name": "custom:role",      "Value": role},
            ],
        )
        detail = _cognito.admin_get_user(UserPoolId=USER_POOL_ID, Username=email)
        sub = next(a["Value"] for a in detail["UserAttributes"] if a["Name"] == "sub")
        log.info("Updated user %s (%s)", email, role)

    # Always set permanent password so demo users never need a forced reset
    _cognito.admin_set_user_password(
        UserPoolId=USER_POOL_ID,
        Username=email,
        Password=DEMO_PASSWORD,
        Permanent=True,
    )
    return sub


def _ensure_assignments(subs: dict[str, str]):
    """Assign the demo consultant to every client tenant."""
    table = _dynamodb.Table(CONFIG_TABLE)
    consultant_sub = subs.get(CONSULTANT_EMAIL, "")
    if not consultant_sub:
        log.warning("Consultant sub not found — skipping assignments")
        return

    for tenant_id in CLIENT_TENANTS:
        # Fetch client name for denormalization
        meta = table.get_item(Key={"pk": f"TENANT#{tenant_id}", "sk": "METADATA"})
        client_name = meta.get("Item", {}).get("name", tenant_id)

        table.put_item(Item={
            "pk": f"ASSIGN#{consultant_sub}",
            "sk": f"CLIENT#{tenant_id}",
            "consultant_sub":    consultant_sub,
            "consultant_email":  CONSULTANT_EMAIL,
            "client_tenant_id":  tenant_id,
            "client_name":       client_name,
            "assigned_by":       "bootstrap",
        })
        log.info("Assigned consultant → %s", tenant_id)


def _respond(event: dict, status: str, data: dict, reason: str = "") -> dict:
    """Send response back to CloudFormation via the pre-signed S3 URL."""
    import urllib.request
    body = json.dumps({
        "Status":             status,
        "Reason":             reason or status,
        "PhysicalResourceId": event.get("PhysicalResourceId", "bootstrap"),
        "StackId":            event.get("StackId", ""),
        "RequestId":          event.get("RequestId", ""),
        "LogicalResourceId":  event.get("LogicalResourceId", ""),
        "Data":               data,
    }).encode()
    url = event.get("ResponseURL", "")
    if url:
        req = urllib.request.Request(url, data=body, method="PUT")
        req.add_header("Content-Type", "")
        urllib.request.urlopen(req)
    return {"statusCode": 200, "body": json.dumps(data)}
