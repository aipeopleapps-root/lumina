# Azure Bicep — Lumina migration IaC

This directory holds the Bicep IaC for Phases 1, 2, 3b, and 4 of the AWS→Azure migration tracked in
`../docs/AZURE_MIGRATION.md`. **Division of labor for this repo: Bicep is authored here; a human with
Azure CLI/portal access runs the actual deployment.** Nothing in this directory has been deployed to a
live subscription — treat every resource definition as unverified against the real ARM API until you've
run a deployment and fixed whatever surfaces.

```
bicep/
  main.bicep                    # subscription-scope: creates the resource group, wires up modules
  modules/
    networking.bicep            # VNet, 3 subnets (app/data/private-endpoint), NSGs, NAT Gateway
    ai.bicep                    # Azure AI Foundry (Claude) + Azure OpenAI (embeddings)
    data.bicep                  # Postgres Flexible Server, Cosmos DB, Blob Storage, Key Vault
  parameters/
    main.bicepparam             # default param values (region, naming prefix, CORS origins)
  README.md                    # this file
```

## Prerequisites (one-time, manual, before first deploy)

1. **Azure subscription** confirmed and a billing owner identified. (Phase 1 checklist item — not
   automatable from here.)
2. **Bicep CLI** and **Azure CLI** installed on the machine that will deploy:
   ```bash
   az bicep install     # or use the standalone bicep CLI this session validated with:
                         # curl -Lo bicep https://github.com/Azure/bicep/releases/latest/download/bicep-<platform>
   az login
   az account set --subscription <subscription-id>
   ```
3. **Claude Marketplace terms acceptance (one-time per subscription).** `modules/ai.bicep`'s
   `claudeDeployment` resource deploys an Anthropic Claude model via "Foundry Models from partners and
   community," which is Marketplace-billed (not directly sold like Azure OpenAI). Before that resource
   will succeed on a clean subscription, accept Anthropic's Marketplace offer terms once, either:
   - Azure Portal → Azure AI Foundry → Model catalog → the Claude model card → "Deploy" → accept terms
     the first time (this creates the underlying Marketplace agreement), or
   - the SaaS-offer equivalent of `az vm image terms accept` (exact command depends on current Azure CLI
     Marketplace extension — verify against the portal flow if the CLI path errors, this surface changes).
   Do this before running `az deployment sub create` against `ai.bicep`, or the deployment will fail on
   the `claudeDeployment` resource specifically (the rest of the template is unaffected).
4. **Postgres admin password** — pick one, do not commit it. Pass it at deploy time (see below).
5. **Unique suffix** — pick a short, stable string for globally-unique resource names (Key Vault, Storage,
   Cosmos DB). A short hash of the subscription ID or an environment tag works. Pass it at deploy time.

## Region

Default region in `parameters/main.bicepparam` is **`eastus2`**.

