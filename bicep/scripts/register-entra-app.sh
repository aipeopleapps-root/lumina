#!/usr/bin/env bash
# Phase 3a — scriptable half of the Entra External ID runbook (bicep/README.md).
#
# What this DOES automate (stable Microsoft Graph v1.0 calls, portable to any tenant/subscription):
#   - SPA app registration + redirect URIs
#   - the app's service principal (needed for sign-in to work at all)
#   - two directory extension attributes for tenant_id / role
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
for attr in tenant_id role; do
  existing=$(az rest --method GET \
    --url "https://graph.microsoft.com/v1.0/applications/$app_object_id/extensionProperties" \
    | jq -r --arg n "$attr" '.value[] | select(.name == $n) | .name' | head -1)
  if [[ -n "$existing" ]]; then
    echo "extension attribute '$attr' already exists, skipping"
  else
    az rest --method POST \
      --url "https://graph.microsoft.com/v1.0/applications/$app_object_id/extensionProperties" \
      --headers "Content-Type=application/json" \
      --body "$(jq -n --arg n "$attr" '{name: $n, dataType: "String", targetObjects: ["User"]}')" \
      | jq -r '"created: " + .name'
  fi
done

echo
echo "== Optional claims (expose extension attrs on the ID token) =="
# Directory extensionProperty values are NOT emitted on any token by default — Entra only puts
# them on a token if the app registration explicitly lists them under optionalClaims. Without
# this step tenant_id/role will silently be absent from every JWT, no matter what the user's
# attribute values are set to.
ext_prefix="extension_$(echo -n "$app_client_id" | tr -d '-')"
az rest --method PATCH \
  --url "https://graph.microsoft.com/v1.0/applications/$app_object_id" \
  --headers "Content-Type=application/json" \
  --body "$(jq -n --arg t "${ext_prefix}_tenant_id" --arg r "${ext_prefix}_role" \
    '{optionalClaims: {idToken: [{name: $t, essential: false}, {name: $r, essential: false}]}}')"
echo "configured optionalClaims.idToken: ${ext_prefix}_tenant_id, ${ext_prefix}_role"
echo "(access-token optional claims need the same treatment once Phase 7 exposes an API scope —"
echo " re-run this against accessToken at that point; see bicep/README.md Phase 3a step 4.)"

echo
echo "== Summary — record these in docs/AZURE_MIGRATION.md and your env config =="
echo "tenant_id:        $tenant_id"
echo "app_client_id:    $app_client_id"
echo "app_object_id:    $app_object_id"
echo "redirect_uris:    ${REDIRECT_URIS[*]}"
echo "extension attrs:  extension_<appId-no-dashes>_tenant_id, extension_<appId-no-dashes>_role"
echo "                  (query /applications/$app_object_id/extensionProperties for the exact names)"
echo
echo "Still manual (portal-only, redo by hand in any new tenant): Entra External ID tenant"
echo "creation, MFA/authentication-methods policy, user flow / self-service-signup config."
echo "See bicep/README.md's Phase 3a runbook steps 1-2 and 5-6."
