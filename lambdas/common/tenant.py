"""
Tenant scoping — the single enforcement point for tenant isolation.

Every Lambda invocation is expected to go through `tenant_from_event()`
to extract `tenant_id` from the Cognito JWT claims. That ID is then
threaded into every downstream call (S3, OpenSearch, Postgres) as
a mandatory filter.

If this module is wrong, cross-tenant data leakage becomes possible.
It is the most scrutinized code in the repo.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

log = logging.getLogger(__name__)

# Defensive: tenant_id must be a safe identifier. Anything with path
# separators, quotes, or wildcards is rejected outright.
_TENANT_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{1,62}$")


class TenantError(Exception):
    """Raised when tenant resolution or validation fails."""


@dataclass(frozen=True)
class TenantContext:
    tenant_id: str
    user_id: str
    role: str  # 'consultant' | 'client' | 'admin'

    def require_role(self, *allowed: str) -> None:
        if self.role not in allowed:
            raise TenantError(
                f"role '{self.role}' not permitted; need one of {allowed}"
            )

    # ---- Storage key shapers -----------------------------------------------
    # These are the ONLY sanctioned ways to build storage keys. Never
    # format paths or queries by hand in handler code.

    def s3_prefix(self) -> str:
        """S3 prefix that scopes all reads/writes to this tenant."""
        return f"tenants/{self.tenant_id}/"

    def s3_key(self, *parts: str) -> str:
        """Safe S3 key under the tenant prefix. Each part is validated."""
        for p in parts:
            if not p or ".." in p or p.startswith("/"):
                raise TenantError(f"unsafe S3 key part: {p!r}")
        return self.s3_prefix() + "/".join(parts)

    def pg_schema(self) -> str:
        """Postgres schema name for this tenant (schema-per-tenant)."""
        return f"t_{self.tenant_id.replace('-', '_')}"

    def opensearch_filter(self) -> dict[str, Any]:
        """
        OpenSearch filter clause that MUST be AND-ed into every query.
        Returns a term filter on the indexed tenant_id keyword field.
        """
        return {"term": {"tenant_id.keyword": self.tenant_id}}


def tenant_from_event(event: dict[str, Any]) -> TenantContext:
    """
    Extract and validate tenant context from an API Gateway v2 event.

    API Gateway v2 with a Cognito JWT authorizer puts the claims at:
        event["requestContext"]["authorizer"]["jwt"]["claims"]

    Custom Cognito attributes are surfaced as 'custom:tenant_id' and
    'custom:role'.
    """
    try:
        claims = event["requestContext"]["authorizer"]["jwt"]["claims"]
    except (KeyError, TypeError) as exc:
        raise TenantError("no JWT claims on request") from exc

    tenant_id = (claims.get("custom:tenant_id") or "").strip().lower()
    user_id = (claims.get("sub") or "").strip()
    role = (claims.get("custom:role") or "client").strip().lower()

    if not _TENANT_ID_PATTERN.match(tenant_id):
        # Log the rejected value at WARNING so we see attempted abuse,
        # but do NOT log the full claims dict (may contain PII).
        log.warning("rejected tenant_id shape: %r", tenant_id)
        raise TenantError("invalid or missing tenant_id claim")

    if not user_id:
        raise TenantError("missing sub claim")

    if role not in ("consultant", "client", "admin"):
        raise TenantError(f"invalid role claim: {role!r}")

    return TenantContext(tenant_id=tenant_id, user_id=user_id, role=role)


# -----------------------------------------------------------------------------
# Cross-tenant assertion helpers — use these at boundaries where a document
# or record is fetched by ID, to verify it belongs to the caller.
# -----------------------------------------------------------------------------

def assert_belongs_to(ctx: TenantContext, record_tenant_id: str) -> None:
    """
    Raise TenantError if `record_tenant_id` does not match the caller.
    Call this immediately after loading any record by ID — before
    returning, rendering, or acting on it.
    """
    if record_tenant_id != ctx.tenant_id:
        # This is a SECURITY event. Log loudly.
        log.error(
            "cross-tenant access attempt: caller=%s target=%s user=%s",
            ctx.tenant_id, record_tenant_id, ctx.user_id,
        )
        raise TenantError("record does not belong to caller")