Rationale (point-in-time research, done 2026-08-04 — **re-verify before deploying**, Azure region
rollout for new models changes frequently): East US 2 was, at research time, the region supporting all
four of: Azure AI Foundry Anthropic Claude models (including the exact version needed to match the AWS
side's pinned `us.anthropic.claude-sonnet-4-5-20250929-v1:0`), Azure OpenAI `text-embedding-3-large`,
Cosmos DB, and Postgres Flexible Server — all in one region, avoiding cross-region latency/egress between
the app tier and its dependencies. It's also a reasonable analog to the AWS side's `us-east-1` choice
(`infra/bin/app.ts:8-13`).

Before deploying, re-check current availability at:
- Azure AI Foundry model region availability: https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/concepts/models-from-partners?tabs=anthropic
- Azure OpenAI model region availability: https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/concepts/models-sold-directly-by-azure
- Cosmos DB region list: https://azure.microsoft.com/en-us/explore/global-infrastructure/products-by-region/
- Postgres Flexible Server region list: same product-by-region page as above

If the exact Claude model version has moved regions, update `claudeModelName`/`claudeModelVersion` in
`modules/ai.bicep` (or override via param) and re-run `bicep build` to confirm the template still compiles.

## Deploying

**Use `bicep/scripts/deploy.sh`** — this is the tested, working path as of the Phase 7 live
-deploy session:
```bash
cd bicep
./scripts/deploy.sh --env pilot            # prompts for the Postgres admin password
./scripts/deploy.sh --env pilot --what-if  # preview without applying
```
`--env` picks one of `parameters/*.bicepparam` (`pilot.bicepparam` today — see below for the
eventual `deloitte.bicepparam`). The script sanity-checks that your `az` session is pointed at the
subscription the environment file expects (via a `SUBSCRIPTION_ID:` comment in the file) before
doing anything, and never lets the Postgres password touch a committed file or the shell history —
see the script's own header comment for exactly how.

**Per-environment `.bicepparam` files, not one shared template + a pile of CLI flags.** Each
environment (`pilot.bicepparam`, and eventually `deloitte.bicepparam`) is a fully-resolved,
committed file with that environment's real `uniqueSuffix`/`entraAppClientId`/`entraTenantId`/
`apimPublisherEmail` already filled in — copy `parameters/deloitte.bicepparam.example` to
`deloitte.bicepparam` and fill in four values when that migration happens, then
`./scripts/deploy.sh --env deloitte`. `postgresAdminPassword` is the one value never committed to
any of these files — `deploy.sh` prompts for it (or reads `POSTGRES_ADMIN_PASSWORD` from the
environment, for non-interactive use e.g. from Phase 9 CI).

`parameters/main.bicepparam` is the older generic template these were cloned from — still useful
as a reference for what every param means, but **do not deploy directly from it**: `az deployment
sub create --parameters main.bicepparam --parameters key=value` (supplementing a partial
`.bicepparam` file with CLI overrides) does not work with the currently-installed Bicep CLI
(v0.46.1) — it throws `BCP258` regardless of whether the missing params are supplied via
`--parameters` flags afterward. This was the previously-documented pattern in this file, and
appears to have never actually been exercised end-to-end before the Phase 7 live-deploy session
surfaced the failure (see `docs/AZURE_MIGRATION.md` Log). `deploy.sh` works around this by writing
a short-lived, gitignored, fully-resolved copy of the chosen environment file (with the password
appended) right before deploying, then deleting it immediately after.

### Deploying the frontend (Phase 8)

The deploy above provisions the Static Web App resource (output `staticWebAppHostname`) but does
not build or push the frontend into it — see `modules/swa.bicep`'s docstring and this file's
"What's deliberately NOT in this Bicep yet" section for why. Until Phase 9 sets up real CI:
```bash
cd ../frontend
# .env.local: VITE_API_ENDPOINT=<apiGatewayUrl output>, VITE_AZURE_TENANT_ID=<entraTenantId>,
# VITE_AZURE_CLIENT_ID=<entraAppClientId>, VITE_AZURE_API_SCOPE=api://<entraAppClientId>/access_as_user
npm run build
npx @azure/static-web-apps-cli deploy ./dist --deployment-token <token>
# token: az staticwebapp secrets list --name lumina-swa --query properties.apiKey -o tsv
```

### Local validation (no Azure account needed)

```bash
bicep build main.bicep --outfile /tmp/main.json   # transitively compiles all modules
bicep lint main.bicep
```

As of the Phase 8 session, both commands run clean except for two expected, non-blocking warnings
(re-verified with `az bicep build`/`az bicep lint` — the first session with `az`/Bicep CLI actually
available; earlier "As of this session" notes in this file predate that and described different,
now-stale warnings from before the `ai.bicep` API version bump documented in
`../docs/AZURE_MIGRATION.md`'s Log):
- `BCP037` on `modules/ai.bicep`'s `claudeDeployment` resource — `modelProviderData` is a real,
  required property on the live ARM API (see that Log entry for the full story) that Bicep's
  bundled type definitions don't know about yet. Does not block deployment.
- `use-recognized-resource-type` on `modules/apim.bicep`'s `listKeys(...)` call against
  `Microsoft.Web/sites/host` — this resource type is real (it's how you fetch a Function App's
  host keys) and the API version *is* specified as the function's second argument; the linter's
  local type-suggestion index just doesn't have it indexed. Does not block deployment.

(Also fixed, prior to Phase 7, and no longer relevant to re-verify each time: an initial
`isVersioningEnabled` placement bug — moved from `storageAccounts` to `storageAccounts/blobServices`,
where ARM actually accepts it — and a suppressed `no-hardcoded-env-urls` warning on the
`privatelink.blob.core.windows.net` private DNS zone name, which is the correct/required value for
Azure Private Link, not a portability bug. `apim.bicep` suppresses the same lint rule once more, on
`login.microsoftonline.com`, for the same reason.)

## What's deliberately NOT in this Bicep yet

- **Phase 3a (Entra ID identity)** — app registration and the `tenant_id`/`role` custom attributes live
  in Microsoft Graph / the Entra admin center, not ARM. There's no `Microsoft.AzureActiveDirectory/*`
  Bicep resource type for this kind of config. Runbook below.
- **Phase 7's Microsoft Graph app-role assignments** — granting the Function App's Managed Identity
  `User.ReadWrite.All`/`UserAuthenticationMethod.ReadWrite.All` (needed by
  `functions/common/graph.py`, Batch D) has no ARM/Bicep resource type either, same reason as Phase 3a
  above. Runbook below (`grant-graph-permissions.sh`).
- **Static Web Apps git integration / CI deploy** — `modules/swa.bicep` creates the hosting
  resource itself, but deliberately without `repositoryUrl`/`branch`/`repositoryToken` params
  (see that file's docstring: embedding a GitHub PAT in Bicep is a real secret-handling decision
  that belongs to Phase 9 — "GitHub Actions Azure OIDC" — not this phase). Until Phase 9 lands,
  deploy the frontend build with the Static Web Apps CLI (`npx @azure/static-web-apps-cli deploy`)
  using this resource's deployment token, or connect GitHub through the Portal's one-click flow.
- **Phase 9+ (CI/CD, data migration)** — these need a live, fully-deployed API endpoint and Entra
  client config to exercise. Out of scope for this Bicep; see `../docs/AZURE_MIGRATION.md` for the
  full phase plan. (Phases 5-8 — application code, the Function App, APIM, and Static Web Apps
  hosting — are now represented here as of the Phase 8 session; this bullet used to say "Phase 5+"
  before that work landed.)

## Manual runbook — Phase 1 remaining items

1. Confirm the Azure subscription to use and who owns billing for it (not automatable — organizational
   decision).
2. Decide single resource group vs per-environment split. This Bicep defaults to **one resource group**
   (`lumina-rg`), matching the AWS side's single-stack/single-env setup. If you want `lumina-dev-rg` /
   `lumina-prod-rg` later, parameterize `resourceGroupName` per deployment — the template already takes
   it as a param, so this is just a matter of running the deploy twice with different param files.
3. Re-confirm region availability (see "Region" section above) before the first real deploy.

## Manual runbook — Phase 3a (Entra ID)

**Scope changed from an earlier version of this runbook**: Lumina is now consultant/admin-only —
Deloitte (or, for now, your own) employees signing in with their existing corporate accounts. The
client-facing persona (`ClientView`/`CoachPanel`) is being spun off into a separate app and no
longer needs its own login, so there's no need for an Entra External ID (CIAM) tenant, external
identity federation, or invite-only self-service-signup config. This is a plain single-tenant
**Governed Workforce** app registration — the same kind of setup as any internal line-of-business app.

Do this after Phase 1's subscription is confirmed, independent of the Bicep deploys above (Phase 3a has
no ARM dependency on Phases 2/3b/4, per the dependency graph in the tracker).

1. **Use your existing tenant — don't create a new one.** Every Azure subscription (including a
   personal/individual one) already has a default Microsoft Entra ID (Workforce) tenant. Check Azure
   Portal → Microsoft Entra ID → Overview to find its tenant name (`<name>.onmicrosoft.com`) and
   tenant ID; note both down. Skip "Manage tenants → Create" entirely — that flow is for standing up
   an *additional* tenant, which isn't needed here. When this moves to the Deloitte Azure platform
   later, the equivalent step is simply: use Deloitte's existing corporate tenant instead of your
   personal one (nothing to "create" there either — it already exists).
