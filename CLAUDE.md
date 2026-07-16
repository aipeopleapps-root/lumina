# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Lumina — a multi-tenant AI platform for Workday consulting engagements, built on AWS. Three personas share one app: **admin** (tenant/user management), **consultant** (upload & analyze Workday config workbooks, process diagrams, SOWs), **client** (RAG chat coach grounded in that tenant's uploaded docs + curated knowledge base). Two seeded demo tenants (`acme`, `globex`) exist to prove tenant isolation.

## Commands

```bash
# Frontend (React + TS + Vite, in frontend/)
cd frontend
npm install
npm run dev        # http://localhost:5173, needs frontend/.env.local (see .env.example)
npm run build       # tsc && vite build — this is the closest thing to a typecheck/lint gate
npx playwright test # e2e tests (playwright is a devDependency; no test script wired into package.json)

# Infra (AWS CDK v2, TypeScript, in infra/)
cd infra
npm install
npx cdk diff         # preview changes against deployed stack
npx cdk deploy --require-approval never
npx cdk synth > template.yaml   # inspect generated CloudFormation without deploying

# Lambdas (Python 3.12, in lambdas/<name>/)
cd lambdas/<name>
pip install -r requirements.txt
# No test suite exists for lambdas today. To sanity-check a handler locally, invoke
# handler.handler(event, {}) directly with a hand-built API Gateway v2 event (see VSCODE_SETUP.md
# for a worked example) — there's no local API Gateway/SAM emulation set up.
```

There is no root-level `package.json`, linter config, or CI test gate — `frontend` and `infra` are independent npm projects. CI (`.github/workflows/deploy.yml`) only runs `cdk diff`/`cdk deploy` on push to `main` when `infra/**` or `lambdas/**` change; it does not run tests.

## Architecture

**Request flow is uniform:** Browser (Cognito JWT) → API Gateway (HTTP API, JWT authorizer) → one Lambda per route → DynamoDB / Aurora Postgres / S3 / Bedrock → JSON response. Every route requiring auth is wired in `infra/lib/stack.ts` as `makeFn(...)` + `httpApi.addRoutes(...)`; there is no shared router — each Lambda is a single-purpose handler in `lambdas/<name>/handler.py`.

**Tenant isolation is the load-bearing constraint of this codebase.** `lambdas/common/tenant.py:tenant_from_event()` extracts `tenant_id`/`role`/`user_id` from the JWT claims and returns a `TenantContext` that every downstream S3/DynamoDB/Aurora call must be scoped by. Consultants and admins can act on a different tenant via the `x-client-tenant` header, but consultants must have a verified assignment (checked against DynamoDB) or they get a 403. Any new Lambda that reads/writes tenant data must go through this module — don't hand-roll tenant extraction.

**Storage split (three systems, each with a distinct purpose — don't confuse them):**
- **DynamoDB** — the actual "hot path" data: `VectorTable` (tenant_id + chunk_id, holds document chunks + embeddings for RAG), `ConfigTable` (generic pk/sk key-value: consultant↔client assignments, folder templates, etc.), `AuditTable`, plus a `doc_id` GSI for pulling all chunks of a document. Similarity search is done in-Lambda (cosine similarity over chunks fetched by `tenant_id`), not via a managed vector index — there is no OpenSearch in this stack despite what `README.md` says (that doc describes an earlier/aspirational design; trust `infra/lib/stack.ts` over it).
- **Aurora Postgres (Serverless v2, accessed via RDS Data API)** — relational/admin metadata: tenants, users, audit trail, schema-per-tenant (`t_<tenant_id>`). Accessed through `lambdas/common/db.py`, which wraps the Data API (`rds-data` boto3 client) with a DB-API-like `Connection`/`Cursor`, since Lambdas in the private VPC subnet don't hold a persistent connection pool.
- **S3** — raw uploaded documents, key-prefixed `tenants/{tenant_id}/...` (bucket policy + `TenantContext.s3_key()` enforce the prefix so nothing can write outside its own tenant's path).

**Bedrock usage:** Claude (`GENERATION_MODEL_ID` in `infra/lib/stack.ts`) for analysis/chat generation, Titan Text Embeddings v2 (1024-dim, `EMBEDDING_MODEL_ID`) for chunk/query embeddings. Both model IDs are stack constants injected into every Lambda's environment — change the model in one place (`infra/lib/stack.ts`) and redeploy, not per-Lambda.

**Lambda packaging:** all ~35 Lambdas are bundled by the same `makeFn` helper in `infra/lib/stack.ts` — each gets its own `requirements.txt` pip-installed, plus `lambdas/common/` and the root `config/` directory copied in verbatim. So `lambdas/common/*.py` is available to every handler as a local import, and anything added to `config/` (e.g. `folder-templates.json`) is available to every Lambda without a redeploy of that specific function. Some routes (e.g. `generate_tests`, `pi_parse`) fan out to a second "worker" Lambda pointed at a different handler function (`handler.worker_handler`) in the same code asset, invoked async for long-running work past the sync route's timeout.

**Frontend** is a single Vite SPA (`frontend/src/App.tsx`) that switches UI entirely based on the Cognito role claim — `AdminPanel`, `ConsultantPanel`/`ConsultantChat`, `ClientView`/`CoachPanel` are effectively separate apps sharing `frontend/src/lib/api.ts` as the one place that attaches JWTs and calls the API Gateway endpoints.

**Docs worth knowing about but not treating as ground truth:** `PROJECT_GUIDE.md` and `docs/FOLDER_STRUCTURE_HANDOFF.md` are useful narrative walkthroughs but were written at specific points in time (the folder-structure feature they describe as a "plan" is already implemented — see `FileExplorer.tsx`, `FolderPicker.tsx`, `admin_get_templates/`, `tenant_folder_structure/`). `README.md`'s stack table (OpenSearch, plain RDS) is stale versus the actual DynamoDB-based implementation. When these disagree with `infra/lib/stack.ts` or the lambda code, the code wins.
