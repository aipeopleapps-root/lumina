"""
Bootstrap — creates demo tenants, demo users, and consultant→client assignments.
All operations are idempotent (safe to re-run).

**Trigger-mechanism note (Phase 6, not yet resolved by Phase 7):** the AWS
original ran as a CloudFormation Custom Resource, invoked automatically on
every `cdk deploy`. Bicep has no direct equivalent (ARM `deploymentScript`
resources are the closest analog but run arbitrary shell/PowerShell, not a
Function). Rather than block this port on that infra decision, this module
exposes the same idempotent logic as `run()` plus a thin admin-only HTTP
wrapper (`POST /manage/bootstrap`) — Phase 7 can either keep it as a
manually/CI-triggered admin action, or wire a `deploymentScript` that curls
this endpoint post-deploy. Whichever Phase 7 picks, `run()` itself doesn't
change.

Demo users created (see DEMO_DOMAIN below for why the email domain isn't a
nice-looking "platform.com" — Entra rejects any userPrincipalName whose
domain isn't verified on the target tenant, unlike Cognito which allowed
arbitrary emails):
  admin@<DEMO_DOMAIN>          super_admin   tenant: platform
  project-admin@<DEMO_DOMAIN>  project_admin tenant: platform
  consultant@<DEMO_DOMAIN>     consultant    tenant: platform

Role model is exactly 3 roles (super_admin/project_admin/consultant, see
functions/common/tenant.py's VALID_ROLES) — an old 4th "security_admin" role was
folded into super_admin (it was already a strict permissions subset). No
security-admin@<DEMO_DOMAIN> seed entry anymore; an existing one from before this
change isn't auto-deleted here (deliberately — see _DEPRECATED_DEMO_EMAILS below,
which is reserved for personas/domains that no longer make sense to create at all,
not for accounts that just needed a role-value update elsewhere).

The client persona (a direct end-user login for people at the client company)
has been removed from this app entirely — it will be picked up as a separate
application later. Demo tenants (acme, globex) are still created and the demo
consultant is still assigned to both, since "client" as a tenant/engagement
concept is unrelated to and unaffected by removing the client login persona.
"""

from __future__ import annotations

import logging
import os

from common import tenant_from_event, TenantError, config, graph, http

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

DEMO_PASSWORD = "Mitre2025!"

# Must be a domain actually verified on the target Entra tenant — Graph
# rejects user creation with "The domain portion of the userPrincipalName
# property is invalid" otherwise. Defaults to this tenant's initial
# `<tenant>.onmicrosoft.com` domain, which always exists and is always
# verified; override via app setting if a custom domain is verified later.
DEMO_DOMAIN = os.environ.get("DEMO_USER_DOMAIN", "ashmanakoutlook.onmicrosoft.com")

TENANTS = [
    {"id": "platform", "name": "The Mitre (Platform)"},
    {"id": "acme",     "name": "Acme Corp"},
    {"id": "globex",   "name": "Globex Industries"},
]

USERS = [
    {"email": f"admin@{DEMO_DOMAIN}",          "role": "super_admin",    "tenant_id": "platform", "given_name": "Platform",  "family_name": "Admin"},
    {"email": f"project-admin@{DEMO_DOMAIN}",  "role": "project_admin",  "tenant_id": "platform", "given_name": "Project",   "family_name": "Admin"},
    {"email": f"consultant@{DEMO_DOMAIN}",     "role": "consultant",     "tenant_id": "platform", "given_name": "Demo",      "family_name": "Consultant"},
]

# Consultant is assigned to all client tenants for the demo
CONSULTANT_EMAIL = f"consultant@{DEMO_DOMAIN}"
CLIENT_TENANTS = ["acme", "globex"]


