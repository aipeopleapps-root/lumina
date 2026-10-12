#!/usr/bin/env bash
# Phase 9 — provisions a dedicated CI app registration for GitHub Actions to deploy this stack
# via OIDC (federated credentials), no long-lived client secret stored anywhere.
#
# Deliberately a SEPARATE app registration from the SPA app `register-entra-app.sh` creates —
# that one is a public client (no secret, used for interactive user sign-in); this one is a
# confidential/service client used non-interactively by CI. Mixing the two would be unusual and
# is not how Microsoft's own OIDC-for-GitHub-Actions guidance is written.
#
# What this does:
#   1. Creates (or reuses) an app registration + service principal for CI.
#   2. Adds a federated credential trusting GitHub's OIDC issuer for THIS repo, scoped to the
#      exact ref(s) you pass (main branch pushes, and pull_request events, by default).
#   3. Grants the service principal Contributor on the target resource group (not
#      subscription-wide — narrower blast radius for what a compromised/misconfigured CI run
#      could do; matches this migration's Phase 2 "deliberate improvement over AWS" instinct).
#
# What this does NOT do (same category of manual step as register-entra-app.sh's leftover items):
#   - Set the GitHub repo secrets/variables themselves (AZURE_CLIENT_ID etc.) — this script prints
#     them at the end; add them via the GitHub UI/CLI (`gh secret set`/`gh variable set`) yourself.
#   - Create the resource group — must already exist (run bicep/scripts/deploy.sh at least once
#     first).
#
# Requires: az CLI logged in with Application Administrator (to create the app registration) AND
# Owner/User Access Administrator on the target resource group (to grant Contributor), jq.
#
# Usage:
#   ./setup-github-oidc.sh \
#     --github-repo <owner>/<repo> \
#     --resource-group lumina-rg \
#     [--display-name lumina-github-ci] \
#     [--branch main]

set -euo pipefail

GITHUB_REPO=""
RESOURCE_GROUP=""
DISPLAY_NAME="lumina-github-ci"
BRANCH="main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --github-repo) GITHUB_REPO="$2"; shift 2 ;;
    --resource-group) RESOURCE_GROUP="$2"; shift 2 ;;
    --display-name) DISPLAY_NAME="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$GITHUB_REPO" || -z "$RESOURCE_GROUP" ]]; then
  echo "usage: $0 --github-repo <owner>/<repo> --resource-group <name> [--display-name <name>] [--branch <name>]" >&2
  exit 1
fi

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

echo "== Subscription/tenant context =="
subscription_id=$(az account show --query id -o tsv)
tenant_id=$(az account show --query tenantId -o tsv)
echo "subscription_id=$subscription_id"
echo "tenant_id=$tenant_id"

echo "== App registration: $DISPLAY_NAME =="
existing_app_id=$(az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/applications?\$filter=displayName eq '$DISPLAY_NAME'" \
  | jq -r '.value[0].id // empty')

if [[ -n "$existing_app_id" ]]; then
  echo "found existing app object id=$existing_app_id"
  app_object_id="$existing_app_id"
  app_client_id=$(az rest --method GET \
    --url "https://graph.microsoft.com/v1.0/applications/$app_object_id" | jq -r '.appId')
else
  echo "creating new app registration"
  create_resp=$(az rest --method POST \
    --url "https://graph.microsoft.com/v1.0/applications" \
    --headers "Content-Type=application/json" \
    --body "$(jq -n --arg name "$DISPLAY_NAME" '{displayName: $name, signInAudience: "AzureADMyOrg"}')")
  app_object_id=$(echo "$create_resp" | jq -r '.id')
  app_client_id=$(echo "$create_resp" | jq -r '.appId')

  echo "creating service principal"
  az rest --method POST \
    --url "https://graph.microsoft.com/v1.0/servicePrincipals" \
    --headers "Content-Type=application/json" \
    --body "$(jq -n --arg appId "$app_client_id" '{appId: $appId}')" >/dev/null
fi

echo "app_object_id=$app_object_id"
echo "app_client_id=$app_client_id"

sp_object_id=$(az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals?\$filter=appId eq '$app_client_id'" \
  | jq -r '.value[0].id')
echo "service_principal_object_id=$sp_object_id"

echo "== Federated credentials (main branch push + pull_request) =="
declare -A SUBJECTS=(
  ["${DISPLAY_NAME}-branch-${BRANCH}"]="repo:${GITHUB_REPO}:ref:refs/heads/${BRANCH}"
  ["${DISPLAY_NAME}-pull-request"]="repo:${GITHUB_REPO}:pull_request"
)

for cred_name in "${!SUBJECTS[@]}"; do
  subject="${SUBJECTS[$cred_name]}"
  existing=$(az rest --method GET \
    --url "https://graph.microsoft.com/v1.0/applications/$app_object_id/federatedIdentityCredentials" \
    | jq -r --arg n "$cred_name" '.value[] | select(.name == $n) | .name' | head -1)
  if [[ -n "$existing" ]]; then
    echo "federated credential '$cred_name' already exists, skipping"
  else
    az rest --method POST \
      --url "https://graph.microsoft.com/v1.0/applications/$app_object_id/federatedIdentityCredentials" \
      --headers "Content-Type=application/json" \
      --body "$(jq -n --arg n "$cred_name" --arg sub "$subject" '{
        name: $n,
        issuer: "https://token.actions.githubusercontent.com",
        subject: $sub,
        audiences: ["api://AzureADTokenExchange"]
      }')" >/dev/null
    echo "created federated credential '$cred_name' (subject: $subject)"
  fi
done

echo "== Role assignment: Contributor on resource group $RESOURCE_GROUP =="
rg_id="/subscriptions/$subscription_id/resourceGroups/$RESOURCE_GROUP"
existing_role=$(az role assignment list --assignee "$app_client_id" --scope "$rg_id" \
  --query "[?roleDefinitionName=='Contributor'].id" -o tsv 2>/dev/null || true)
if [[ -n "$existing_role" ]]; then
  echo "Contributor role already assigned, skipping"
else
  az role assignment create \
    --assignee "$app_client_id" \
    --role "Contributor" \
    --scope "$rg_id" >/dev/null
  echo "granted Contributor on $rg_id"
fi

echo
echo "== Done — set these in the GitHub repo (Settings -> Secrets and variables -> Actions) =="
echo "Repository VARIABLES (not secrets — these aren't sensitive):"
echo "  AZURE_CLIENT_ID       = $app_client_id"
echo "  AZURE_TENANT_ID       = $tenant_id"
echo "  AZURE_SUBSCRIPTION_ID = $subscription_id"
echo
echo "Via gh CLI:"
echo "  gh variable set AZURE_CLIENT_ID -b \"$app_client_id\" --repo $GITHUB_REPO"
echo "  gh variable set AZURE_TENANT_ID -b \"$tenant_id\" --repo $GITHUB_REPO"
echo "  gh variable set AZURE_SUBSCRIPTION_ID -b \"$subscription_id\" --repo $GITHUB_REPO"
echo
echo "Also still needed (a real secret, not from this script):"
echo "  gh secret set POSTGRES_ADMIN_PASSWORD --repo $GITHUB_REPO"
echo "  (same value used for the pilot environment — see bicep/parameters/pilot.bicepparam's"
echo "   SUBSCRIPTION_ID comment for which environment this corresponds to)"
