using '../main.bicep'

// Default param values for the single environment (mirrors AWS side's single-stack setup).
// postgresAdminPassword is deliberately NOT set here — pass it at deploy time, e.g.:
//   az deployment sub create --location eastus2 --template-file ../main.bicep \
//     --parameters main.bicepparam --parameters postgresAdminPassword=<secret>
// uniqueSuffix is also left unset here for the same reason (pick something stable per
// environment, e.g. a short hash of the subscription ID, and pass it at deploy time).
//
// Repointing to a different subscription/environment/model: every value below is a plain
// override of a main.bicep param default — nothing here is load-bearing infrastructure.
// - Different subscription/tenant: `az account set --subscription <id>` before deploying;
//   nothing in this file is subscription-specific.
// - Different region: change `location` (must support Azure AI Foundry Anthropic Claude,
//   Azure OpenAI, Cosmos DB, and Postgres Flexible Server together — see README.md "Region").
// - Different environment naming (dev/staging/prod): change `namePrefix`/`resourceGroupName`,
//   or copy this file to e.g. `main.dev.bicepparam` and pass that instead.
// - Different Claude/embedding model: change `claudeModelName`/`claudeModelVersion`/
//   `embeddingModelName`/`embeddingModelVersion` — verify quota first with
//   `Microsoft.CognitiveServices/locations/{region}/usages` (a subscription's default quota
//   is NOT the same across models/regions; see docs/AZURE_MIGRATION.md Log for the tradeoffs
//   behind the current claude-haiku-4-5 pick) and adjust `claudeDeploymentCapacity`/
//   `embeddingDeploymentCapacity` to match what's actually available.
// - Different organization: change `modelProviderIndustry`/`modelProviderOrganizationName`/
//   `modelProviderCountryCode` (Anthropic Marketplace buyer-profile metadata, required once
//   per subscription on first partner-model deploy — not sensitive, just needs to be accurate).
//   `modelProviderIndustry` must be a lowercase ModelProviderIndustry enum value (technology,
//   finance, healthcare, education, retail, manufacturing, government, media, other).

param location = 'eastus2'
param namePrefix = 'lumina'
param resourceGroupName = 'lumina-rg'

param corsAllowedOrigins = [
  'http://localhost:5173'
  'http://localhost:3000'
]

param postgresAdminUsername = 'platformadmin'

param claudeModelName = 'claude-haiku-4-5'
param claudeModelVersion = '2'
param claudeDeploymentCapacity = 1

param embeddingModelName = 'text-embedding-3-large'
param embeddingModelVersion = '1'
param embeddingDeploymentCapacity = 30

param modelProviderIndustry = 'technology'
param modelProviderOrganizationName = 'Lumina'
param modelProviderCountryCode = 'US'
