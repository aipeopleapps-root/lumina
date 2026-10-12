#!/usr/bin/env bash
# Phase 3a — scriptable half of the Entra External ID runbook (bicep/README.md).
#
# What this DOES automate (stable Microsoft Graph v1.0 calls, portable to any tenant/subscription):
#   - SPA app registration + redirect URIs
#   - the app's service principal (needed for sign-in to work at all)
#   - two directory extension attributes for tenant_id / role
#   - exposing an API (api://<client-id>/access_as_user) so Phase 8's frontend has a scope to
#     request an access token for — the token APIM's validate-jwt policy (Phase 7) validates
#   - optionalClaims on both the ID token and access token for the two extension attributes above
#
# What this deliberately does NOT automate (portal-wizard-only / shifting Entra External ID
# feature surface — see bicep/README.md's caveats):
#   - creating the Entra External ID (CIAM) tenant itself
#   - MFA/authentication-methods policy
#   - user flows / sign-up-sign-in policy (self-service signup disable)
#
# Why a script instead of just portal clicks: this is meant to be re-run as-is against a
# different tenant/subscription later (e.g. moving from a personal Azure account to an
# organization's Azure platform) — same command, different --display-name/--redirect-uri
# flags, `az login`'d into the new tenant. Nothing here is hardcoded to one tenant.
#
# Requires: az CLI logged in (`az login`) with Application Administrator (or Global
# Administrator) rights in the target Entra tenant, and jq.
#
# Usage:
#   ./register-entra-app.sh \
#     --display-name lumina-spa \
#     --redirect-uri http://localhost:5173 \
#     [--redirect-uri https://lumina.example.com] \
#     [--single-tenant]   # default sign-in audience is single-tenant (AzureADMyOrg);
#                          # this flag is a no-op today, kept for symmetry/clarity
#
# Re-running with the same --display-name updates the existing app's redirect URIs and
# extension attributes in place instead of creating duplicates.

set -euo pipefail

DISPLAY_NAME=""
REDIRECT_URIS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --display-name) DISPLAY_NAME="$2"; shift 2 ;;
    --redirect-uri) REDIRECT_URIS+=("$2"); shift 2 ;;
    --single-tenant) shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$DISPLAY_NAME" || ${#REDIRECT_URIS[@]} -eq 0 ]]; then
  echo "usage: $0 --display-name <name> --redirect-uri <uri> [--redirect-uri <uri> ...]" >&2
  exit 1
fi

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

redirect_uris_json=$(printf '%s\n' "${REDIRECT_URIS[@]}" | jq -R . | jq -s .)

echo "== Tenant context =="
tenant_id=$(az account show --query tenantId -o tsv)
echo "tenant_id=$tenant_id (confirm this is the Entra External ID tenant, not a Workforce tenant)"