def handler(event, context):
    """POST /manage/bootstrap — admin-only HTTP entry point."""
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("super_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        result = run()
        log.info("Bootstrap complete (triggered by %s)", ctx.user_id)
        return http.ok(result)
    except Exception as e:
        log.exception("Bootstrap failed")
        return http.server_error(f"Bootstrap failed: {e}")


def run() -> dict:
    """Idempotent bootstrap logic, callable directly (e.g. from a script or a
    future deploymentScript) without going through the HTTP handler."""
    _delete_stale_users()
    _ensure_tenants()
    user_ids = _ensure_users()
    _ensure_assignments(user_ids)
    return {"message": "Bootstrap complete"}


# Demo accounts this module has provisioned under prior role/domain schemes
# that are no longer current — kept here purely so _delete_stale_users() has
# something explicit to clean up. Add an entry whenever USERS changes shape
# (a role gets renamed/removed, or DEMO_DOMAIN changes) instead of removing
# the old one outright.
_DEPRECATED_DEMO_EMAILS = [
    # Client persona, removed entirely (see module docstring) — old @platform.com domain.
    "client@acme.com",
    "client@globex.com",
    # Pre-verified-domain demo accounts (platform.com isn't a real verified
    # domain on this tenant — Graph rejected these outright, but clean up
    # defensively in case an earlier partial run got one through).
    "admin@platform.com",
    "project-admin@platform.com",
    "security-admin@platform.com",
    "consultant@platform.com",
]


def _delete_stale_users():
    """Delete specific, individually-named deprecated demo accounts.

    Deliberately a fixed allowlist of exact emails — NOT "scan every user in
    the tenant and delete whatever isn't in the current USERS list". An
    earlier version did exactly that and would have deleted ANY real Entra
    user in the tenant that happens not to be one of our 4 demo accounts,
    including the tenant's own guest/owner account; that one run only
    survived because Graph's own directory-role protections happened to
    block an app-only delete of a privileged account — not because the code
    protected it. Never rely on that. This function must only ever be able
    to touch accounts we ourselves provisioned by exact email match.
    """
    for email in _DEPRECATED_DEMO_EMAILS:
        existing = graph.get_user_by_upn(email)
        if existing is None:
            continue
        try:
            graph.delete_user(existing["id"])
            log.info("Deleted deprecated demo user %s", email)
        except graph.GraphError as exc:
            log.warning("Could not delete %s: %s", email, exc)


def _ensure_tenants():
    for t in TENANTS:
        try:
            config.create_item({
                "pk": f"TENANT#{t['id']}",
                "sk": "METADATA",
                "tenant_id": t["id"],
                "name": t["name"],
                "status": "active",
            })
            log.info("Created tenant %s", t["id"])
        except FileExistsError:
            log.info("Tenant %s already exists", t["id"])


def _ensure_users() -> dict[str, str]:
    """Create/update all demo users. Returns {email: entra user id (oid)}."""
    return {
        u["email"]: _upsert_user(u["email"], u["given_name"], u["family_name"], u["role"], u["tenant_id"])
        for u in USERS
    }


def _upsert_user(email: str, given_name: str, family_name: str, role: str, tenant_id: str) -> str:
    """Create user if missing, update attributes if present. Returns the Entra
    user `id` — the `oid`-claim equivalent of Cognito's `sub`."""
    existing = graph.get_user_by_upn(email)
    if existing is None:
        user = graph.create_user(email, given_name, family_name, tenant_id, role, DEMO_PASSWORD)
        user_id = user["id"]
        log.info("Created user %s (%s)", email, role)
    else:
        user_id = existing["id"]
        graph.update_user_attributes(user_id, {
            graph.tenant_attr(): tenant_id,
            graph.role_attr(): role,
        })
        log.info("Updated user %s (%s)", email, role)

    # Always set a permanent password so demo users never need a forced reset.
    graph.set_password(user_id, DEMO_PASSWORD, force_change=False)
    return user_id


def _ensure_assignments(user_ids: dict[str, str]):
    """Assign the demo consultant to every client tenant."""
    consultant_id = user_ids.get(CONSULTANT_EMAIL, "")
    if not consultant_id:
        log.warning("Consultant id not found — skipping assignments")
        return

    for tenant_id in CLIENT_TENANTS:
        meta = config.get_item(f"TENANT#{tenant_id}", "METADATA")
        client_name = (meta or {}).get("name", tenant_id)

        config.put_item({
            "pk": f"ASSIGN#{consultant_id}",
            "sk": f"CLIENT#{tenant_id}",
            "consultant_sub":    consultant_id,
            "consultant_email":  CONSULTANT_EMAIL,
            "client_tenant_id":  tenant_id,
            "client_name":       client_name,
            "assigned_by":       "bootstrap",
        })
        log.info("Assigned consultant → %s", tenant_id)