2. **Register the app, and create its `tenant_id`/`role` extension attributes, via script.**
   `bicep/scripts/register-entra-app.sh` does both over Microsoft Graph v1.0 (`az rest`), and is
   already written for single-tenant (`signInAudience: AzureADMyOrg`) sign-in — the correct audience
   for a Workforce app. Safe to re-run (updates redirect URIs / skips existing attributes instead of
   duplicating), which is what makes it portable to the Deloitte tenant later: `az login` into that
   tenant and re-run the same command.
   ```bash
   az login   # into the target Entra tenant (your own now, Deloitte's later)
   ./bicep/scripts/register-entra-app.sh \
     --display-name lumina-app \
     --redirect-uri http://localhost:5173
     # add another --redirect-uri once Phase 8 stands up Azure Static Web Apps
   ```
   The script prints the app's object ID, client ID, and the extension-attribute names it created
   (or found already present) — record those in this tracker/`docs/AZURE_MIGRATION.md`'s Log.
3. **Assign yourself (and any other early users) the `role` attribute.** Since everyone is now an
   employee added directly to the directory (no self-service signup to disable), user provisioning
   is just: Entra admin center → Users → Invite/New user (or, for your own tenant, you're likely
   already the only user) → set the `role` extension attribute created above to `admin` for yourself,
   and `consultant` for anyone else you add. `tenant_id` still matters per user — it's what scopes a
   consultant's access to a given client engagement (see `lambdas/common/tenant.py`'s existing
   `x-client-tenant` header/assignment-check logic, which Phase 5 already ported to Cosmos) — set it
   per user as appropriate, or leave unset for admins who aren't scoped to a single client.
