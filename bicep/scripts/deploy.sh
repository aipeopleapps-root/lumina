#!/usr/bin/env bash
# Deploys the full Lumina stack for a given environment.
#
# Wraps `az deployment sub create` around one of the per-environment .bicepparam files in
# ../parameters/ (pilot.bicepparam today; deloitte.bicepparam once that migration happens — copy
# deloitte.bicepparam.example to get started). Exists so switching environments is "copy a
# .bicepparam file, fill in a few values, pass a different --env flag" instead of retyping a long
# az command with a dozen --parameters flags by hand (how earlier sessions of this migration did
# it, error-prone and easy to typo a value that then silently deploys to the wrong place).
#
# Usage:
#   ./deploy.sh --env pilot
#   ./deploy.sh --env pilot --deploy-claude-model   # once Claude quota is approved
#   POSTGRES_ADMIN_PASSWORD=... ./deploy.sh --env pilot   # non-interactive (e.g. CI, Phase 9)
#
# Postgres admin password is never a CLI flag (would land in shell history) — prompted
# interactively unless POSTGRES_ADMIN_PASSWORD is already set in the environment.
#
# Implementation note: `az deployment sub create --parameters <file>.bicepparam --parameters
# key=value` does NOT work the way bicep/README.md previously documented — a .bicepparam file
# must be fully self-contained (every required param assigned in-file); the CLI silently refuses
# to supplement a partial one with extra --parameters flags (confirmed live, BCP258, both via
# `az bicep build-params` and `az deployment sub create` — this had apparently never actually
# been exercised before the Phase 7 live-deploy session, since every param used to be typed
# individually on the command line). So this script writes a short-lived, gitignored full copy
# of the chosen .bicepparam file with postgresAdminPassword appended, in the same directory (so
# its `using '../main.bicep'` relative path still resolves), deploys with that, then deletes it —
# the committed .bicepparam files themselves never contain the secret.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BICEP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PARAMS_DIR="$BICEP_DIR/parameters"

ENV_NAME=""
DEPLOY_CLAUDE_FLAG=""
WHAT_IF=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    --deploy-claude-model) DEPLOY_CLAUDE_FLAG="--parameters deployClaudeModel=true"; shift ;;
    --what-if) WHAT_IF=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$ENV_NAME" ]]; then
  echo "usage: $0 --env <pilot|deloitte|...> [--deploy-claude-model] [--what-if]" >&2
  exit 1
fi

