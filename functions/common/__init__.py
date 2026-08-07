"""Shared utilities for all Functions — tenant scoping, Azure AI, Cosmos vectors, audit."""

from .tenant import TenantContext, TenantError, tenant_from_event, assert_belongs_to
from . import (
    azure_ai as ai,
    cosmos_vectors as vectors,
    cosmos_config as config,
    chunking,
    audit,
    audit_events,
    blob,
    queue,
    http,
)

__all__ = [
    "TenantContext",
    "TenantError",
    "tenant_from_event",
    "assert_belongs_to",
    "ai",
    "vectors",
    "config",
    "chunking",
    "audit",
    "audit_events",
    "blob",
    "queue",
    "http",
]