4. **Confirm the extension-attribute claim names Entra actually emits.** The script creates
   `tenant_id`/`role` as classic Azure AD `extensionProperty` objects (stable Graph v1.0 API), and
   also (as of this session) PATCHes `optionalClaims.idToken` so they actually get emitted — **a
   directory extension value is never included on any token unless the app explicitly opts in via
   `optionalClaims`, even after the user has a value set.** They appear in the ID token as
   `extension_<appid-no-dashes>_tenant_id` / `_role` — **write down the exact claim name**, Phase 5's
   `functions/common/tenant.py` needs this exact string, not an approximation. As of the Phase 7
   session, the script configures this on **both** the ID token and the access token (Phase 7
   added an "Expose an API" step — `api://<client-id>/access_as_user` — since APIM's `validate-jwt`
   policy, `bicep/modules/apim.bicep`, validates whatever token the frontend sends it, which per
   standard MSAL usage against a backend API will be an access token scoped to that API, not the ID
   token this step 6 smoke-tests directly).
5. **Enable MFA**, as a baseline security measure (there's no self-service-signup to disable in a
   Workforce tenant — users are provisioned directly by an admin, so that half of the old runbook no
   longer applies): Entra admin center → Security → Authentication methods → enable TOTP
   (Authenticator app / OTP) for the app's users.
