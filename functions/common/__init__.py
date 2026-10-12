"""Shared utilities for all Functions — tenant scoping, Azure AI, Cosmos vectors, audit."""

from .tenant import TenantContext, TenantError, tenant_from_event, assert_belongs_to
from . import (
    azure_ai as ai,
    cosmos_vectors as vectors,
    cosmos_config as config,
    industry_knowledge,
    chunking,
    audit,
    audit_events,
    blob,
    queue,
    graph,
    http,
    keyvault,
    settings_registry as app_settings,
)

__all__ = [
    "TenantContext",
    "TenantError",
    "tenant_from_event",
    "assert_belongs_to",
    "ai",
    "vectors",
    "config",
    "industry_knowledge",
    "chunking",
    "audit",
    "audit_events",
    "blob",
    "queue",
    "graph",
    "http",
    "keyvault",
    "app_settings",
]
