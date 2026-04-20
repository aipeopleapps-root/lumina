# Deployment Guide

End-to-end instructions for deploying the Workday AI Platform prototype from a clean AWS account to a running demo.

## Prerequisites

- **AWS account** with admin-level permissions (or sufficient IAM for CDK, Cognito, RDS, S3, OpenSearch, Bedrock)
- **Bedrock model access** in us-east-1:
  - Claude Sonnet 4.6 (`us.anthropic.claude-sonnet-4-6`)
  - Titan Text Embeddings v2 (`amazon.titan-embed-text-v2:0`)
  - Request access via AWS Console > Bedrock > Model Access if not already enabled
- **AWS CLI** configured with credentials (`aws configure`)
- **Node.js 20+** and **Python 3.12+**
- **CDK bootstrap** in us-east-1 (if first time): `npx cdk bootstrap aws://ACCOUNT/us-east-1`

## Step 1: Deploy the infrastructure

```bash
cd infra
npm install
npx cdk deploy --require-approval never
```

This creates:
- VPC with public + private subnets, NAT gateway
- S3 bucket for docs (versioned, encrypted)
- Aurora Serverless v2 Postgres cluster (min 0.5 ACU)
- OpenSearch Serverless collection with k-NN index
- Cognito user pool with `tenant_id` custom attribute
- Four Lambda functions (upload-url, ingest, analyze, chat)
- HTTP API with JWT authorizer

The deploy takes ~8–10 minutes. At the end, CDK prints stack outputs:

```
Outputs:
WorkdayAiPlatformStack.ApiEndpoint = https://xxxxxx.execute-api.us-east-1.amazonaws.com
WorkdayAiPlatformStack.UserPoolId = us-east-1_xxxxxxxxx
WorkdayAiPlatformStack.UserPoolClientId = xxxxxxxxxxxxxxxxxxxxxxxxxx
WorkdayAiPlatformStack.DocsBucketName = workdayaiplatformstack-docsbucket-xxxxx
WorkdayAiPlatformStack.VectorCollectionEndpoint = https://xxxxx.us-east-1.aoss.amazonaws.com
WorkdayAiPlatformStack.DbClusterArn = arn:aws:rds:us-east-1:123456789012:cluster:xxxxx
```

**Copy these outputs.** You'll need them in Step 2 and Step 3.

## Step 2: Seed the tenants and data

```bash
cd ../seed-data
pip install -r requirements.txt

# Copy the example env file and fill in the stack outputs from Step 1.
cp .env.example .env
nano .env  # or your editor of choice
```

Your `.env` should look like:

```bash
AWS_REGION=us-east-1
USER_POOL_ID=us-east-1_xxxxxxxxx
DOCS_BUCKET=workdayaiplatformstack-docsbucket-xxxxx
DB_CLUSTER_ARN=arn:aws:rds:us-east-1:123456789012:cluster:xxxxx
DB_SECRET_ARN=arn:aws:secretsmanager:us-east-1:123456789012:secret:xxxxx
DB_NAME=platform
AOSS_ENDPOINT=https://xxxxx.us-east-1.aoss.amazonaws.com
AOSS_COLLECTION=workday-ai-kb
AOSS_INDEX=kb-chunks
```

Then run the seed script:

```bash
python seed.py
```

This will:
1. Create the OpenSearch k-NN index (if it doesn't exist)
2. Create four Cognito users:
   - `consultant-acme@example.com` (tenant: acme, role: consultant)
   - `client-acme@example.com` (tenant: acme, role: client)
   - `consultant-globex@example.com` (tenant: globex, role: consultant)
   - `client-globex@example.com` (tenant: globex, role: client)
3. Bootstrap Postgres schemas (`t_acme`, `t_globex`) with tables
4. Generate synthetic Workday workbooks (Absence + HCM for each tenant)
5. Upload workbooks to S3 under `tenants/{tenant_id}/seed/`
6. Chunk, embed, and index all workbooks (takes ~2 minutes)
7. Ingest curated KB passages

The seed script is idempotent — safe to re-run. If users already exist, it skips them.

**Default password for all users:** `TempPass123!`

## Step 3: Run the frontend

```bash
cd ../frontend
npm install

# Copy the example env and fill in the stack outputs.
cp .env.example .env.local
nano .env.local
```

Your `.env.local`:

```bash
VITE_API_ENDPOINT=https://xxxxxx.execute-api.us-east-1.amazonaws.com
VITE_USER_POOL_ID=us-east-1_xxxxxxxxx
VITE_USER_POOL_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
VITE_AWS_REGION=us-east-1
```

Start the dev server:

```bash
npm run dev
```

Open `http://localhost:5173` in your browser.

## Step 4: Verify the demo

1. **Sign in as Acme consultant:**
   - Email: `consultant-acme@example.com`
   - Password: `TempPass123!`
   - Verify the header shows **Tenant: ACME**

2. **Upload a workbook (or use the seeded one):**
   - The seed script already indexed workbooks, so you can skip straight to asking questions in the coach panel.
   - Or, upload a new `.xlsx` file to test the full flow.

3. **Switch to the coach panel and ask:**
   - "How does the Annual Leave accrual work?"
   - Verify the answer cites Acme-specific data (1.25 days/month, service bands).

4. **Sign out and sign in as Globex client:**
   - Email: `client-globex@example.com`
   - Password: `TempPass123!`
   - Verify the header now shows **Tenant: GLOBEX**
   - Ask the same question — the answer should be different (Globex's config).

## Step 5: Run the leadership demo

Follow the script in `docs/demo-script.md`. It includes the exact talking points, clicks, and anticipated questions.

## Tear down

To delete everything:

```bash
cd infra
npx cdk destroy
```

This removes the stack. Note:
- The S3 bucket has `autoDeleteObjects: true`, so all docs are deleted too.
- The Aurora cluster and OpenSearch collection are deleted (no snapshots).
- Cognito user pool is deleted.

For a real deployment, you'd remove `removalPolicy: DESTROY` from the CDK stack and take manual snapshots before tear-down.

## Troubleshooting

**Problem:** CDK deploy fails with "No export named XYZ found"  
**Fix:** You likely have a VPC or subnet conflict. Delete any existing stacks in the region and redeploy.

**Problem:** Seed script fails with "Access Denied" on OpenSearch  
**Fix:** The OpenSearch data access policy takes ~30 seconds to propagate after `cdk deploy`. Wait 1 minute and retry.

**Problem:** Lambda times out on first ingest  
**Fix:** Cold start. The first invocation pulls the Docker image, installs deps, and initializes Bedrock. Subsequent calls are <5s. Just retry the upload.

**Problem:** Coach answers are generic / not grounded  
**Fix:** Check that the seed script actually indexed chunks. Run:
```bash
aws opensearchserverless list-indexes --collection-name workday-ai-kb --region us-east-1
```
If the index is empty, re-run `seed.py`.

**Problem:** "Model not found" or Bedrock throttle  
**Fix:** Verify Bedrock model access in the AWS Console. If the model ID is wrong, update `GENERATION_MODEL_ID` in the CDK stack and redeploy.

## Next steps

See `docs/README.md` for what's missing from the prototype and what you'd add for production.