6. **Capture the JWT claim shape verbatim.** No frontend exists yet to sign in through, so test with
   a manual browser flow instead: temporarily add `https://jwt.ms` (Microsoft's own token decoder,
   safe to use as a redirect target) to the app's SPA redirect URIs, then navigate to
   `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/authorize?client_id=<client-id>&response_type=id_token&redirect_uri=https%3A%2F%2Fjwt.ms&scope=openid%20profile&response_mode=fragment&nonce=<any-value>&prompt=login`
   and sign in — jwt.ms decodes the returned token automatically. Two gotchas hit while doing this:
   SPA app registrations reject `response_type=id_token` by default (`AADSTS700054`) until
   `web.implicitGrantSettings.enableIdTokenIssuance: true` is PATCHed onto the app (doesn't require a
   "web" redirect URI, just toggles implicit-flow issuance); and Entra's SSO session will silently
   replay a cached token if you just reload the same tab, so use `prompt=login` plus a fresh
   `nonce` each time you need a genuinely new token. Save the full claim list somewhere durable
   (this tracker's Log section) — Phase 5 depends on this exact shape. **Known caveat from the first
   run of this against a personal/MSA-backed account**: the `extension_...` claims may not appear
   even when correctly configured, if the signed-in account is guest/MSA-federated (check the token's
   `idp` claim and `GET /me`'s `userPrincipalName` for a `#EXT#` marker) — re-verify this step against
   a genuine work/school account (e.g. once on the Deloitte tenant) before trusting it fully.

Once this runbook is done and the Bicep above is deployed, share back: the Entra tenant ID, app client
ID, redirect URIs, the exact custom-claim names, and the resource outputs from `main.bicep` (Foundry/
OpenAI endpoints, Postgres FQDN, Cosmos endpoint, Storage account name, Key Vault name) — that unblocks
Phase 5 (porting `lambdas/common/`).

## Manual runbook — Phase 7 (Microsoft Graph app-role assignments)

Everything else in Phase 7 (Function App, RBAC role assignments, APIM) deploys via the
`compute`/`rbac`/`apim` modules in the main `az deployment sub create` command above — this is the
one Phase 7 step that, like Phase 3a, has no ARM/Bicep resource type and must be run separately
against Microsoft Graph.

1. **Deploy the Bicep first.** `functions/common/graph.py` (Batch D) needs the Function App's
   Managed Identity to already exist before it can be granted anything, and that identity is only
   created once `compute.bicep` deploys — this step comes *after* the main deploy, not before or
   alongside it (unlike Phase 3a, which has no ARM dependency and can run any time after Phase 1).
2. **Grant the Graph app roles.** Get the Managed Identity's principal ID from the deploy output
   (`functionAppPrincipalId`), then:
   ```bash
   az login   # Application Administrator or Global Administrator in the target tenant
   ./bicep/scripts/grant-graph-permissions.sh --principal-id <functionAppPrincipalId>
   ```
   Grants `User.ReadWrite.All` and `UserAuthenticationMethod.ReadWrite.All` (both resolved by name
   against Microsoft Graph's own service principal, not a hardcoded GUID — see the script's own
   comments). Safe to re-run; already-granted roles are skipped.
3. **Verify the Entra app registration exposes an API scope with access-token optional claims.**
   If Phase 3a's `register-entra-app.sh` was run *before* the Phase 7 session's update to that
   script, re-run it once (same `--display-name`/`--redirect-uri` flags as before — it's
   idempotent) so the app registration gets the `api://<client-id>/access_as_user` scope and
   `optionalClaims.accessToken` entries `apim.bicep`'s `validate-jwt` policy depends on. If Phase 3a
   was run for the first time during or after the Phase 7 session, this is already covered — nothing
   to redo.
4. **Smoke-test a route through APIM** once Phase 7's deploy and the two steps above are done —
   see the Verification section of the original planning conversation, or hit any GET route (e.g.
   `/admin/list-tenants`) with a real access token via `curl` and confirm a 200/403 (not a 401 from
   APIM itself, which would mean JWT validation or the claim names are still wrong) — this is real
   end-to-end verification that requires a live tenant and Azure credentials, which this session
   doesn't have; it's the next thing to run once you do.

Not yet decided in Phase 7 and left for whoever picks this up next: `functions/bootstrap`'s trigger
mechanism (see that handler's own docstring — currently a manually/CI-triggered `POST
/admin/bootstrap` admin action, not wired to anything automatic on deploy the way AWS's
CloudFormation Custom Resource was).
