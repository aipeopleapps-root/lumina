# Leadership Demo Script — Workday AI Platform Prototype

**Audience:** Internal leadership (proving the concept works)  
**Duration:** 10–12 minutes  
**Goal:** Show dual personas sharing a RAG pipeline, tenant-scoped retrieval, and concrete findings that a consultant would act on

---

## Pre-demo setup (done before the meeting)

1. **Deploy the stack:**
   ```bash
   cd infra && npm install && npx cdk deploy
   ```
   Copy the stack outputs into `seed-data/.env` and `frontend/.env.local`.

2. **Run the seed script:**
   ```bash
   cd seed-data && pip install -r requirements.txt && python seed.py
   ```
   This creates:
   - Two tenants: Acme Corp (`acme`) and Globex (`globex`)
   - Four Cognito users (one consultant + one client per tenant)
   - Synthetic Workday Absence + HCM config workbooks for each tenant
   - Curated best-practice KB passages

3. **Start the frontend:**
   ```bash
   cd frontend && npm install && npm run dev
   ```
   Open `http://localhost:5173` in the browser you'll share.

4. **Pre-open browser tabs:**
   - Tab 1: Frontend at localhost:5173 (signed out)
   - Tab 2: AWS Console > OpenSearch Serverless > Collections (showing the index)
   - Tab 3: AWS Console > Cognito > User Pool > Users (showing the four users with `tenant_id` attributes visible)

---

## Demo narrative

### Act 1: The isolation story (2 minutes)

**You:** "We're building a multi-tenant AI platform for Workday delivery. The core challenge is tenant isolation — each client's data must be completely segregated. Let me show you how we've wired that."

**[Tab 3: Cognito]**
- Show the user list. Point out the `custom:tenant_id` attribute.
- "Every user is tagged with a tenant at account creation. That ID flows into every JWT."

**[Tab 2: OpenSearch]**
- Show the `kb-chunks` index.
- "The vector store is shared across tenants, but every chunk is stamped with `tenant_id` at write time. Every query includes a mandatory filter on that field. If that filter is missing or forged, the query fails — there's no code path that allows cross-tenant reads."

**You:** "The enforcement happens in a single shared module that all three Lambda functions import. Let me show you the actual isolation working."

---

### Act 2: Consultant persona — upload and analyze (4 minutes)

**[Tab 1: Frontend, signed out]**

**You:** "First, the consultant view. I'm signing in as the Acme consultant."

- Sign in: `consultant-acme@example.com` / `TempPass123!`
- Point to the **header**: "See the tenant name — 'ACME' — displayed at the top. That's the first visual cue that isolation is working."

**[Consultant panel on the left]**

**You:** "The consultant uploads a Workday configuration workbook. The system parses it, chunks it, embeds each chunk, and indexes it — all with the caller's `tenant_id` stamped on."

- **Upload the workbook:**
  - Keep the defaults (Document type: Configuration workbook, Module: Absence)
  - Click **Upload & analyze**
  - Wait ~20 seconds for ingestion + analysis

**You (while waiting):** "Behind the scenes: the workbook is being chunked sheet-by-sheet. Each chunk gets embedded via Bedrock Titan, indexed in OpenSearch with a `tenant_id: acme` tag, and stored in the Postgres metadata table. Then Claude Sonnet 4.6 reads the full document plus retrieves related best-practice KB chunks and produces structured findings."

**[Findings appear]**

**You:** "Here's what came back."

- **Point to the summary:** Read the one-sentence overview aloud.
- **Point to the findings table:**
  - Show the **severity pills** (high/medium/low) and **category pills** (risk / anti-pattern / best-practice).
  - Click into one finding. Read the **evidence** (quoted from the workbook) and the **recommendation** aloud.
  
**You:** "This is the kind of review output a delivery lead can take into a design checkpoint. Notice the model cited concrete evidence — it's quoting the actual eligibility rule from the workbook. It's not making this up."

- **Highlight a specific finding** (e.g., "Manager Override Flag" anti-pattern from the Eligibility Conditions sheet).
  - "This one flagged the use of a custom field for eligibility bypass. That's a known anti-pattern — it'll cause manual update overhead and audit trail gaps. The recommendation is concrete: replace it with a security group. A consultant reading this knows exactly what to do."

**You:** "This is all grounded in the workbook we just uploaded plus curated best-practice passages we've seeded into the KB. The model didn't invent Workday functionality — it's using what we gave it."

---

### Act 3: Client persona — grounded chat (3 minutes)

**[Coach panel on the right]**

**You:** "Now the client view. Same tenant — Acme — but a different user role. The client-facing coach answers questions about *this tenant's* configuration. Let's ask it something."

- **Type:** `How does the Annual Leave accrual work?`
- **Send**

**[Wait ~3 seconds for the response]**

**You (while waiting):** "Behind the scenes: the question gets embedded, a k-NN search retrieves the top 6 chunks from *Acme's* indexed documents — filtered by `tenant_id` — and Claude generates a grounded answer with citations."

