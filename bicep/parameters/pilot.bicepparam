using '../main.bicep'

// SUBSCRIPTION_ID: 35fd0ace-9efc-4aa6-9319-c46373abcfe1
// (Not a Bicep param — subscription-scope deployments select the subscription via
// `az account set`/`az deployment sub create --subscription`, outside the template entirely.
// Recorded here as a comment so bicep/scripts/deploy.sh can sanity-check "am I pointed at the
// right subscription for this environment file" before deploying, and so a human re-reading
// this file later has the value without needing to dig through the tracker Log.)
//
// Pilot Subscription environment — fully resolved, real values for the live pilot deploy.
// Unlike main.bicep's generic template (main.bicepparam), this file is meant to be committed
// as-is and reused: `az deployment sub create --parameters pilot.bicepparam --parameters
// postgresAdminPassword=<secret>` is the whole command, no other flags to remember or retype.
// postgresAdminPassword is the one value NOT here (secret) — see bicep/scripts/deploy.sh, which
// prompts for it interactively instead of taking it as a flag that could end up in shell history.
//
// Migrating to a new environment (e.g. the eventual move to Deloitte's tenant/subscription)?
// Copy this file to deloitte.bicepparam and update exactly four values: uniqueSuffix (pick a
// new short unique string), entraAppClientId/entraTenantId (from re-running
// bicep/scripts/register-entra-app.sh against the Deloitte tenant), and apimPublisherEmail.
// Everything else — region, model choices, CORS origins, resource naming — carries over
// unchanged unless there's a specific reason to diverge. See
// bicep/parameters/deloitte.bicepparam.example for a blank starting point.

param location = 'eastus2'
param namePrefix = 'lumina'
param resourceGroupName = 'lumina-rg'

// 'https://lumina.aashish.fyi' (the Static Web App custom domain, added session 15) was
// missing here even after the domain itself was live — the app worked "well enough" to not
// notice immediately, since every GET call site that feeds Platform Home swallows fetch
// failures silently (catches into an empty default), but any POST without that swallow
// (e.g. AdminPanel's Apps-tab save) surfaced it as a raw "Failed to fetch" CORS error.
param corsAllowedOrigins = [
  'http://localhost:5173'
  'http://localhost:3000'
  'https://lumina.aashish.fyi'
]

param postgresAdminUsername = 'platformadmin'

param claudeModelName = 'claude-haiku-4-5'
param claudeModelVersion = '2'
// Bumped 1 -> 10 -> 80 (2026-08-10): capacity=1 maps to a 1 request/min, 1000
// token/min rate limit — far too tight for any real interactive usage (Ask
// Stuey's chat, Process Intelligence's multi-call parse pipeline). 80 is the
// full GlobalStandard quota available for this model in this region/subscription
// (confirmed live via `az cognitiveservices usage list`) — nothing else on this
// subscription draws from the same pool, so there's no reason to leave headroom
// unused. Lower this if a second consumer of the same model/region quota shows
// up and the two need to share it.
param claudeDeploymentCapacity = 80
// Quota was approved and the deployment created live (2026-08-10) directly via `az rest` PUT
// against Microsoft.CognitiveServices/accounts/deployments (the CLI's `az cognitiveservices
// account deployment create` doesn't support the modelProviderData body this API version
// requires) — flipped back to true so a future `cdk`/Bicep redeploy reproduces it instead of
// silently reverting to no deployment (which is what caused pi_parse to fail with a raw 404
// from the missing model, surfaced verbatim to users as parse_error).
param deployClaudeModel = true

param embeddingModelName = 'text-embedding-3-large'
param embeddingModelVersion = '1'
param embeddingDeploymentCapacity = 30

param modelProviderIndustry = 'technology'
param modelProviderOrganizationName = 'Lumina'
param modelProviderCountryCode = 'US'

// Globally-unique suffix actually used for this environment's resources
// (lumina-cosmos-ogb5kyod, luminadocsogb5kyod, etc.) — picked once on first deploy, must stay
// identical on every subsequent deploy to this environment or Bicep will try to create
// duplicate resources instead of updating the existing ones.
param uniqueSuffix = 'ogb5kyod'

// Entra Workforce tenant + app registration — see Phase 3a in docs/AZURE_MIGRATION.md for how
// these were produced (bicep/scripts/register-entra-app.sh). Personal/pilot tenant for now;
// re-point these two when re-registering against Deloitte's tenant later.
param entraAppClientId = '5cc4858b-aa23-4916-a34f-dd3a028d197d'
param entraTenantId = '9eb4680c-8bfd-4a8e-ab9a-2ac841f47d25'

param apimPublisherEmail = 'aashish.manaktala@gmail.com'

param swaSku = 'Free'
