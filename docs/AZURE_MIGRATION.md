# Azure Migration — Progress Tracker

**Purpose of this file**: this is the resumable source of truth for the AWS→Azure migration. It is checked into git so it travels across sessions/laptops — read this file first when picking the work back up, update the checkboxes/status as you go, and add dated notes under "Log" when a session ends mid-phase.

Full architecture mapping and rationale: see the plan written 2026-08-04 (not in git — if you need the full AWS→Azure resource table again, ask Claude to regenerate it from this tracker + `infra/lib/stack.ts`, or re-run the original planning conversation). This file is the execution tracker; that conversation was the design doc.

## Locked-in decisions (2026-08-04)

| Decision | Choice | Why |
|---|---|---|
| Cutover strategy | **Rebuild in parallel, one-time cutover** (not strangler/phased) | Only 2 seeded demo tenants, no evidence of production load — dual-write complexity isn't worth it. |
| IaC tool | **Bicep** | Azure-native, no state file. (CDK/TypeScript familiarity was the alternative case for Pulumi, but Bicep was chosen.) |
| AI model strategy | **Azure AI Foundry (Claude, unchanged prompts) + Azure OpenAI embeddings** (`text-embedding-3`, dims=1024) | Keeps generation behavior stable; embeddings must be regenerated regardless of provider since Titan vectors don't transfer. |
| Vector store | **Cosmos DB, same brute-force cosine-similarity scan** (no native vector index yet) | Direct parity with current DynamoDB approach — lowest migration risk. Upgrade to native vector index is a later, separate decision. |

Do not revisit these without good reason — re-deciding them mid-migration will desync this tracker from reality.

## How to resume a session

1. Read this file top to bottom.
2. Find the first phase that isn't `✅ Done`.
3. Check its "Depends on" row — confirm those phases are actually done (not just checked off wrong).
4. Read the "Log" entries for that phase for any in-progress notes, blockers, or half-finished steps.
5. Continue from there.

---

## Dependency graph (text form)

```
Phase 0 (Decisions)
   |
Phase 1 (Azure account foundation: subscription, resource group, existing Entra ID Workforce tenant)
   |
   +-----------------------------+--------------------------------+
   |                              |                                |
Phase 2 (Networking:         Phase 3a (Entra app registration, Phase 3b (Azure AI Foundry +
VNet/subnets/NSG/NAT)        custom attrs, MFA policy)          Azure OpenAI model deploys)
   |                              |                                |
Phase 4 (Data stores: Postgres Flexible Server, Cosmos DB, Blob Storage, Key Vault)
   [needs Phase 2 for private endpoints; independent of 3a/3b]
   |
   +---------------------------------------------------------------+
   |                                                                 |
Phase 5 (Port lambdas/common/*.py into new functions/common/)                |
   [needs Phase 3a for tenant.py claim shape, Phase 3b for          |
    azure_ai.py, Phase 4 for db.py/cosmos_vectors.py to test        |
    against real resources. Code now lives under functions/,        |
    NOT edited in place under lambdas/ — see Phase 5 notes.]         |
   |                                                                 |
Phase 6 (Port the 37 handlers into functions/<name>/)               |
   [needs Phase 5 done — every handler imports common/]              |
   |                                                                 |
Phase 7 (Function App + APIM deployment wiring)  <-------------------+
   [needs Phase 6 handlers to deploy, Phase 1/2/4 infra to deploy into]
   |
Phase 8 (Frontend: MSAL swap, Static Web Apps)
   [needs Phase 3a for Entra client ID, Phase 7 for a live API endpoint to test against]
   |
Phase 9 (CI/CD: GitHub Actions Azure OIDC + Bicep deploy)
   [needs Phase 1-7 stable enough that there's something worth automating;
    can be scaffolded early but finalized last]
   |
Phase 10 (Data migration & cutover)
   [needs everything above verified end-to-end on a test tenant]
   |
Phase 11 (Decommission AWS)
   [needs a confirmed soak period post-cutover]
```

Phases 2/3a/3b can run in parallel (different Azure control planes: networking, identity, AI). Phase 9 (CI/CD) can be scaffolded in skeleton form any time after Phase 1 but shouldn't be finalized until Phase 7 settles the deployable unit shape.

---

## Phase status

### Phase 0 — Decisions
**Status:** ✅ Done (2026-08-04)
See locked-in decisions table above.

### Phase 1 — Azure account foundation
**Status:** 🟡 IaC written, not deployed (resource group only — see `bicep/main.bicep`)
**Depends on:** Phase 0
- [ ] Azure subscription confirmed/created, billing owner identified — **manual, see `bicep/README.md` runbook**
- [x] Resource group Bicep authored (`bicep/main.bicep` creates `lumina-rg` at subscription scope) — not yet deployed
- [x] Entra tenant identified — **no creation needed**: every Azure subscription (including a personal one) already has a default Entra ID (Workforce) tenant; app registers directly into it (see `bicep/README.md` runbook — scope changed 2026-08-07, was previously going to be a separate Entra External ID/CIAM tenant)
- [x] Region availability researched — **East US 2** chosen as the region supporting Azure AI Foundry Anthropic Claude, Azure OpenAI embeddings, Cosmos DB, and Postgres Flexible Server together (point-in-time research, 2026-08-04 — re-verify before deploying, see `bicep/README.md` "Region" section for links)