**[Response appears with citation pills]**

**You:** "Look at the answer. It's specific to Acme's config — it's talking about the 1.25 days/month accrual rate and the service bands. That's not generic Workday documentation. That's from the workbook we just uploaded."

- **Click on a citation pill** to expand it.
- "The citation shows which chunk this came from — the sheet name, the chunk index, even the retrieval score. Full explainability."

**You:** "Let me ask a follow-up."

- **Type:** `What happens if someone is a contractor?`
- **Send**

**[Response appears]**

**You:** "It correctly pulled the eligibility condition that excludes contractors from Sick Leave. Again, grounded in the uploaded artifact. This is RAG working — retrieval plus generation, tenant-scoped."

---

### Act 4: The tenant switch — proving isolation (2 minutes)

**You:** "Now the isolation moment. I'm going to sign out and sign in as a *different* tenant — Globex."

- **Sign out**
- **Sign in:** `client-globex@example.com` / `TempPass123!`
- Point to the **header**: "See the tenant name change — now it says 'GLOBEX'."

**[Coach panel]**

**You:** "Same question. Let's ask about Annual Leave again."

- **Type:** `How does the Annual Leave accrual work?`
- **Send**

**[Response appears]**

**You:** "Different answer. The accrual rates are different because Globex has a different configuration workbook. The model is pulling from Globex's indexed chunks, not Acme's. The `tenant_id` filter in the retrieval query is doing its job — Globex cannot see Acme's data, and vice versa."

**You:** "Let me try to trick it. I'll ask about Acme explicitly."

- **Type:** `What about Acme Corp's absence policy?`
- **Send**

**[Response appears — something like "I don't have information about other tenants" or "No relevant documents found"]**

**You:** "It refuses. The retrieval came back empty because all of Globex's queries are hard-filtered to `tenant_id: globex`. Acme's chunks aren't in the result set. There's no code path that allows a cross-tenant leak."

---

### Act 5: Wrap-up — what this proves (1 minute)

**You:** "So what did we just see?"

1. **Dual personas sharing one pipeline:** The consultant uploads and gets structured findings. The client asks questions and gets grounded answers. Both are hitting the same vector index and the same Bedrock models — but with different prompts and different UX.

2. **Tenant isolation enforced at the data layer:** Every query to OpenSearch includes a `tenant_id` filter. Every S3 key is prefixed by tenant. Every Postgres row is scoped to a tenant schema. The enforcement happens in a shared utility module — one place, scrutinized heavily, no bypass paths.

3. **Grounded, not hallucinated:** The findings cite evidence from the workbook. The coach answers cite chunks with retrieval scores. We're not just calling Claude and hoping — we're giving it scoped context and requiring citations.

**You:** "This is a working prototype — Bedrock for generation and embeddings, OpenSearch Serverless for vectors, Aurora Postgres for metadata, Cognito for auth, all on AWS. The code is in the repo, the IaC is CDK, and the demo you just saw is reproducible. Next steps would be hardening the tenant isolation tests, adding more curated KB content, and wiring in a production-grade upload flow. But the core concept — multi-tenant RAG with dual personas — is proven."

---

## Likely questions from leadership

**Q: What happens if the model hallucinates?**  
A: The retrieval step is the guardrail. The model only sees chunks we gave it — it can't invent facts about Workday that aren't in the context. If a question has no relevant chunks, the response is "I don't have information on that" rather than a fabrication. The citations make it auditable — you can trace every claim back to a specific chunk.

**Q: How do we keep the curated KB up to date?**  
A: The KB is versioned content we control. We'd have a content pipeline where subject-matter experts submit passages, they get reviewed, and then they're ingested with a `doc_type: kb` tag. We can periodically refresh or deprecate KB chunks without touching client artifacts.

**Q: What's the cost at scale?**  
A: For this prototype, negligible — OpenSearch Serverless scales to zero when idle, Aurora Serverless v2 starts at 0.5 ACU, Bedrock is pay-per-token. At production scale with 50 active tenants and 10k chunks per tenant, we'd be looking at ~$200/month for storage + $500–1000/month for Bedrock inference depending on query volume. The expensive part is human review — we'd want consultants spot-checking findings before they go to clients.

**Q: Can we white-label this for client-facing use?**  
A: Yes. The frontend is a React SPA — rebrand the header, swap the Cognito pool for each client's IdP via SAML/OIDC federation, done. The backend is already multi-tenant. The harder part is the legal/compliance side — client contracts would need to cover AI-generated content and liability.

**Q: How long to production?**  
A: This prototype took ~3 weeks (one person, part-time). To production: add integration tests for tenant isolation (critical), wire up monitoring/alerting, build an admin UI for managing KB content and reviewing findings, harden the upload flow, add rate limiting, get a security review. Call it 8–12 weeks with a small team.