echo "== App registration: $DISPLAY_NAME =="
existing_app_id=$(az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/applications?\$filter=displayName eq '$DISPLAY_NAME'" \
  | jq -r '.value[0].id // empty')

if [[ -n "$existing_app_id" ]]; then
  echo "found existing app object id=$existing_app_id, updating redirect URIs"
  az rest --method PATCH \
    --url "https://graph.microsoft.com/v1.0/applications/$existing_app_id" \
    --headers "Content-Type=application/json" \
    --body "$(jq -n --argjson uris "$redirect_uris_json" '{spa: {redirectUris: $uris}}')"
  app_object_id="$existing_app_id"
  app_client_id=$(az rest --method GET \
    --url "https://graph.microsoft.com/v1.0/applications/$app_object_id" | jq -r '.appId')
else
  echo "creating new app registration"
  create_resp=$(az rest --method POST \
    --url "https://graph.microsoft.com/v1.0/applications" \
    --headers "Content-Type=application/json" \
    --body "$(jq -n --arg name "$DISPLAY_NAME" --argjson uris "$redirect_uris_json" \
      '{displayName: $name, signInAudience: "AzureADMyOrg", spa: {redirectUris: $uris}}')")
  app_object_id=$(echo "$create_resp" | jq -r '.id')
  app_client_id=$(echo "$create_resp" | jq -r '.appId')

  echo "creating service principal (required for sign-in)"
  az rest --method POST \
    --url "https://graph.microsoft.com/v1.0/servicePrincipals" \
    --headers "Content-Type=application/json" \
    --body "$(jq -n --arg appId "$app_client_id" '{appId: $appId}')" >/dev/null
fi

echo "app_object_id=$app_object_id"
echo "app_client_id=$app_client_id"

echo "== Extension attributes (tenant_id, role) =="
# NOTE: this is the classic Azure AD `extensionProperty` mechanism (stable Graph v1.0 API,
# works across both Workforce and External ID/CIAM tenants). The Entra External ID admin
# center's "Custom user attributes" UI may create these through a different surface
# (customAuthenticationExtensions / identityGovernance) depending on the current product
# iteration — if the portal-created attribute name doesn't match what this script produces,
# trust whichever one you actually configured and update functions/common/tenant.py's header
# contract to match. This script's approach is the safe fallback since v1.0 extensionProperty
# has been stable for years and is scriptable/idempotent, unlike the newer CIAM-specific UI.
#
# Graph auto-prefixes whatever short `name` you POST (e.g. "tenant_id") into
# extension_<appId-no-dashes>_tenant_id when it stores/returns it — the idempotency check
# below must compare against that full prefixed form, not the short name, or it never finds
# a match and tries to re-create on every re-run (409 Conflict — this exact bug shipped in an
# earlier session and was only caught the first time the script was actually re-run against a
# live tenant; see docs/AZURE_MIGRATION.md Log).
ext_prefix="extension_$(echo -n "$app_client_id" | tr -d '-')"

for attr in tenant_id role; do
  full_name="${ext_prefix}_${attr}"
  existing=$(az rest --method GET \
    --url "https://graph.microsoft.com/v1.0/applications/$app_object_id/extensionProperties" \
    | jq -r --arg n "$full_name" '.value[] | select(.name == $n) | .name' | head -1)
  if [[ -n "$existing" ]]; then
    echo "extension attribute '$attr' already exists as '$existing', skipping"
  else
    az rest --method POST \
      --url "https://graph.microsoft.com/v1.0/applications/$app_object_id/extensionProperties" \
      --headers "Content-Type=application/json" \
      --body "$(jq -n --arg n "$attr" '{name: $n, dataType: "String", targetObjects: ["User"]}')" \
      | jq -r '"created: " + .name'
  fi
done

echo
echo "== Expose an API (Phase 7 — APIM's validate-jwt needs an access token to validate, not the ID token) =="
# Phase 3a only got the ID token working (fine for a temporary jwt.ms smoke test with no backend
# API yet). Phase 7 stands up a real backend behind APIM, and the frontend (Phase 8) will request
# an ACCESS token scoped to this API via MSAL — that's the token APIM's validate-jwt policy
# actually receives on every request, and it needs its own optionalClaims entry (below) plus a
# defined scope to request in the first place. `identifierUris` must be set before/alongside a
# scope — using the api://<client-id> form since no custom/verified domain is assumed.
current_app=$(az rest --method GET --url "https://graph.microsoft.com/v1.0/applications/$app_object_id")
existing_scope_id=$(echo "$current_app" | jq -r '.api.oauth2PermissionScopes[]? | select(.value == "access_as_user") | .id' | head -1)

if [[ -n "$existing_scope_id" ]]; then
  echo "API scope 'access_as_user' already exposed (id=$existing_scope_id), skipping"
else
  echo "exposing API scope 'access_as_user'"
  scope_id=$(python3 -c 'import uuid; print(uuid.uuid4())' 2>/dev/null || uuidgen | tr '[:upper:]' '[:lower:]')
  az rest --method PATCH \
    --url "https://graph.microsoft.com/v1.0/applications/$app_object_id" \
    --headers "Content-Type=application/json" \
    --body "$(jq -n --arg uri "api://$app_client_id" --arg id "$scope_id" '{
      identifierUris: [$uri],
      api: {
        oauth2PermissionScopes: [{
          id: $id,
          value: "access_as_user",
          type: "User",
          isEnabled: true,
          adminConsentDisplayName: "Access Lumina API",
          adminConsentDescription: "Allows the app to call the Lumina API as the signed-in user.",
          userConsentDisplayName: "Access Lumina API",
          userConsentDescription: "Allow the app to access the Lumina API on your behalf."
        }]
      }
    }')"
  echo "exposed api://$app_client_id/access_as_user (scope id=$scope_id)"