ENV_FILE="$PARAMS_DIR/${ENV_NAME}.bicepparam"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: no such environment file $ENV_FILE" >&2
  echo "available environments:" >&2
  ls "$PARAMS_DIR"/*.bicepparam 2>/dev/null | xargs -n1 basename | sed 's/\.bicepparam$//' | sed 's/^/  - /' >&2
  exit 1
fi

echo "== Environment: $ENV_NAME (${ENV_FILE}) =="

EXPECTED_SUB=$(grep -oE 'SUBSCRIPTION_ID: [a-f0-9-]+' "$ENV_FILE" | awk '{print $2}' || true)
CURRENT_SUB=$(az account show --query id -o tsv 2>/dev/null || true)
CURRENT_SUB_NAME=$(az account show --query name -o tsv 2>/dev/null || true)

if [[ -z "$CURRENT_SUB" ]]; then
  echo "error: not logged in to az (run 'az login' first)" >&2
  exit 1
fi

echo "az is currently pointed at: $CURRENT_SUB_NAME ($CURRENT_SUB)"

if [[ -n "$EXPECTED_SUB" && "$EXPECTED_SUB" != "$CURRENT_SUB" ]]; then
  echo "error: $ENV_FILE expects subscription $EXPECTED_SUB, but az is on $CURRENT_SUB." >&2
  echo "Run: az account set --subscription $EXPECTED_SUB" >&2
  exit 1
fi

LOCATION=$(grep -oE "^param location = '[^']+'" "$ENV_FILE" | sed -E "s/^param location = '([^']+)'/\1/")
LOCATION="${LOCATION:-eastus2}"

if [[ -z "${POSTGRES_ADMIN_PASSWORD:-}" ]]; then
  read -rsp "Postgres admin password: " POSTGRES_ADMIN_PASSWORD
  echo
fi

# Unlike the Postgres password, this is a pure machine-to-machine secret (the Workday-execution
# Container Apps Job authenticating internal Function calls, see modules/execution.bicep) — no
# human needs to choose or remember it. BUT it must stay stable across redeploys: generating a
# fresh one every run (the old behaviour) silently invalidates any Workday-execution scenario in
# flight the moment a deploy lands, since the Container App and Function App only agree on the
# value this script just handed them. Key Vault would be the natural place to persist it, but
# this vault is private-endpoint-only with no public network access (confirmed live — not
# reachable from a local machine or a GitHub-hosted runner), so it can't be read here. Instead:
# if an EXECUTION_WORKER_KEY env var wasn't explicitly passed in, reuse whatever value is already
# live on a previously-deployed Function App in this environment's resource group (ARM/Bicep
# deploys are incremental — handing the same value back through is a no-op on that resource, not
# a rotation). Only fall back to generating a brand new one if this resource group has no
# Function App yet at all (a genuine first-ever deploy).
if [[ -z "${EXECUTION_WORKER_KEY:-}" ]]; then
  RESOURCE_GROUP=$(grep -oE "^param resourceGroupName = '[^']+'" "$ENV_FILE" | sed -E "s/^param resourceGroupName = '([^']+)'/\1/")
  RESOURCE_GROUP="${RESOURCE_GROUP:-${namePrefix:-lumina}-rg}"
  EXISTING_FUNC_APP=$(az functionapp list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv 2>/dev/null || true)
  if [[ -n "$EXISTING_FUNC_APP" ]]; then
    EXECUTION_WORKER_KEY=$(az functionapp config appsettings list --name "$EXISTING_FUNC_APP" --resource-group "$RESOURCE_GROUP" --query "[?name=='EXECUTION_WORKER_KEY'].value | [0]" -o tsv 2>/dev/null || true)
  fi
  if [[ -z "$EXECUTION_WORKER_KEY" ]]; then
    echo "No existing EXECUTION_WORKER_KEY found in $RESOURCE_GROUP — generating a new one (first deploy)." >&2
    EXECUTION_WORKER_KEY=$(openssl rand -hex 32)
  else
    echo "Reusing the existing live EXECUTION_WORKER_KEY from $EXISTING_FUNC_APP (not rotating it)." >&2
  fi
fi

TEMP_PARAMS_FILE="$PARAMS_DIR/.deploy-${ENV_NAME}.bicepparam"
cleanup() { rm -f "$TEMP_PARAMS_FILE"; }
trap cleanup EXIT

cp "$ENV_FILE" "$TEMP_PARAMS_FILE"
# jq-free single-quote escaping: the password is generated by this repo's own scripts and
# expected to be alphanumeric-plus-punctuation, not to contain a literal single quote — this is
# not a general-purpose escaper.
printf "\nparam postgresAdminPassword = '%s'\n" "$POSTGRES_ADMIN_PASSWORD" >> "$TEMP_PARAMS_FILE"
printf "param executionWorkerKey = '%s'\n" "$EXECUTION_WORKER_KEY" >> "$TEMP_PARAMS_FILE"

DEPLOY_NAME="lumina-deploy-$(date +%Y%m%d%H%M%S)"
CMD=(az deployment sub)
if [[ "$WHAT_IF" == "true" ]]; then
  CMD+=(what-if)
else
  CMD+=(create)
fi
CMD+=(
  --name "$DEPLOY_NAME"
  --location "$LOCATION"
  --template-file "$BICEP_DIR/main.bicep"
  --parameters "$TEMP_PARAMS_FILE"
)
if [[ -n "$DEPLOY_CLAUDE_FLAG" ]]; then
  CMD+=($DEPLOY_CLAUDE_FLAG)
fi

echo "== Running: az deployment sub $([[ "$WHAT_IF" == "true" ]] && echo what-if || echo create) --name $DEPLOY_NAME ... =="
"${CMD[@]}"
