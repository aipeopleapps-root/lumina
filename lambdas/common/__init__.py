"""Shared utilities for all Lambdas — tenant scoping, Bedrock, DynamoDB vectors, audit."""

from .tenant import TenantContext, TenantError, tenant_from_event, assert_belongs_to
from . import bedrock, dynamo_vectors as vectors, chunking, audit, audit_events, http

__all__ = [
    "TenantContext",
    "TenantError",
    "tenant_from_event",
    "assert_belongs_to",
    "bedrock",
    "vectors",
    "chunking",
    "audit",
    "http",
]
