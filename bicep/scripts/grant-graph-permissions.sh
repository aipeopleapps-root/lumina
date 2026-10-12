#!/usr/bin/env bash
# Phase 7 — grants the Function App's Managed Identity the Microsoft Graph
# application permissions functions/common/graph.py needs (Batch D — Cognito's
# admin user-management calls have no ARM/Bicep equivalent for this: Graph
# app-role assignments to a Managed Identity have no Microsoft.Graph/*
# resource type Bicep can drive, unlike every other RBAC grant in this
# migration, which lives in bicep/modules/rbac.bicep instead).
#
# Permissions granted (application/app-only, not delegated):
#   User.ReadWrite.All                    — create/list/update/delete users,
#                                            reset passwords (admin_create_user,
#                                            admin_list_users, admin_manage_user,
#                                            admin_reset_password,
#                                            admin_update_user, bootstrap)
#   UserAuthenticationMethod.ReadWrite.All — graph.py's reset_mfa()
#
# Both are resolved dynamically from Microsoft Graph's own service principal
# (well-known appId 00000003-0000-0000-c000-000000000000) by role *name*
# rather than a hardcoded GUID — unlike bicep/modules/rbac.bicep's built-in
# Azure RBAC role IDs (which have no name-based lookup available from within
# Bicep and had to be recalled from memory, flagged there for verification),
# `az rest` can query Graph directly here, so there is nothing to verify by
# hand for these two specific roles.
#
# Requires: az CLI logged in (`az login`) with Application Administrator (or
# Global Administrator / Privileged Role Administrator) rights in the target
# Entra tenant, and jq. Idempotent — re-running skips permissions already
# granted instead of erroring or duplicating.
#
# Usage:
#   ./grant-graph-permissions.sh --principal-id <function-app-managed-identity-principal-id>
#
# The principal ID is compute.bicep's `functionAppPrincipalId` output
# (`az deployment sub show --name <deployment> --query properties.outputs.functionAppPrincipalId.value -o tsv`
# after Phase 7's deploy, or read directly from the Function App resource:
# `az resource show --ids <function-app-id> --query identity.principalId -o tsv`).

set -euo pipefail

PRINCIPAL_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --principal-id) PRINCIPAL_ID="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$PRINCIPAL_ID" ]]; then
  echo "usage: $0 --principal-id <function-app-managed-identity-principal-id>" >&2
  exit 1
fi

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

GRAPH_APP_ID="00000003-0000-0000-c000-000000000000"
ROLES=("User.ReadWrite.All" "UserAuthenticationMethod.ReadWrite.All")

echo "== Resolving Microsoft Graph's own service principal =="
graph_sp_id=$(az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals?\$filter=appId eq '$GRAPH_APP_ID'" \
  | jq -r '.value[0].id')
echo "graph_sp_id=$graph_sp_id"

graph_sp_roles=$(az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$graph_sp_id?\$select=appRoles")

echo "== Confirming target Managed Identity's service principal exists =="
target_sp=$(az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$PRINCIPAL_ID" 2>/dev/null || true)
if [[ -z "$target_sp" ]]; then
  echo "error: no service principal found for principal id $PRINCIPAL_ID — is this the Function App's Managed Identity principalId (not its resource ID)?" >&2
  exit 1
fi
echo "target service principal displayName: $(echo "$target_sp" | jq -r '.displayName')"

echo "== Existing app role assignments for this principal =="
existing_assignments=$(az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$PRINCIPAL_ID/appRoleAssignments" \
  | jq -r '[.value[].appRoleId]')

for role_name in "${ROLES[@]}"; do
  role_id=$(echo "$graph_sp_roles" | jq -r --arg n "$role_name" '.appRoles[] | select(.value == $n) | .id')
  if [[ -z "$role_id" ]]; then
    echo "error: could not resolve app role '$role_name' on Microsoft Graph's service principal — Graph's own appRoles list may have changed" >&2
    exit 1
  fi

  already_granted=$(echo "$existing_assignments" | jq --arg id "$role_id" 'index($id) != null')
  if [[ "$already_granted" == "true" ]]; then
    echo "'$role_name' already granted, skipping"
    continue
  fi

  echo "granting '$role_name' (appRoleId=$role_id)"
  az rest --method POST \
    --url "https://graph.microsoft.com/v1.0/servicePrincipals/$PRINCIPAL_ID/appRoleAssignments" \
    --headers "Content-Type=application/json" \
    --body "$(jq -n --arg pid "$PRINCIPAL_ID" --arg rid "$graph_sp_id" --arg aid "$role_id" \
      '{principalId: $pid, resourceId: $rid, appRoleId: $aid}')" >/dev/null
  echo "granted"
done

echo
echo "== Done — verify in the portal under this Function App's Managed Identity =="
echo "Entra admin center -> Enterprise applications -> (search by the Function App's name,"
echo "  Managed Identities application type) -> Permissions"
