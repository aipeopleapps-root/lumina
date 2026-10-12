"""
Microsoft Graph client — the Azure replacement for `boto3.client("cognito-idp")`.

Cognito and Entra ID diverge in a few structural ways that the handlers ported
against this module need to know about:

  - There is no `custom:tenant_id`/`custom:role` equivalent as first-class
    Cognito-style custom attributes. Lumina's `tenant_id`/`role` are stored as
    **directory extension properties** (`extensionProperty`, created once by
    `bicep/scripts/register-entra-app.sh`), whose full attribute name is
    `extension_<appId-no-dashes>_<name>` — the `<appId-no-dashes>` segment is
    specific to *this* app registration and will change on re-registration
    (e.g. the eventual Deloitte tenant). `ENTRA_APP_CLIENT_ID` env var supplies
    that segment so this module never hardcodes it.
  - Cognito's `sub` == Entra's `id` (the user object's GUID) == the `oid` JWT
    claim `tenant.py` already keys `x-user-sub` on (see Phase 3a Log,
    2026-08-07: `oid` is stable across re-registrations, `sub` is not — the
    same reasoning applies here: this module surfaces Graph's `id`, never a
    pairwise `sub`).
  - Cognito's `UserStatus` (CONFIRMED / FORCE_CHANGE_PASSWORD / ...) has no
    Graph equivalent. `list_users()` approximates it from `accountEnabled`
    only ("active"/"disabled") — callers should not expect Cognito's finer
    states.
  - Cognito's `admin_set_user_mfa_preference(..., Enabled=False)` is a single
    call; Graph has no bulk "reset MFA" endpoint. `reset_mfa()` enumerates the
    user's registered authentication methods and deletes each one
    individually via its type-specific collection endpoint — best-effort,
    unverified against a live tenant (see Phase 6 Log).
  - **Domain assumption**: `create_user`/lookups use the plain email as the
    Graph `userPrincipalName`, which only works if that email's domain is
    verified in the target Entra tenant (true for an eventual corporate
    tenant, not for arbitrary external addresses). Guest/B2B invitation is a
    different Graph flow (`POST /invitations`) and is out of scope here —
    flagged for whoever ports the (deprioritized) client-facing persona.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Iterator
from urllib.parse import quote

import requests
from azure.identity import DefaultAzureCredential

log = logging.getLogger(__name__)

_GRAPH_BASE = "https://graph.microsoft.com/v1.0"
_GRAPH_SCOPE = "https://graph.microsoft.com/.default"

_credential: DefaultAzureCredential | None = None
_cached_token: str | None = None
_cached_token_exp: float = 0.0


def _extension_attr(name: str) -> str:
    app_id = os.environ["ENTRA_APP_CLIENT_ID"].replace("-", "")
    return f"extension_{app_id}_{name}"


def tenant_attr() -> str:
    return _extension_attr("tenant_id")


def role_attr() -> str:
    return _extension_attr("role")


_USER_SELECT_FIELDS = (
    "id,mail,userPrincipalName,givenName,surname,accountEnabled,createdDateTime"
)


class GraphError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(f"Graph API error {status_code}: {message}")
        self.status_code = status_code
        self.message = message


class GraphNotFoundError(GraphError):
    """User (or sub-resource) does not exist."""


class GraphConflictError(GraphError):
    """User already exists (e.g. duplicate userPrincipalName)."""


def _get_token() -> str:
    global _credential, _cached_token, _cached_token_exp
    if _cached_token and time.time() < _cached_token_exp - 60:
        return _cached_token
    if _credential is None:
        _credential = DefaultAzureCredential()
    token = _credential.get_token(_GRAPH_SCOPE)
    _cached_token = token.token
    _cached_token_exp = token.expires_on
    return _cached_token


def _request(method: str, path_or_url: str, *, allow_404: bool = False, **kwargs) -> dict[str, Any] | None:
    url = path_or_url if path_or_url.startswith("http") else f"{_GRAPH_BASE}{path_or_url}"
    headers = kwargs.pop("headers", {})
    headers["Authorization"] = f"Bearer {_get_token()}"
    headers.setdefault("Content-Type", "application/json")

    resp = requests.request(method, url, headers=headers, timeout=15, **kwargs)

    if resp.status_code == 404 and allow_404:
        return None
    if resp.status_code == 204:
        return None
    if not resp.ok:
        try:
            message = resp.json().get("error", {}).get("message", resp.text)
        except ValueError:
            message = resp.text
        if resp.status_code == 404:
            raise GraphNotFoundError(resp.status_code, message)
        if resp.status_code == 409:
            raise GraphConflictError(resp.status_code, message)
        raise GraphError(resp.status_code, message)

    return resp.json() if resp.content else None


def _mail_nickname(email: str) -> str:
    return email.split("@")[0].replace(".", "-")


def create_user(
    email: str,
    given_name: str,
    family_name: str,
    tenant_id: str,
    role: str,
    temporary_password: str,
) -> dict[str, Any]:
    """POST /users. Returns the created user object (`id` is the Cognito-`sub` equivalent)."""
    body = {
        "accountEnabled": True,
        "displayName": f"{given_name} {family_name}".strip() or email,
        "givenName": given_name,
        "surname": family_name,
        "mailNickname": _mail_nickname(email),
        "userPrincipalName": email,
        "mail": email,
        "passwordProfile": {
            "forceChangePasswordNextSignIn": True,
            "password": temporary_password,
        },
        tenant_attr(): tenant_id,
        role_attr(): role,
    }
    try:
        return _request("POST", "/users", json=body)
    except GraphError as e:
        # Graph reports a duplicate userPrincipalName as 400 Request_BadRequest,
        # not 409 — detect it by message rather than status code so callers get
        # the same GraphConflictError they'd get from an endpoint that does use 409.
        if e.status_code == 400 and "already exists" in e.message.lower():
            raise GraphConflictError(e.status_code, e.message) from e
        raise


def get_user_by_upn(email: str) -> dict[str, Any] | None:
    select = f"{_USER_SELECT_FIELDS},{tenant_attr()},{role_attr()}"
    return _request("GET", f"/users/{quote(email)}", params={"$select": select}, allow_404=True)


def list_users() -> Iterator[dict[str, Any]]:
    """Yields every user in the tenant, transparently following `@odata.nextLink` pages."""
    select = f"{_USER_SELECT_FIELDS},{tenant_attr()},{role_attr()}"
    url = "/users"
    params: dict[str, Any] | None = {"$top": 60, "$select": select}
    while url:
        data = _request("GET", url, params=params)
        yield from data.get("value", [])
        url = data.get("@odata.nextLink")
        params = None  # nextLink already carries the query string


def disable_user(user_id: str) -> None:
    _request("PATCH", f"/users/{user_id}", json={"accountEnabled": False})


def enable_user(user_id: str) -> None:
    _request("PATCH", f"/users/{user_id}", json={"accountEnabled": True})


def delete_user(user_id: str) -> None:
    _request("DELETE", f"/users/{user_id}")


def set_password(user_id: str, password: str, *, force_change: bool = False) -> None:
    _request(
        "PATCH",
        f"/users/{user_id}",
        json={"passwordProfile": {"forceChangePasswordNextSignIn": force_change, "password": password}},
    )


def update_user_attributes(user_id: str, updates: dict[str, Any]) -> None:
    """`updates` keys must already be Graph property names (see callers for extension-attr mapping)."""
    _request("PATCH", f"/users/{user_id}", json=updates)


# Graph has no single "reset MFA" call — each registered authentication method
# lives in its own type-specific collection and must be deleted individually.
_MFA_METHOD_COLLECTIONS = {
    "#microsoft.graph.microsoftAuthenticatorAuthenticationMethod": "microsoftAuthenticatorMethods",
    "#microsoft.graph.softwareOathAuthenticationMethod": "softwareOathMethods",
    "#microsoft.graph.phoneAuthenticationMethod": "phoneMethods",
    "#microsoft.graph.fido2AuthenticationMethod": "fido2Methods",
    "#microsoft.graph.emailAuthenticationMethod": "emailMethods",
}


def reset_mfa(user_id: str) -> None:
    """Best-effort: delete every non-password auth method registered for the user."""
    methods = _request("GET", f"/users/{user_id}/authentication/methods").get("value", [])
    for m in methods:
        odata_type = m.get("@odata.type", "")
        collection = _MFA_METHOD_COLLECTIONS.get(odata_type)
        if not collection:
            continue  # passwordAuthenticationMethod or an unrecognized type — skip
        try:
            _request("DELETE", f"/users/{user_id}/authentication/{collection}/{m['id']}")
        except GraphError as e:
            log.warning("could not delete auth method %s (%s) for user %s: %s", m.get("id"), odata_type, user_id, e)
