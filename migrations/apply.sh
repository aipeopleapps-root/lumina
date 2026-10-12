#!/bin/bash
# Apply a migrations/*.sql file to the deployed Aurora cluster via the RDS Data API,
# one statement at a time (the Data API's execute-statement does not support
# multiple statements per call).
#
# Usage:
#   ./migrations/apply.sh migrations/005_pi_recommendations_agents_plans.sql
#
# Requires the AWS CLI configured with credentials for the target account.
# DB_CLUSTER_ARN / DB_SECRET_ARN default to this stack's known values (same
# ones baked into run_migration.sh) — override via env vars if the stack has
# since been replaced (cluster/secret IDs regenerate on stack replacement,
# not on ordinary `cdk deploy` updates, so these should still be valid).

set -euo pipefail

FILE="${1:?Usage: $0 <migrations/NNN_name.sql>}"
DB_CLUSTER_ARN="${DB_CLUSTER_ARN:-arn:aws:rds:us-east-1:893361712185:cluster:workdayaiplatformstack-db5d02a0a9-7gp0sv8iihlx}"
DB_SECRET_ARN="${DB_SECRET_ARN:-arn:aws:secretsmanager:us-east-1:893361712185:secret:DbSecret685A0FA5-42pEl7lNn5Jt-BiFLe8}"
DATABASE="${DATABASE:-platform}"
REGION="${REGION:-us-east-1}"

if [[ ! -f "$FILE" ]]; then
  echo "File not found: $FILE" >&2
  exit 1
fi

# Strip full-line comments and blank lines, then split on ';' at end of line.
# This migration file has no semicolons inside string/dollar-quoted literals,
# so a naive split is safe.
STATEMENTS=$(grep -v '^\s*--' "$FILE" | sed '/^\s*$/d')

echo "Applying $FILE against cluster ${DB_CLUSTER_ARN##*:}"
echo "---"

# Read statements split on ';', preserving multi-line statements.
# `-d ''` makes read slurp the whole input (delimiter = NUL, never found) instead
# of stopping at the first newline, which is what plain `read -ra <<<` does —
# that bug silently dropped every statement after the first line.
IFS=';' read -d '' -ra STMTS <<< "$STATEMENTS" || true
for stmt in "${STMTS[@]}"; do
  trimmed=$(echo "$stmt" | sed '/^\s*$/d')
  if [[ -z "$trimmed" ]]; then continue; fi
  echo "→ ${trimmed:0:80}..."
  aws rds-data execute-statement \
    --resource-arn "$DB_CLUSTER_ARN" \
    --secret-arn "$DB_SECRET_ARN" \
    --database "$DATABASE" \
    --sql "$trimmed" \
    --region "$REGION" \
    > /dev/null
done

echo "---"
echo "Done."
