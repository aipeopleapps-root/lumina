# Documentation

## What's here

- **`demo-script.md`** — The minute-by-minute leadership demo narrative. Read this before the demo. It includes the setup steps, the exact clicks, the talking points, and anticipated questions.

## Architecture decisions

**Why Claude Sonnet 4.6 instead of Opus?**  
Cost and speed. Sonnet 4.6 via the US cross-region inference profile is ~5x cheaper than Opus 4.7 and fast enough for chat. The findings quality is strong — Sonnet handles structured output and evidence citation well. For the actual leadership demo day, consider swapping the `GENERATION_MODEL_ID` constant to `us.anthropic.claude-opus-4-7` for the top-tier branding moment, then swap back to Sonnet for ongoing dev.

**Why OpenSearch Serverless instead of Pinecone/Weaviate?**  
AWS-native, scales to zero when idle, and works with the existing IAM/VPC setup without adding another vendor. The k-NN performance is good enough for the prototype (sub-100ms retrieval for 6 chunks out of 500 total). At production scale (50k+ chunks per tenant), we'd benchmark OpenSearch provisioned vs. Pinecone.

**Why Aurora Serverless v2 instead of DynamoDB?**  
Postgres gives us schema-per-tenant isolation (clean, auditable) and the RDS Data API works well from Lambda. DynamoDB would be cheaper at scale but tenant isolation becomes an application-layer concern (partition key prefixes) rather than a database-layer guarantee. For a multi-tenant prototype where isolation is the headline feature, Postgres makes the story clearer.

**Why schema-per-tenant instead of one schema with a tenant_id column?**  
Defense in depth. If a bug forgets the `WHERE tenant_id = ?` clause on a query, the blast radius is one tenant, not all tenants. Schema-per-tenant means the database itself enforces isolation — even a SQL injection or buggy query can't cross tenant boundaries. The cost is schema proliferation (manageable with automation) and slightly more complex migrations (run per schema). Trade-off is worth it for the prototype's isolation story.

**Why Cognito custom attributes instead of a separate user profile table?**  
Fewer moving parts. The `tenant_id` lives in the JWT and flows into every Lambda request with zero extra queries. The downside is Cognito custom attributes are immutable per-user after creation, so tenant reassignment needs a new user. For the demo, that's fine. In production, we'd probably still use Cognito for the claim but have a user profile table for mutable attributes.

## What's missing from the prototype

This is a **proof-of-concept**, not a production system. Here's what you'd add before going live:

1. **Tenant isolation integration tests.** The most important gap. Write tests that create two tenants, ingest docs for each, and assert that tenant A's queries return zero of tenant B's chunks. Run these in CI on every commit. A tenant leak is a catastrophic failure — the tests need to catch it before deploy.

2. **Rate limiting.** Right now a malicious user can spam `/chat` and drive up Bedrock costs. Add per-user or per-tenant rate limits at the API Gateway layer (usage plans) or in the Lambda (check recent query count in a Redis cache).

3. **Admin UI for KB management.** The curated KB passages are hardcoded in the seed script. In production, you'd want a UI where SMEs can submit passages, tag them by module, version them, and mark them as active/deprecated. Store them in the `documents` table with `doc_type: kb` and a workflow state.

4. **Findings persistence.** The analyze Lambda returns findings JSON but doesn't save them. Add a `findings` table write so the consultant UI can show "past reviews" for a doc without re-running the model. Gives you audit history and cost savings.

5. **Audit log UI.** The audit table exists but there's no UI to view it. Leadership will want to see "why did the model say that" traces — which chunks were retrieved, what the prompt was, how long it took. Build a simple admin panel that queries the audit table and renders the retrieved chunks + prompt + response.

6. **Error handling and retries.** The Lambda handlers do basic try/catch but don't retry transient failures (throttling, network blips). Add exponential backoff on Bedrock calls and OpenSearch writes. Also: dead-letter queues for failed ingestion jobs.

7. **Monitoring and alerting.** Wire CloudWatch alarms for: Lambda error rate, Bedrock throttle rate, OpenSearch indexing failures, Aurora connection pool exhaustion. The prototype logs to CloudWatch but doesn't alert.

8. **Multi-file upload.** The consultant panel uploads one file at a time. In practice, a consultant would want to drop 5 workbooks + 3 PDFs in one go. Add a queue (SQS) between upload and ingestion so large batches don't time out the API.

9. **Real presigned POST for uploads.** The current flow is presigned PUT. For large files (50MB+ workbooks), use presigned POST with a size limit and content-type enforcement. More secure.

10. **Versioning and rollback.** If a tenant re-uploads a config workbook, the old chunks stay in the index. Add a version field and a "delete old chunks for this doc" step on re-ingest. Or soft-delete with an `active` flag so you can roll back.

11. **Multi-region failover.** Right now everything is in us-east-1. For production uptime, replicate the RDS cluster to a second region, set up a Route 53 health check + failover, and use Bedrock's cross-region inference profiles (already wired in the stack). OpenSearch Serverless doesn't support cross-region replication yet — you'd need to dual-write or re-ingest on failover.

12. **Security review.** Before going live, get a third-party security audit. Focus areas: tenant isolation (the big one), IAM roles (least privilege), encryption at rest + in transit (already on, but verify), logging of sensitive data (JWT claims, PII in workbooks), and API auth bypass attempts.

## Cost estimate (prototype vs. production)

**Prototype (as built):**
- OpenSearch Serverless: ~$25/month (4 OCUs idle)
- Aurora Serverless v2: ~$15/month (0.5 ACU idle, spikes to 1.0 during seed)
- S3: <$1/month (50MB total docs)
- Lambda: <$1/month (free tier)
- API Gateway: <$1/month (free tier)
- Bedrock (10k tokens/day): ~$5/month
- **Total: ~$50/month**

**Production (50 tenants, 10k chunks per tenant, 1k queries/day):**
- OpenSearch Serverless: ~$180/month (16 OCUs under load)
- Aurora Serverless v2: ~$80/month (2 ACU average)
- S3: ~$5/month (5GB docs)
- Lambda: ~$20/month (invocations + duration)
- API Gateway: ~$10/month (1M requests)
- Bedrock (500k tokens/day): ~$600/month (embeddings + generation)
- Data transfer: ~$10/month
- **Total: ~$900/month**

The Bedrock line dominates at scale. If query volume is higher, consider caching common questions (Redis) and using Haiku for simple questions (10x cheaper than Sonnet).