fi

echo
echo "== Optional claims (expose extension attrs on both the ID token and access token) =="
# Directory extensionProperty values are NOT emitted on any token by default — Entra only puts
# them on a token if the app registration explicitly lists them under optionalClaims. Without
# this step tenant_id/role will silently be absent from every JWT, no matter what the user's
# attribute values are set to. Both token types are configured together (idempotent either way):
# idToken for any direct-to-frontend use (Phase 3a's original jwt.ms smoke test), accessToken for
# the token APIM's validate-jwt policy (bicep/modules/apim.bicep) actually inspects on every API call.
# (ext_prefix computed earlier, above the extension-attributes loop.)
#
# `source: "user"` is REQUIRED on each entry — it's what tells Entra "resolve this claim name as
# a directory extension attribute read from the user object", as opposed to a built-in claim.
# Omitting it (as an earlier version of this script did) doesn't error; Entra just silently
# drops the claim from every issued token, which is much harder to notice than a hard failure —
# confirmed via GET .../applications/{id}?$select=optionalClaims showing "source": null on all
# four entries, and reproduced live: the claim was still missing even for a fresh, directly
# -created native Member account, ruling out the MSA-guest-account theory this was first
# attributed to. See docs/AZURE_MIGRATION.md Log for the full diagnosis trail.
#
# NOTE: this PATCH *replaces* the whole optionalClaims object (Graph doesn't merge per-entry) —
# `email` was added here too because an earlier run of this script (before the source:"user" fix)
# clobbered a pre-existing `email` optional claim from Phase 3a by omitting it from the body.
# If you add another optional claim by hand later, it needs to be listed here too or a future
# re-run of this script will silently drop it the same way.
az rest --method PATCH \
  --url "https://graph.microsoft.com/v1.0/applications/$app_object_id" \
  --headers "Content-Type=application/json" \
  --body "$(jq -n --arg t "${ext_prefix}_tenant_id" --arg r "${ext_prefix}_role" \
    '{optionalClaims: {
      idToken: [
        {name: $t, source: "user", essential: false},
        {name: $r, source: "user", essential: false},
        {name: "email", essential: false}
      ],
      accessToken: [
        {name: $t, source: "user", essential: false},
        {name: $r, source: "user", essential: false},
        {name: "email", essential: false}
      ]
    }}')"
echo "configured optionalClaims.idToken AND .accessToken (with source: user, plus email): ${ext_prefix}_tenant_id, ${ext_prefix}_role"

echo
echo "== Summary — record these in docs/AZURE_MIGRATION.md and your env config =="
echo "tenant_id:        $tenant_id"
echo "app_client_id:    $app_client_id"
echo "app_object_id:    $app_object_id"
echo "redirect_uris:    ${REDIRECT_URIS[*]}"
echo "extension attrs:  extension_<appId-no-dashes>_tenant_id, extension_<appId-no-dashes>_role"
echo "                  (query /applications/$app_object_id/extensionProperties for the exact names)"
echo "api scope:        api://$app_client_id/access_as_user"
echo "                  (Phase 8's MSAL config requests this scope; pass entraAppClientId="
echo "                  \"$app_client_id\" and entraTenantId=\"$tenant_id\" to Phase 7's Bicep deploy)"
echo
echo "Still manual (portal-only, redo by hand in any new tenant): Entra External ID tenant"
echo "creation, MFA/authentication-methods policy, user flow / self-service-signup config."
echo "See bicep/README.md's Phase 3a runbook steps 1-2 and 5-6."
