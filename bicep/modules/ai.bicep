// Phase 3b — AI services
// Azure AI Foundry (Anthropic Claude, unchanged prompts) + Azure OpenAI embeddings (text-embedding-3, dims=1024).
// See locked-in decision table in docs/AZURE_MIGRATION.md.
//
// NOTE: Foundry Models from partners/community (Anthropic Claude) are Marketplace-billed and require a
// `modelProviderData` block (industry/organizationName/countryCode) on the deployment resource — this
// property only exists starting API version 2026-05-15-preview (older versions silently drop it and then
// report it as "not provided"), and `industry` must be a lowercase ModelProviderIndustry enum value
// (e.g. 'technology', not 'Technology') or the whole object is rejected the same way. The `aiFoundry`
// account also needs `allowProjectManagement: true`, and `foundryProject` needs its own
// `identity: { type: 'SystemAssigned' }` (not just the parent account's) — see docs/AZURE_MIGRATION.md Log.

@description('Azure region for AI resources — must support the exact Claude model deployed (see bicep/README.md region research)')
param location string

@description('Naming prefix for all resources (e.g. "lumina")')
param namePrefix string

@description('Globally-unique suffix — Cognitive Services customSubDomainName is globally unique across ALL Azure tenants/subscriptions, not just this one, so a bare "<namePrefix>-foundry" collides with any prior deployment anywhere (discovered via a CustomDomainInUse error on first deploy attempt)')
param uniqueSuffix string

@description('Claude model name to deploy — see docs/AZURE_MIGRATION.md Log for the quota/catalog-availability tradeoffs behind the current pick. Override this (and claudeModelVersion/claudeDeploymentCapacity) freely when repointing to a different model or subscription with different quota.')
param claudeModelName string = 'claude-haiku-4-5'

@description('Claude model version')
param claudeModelVersion string = '2'

@description('GlobalStandard quota capacity (in units) for the Claude deployment — quota varies per subscription/model/region, check Microsoft.CognitiveServices/locations/{region}/usages before changing the model')
param claudeDeploymentCapacity int = 1

@description('Azure OpenAI embedding model — must support the `dimensions` param to match EMBEDDING_DIM=1024 (ada-002 does not support it)')
param embeddingModelName string = 'text-embedding-3-large'

@description('Embedding model version')
param embeddingModelVersion string = '1'

@description('Standard quota capacity (in units) for the embedding deployment — quota varies per subscription/model/region')
param embeddingDeploymentCapacity int = 30

@description('Anthropic Marketplace buyer-profile metadata, required on first deployment of a partner/Marketplace model on this subscription (industry, legal org name, ISO country code) — not sensitive, but organization-specific: override per environment. `modelProviderIndustry` must be a lowercase ModelProviderIndustry enum value (technology, finance, healthcare, education, retail, manufacturing, government, media, other) — the ARM API silently drops the whole modelProviderData object if the casing/value does not match, then reports it as "not provided".')
param modelProviderIndustry string = 'technology'
param modelProviderOrganizationName string = 'Lumina'
param modelProviderCountryCode string = 'US'

// AI Foundry resource (Cognitive Services account, kind AIServices) hosting the Claude deployment.
resource aiFoundry 'Microsoft.CognitiveServices/accounts@2026-05-15-preview' = {
  name: '${namePrefix}-foundry-${uniqueSuffix}'
  location: location
  sku: {
    name: 'S0'
  }
  kind: 'AIServices'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: '${namePrefix}-foundry-${uniqueSuffix}'
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: false
    allowProjectManagement: true
  }
}

resource foundryProject 'Microsoft.CognitiveServices/accounts/projects@2026-05-15-preview' = {
  parent: aiFoundry
  name: '${namePrefix}-project'
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {}
}

resource claudeDeployment 'Microsoft.CognitiveServices/accounts/deployments@2026-05-15-preview' = {
  parent: aiFoundry
  name: claudeModelName
  sku: {
    name: 'GlobalStandard'
    capacity: claudeDeploymentCapacity
  }
  properties: {
    model: {
      format: 'Anthropic'
      name: claudeModelName
      version: claudeModelVersion
    }
    modelProviderData: {
      industry: modelProviderIndustry
      organizationName: modelProviderOrganizationName
      countryCode: modelProviderCountryCode
    }
  }
}

// Separate Azure OpenAI account for embeddings (kept distinct from the Foundry/Claude account so the
// two AI providers can be redeployed/rotated independently, mirroring how Bedrock kept Titan and Claude
// as separate model grants on the AWS side).
resource openAi 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: '${namePrefix}-openai-${uniqueSuffix}'
  location: location
  sku: {
    name: 'S0'
  }
  kind: 'OpenAI'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: '${namePrefix}-openai-${uniqueSuffix}'
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: false
  }
}

resource embeddingDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openAi
  name: embeddingModelName
  sku: {
    name: 'Standard'
    capacity: embeddingDeploymentCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: embeddingModelName
      version: embeddingModelVersion
    }
  }
}

output foundryEndpoint string = aiFoundry.properties.endpoint
output foundryAccountName string = aiFoundry.name
output openAiEndpoint string = openAi.properties.endpoint
output openAiAccountName string = openAi.name
