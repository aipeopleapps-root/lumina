"""
Tenant scoping — the single enforcement point for tenant isolation.

Every Function invocation is expected to go through `tenant_from_event()`
to extract `tenant_id`. Identity is handled by APIM in front of the
Function App: its `validate-jwt` policy validates the Entra-issued token
and injects the individual claims as plain request headers
(`x-tenant-id`, `x-user-role`, `x-user-sub`, `x-user-email`) before the
request reaches this code. That tenant_id is then threaded into every
downstream call (Blob, Cosmos, Postgres) as a mandatory filter.

Consultants may send `x-client-tenant` to operate on an assigned client
tenant. The assignment is verified against the Cosmos `config` container
before the context is issued. If verification fails the request is
rejected with 403.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from typing import Any

from azure.cosmos import CosmosClient
from azure.identity import DefaultAzureCredential

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


def tenant_from_event(event: dict[str, Any]) -> TenantContext:
    """
    Extract and validate tenant context from a Function request event.

    Identity claims arrive as headers injected by APIM's `validate-jwt`
    policy after it has already validated the Entra token — this code
    does not decode or verify the JWT itself.

    For consultants: if `x-client-tenant` header is present, the
    request is scoped to that client tenant after verifying the
    assignment in the Cosmos `config` container.
    """
    headers = event.get("headers") or {}

    tenant_id = (headers.get("x-tenant-id") or "").strip().lower()
    user_id = (headers.get("x-user-sub") or "").strip()
    role = (headers.get("x-user-role") or "client").strip().lower()
    email = (headers.get("x-user-email") or "").strip().lower()

    if not _TENANT_ID_PATTERN.match(tenant_id):
        log.warning("rejected tenant_id shape: %r", tenant_id)
        raise TenantError("invalid or missing tenant_id claim")

    if not user_id:
        raise TenantError("missing sub claim")

    if role not in VALID_ROLES:
        raise TenantError(f"invalid role claim: {role!r}")

    # Consultants and admins can switch to a client tenant via header.
    # Consultants require an assignment check; admins have unrestricted access.
    if role in ("consultant", "admin", "project_admin", "security_admin"):
        target = (headers.get("x-client-tenant") or "").strip().lower()
        if target:
            if not _TENANT_ID_PATTERN.match(target):
                raise TenantError("invalid x-client-tenant header value")
            if role == "consultant":
                _verify_assignment(user_id, target)
            tenant_id = target

    return TenantContext(
        tenant_id=tenant_id,
        user_id=user_id,
        role=role,
        email=email,
    )


_cosmos_client: CosmosClient | None = None


def _config_container():
    global _cosmos_client
    if _cosmos_client is None:
        endpoint = os.environ["COSMOS_ENDPOINT"]
        _cosmos_client = CosmosClient(endpoint, credential=DefaultAzureCredential())
    database = _cosmos_client.get_database_client(os.environ.get("COSMOS_DATABASE", "lumina"))
    return database.get_container_client(os.environ.get("CONFIG_CONTAINER_NAME", "config"))


def _verify_assignment(consultant_sub: str, client_tenant_id: str) -> None:
    """Raise TenantError if the consultant is not assigned to the client tenant."""
    container = _config_container()
    pk = f"ASSIGN#{consultant_sub}"
    item_id = f"CLIENT#{client_tenant_id}"
    try:
        container.read_item(item=item_id, partition_key=pk)
    except Exception:
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
