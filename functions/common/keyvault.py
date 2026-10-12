"""
Key Vault secret helper — first real runtime consumer of the Key Vault
provisioned in `bicep/modules/data.bicep` (RBAC-enabled, VNet-private via
`snet-pe`; previously held only the unused `postgres-admin-password` secret).

Used exclusively for per-client-tenant Workday service-account credentials
(`admin_tenant_credentials/handler.py`) — never for Lumina's own platform
secrets, which stay as plain Function App settings per this codebase's
existing "unnecessary complexity at this scale" call (see data.bicep's
comment on `postgres-admin-password`). A real third-party credential that
drives a live client Workday tenant is a different risk class, worth the
extra indirection.

Auth: DefaultAzureCredential, same as every other Azure SDK client in
`functions/common/` — the Function App's managed identity needs a
`Key Vault Secrets Officer` RBAC grant (bicep change, see
`bicep/modules/rbac.bicep`) to read AND write these secrets, unlike Postgres's
password which only ever needed a data-plane read (never granted, per the
comment above) since nothing writes it today.
"""

from __future__ import annotations

import os

from azure.core.exceptions import ResourceNotFoundError
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

_client: SecretClient | None = None


def _secret_client() -> SecretClient:
    global _client
    if _client is None:
        _client = SecretClient(
            vault_url=os.environ["KEY_VAULT_URL"],
            credential=DefaultAzureCredential(),
        )
    return _client


def _tenant_credential_name(tenant_id: str, environment_id: str) -> str:
    # Key Vault secret names allow only alphanumerics and dashes — environment_id is a
    # Postgres-generated UUID string (test_automation.environments), already safe as-is.
    return f"workday-cred-{tenant_id}-{environment_id}"


def set_tenant_workday_credential(
    tenant_id: str, environment_id: str, username: str, password: str, workday_url: str
) -> None:
    """Stores as a single JSON-encoded secret value (username+password+sign-in URL
    together) — Key Vault has no concept of a multi-field secret, and this keeps
    set/get atomic. workday_url is the environment's actual sign-in page (e.g.
    https://wd5.myworkday.com/<tenant>/login.htmld) — without it the execution
    container has no idea which Workday tenant to even navigate to. Keyed by
    (tenant_id, environment_id) — one client can have several Workday environments
    (sandbox, preview, prod mirror), each with its own credential."""
    import json
    value = json.dumps({"username": username, "password": password, "workday_url": workday_url})
    _secret_client().set_secret(_tenant_credential_name(tenant_id, environment_id), value)


def get_tenant_workday_credential(tenant_id: str, environment_id: str) -> dict[str, str] | None:
    import json
    try:
        secret = _secret_client().get_secret(_tenant_credential_name(tenant_id, environment_id))
    except ResourceNotFoundError:
        return None
    return json.loads(secret.value)
