"""
Tenant scoping — the single enforcement point for tenant isolation.

Every Lambda invocation is expected to go through `tenant_from_event()`
to extract `tenant_id` from the Cognito JWT claims. That ID is then
threaded into every downstream call (S3, DynamoDB, Aurora) as a
mandatory filter.

Consultants may send `x-client-tenant` to operate on an assigned client
tenant. The assignment is verified against DynamoDB before the context
is issued. If verification fails the request is rejected with 403.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from typing import Any

import boto3

log = logging.getLogger(__name__)

_TENANT_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{1,62}$")

VALID_ROLES = {"consultant", "client", "project_admin", "security_admin", "admin"}


class TenantError(Exception):
    """Raised when tenant resolution or validation fails."""


@dataclass(frozen=True)
class TenantContext:
    tenant_id: str
    user_id: str
    role: str
    email: str = ""

    def require_role(self, *allowed: str) -> None:
        if self.role not in allowed:
            raise TenantError(
                f"role '{self.role}' not permitted; need one of {allowed}"
            )

    # ---- Storage key shapers -----------------------------------------------

    def s3_prefix(self) -> str:
        return f"tenants/{self.tenant_id}/"

    def s3_key(self, *parts: str) -> str:
        for p in parts:
            if not p or ".." in p or p.startswith("/"):
                raise TenantError(f"unsafe S3 key part: {p!r}")
        return self.s3_prefix() + "/".join(parts)

    def pg_schema(self) -> str:
        return f"t_{self.tenant_id.replace('-', '_')}"

    def opensearch_filter(self) -> dict[str, Any]:
        return {"term": {"tenant_id.keyword": self.tenant_id}}


def tenant_from_event(event: dict[str, Any]) -> TenantContext:
    """
    Extract and validate tenant context from an API Gateway v2 event.

    For consultants: if `x-client-tenant` header is present, the
    request is scoped to that client tenant after verifying the
    assignment in DynamoDB.
    """
    try:
        claims = event["requestContext"]["authorizer"]["jwt"]["claims"]
    except (KeyError, TypeError) as exc:
        raise TenantError("no JWT claims on request") from exc

    tenant_id = (claims.get("custom:tenant_id") or "").strip().lower()
    user_id = (claims.get("sub") or "").strip()
    role = (claims.get("custom:role") or "client").strip().lower()
    email = (claims.get("email") or "").strip().lower()

    if not _TENANT_ID_PATTERN.match(tenant_id):
        log.warning("rejected tenant_id shape: %r", tenant_id)
        raise TenantError("invalid or missing tenant_id claim")

    if not user_id:
        raise TenantError("missing sub claim")

    if role not in VALID_ROLES:
        raise TenantError(f"invalid role claim: {role!r}")

    # Consultants can switch to an assigned client tenant via header
    if role == "consultant":
        headers = event.get("headers") or {}
        # API GW lowercases header names
        target = (headers.get("x-client-tenant") or "").strip().lower()
        if target:
            if not _TENANT_ID_PATTERN.match(target):
                raise TenantError("invalid x-client-tenant header value")
            _verify_assignment(user_id, target)
            tenant_id = target

    return TenantContext(
        tenant_id=tenant_id,
        user_id=user_id,
        role=role,
        email=email,
    )


def _verify_assignment(consultant_sub: str, client_tenant_id: str) -> None:
    """Raise TenantError if the consultant is not assigned to the client tenant."""
    table_name = os.environ.get("CONFIG_TABLE_NAME")
    if not table_name:
        raise TenantError("CONFIG_TABLE_NAME not configured")

    dynamodb = boto3.resource("dynamodb")
    table = dynamodb.Table(table_name)
    resp = table.get_item(
        Key={
            "pk": f"ASSIGN#{consultant_sub}",
            "sk": f"CLIENT#{client_tenant_id}",
        }
    )
    if "Item" not in resp:
        log.warning(
            "consultant %s attempted access to unassigned tenant %s",
            consultant_sub,
            client_tenant_id,
        )
        raise TenantError(
            f"consultant is not assigned to client tenant '{client_tenant_id}'"
        )


# -----------------------------------------------------------------------------
# Cross-tenant assertion helpers
# -----------------------------------------------------------------------------

def assert_belongs_to(ctx: TenantContext, record_tenant_id: str) -> None:
    if record_tenant_id != ctx.tenant_id:
        log.error(
            "cross-tenant access attempt: caller=%s target=%s user=%s",
            ctx.tenant_id, record_tenant_id, ctx.user_id,
        )
        raise TenantError("record does not belong to caller")
