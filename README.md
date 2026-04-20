# Workday Insight Studio — Prototype

Dual-persona demo of an AI-powered Workday delivery and support platform. Built for an internal leadership demo — proves the concept end-to-end on AWS with real Bedrock calls and tenant-scoped RAG.

## What this demonstrates

One shared RAG pipeline, two personas on a split-screen UI:

- **Consultant panel** — upload a Workday configuration or business process workbook, get risk findings, anti-pattern warnings, and best-practice recommendations.
- **Client coach panel** — ask natural-language questions about Workday configuration and get grounded answers that cite the same uploaded artifacts and curated knowledge.

Two seeded tenants (`acme` and `globex`). Switching tenants changes what the coach sees — proving isolation.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + Vite, Amplify Hosting | Fast to build, easy to deploy, split-screen fits in one SPA |
| Auth | Cognito with `tenant_id` custom claim | The tenant claim flows into every JWT and into every Lambda |
| API | API Gateway (HTTP API) + Lambda | Cheap for demo load, fast cold-starts with ARM64 |
| LLM | Bedrock — Claude Sonnet 4.6 for generation | Strong enough for workbook analysis, fast enough for chat |
| Embeddings | Bedrock — Titan Text Embeddings v2 | 1024-dim, ~$0.02 per million tokens |
| Vector store | OpenSearch Serverless, k-NN collection | AWS-native, scales to zero when idle |
| Metadata | RDS Postgres (Aurora Serverless v2) | Schema-per-tenant isolation, min 0.5 ACU |
| Docs | S3 with `tenants/{tenant_id}/` prefix | Bucket policies deny cross-tenant reads |
| IaC | AWS CDK (TypeScript) | Typed Bedrock/OpenSearch constructs |

## Repository layout

```
infra/           CDK TypeScript stack
lambdas/
  common/        Shared tenant-scoping utility (critical)
  ingest/        Parse, chunk, embed, index
  analyze/       Consultant findings from a workbook
  chat/          Client coach RAG
prompts/         Prompt templates for analyze and chat
frontend/        React SPA with split-screen UI
seed-data/       Synthetic Workday workbooks for the demo
docs/            Architecture notes, demo script
```

## Quick start

```bash
# 1. Deploy infra (Bedrock access in us-east-1 required)
cd infra && npm install && npx cdk deploy

# 2. Seed two tenants + sample artifacts
cd ../seed-data && python seed.py

# 3. Run frontend locally, pointing at the deployed API
cd ../frontend && npm install && npm run dev
```

## The thing that must not break

Every Lambda call asserts the `tenant_id` from the Cognito JWT and uses it as the filter on every read and write. This is enforced in `lambdas/common/tenant.py` — nothing else touches OpenSearch or Postgres directly. One cross-tenant leak in a leadership demo kills the project, so this module is the most scrutinized code in the repo.