### Phase 2 — Networking
**Status:** 🟡 IaC written, not deployed (`bicep/modules/networking.bicep`)
**Depends on:** Phase 1
- [x] VNet + 3 subnets authored (app/data/private-endpoint — added a third subnet vs. the AWS 2-AZ split, since Azure's zone model differs; single-region no zone-redundancy for now)
- [x] NSGs authored (mirrors `DbSg` — Postgres port 5432 ingress restricted to VNet CIDR)
- [x] NAT Gateway authored
- [x] Private Endpoint subnet authored (`snet-pe`), consumed by Postgres/Cosmos/Blob/Key Vault in `data.bicep` — deliberate improvement over the AWS side, which had no VPC endpoints
- [ ] Deployed to a live subscription — pending user action

### Phase 3a — Identity (Entra ID app registration)
**Status:** 🟡 In progress — app registered, JWT claim shape captured (with one open caveat, see Log), MFA remains (see `bicep/README.md` "Manual runbook — Phase 3a")
**Depends on:** Phase 1
- [x] Entra ID (Workforce) tenant confirmed — using the existing default tenant, **not** creating a separate one: tenant ID `9eb4680c-8bfd-4a8e-ab9a-2ac841f47d25`, name "Default Directory". This is the personal-account tenant; re-run against Deloitte's tenant ID later, same script.
- [x] App registration created (ad-hoc `az rest` commands run on a second machine without a repo clone, equivalent to `bicep/scripts/register-entra-app.sh --display-name lumina-app --redirect-uri http://localhost:5173`): app object ID `60450b8f-227b-41d3-9a9d-d10889f00335`, app (client) ID `5cc4858b-aa23-4916-a34f-dd3a028d197d`. Service principal created (required for sign-in to actually work).
- [x] Custom attributes created — `extension_5cc4858baa234916a34fdd3a028d197d_tenant_id`, `extension_5cc4858baa234916a34fdd3a028d197d_role`. These extension-property names are specific to this app registration (the `5cc4858baa234916a34fdd3a028d197d` segment is the client ID with dashes stripped) — will differ when re-registered against the Deloitte tenant later; `functions/common/tenant.py`'s eventual APIM header mapping needs to reference whatever the Deloitte re-run produces, not these literal names.
- [x] Assign yourself (and any other users) the `role`/`tenant_id` attribute values (runbook step 3) — `role=admin` set for the account, confirmed via `GET /me?$select=extension_..._role`
- [ ] TOTP MFA policy configured (no self-signup to disable — Workforce tenant, users provisioned directly by an admin)
- [x] JWT claim shape captured (see Log for full shape, the `oid`-vs-`sub` design decision, and the MSA-guest caveat on the two `extension_...` claims specifically)

This phase can't be represented in Bicep/ARM — it lives in Microsoft Graph / the Entra admin center. The
runbook in `bicep/README.md` has step-by-step instructions; it's the user's action to run whenever ready.

### Phase 3b — AI services
**Status:** 🟢 Deployed and verified live (`bicep/modules/ai.bicep`)
**Depends on:** Phase 1
- [x] Azure AI Foundry account + project deployed, Claude deployment live (`claude-haiku-4-5` v2, `hostedOn: azure` variant — chosen over the `hostedOn: anthropic` v20251001 variant for quota/availability reasons, see Log)
- [x] Azure OpenAI account + `text-embedding-3-large` deployment live, `EMBEDDING_DIM=1024` handled via the `dimensions` param at call time
- [ ] Smoke-test both endpoints directly (curl/SDK)
- Foundry endpoint: `https://lumina-foundry-c8808fff.cognitiveservices.azure.com/`
- Foundry AI project endpoint: `https://lumina-foundry-c8808fff.services.ai.azure.com/api/projects/lumina-project`
- Azure OpenAI endpoint: `https://lumina-openai-c8808fff.openai.azure.com/`

### Phase 4 — Data stores
**Status:** 🟢 Deployed and verified live (`bicep/modules/data.bicep`)
**Depends on:** Phase 2 (private endpoints), Phase 1
- [x] Postgres Flexible Server authored (Burstable `Standard_B1ms`, private access via delegated subnet + private DNS zone — no PgBouncer equivalent added yet, Flexible Server's built-in connection pooling story differs from Aurora's; revisit if Phase 5 testing shows a need)
- [x] Cosmos DB account + 3 containers (`vectors`, `config`, `audit`) authored, partition keys mirror `VectorTable`/`ConfigTable`/`AuditTable` pk shape, `defaultTtl` enabled on `audit` (Cosmos's automatic indexing covers what the DynamoDB GSIs — `doc_id-index`, `action-index` — did explicitly)
- [x] Blob Storage account + `docs` container authored, CORS rules ported from `stack.ts:42-55` (GET/PUT/POST/DELETE/HEAD, headers `*`, exposed `ETag` — origins currently just the two localhost dev URLs; add the production Static Web Apps origin once Phase 8 stands it up)
- [x] Key Vault authored, Postgres admin password stored as a secret; Key Vault/Cosmos/Storage all get private endpoints into `snet-pe`
- [x] Deployed to a live subscription
- Postgres FQDN: `lumina-pg.postgres.database.azure.com`
- Cosmos endpoint: `https://lumina-cosmos-c8808fff.documents.azure.com:443/`
- Storage account: `luminadocsc8808fff`
- Key Vault: `lumina-kv-c8808fff` (private-endpoint-only, not reachable from outside the VNet — expected)

### Phase 5 — Port `lambdas/common/`
**Status:** 🟡 Code written and syntax-verified under new `functions/common/` directory — **not yet unit-tested against live resources** (no Azure credentials in this session)
**Depends on:** Phase 3a, Phase 3b, Phase 4

**⚠️ Structural decision (this session): `lambdas/` is live AWS production, not a scratch copy.**
`lambdas/common/` is the literal, currently-deployed source tree serving live AWS traffic for both
seeded demo tenants, and `.github/workflows/deploy.yml` auto-runs `cdk deploy` on every push to
`main` touching `lambdas/**` or `infra/**`. Editing it in place for the Azure port would risk
breaking live AWS on the next push. **Decision (user-confirmed): all Azure-port code lives under a
new, parallel `functions/` directory** (`functions/common/`, and `functions/<name>/` per handler in
Phase 6+), mirroring `lambdas/`'s layout. `lambdas/` must **never** be edited as part of this
migration — it stays untouched until the Phase 10 cutover, then Phase 11 decommissions it. This
supersedes every earlier phase note that assumed in-place editing.

- [x] `db.py` → pooled `psycopg2` connections (`functions/common/db.py`), preserves `pg_schema()` +
  `Connection`/`Cursor`/`get_connection()` interface exactly — no `:paramN` translation needed since
  psycopg2 natively accepts the `%s` placeholders `pi_aurora.py` already uses
- [x] `tenant.py` → rewritten to read Entra claims from **APIM-injected headers**
  (`x-tenant-id`/`x-user-role`/`x-user-sub`/`x-user-email`), not a nested JWT claims object — see
  "APIM header contract" in the Log below. Exact claim *names* still depend on Phase 3a's runbook
  being run; header names may need a small follow-up edit once that happens.
- [x] `bedrock.py` → new `azure_ai.py` (same signatures: `generate`, `generate_json`, `embed`,
  `embed_batch`; `embed_batch` now a single batched Azure OpenAI call instead of a per-item loop)
- [x] `dynamo_vectors.py` → `cosmos_vectors.py` (same brute-force cosine similarity, same
  `ensure_index`/`index_chunks`/`search` signatures; vectors base64-encoded since Cosmos has no
  native binary type)
- [x] `audit.py`, `audit_events.py` → repointed at Postgres/Cosmos respectively (also fixed a real
  TTL semantics bug — see Log)
- [x] Delete `aoss.py` (confirmed dead code; not ported, `opensearch_filter()` also removed from
  `tenant.py`)
- [x] `chunking.py`, `http.py`, `pi_aurora.py` — confirmed AWS-agnostic, copied unchanged into
  `functions/common/`
- [ ] `tenant.py` Entra claim shape — **unchecked on purpose**: this session assumed the APIM
  header-injection contract described in the Log; the *exact* header/claim names need confirming
  once Phase 3a's runbook actually runs
- [ ] Unit-test each module against the real Phase 4 resources — **unchecked on purpose**: no Azure
  CLI/credentials in this session (confirmed `az` not installed). All 10 files pass
  `python3 -m py_compile`; real verification (`pip install -r functions/common/requirements.txt`,
  then actually calling Cosmos/Postgres/Foundry/OpenAI) is the user's action to run.

Env var contract for Phase 7 to wire into the Function App (the Azure-side equivalent of
`stack.ts`'s `commonEnv` block): `AZURE_AI_FOUNDRY_ENDPOINT`, `GENERATION_MODEL_NAME`,
`AZURE_OPENAI_ENDPOINT`, `EMBEDDING_MODEL_NAME`, `EMBEDDING_DIM`, `COSMOS_ENDPOINT`,
`COSMOS_DATABASE` (=`lumina`), `VECTOR_CONTAINER_NAME` (=`vectors`), `CONFIG_CONTAINER_NAME`
(=`config`), `AUDIT_CONTAINER_NAME` (=`audit`), `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`.

### Phase 6 — Port the 37 handlers
**Status:** 🟡 In progress — Batch A + Batch B + Batch C + Batch E complete (27/37 handlers ported)
**Depends on:** Phase 5
- [x] Port each handler into `functions/<name>/` (mirroring `lambdas/<name>/`) — **never edit
  `lambdas/<name>/` in place**, per the Phase 5 structural decision above — **Batch A + Batch B +
  Batch C + Batch E (27/37)**; Batch D below is the remaining 10 (actually 7 handlers — Batch D
  is the only unstarted batch)
- [x] Group by AWS service touched (per original inventory: ~20 DynamoDB, 8 S3, 7 Cognito, 3 cross-invoke, 1 Cost Explorer) and batch-port each group — grouping landed as:
  - **Batch A (done, 17)**: pure-DynamoDB/Cosmos-config + AI-generation handlers with no S3/Blob or Cognito/Graph dependency — `admin_archive_client`, `admin_assign_consultant`, `admin_audit_log`, `admin_create_tenant`, `admin_get_templates`, `consultant_my_clients`, `documents_list`, `documents_publish`, `mfa_reset_request`, `tenant_folder_structure`, `test_scripts_status`, `change_impact`, `sow_validate`, `analyze`, `chat`, `pi_graph`, `pi_plan`
  - **Batch B (done, 8)**: S3→Blob handlers — `documents_delete`, `documents_download_url`, `generate_tests`, `ingest`, `pi_parse`, `pi_upload`, `status_report`, `upload_url`. The two cross-invoke members of this batch (`generate_tests`, `pi_parse`) were ported with the Batch C queue-trigger rewrite done in the same pass (see below) rather than split across two later touches of the same file.
  - **Batch C (done, 3)**: cross-invoke workers → Azure Storage Queue trigger pattern — `generate_tests`, `pi_parse` (folded into Batch B above), `pi_agent_lld` (ported separately, queue-enqueue rewrite only — no Blob dependency). All three now use the shared `functions/common/queue.py` `enqueue_job(job_type, payload)` helper and the pre-provisioned `jobs` Storage Queue from Phase 5/Task 13.
  - **Batch D (not started, 7, blocked on Phase 3a)**: Cognito→Microsoft Graph — `admin_create_user`, `admin_list_users`, `admin_manage_user`, `admin_reset_password`, `admin_update_user`, `admin_list_tenants`, `bootstrap`
  - **Batch E (done, 1)**: `admin_cost_summary` → Azure Cost Management API
- [ ] Cognito-touching handlers (`admin_create_user`, `admin_list_users`, `admin_manage_user`, `admin_reset_password`, `admin_update_user`, `admin_list_tenants`, `bootstrap`) → Microsoft Graph API calls — **Batch D, not started**
- [x] Cross-invoke handlers (`generate_tests`, `pi_parse`, `pi_agent_lld`) → Azure Storage Queue trigger pattern — **Batch C, done (3/3)**
- [x] `admin_cost_summary` → rewrite against Azure Cost Management API (different query shape, not a client swap) — **Batch E, done**

### Phase 7 — Function App + APIM deployment wiring
**Status:** ⬜ Not started
**Depends on:** Phase 6 (code), Phase 1/2/4 (infra)
- [ ] Function App plan (Premium/EP1 for VNet integration) deployed via Bicep
- [ ] All handlers deployed as functions, VNet-integrated
- [ ] APIM instance fronting the Function Apps, routes mirroring the original `httpApi.addRoutes` list, JWT validation against Entra
- [ ] CORS + `X-Client-Tenant` header passthrough configured
- [ ] End-to-end route smoke test (see Verification section of original plan) against a throwaway tenant

### Phase 8 — Frontend
**Status:** ⬜ Not started
**Depends on:** Phase 3a, Phase 7
- [ ] Swap `aws-amplify` for `@azure/msal-browser`/`@azure/msal-react` in `main.tsx`/`App.tsx`
- [ ] Rewrite `getAuthToken()` in `api.ts`; fix the existing raw-token-vs-`Bearer` inconsistency while touching this code
- [ ] Update `.env.example` (Entra tenant/client IDs, APIM endpoint)
- [ ] Repoint presigned-URL flows at Blob SAS URLs (shape unchanged)
- [ ] Azure Static Web Apps hosting set up, git-connected

### Phase 9 — CI/CD
**Status:** ⬜ Not started (may scaffold early, finalize last)
**Depends on:** Phase 1 (can start skeleton), Phase 7 (to finalize)
- [ ] GitHub Actions Azure OIDC federated credentials configured
- [ ] `.github/workflows/deploy.yml` rewritten: `azure/login` + `az deployment group create`
- [ ] Decide whether the AWS side's diff-based hotswap-vs-full-deploy trigger logic is worth replicating under Bicep, or simplify to always-full-deploy

### Phase 10 — Data migration & cutover
**Status:** ⬜ Not started
**Depends on:** Phase 8, Phase 9, everything else verified
- [ ] Aurora Postgres → Azure Postgres (`pg_dump`/restore per tenant schema)
- [ ] DynamoDB → Cosmos DB (export/transform/import per table)
- [ ] S3 → Blob (`azcopy`, preserve tenant prefixes)
- [ ] Re-embed all documents against Azure OpenAI embeddings (required — Titan vectors don't transfer)
- [ ] Full tenant-isolation verification on both seeded demo tenants (`acme`, `globex`) on the new stack
- [ ] Flip frontend env vars / DNS
- [ ] Soak period, monitor Azure Monitor/App Insights

### Phase 11 — Decommission AWS
**Status:** ⬜ Not started
**Depends on:** Phase 10, confirmed soak period
- [ ] Tear down CDK stack (`cdk destroy` or manual, after confirming nothing else depends on it)
- [ ] Cancel/downsize AWS Amplify Hosting
- [ ] Final cost/data export archive if needed for compliance

---

## Log

_(Add dated entries here whenever a session ends mid-phase, noting what's done, what's half-done, and any gotchas discovered — e.g. region availability surprises, claim-name mismatches, quota limits.)_

- **2026-08-04**: Migration planned and decisions locked in (see table above). No infra work started yet. Next step: Phase 1.
- **2026-08-04 (session 2)**: Authored Bicep IaC for Phases 1 (resource group), 2 (networking), 3b (AI Foundry + Azure OpenAI), and 4 (Postgres/Cosmos/Storage/Key Vault) — see `bicep/` directory, `bicep/README.md` for deploy instructions. All four `.bicep` files (`main.bicep` + 3 modules) compile clean with `bicep build`/`bicep lint` (one expected benign warning: `BCP081` on the AI Foundry `projects` sub-resource, whose type schema isn't fully registered in Bicep yet). **Nothing has been deployed to a live Azure subscription** — this environment has no Azure CLI/credentials, and the agreed division of labor for this migration is "Claude writes Bicep, the user deploys it." Region research landed on **East US 2** (supports Claude-on-Foundry, Azure OpenAI, Cosmos DB, and Postgres Flexible Server together) — flagged as point-in-time, re-verify before the real deploy. Phase 3a (Entra External ID identity) can't be represented in Bicep since it lives in Microsoft Graph, not ARM — wrote a manual step-by-step runbook in `bicep/README.md` instead. Phase 5+ is explicitly **not started and blocked**: porting `lambdas/common/` needs real resource endpoints and the exact Entra JWT claim shape, neither of which exist until the user runs the Phase 3a runbook and deploys the Bicep, then shares back the outputs. Next step for a future session: user runs `bicep/README.md`'s prerequisites + deploy + Phase 3a runbook, shares back endpoints/tenant IDs/claim shape, then resume at Phase 5.
- **2026-08-04 (session 3)**: Ran the real `az deployment sub create` against a live subscription (`lumina-rg`, East US 2). 27+ of 37 resources succeeded on the first attempt (networking, Postgres, Cosmos, Storage, Key Vault, private endpoints/DNS, both Cognitive Services accounts) — confirmed ARM subscription-scope deployments do **not** roll back sibling resources when one nested resource fails, so a partial failure is safe to iterate on in place. Two resources failed:
  - **`Microsoft.CognitiveServices/accounts/lumina-foundry-c8808fff` naming collision** and a stale pinned API version (`2024-10-01`, deregistered for `accounts/projects` — supported versions had moved on to `2025-04-01-preview` through `2026-07-15-preview`). Fixed by bumping all three Cognitive Services resource types in `ai.bicep` to `2026-05-15-preview` (needed anyway for the `modelProviderData` fix below).
  - **`foundryProject` (`accounts/projects`) — `"Project can only created under AIServices Kind account with allowProjectManagement set to true"`.** Fixed with two changes, both now confirmed required: (1) `allowProjectManagement: true` in the parent `aiFoundry` account's `properties`, AND (2) the **project resource itself** also needs its own `identity: { type: 'SystemAssigned' }` block — the parent account having an identity is not sufficient; Microsoft's own docs example (`learn.microsoft.com/.../create-projects`) confirms both are required.
  - **`claudeDeployment` — `InvalidModelProviderData: ModelProviderData is required for Anthropic model deployments but was not provided`, despite the Bicep already setting it.** Root cause (found via GitHub code search across `Azure/azure-rest-api-specs`, `Azure/bicep-registry-modules`, and a real-world sample repo, since Microsoft Learn's docs never mention this property): `modelProviderData` was only added to the `DeploymentProperties` ARM schema at API version **`2026-05-15-preview`** — anything older (including `2025-06-01`, which we'd tried) silently drops the unrecognized property and the RP then reports it as "not provided". Separately, **`industry` must be a lowercase `ModelProviderIndustry` enum value** (`technology`, `finance`, `healthcare`, `education`, `retail`, `manufacturing`, `government`, `media`, `other`) — our default was `'Technology'` (capitalized), which is also silently rejected the same way. Fixed both `ai.bicep` (API version bump) and `main.bicepparam` (`modelProviderIndustry = 'technology'`). Bicep's bundled type definitions still don't know about `modelProviderData` (`BCP037` warning on build) even though the real ARM API accepts and requires it — this is a harmless warning, confirmed via direct `az rest` calls against the live API before porting the fix into the tracked Bicep files.
  - All three fixes verified via an isolated `az deployment group create` (resource-group scope, `ai.bicep` only) before being trusted — both `foundryProject` and `claudeDeployment` now show `provisioningState: Succeeded`. A subsequent `az deployment sub what-if` against the full `main.bicep` shows no errors and only benign RP-defaulted-property drift (the same kind of no-op diff every other already-deployed resource shows), confirming the whole template is now internally consistent for a clean redeploy.
  - Final live outputs: Foundry endpoint `https://lumina-foundry-c8808fff.cognitiveservices.azure.com/`, Foundry AI project endpoint `https://lumina-foundry-c8808fff.services.ai.azure.com/api/projects/lumina-project`, Azure OpenAI endpoint `https://lumina-openai-c8808fff.openai.azure.com/`, Postgres FQDN `lumina-pg.postgres.database.azure.com`, Cosmos endpoint `https://lumina-cosmos-c8808fff.documents.azure.com:443/`, Storage account `luminadocsc8808fff`, Key Vault `lumina-kv-c8808fff` (private-endpoint-only by design, not reachable outside the VNet).
  - Phases 1–4 (and 3b) are now fully deployed and live. Next step: run the Phase 3a Entra External ID runbook, then resume Phase 5 (`lambdas/common/` port) using the real endpoints above plus the Entra JWT claim shape.
- **2026-08-06 (session 4)**: Started Phase 5 by editing `lambdas/common/` in place per the original plan — then, before any commit/push, realized `lambdas/common/` is the literal source tree behind the currently-deployed, live-serving AWS CDK stack, and `.github/workflows/deploy.yml` auto-deploys on any push to `main` touching `lambdas/**`. Editing it in place is a production-risk change, not a passive migration edit. Flagged this to the user via a direct question; **user chose "separate directory"** over "stop auto-deploy" or "long-lived branch". Reverted all `lambdas/common/` edits via `git checkout --` (confirmed clean via `git status`/`ls`), then redid the entire Phase 5 port under a new **`functions/` directory** (`functions/common/`), left completely untracked from `lambdas/`. **This directory convention is now binding for all remaining phases**: Phase 6 onward ports handlers into `functions/<name>/`, never touching `lambdas/<name>/`. `lambdas/` stays live/untouched until Phase 10's cutover and Phase 11's decommission.
  - Delivered `functions/common/{__init__.py, tenant.py, azure_ai.py, cosmos_vectors.py, db.py, audit.py, audit_events.py, chunking.py, http.py, pi_aurora.py, requirements.txt}`. All 10 `.py` files pass `python3 -m py_compile`.
  - **APIM header contract (design decision, not yet verified against real APIM)**: `tenant_from_event()` now reads `x-tenant-id`/`x-user-role`/`x-user-sub`/`x-user-email` from `event["headers"]`, replacing AWS API Gateway's nested `event.requestContext.authorizer.jwt.claims`. This assumes Phase 7's APIM `validate-jwt` policy will inject individual Entra claims as headers via `<set-header>` — Phase 7 must implement this, and Phase 3a's runbook output (exact claim names) may require a small follow-up edit to the header names used here.
  - **Cosmos TTL bug fix**: DynamoDB's `ttl` is an absolute epoch timestamp; Cosmos's per-item `ttl` is a *relative* duration in seconds since last write. `audit_events.py` now writes `ttl = _TTL_DAYS * 86400`, not `time.time() + ...` — this would have silently made every audit event expire almost immediately if ported naively.
  - Auth split: `DefaultAzureCredential` for Cosmos/Foundry/OpenAI (Managed-Identity-ready for Phase 7); Postgres stays username/password (Flexible Server has no AAD admin configured), reading the existing Key Vault-sourced secret as a plain env var.
  - `db.py` came out simpler than planned: psycopg2 natively accepts the `%s`-style placeholders `pi_aurora.py` already uses, so no `:paramN` rewriting was needed (unlike the RDS Data API shim it replaces) — `pi_aurora.py` was copied over completely unchanged.
  - Confirmed `aoss.py` is dead code (only self-referencing caller of `TenantContext.opensearch_filter()`) — deleted outright, not ported; `opensearch_filter()` removed from `tenant.py` too.
  - Not done this session: no Azure CLI/credentials available, so nothing was actually run against live Cosmos/Postgres/Foundry/OpenAI — that verification is the user's action (`pip install -r functions/common/requirements.txt` then smoke-test). Next step: user can either run that verification now, or move straight into Phase 6 (port the 37 handlers into `functions/<name>/`), which doesn't strictly need Phase 5's live-verification to proceed since it's the same code-authoring/user-verifies division of labor.
- **2026-08-07 (session 5)**: Started Phase 6 with **Batch A** (17 handlers with no S3/Blob or Cognito/Graph dependency — pure Cosmos-config/vectors + AI-generation calls): `admin_archive_client`, `admin_assign_consultant`, `admin_audit_log`, `admin_create_tenant`, `admin_get_templates`, `consultant_my_clients`, `documents_list`, `documents_publish`, `mfa_reset_request`, `tenant_folder_structure`, `test_scripts_status`, `change_impact`, `sow_validate`, `analyze`, `chat`, `pi_graph`, `pi_plan`. All 17 now live under `functions/<name>/`, `lambdas/<name>/` untouched.
  - **`bedrock` → `ai` rename applied** at every call site in `analyze`, `change_impact`, `chat`, `sow_validate`, `pi_graph`, `pi_plan` (the six handlers that call the AI module), matching Phase 5's module rename. `pi_graph`/`pi_plan` needed *only* this rename plus two cosmetic log-message wording tweaks ("bedrock error" → "AI error") — both already routed all persistent state through `common.pi_aurora` (Postgres, unchanged), with zero DynamoDB/S3/Cognito calls to port.
  - **DynamoDB → Cosmos substitution patterns**: paginated table scans became `vectors.query_all(tenant_id)`; the old `doc_id-index` GSI query became `vectors.query_by_doc_id(tenant_id, doc_id)` (now sorted server-side by `chunk_index`, more efficient since it's partition-scoped); `table.get_item(Key={...})` became `vectors.get_item(tenant_id, chunk_id)`. Applied in `test_scripts_status` (job-status polling), `change_impact` and `sow_validate` (full-tenant-scan + doc-scoped-scan patterns), and `analyze` (doc-scoped chunk load, dropping an inline `import boto3` GSI query).
  - **`chat` simplification**: dropped the `from decimal import Decimal` import and Decimal→float conversion entirely — dead code under Cosmos's native floats (DynamoDB forced Decimal for numeric attributes; Cosmos does not). Citations/audit `retrieved_chunks` now read `h.get("score")` directly with no isinstance check.
  - **Prompt `.md` files copied verbatim** (no edits) from `lambdas/<name>/` into the matching `functions/<name>/`: `analyze/{prompt.md, prompt_delivery_review.md}`, `chat/{prompt.md, hr_policy_prompt.md, consultant_advisor_prompt.md}`.
  - **Per-handler `requirements.txt` gap closed**: none of the 17 new directories had one. Checked all 17 AWS-side `requirements.txt` files — all Batch A handlers need nothing beyond what `functions/common/requirements.txt` already declares (and confirmed `analyze`/`chat`'s AWS-side `requirements.txt` carry *dead* OpenSearch-era deps — `opensearch-py`, `requests-aws4auth`, pinned `boto3==1.34.100` — that must NOT be carried forward, since there is no OpenSearch in either stack and Cosmos vector search replaced it back in Phase 5). Wrote a minimal one-line comment `requirements.txt` in each of the 17 new directories instead.
  - All 17 `functions/<name>/handler.py` files pass `python3 -m py_compile` clean.
  - Batches B (S3→Blob, 8 handlers), C (cross-invoke queue-trigger rewrite, 3 handlers, overlaps Batch B), D (Cognito→Graph, 7 handlers, blocked on Phase 3a), and E (`admin_cost_summary` → Cost Management API, 1 handler) are still unstarted — see the itemized breakdown added to the Phase 6 checklist above. Next step: pick up Batch B (S3→Blob is the next unblocked, non-Phase-3a-dependent group).
- **2026-08-07 (session 6)**: Completed **Batch B** (all 8 S3→Blob handlers): `documents_delete`, `documents_download_url`, `upload_url`, `ingest`, `pi_upload`, `status_report`, `generate_tests`, `pi_parse`. All now live under `functions/<name>/`, `lambdas/<name>/` untouched.
  - **New `functions/common/queue.py`**: enqueue helper for the shared `jobs` Azure Storage Queue (provisioned in Phase 5/Task 13) — `enqueue_job(job_type: str, payload: dict)` sends `{"job_type", "payload"}` as a JSON message. This is the Azure replacement for AWS's fire-and-forget `_lambda_client.invoke(InvocationType="Event", ...)` cross-invoke pattern: since Azure has no direct function-to-function async invoke, the trigger handler enqueues a message instead, and a single queue-triggered dispatcher Function (Phase 7, not yet built) will parse `job_type` and call the matching worker module's `worker_handler(payload)`. Uses `DefaultAzureCredential`, mirrors `blob.py`'s env-var naming convention (`AZURE_STORAGE_QUEUE_URL`, `JOBS_QUEUE_NAME` default `"jobs"`). Added `azure-storage-queue>=12.9,<13` to `functions/common/requirements.txt`.
  - **`generate_tests` and `pi_parse` ported with both the Blob swap AND the Batch C queue-trigger rewrite done together**, not split across two passes — both are AWS cross-invoke workers (`handler` + `worker_handler`), and the `jobs` queue infra was already available, so doing both rewrites in one touch of each file was more efficient and avoided leaving stray `boto3`/`_lambda_client.invoke` calls sitting in an otherwise-ported Azure file. `worker_handler(event, context)` → `worker_handler(payload: dict) -> None` in both (queue-triggered functions don't receive a Lambda-style `context`). `pi_agent_lld` (the third cross-invoke handler) was deliberately left out of this batch — confirmed it has zero S3/Blob dependency, so it's pure Batch C work, picked up separately.
  - **New `vectors.put_item(item: dict)`** added to `functions/common/cosmos_vectors.py` — a raw `upsert_item` for pre-built items (auto-filling `id` from `chunk_id`), needed because `generate_tests`'s trigger handler creates a brand-new job-status record rather than updating an existing one (the existing `update_item` is read-modify-write and requires the item to already exist). Reapplied the Cosmos TTL fix (relative seconds, not absolute epoch) to this job record: `"ttl": 3600` instead of AWS's `int(time.time()) + 3600`.
  - **`_load_chunks_by_doc` DynamoDB GSI helper deleted** from `generate_tests` — replaced by direct `vectors.query_by_doc_id(tenant_id, doc_id)` calls (already sorted by `chunk_index` server-side).
  - **Multimodal message bug caught and fixed in `functions/common/azure_ai.py`**: `pi_parse`'s image/PDF parsing (`_parse_image`/`_parse_pdf`) needs to send multimodal content (text + image/document blocks) to Claude, using the same Anthropic-style block shape (`{"type": "image", "source": {"type": "base64", "media_type", "data"}}`) the AWS handler already used. But `azure_ai.py`'s `_to_inference_messages` was forwarding `content` straight into `UserMessage(content=content)`, which only works for plain strings — passing a list of Anthropic-style dicts would have silently sent garbage to the `azure-ai-inference` SDK. Fixed by adding `_to_content_items()`, which translates text/image blocks into the SDK's actual `TextContentItem`/`ImageContentItem(image_url=ImageUrl(url="data:<mime>;base64,<data>"))` types — verified the exact class/constructor shapes by installing `azure-ai-inference` into a throwaway venv and introspecting `azure.ai.inference.models` (no live Foundry credentials needed for this, just the SDK's local type definitions). Note: the SDK has no distinct "document" content item — PDFs are mapped through the same `ImageContentItem`/data-URL path as images, which is a best-effort choice that still needs verification against the live Foundry/Claude deployment once Phase 7 exists.
  - **Gap found and fixed while closing out Batch B**: `functions/common/chunking.py` (ported in Phase 5) lazily imports `pypdf`, `python-docx` (`docx`), and `openpyxl` for `ingest`'s PDF/DOCX/XLSX parsing, but `functions/common/requirements.txt` never declared them — `ingest` would have failed at runtime with `ModuleNotFoundError`. Added `pypdf`, `python-docx`, `openpyxl`, `lxml` (the last as an explicit pin for python-docx's transitive dependency, matching the AWS original's `ingest/requirements.txt`).
  - All new/modified files (`queue.py`, `cosmos_vectors.py`, `azure_ai.py`, `__init__.py`, `generate_tests/handler.py`, `pi_parse/handler.py`) and, as a full sweep, every `functions/**/handler.py` and `functions/common/*.py` pass `python3 -m py_compile` clean.
  - Batch C is now 2/3 done (`generate_tests`, `pi_parse` folded into Batch B above) — only `pi_agent_lld` remains, needing just the queue-enqueue rewrite (no Blob dependency). Batches D (Cognito→Graph, blocked on Phase 3a) and E (`admin_cost_summary`) are still unstarted. Next step: either pick up `pi_agent_lld` to fully close Batch C, or move to Batch D once Phase 3a unblocks it.
  - **Same session, continued**: ported `pi_agent_lld` (`functions/pi_agent_lld/handler.py`), closing Batch C fully (3/3). Only change from the AWS original: `_lambda_client.invoke(FunctionName=_WORKER_FUNCTION_ARN, InvocationType="Event", ...)` → `queue.enqueue_job("pi_agent_lld", worker_payload)`; `worker_handler(event, context)` → `worker_handler(payload: dict) -> None`; `bedrock.generate` → `ai.generate`. `trigger_handler`/`poll_handler` split and the LLD system prompt are unchanged. Dropped the `boto3`/`_lambda_client`/`_WORKER_FUNCTION_ARN` globals and the "worker not configured" guard, matching the pattern already used for `generate_tests`/`pi_parse`. Compiles clean. **Phase 6 is now 26/37 handlers ported** — remaining work is entirely Batch D (7 handlers, blocked on Phase 3a/Entra External ID) and Batch E (1 handler, `admin_cost_summary`). Next step: Batch E has no Phase 3a dependency, so it's the next unblocked unit of work; Batch D waits on Phase 3a's Entra app registration output.
  - **Same session, continued**: ported `admin_cost_summary` (`functions/admin_cost_summary/handler.py`), closing Batch E — this was a genuine rewrite, not a client swap: AWS's `boto3 ce.get_cost_and_usage(GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}], Metrics=["BlendedCost"], Granularity="MONTHLY")` has no like-for-like Azure client — replaced with `azure-mgmt-costmanagement`'s `CostManagementClient.query.usage(scope, QueryDefinition(...))`, scoped to `/subscriptions/{AZURE_SUBSCRIPTION_ID}/resourceGroups/{AZURE_RESOURCE_GROUP}` (new env vars — this is a single-resource-group deployment per `bicep/main.bicep`, so resource-group scope is the natural equivalent of AWS's account-wide Cost Explorer query). `QueryDefinition`/`QueryDataset`/`QueryAggregation`/`QueryGrouping`/`QueryTimePeriod` constructor shapes and the `QueryResult.columns`/`.rows` response shape were verified against the real SDK (not training-data recall) via the same throwaway-venv-introspection method used for `azure-ai-inference` earlier this session — confirmed `QueryAggregation(name="Cost", function="Sum")`, `QueryGrouping(type="Dimension", name="ServiceName")`, and that `result.rows` is a plain list of lists indexed by `result.columns[i].name`. The `_SERVICE_LABELS` map was rewritten from AWS service names (Bedrock, Lambda, DynamoDB, S3, ...) to their Azure equivalents (Azure OpenAI, Cognitive Services, Cosmos DB, Storage, PostgreSQL, Functions, API Management, ...). The AI-usage half of the handler needed no new Cosmos code — reused the existing `audit_events.query_by_action_prefix("ai.", start_iso, end_iso)` cross-partition helper (already built in Phase 5/Task 11) instead of hand-rolling a DynamoDB-scan equivalent, and `config.get_item(f"TENANT#{tid}", "METADATA")` for tenant name lookups (same pk/sk convention already used by other ported handlers). **Response shape is byte-for-byte preserved** (`total_usd`, `bedrock_usd`, `currency`, `services[]`, `ai_usage`, `data_lag_note`) since `frontend/src/components/AdminPanel.tsx` and `frontend/src/lib/api.ts` read these exact field names — `bedrock_usd` is a AWS-era field name kept as-is rather than renamed, since renaming it would be a frontend-contract break out of scope for this port. Added `azure-mgmt-costmanagement>=4.0,<5` to `functions/common/requirements.txt`; wrote the standard one-line placeholder `functions/admin_cost_summary/requirements.txt`. Compiles clean. **Phase 6 is now 27/37 handlers ported** — the only remaining work is Batch D (7 handlers, Cognito→Microsoft Graph), still blocked on Phase 3a (Entra External ID).
  - **Same session, continued**: user is setting up Phase 3a themselves, on a personal Azure account for now, with an explicit later move to an organization ("Deloitte") Azure tenant/subscription in mind — asked for the setup to be structured so it's easy to re-run against that future tenant rather than redone from memory. Audited portability of the whole Azure layer first: `bicep/main.bicep`/`bicep/parameters/main.bicepparam` were already fully subscription/tenant-agnostic (`targetScope = 'subscription'`, every identifying value — location, namePrefix, resourceGroupName, uniqueSuffix, CORS origins, Postgres admin creds via `@secure()`, model names — is an overridable param with inline "different subscription/tenant" guidance already in place from an earlier session). So the only real portability gap was Phase 3a itself, which up to now was a pure manual-portal runbook (`bicep/README.md`'s "Manual runbook — Phase 3a" section) with nothing scripted or re-runnable.
  - **New `bicep/scripts/register-entra-app.sh`**: scripts the stable, tenant-portable half of Phase 3a over Microsoft Graph v1.0 via `az rest` (not `az ad app create`, to avoid CLI-version-specific wrapper behavior) — SPA app registration (`POST /applications` with `displayName`/`signInAudience: AzureADMyOrg`/`spa.redirectUris`), its service principal (`POST /servicePrincipals`, required for sign-in to work at all — AWS Cognito has no equivalent manual step, so this was easy to miss), and the `tenant_id`/`role` custom-attribute pair as classic Azure AD `extensionProperty` objects (`POST /applications/{id}/extensionProperties`, `dataType: "String"`, `targetObjects: ["User"]`). Idempotent by design: re-running with the same `--display-name` looks up the existing app by display name and PATCHes redirect URIs instead of creating a duplicate, and skips extension-attribute creation if an attribute with that name already exists. Parameterized entirely via `--display-name`/`--redirect-uri` flags — nothing in the script is hardcoded to one tenant/subscription, so the same command re-run after `az login` into a different tenant (e.g. the future Deloitte tenant) reproduces the same app registration there. Deliberately does NOT attempt to script Entra External ID tenant creation itself, MFA/authentication-methods policy, or user-flow/self-service-signup config — these remain portal-wizard-only or have a UI surface that shifts across Entra product iterations (already flagged in the pre-existing runbook text), so they stay a manual checklist to redo by hand in any new tenant.
  - **`bicep/README.md`'s Phase 3a runbook updated**: step 3 (SPA registration) and step 4 (custom attributes) now point at the script instead of describing portal clicks, with the `az login && ./bicep/scripts/register-entra-app.sh --display-name ... --redirect-uri ...` invocation inline; step 4 also now notes that if custom attributes were instead configured through the portal's `identityGovernance`/`customAuthenticationExtensions` surface, whatever was actually configured there takes precedence over what the script produced — the exact claim name Entra emits is what matters for Phase 5's `tenant.py`, not which mechanism created it. Steps 1, 2, 5, 6 (tenant creation, product-availability confirmation, MFA policy, user-flow config, capturing the final JWT claim shape) are unchanged and remain manual.
  - No code/handler changes this entry — this is tooling/documentation only, in support of the user's own manual Phase 3a execution. Batch D and Phase 7 remain exactly where they were (Batch D blocked on the user completing Phase 3a and sharing back the Entra tenant ID/app client ID/exact claim names; Phase 7 paused pending user direction on Function App/APIM SKU decisions).
  - **Same session, continued — scope change: Phase 3a is Workforce, not External ID/CIAM.** Working through the runbook in the actual Azure portal, the user surfaced two decisions that change the identity architecture: (1) consultants are Deloitte employees who should SSO with their existing corporate identity, not get separate CIAM passwords — ruled out an External (CIAM) tenant with federation in favor of a plain single-tenant **Governed Workforce** app registration (the "Governed Workforce"/"External" choice is Microsoft's current "Manage tenants → Create" wizard naming); (2) the client-facing persona (`ClientView`/`CoachPanel`) is being spun off into a separate app entirely and will no longer log into this one — deprioritized (explicitly "least priority" per the user), tracked as a follow-up (comment out or relocate the client-facing frontend routes, the client-scoped Lambda/`functions/` handlers, and their `infra/lib/stack.ts` route wiring — not yet scoped or started, needs its own plan given it touches routing, multiple handlers, and infra wiring).
  - **Consequence for Phase 3a**: no Entra External ID tenant, no external-identity federation, no MFA/self-service-signup-disable config (Workforce tenants have no public self-signup to disable in the first place — users are provisioned directly by an admin). Confirmed every Azure subscription, including a personal one, already has a default Entra ID Workforce tenant — no tenant-creation step needed at all, now or when this moves to the Deloitte tenant later (same non-step: just point at Deloitte's existing corporate tenant). `role` still needs multiple values (`admin`/`consultant` — the user confirmed elevated-access admins are still a thing) and `tenant_id` is still needed per user (scopes a consultant to a client engagement, unrelated to whether clients themselves log in) — so the `tenant_id`/`role` extension-attribute design from `register-entra-app.sh` and the Phase 5 `tenant.py` contract are unaffected; only the tenant type and the MFA/signup-policy steps changed.
  - **`bicep/README.md`'s Phase 3a runbook rewritten** (not just tweaked) to match: dropped the old steps 1-2 (confirm CIAM product availability, create an External tenant) in favor of a single "use your existing tenant, check Entra ID → Overview for its name/ID" step; the registration script step is unchanged (it already used `signInAudience: AzureADMyOrg`, the correct single-tenant audience, so **no script changes were needed** — it was accidentally already correct for this scope); added an explicit "assign yourself/other users the `role` attribute" step now that there's no self-service signup to fall back on; replaced "configure MFA + disable self-service signup" with just "enable MFA" (the signup-disable half no longer applies to a Workforce tenant). Also updated `bicep/README.md`'s "What's deliberately NOT in this Bicep yet" bullet and this tracker's dependency-graph/Phase 1/Phase 3a headings from "Entra External ID" to "Entra ID"/"Workforce" wording, since those are forward-looking/living sections (left the pre-existing dated Log entries above this one as-is — they're a historical record of what was decided/built at the time, not something to retcon).
  - No handler/code changes this entry either — still tooling/documentation. Next step: user finishes the (now-simplified) Phase 3a runbook in the portal + `register-entra-app.sh`, shares back the tenant ID/app client ID/claim names, which unblocks Batch D. The client-persona spinoff is a separate, deliberately deprioritized piece of work to scope later.
  - **Same session, continued — optional claims are required, and were missing.** Discovered while walking the user through capturing a live JWT: Entra does **not** emit directory `extensionProperty` values on any token by default, even once a user has a value set — the app registration must explicitly declare `optionalClaims.idToken` entries naming each extension claim, or `tenant_id`/`role` are silently absent no matter what. This is a real, permanent requirement (not just a testing artifact — Phase 8's real MSAL frontend needs it too), so added a step to `bicep/scripts/register-entra-app.sh` that PATCHes `optionalClaims.idToken` with both extension names right after creating them, using the same `extension_<appId-no-dashes>_<attr>` naming the script already derives. Also added the standard `email` optional claim (not extension-based) since `preferred_username` alone isn't guaranteed to be an email-shaped value for every account type. **Access-token optional claims are a separate, still-open TODO** — the config above only covers the ID token; once Phase 7 exposes an API scope and the frontend requests access tokens against it, the same `optionalClaims.accessToken` entries need to be added, flagged in the script's own echo output so Phase 7 doesn't get surprised.
  - **Also discovered while testing: Azure AD's SPA app-registration type doesn't allow the implicit `id_token` response type by default** (`AADSTS700054`) — needed a one-off `PATCH /applications/{id}` setting `web.implicitGrantSettings.enableIdTokenIssuance: true` (this flag name is a legacy holdover; it does not require adding a "web" platform redirect URI, it just toggles implicit-flow issuance for the app overall). This was only needed to manually test via a browser redirect with no frontend built yet ([jwt.ms](https://jwt.ms) as a temporary additional SPA redirect URI, decoding the token it receives) — Phase 8's real MSAL.js auth-code+PKCE flow won't need implicit grant at all, so this flag is test-scaffolding, not a permanent app setting. Not reverted yet (harmless to leave enabled); revisit before Deloitte re-registration if a stricter security baseline wants it off.
  - **Captured the full JWT claim shape** (ID token, `v2.0` endpoint): `aud`, `iss`, `iat`, `nbf`, `exp`, `aio` (opaque, ignore), `idp`, `name`, `nonce`, `oid`, `preferred_username`, `email`, `rh` (opaque, ignore), `sid`, `sub`, `tid`, `uti` (opaque, ignore), `ver`. **Design decision this directly informs**: `tenant_from_event()`'s `x-user-sub` header must map from `oid`, not `sub` — `sub` is pairwise-per-app-registration and will silently change value the moment this gets re-registered against the Deloitte tenant (or any new client ID), corrupting anything keyed on it (assignment records, audit trail); `oid` is the actual directory object ID and is stable across re-registrations within the same tenant.
  - **Open caveat, not yet resolved**: despite `role=admin` being correctly set on the test account (confirmed via `GET /me?$select=extension_..._role` returning `"admin"`) and `optionalClaims` correctly configured (proven working — the sibling `email` optional claim *does* appear), the two `extension_5cc4858baa234916a34fdd3a028d197d_tenant_id`/`_role` claims never appeared on any issued ID token in this environment. Strong circumstantial evidence points at the test account itself: every token's `idp` claim resolves to the well-known consumer/MSA STS (`9188040d-6c67-4c5b-b112-36a304b66dad`), and `GET /me` shows `userPrincipalName: ash.manak_outlook.com#EXT#@ashmanakoutlook.onmicrosoft.com` — the `#EXT#` marker is Entra's B2B-guest naming convention, present here despite `userType: Member` (the usual shape for the personal-Microsoft-account owner of an auto-provisioned tenant). Directory-extension optional claims are known to be unreliable for identities authenticated through that consumer-federated path. **Not blocking**: the claim *name* contract (`extension_<appId-no-dashes>_tenant_id`/`_role`) is already fixed by documentation and by Entra accepting the config without error — `tenant.py`'s header-mapping code can be written against that name today. Live end-to-end confirmation with a populated value will happen naturally once this is re-registered against the Deloitte tenant with a genuine work/school account (which was always the eventual real target anyway) — re-run this same capture process there and confirm the claim actually appears before fully trusting it in production.
  - Next step: MFA (last open Phase 3a checklist item) is unblocked and independent of the above; once done, Phase 3a is functionally complete enough to unblock Batch D (`tenant.py`'s header contract already has what it needs). Re-verify the extension-claim caveat above when re-registering against Deloitte's tenant.
