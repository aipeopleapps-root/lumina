// Phase 1 — Azure account foundation (resource group) + module wiring for Phases 2/3b/4.
// Subscription-scope deployment: creates the resource group, then deploys networking/ai/data
// modules into it. Phase 3a (Entra External ID app registration) is NOT represented here — it
// lives in Microsoft Graph, not ARM. See README.md for that manual runbook.
//
// Deploy with (subscription-scope):
//   az deployment sub create --location <region> --template-file main.bicep \
//     --parameters parameters/main.bicepparam
//
// See README.md for full prerequisites (Claude Marketplace terms acceptance, Postgres password, etc).

targetScope = 'subscription'

@description('Azure region for all resources — see README.md for region research/constraints')
param location string = 'eastus2'

@description('Naming prefix for all resources (e.g. "lumina")')
param namePrefix string = 'lumina'

@description('Resource group name')
param resourceGroupName string = '${namePrefix}-rg'

@description('Globally-unique suffix for resources with global name uniqueness requirements (Key Vault, Storage, Cosmos)')
param uniqueSuffix string

@description('CORS allowed origins for the docs storage container — mirrors stack.ts:42-55')
param corsAllowedOrigins array = [
  'http://localhost:5173'
  'http://localhost:3000'
]

@description('Postgres Flexible Server admin username')
param postgresAdminUsername string = 'platformadmin'

@secure()
@description('Postgres Flexible Server admin password — pass at deploy time, never commit a default')
param postgresAdminPassword string

@description('Claude model name to deploy (see modules/ai.bicep for default/version/capacity)')
param claudeModelName string = 'claude-haiku-4-5'

@description('Claude model version (see modules/ai.bicep)')
param claudeModelVersion string = '2'

@description('GlobalStandard quota capacity for the Claude deployment — varies per subscription/model/region')
param claudeDeploymentCapacity int = 1

@description('Azure OpenAI embedding model name (see modules/ai.bicep for default/version/capacity)')
param embeddingModelName string = 'text-embedding-3-large'

@description('Embedding model version (see modules/ai.bicep)')
param embeddingModelVersion string = '1'

@description('Standard quota capacity for the embedding deployment — varies per subscription/model/region')
param embeddingDeploymentCapacity int = 30

@description('Anthropic Marketplace buyer-profile metadata (industry, legal org name, ISO country code) — override per organization/environment; see modules/ai.bicep')
param modelProviderIndustry string = 'Technology'
param modelProviderOrganizationName string = 'Lumina'
param modelProviderCountryCode string = 'US'

resource rg 'Microsoft.Resources/resourceGroups@2024-11-01' = {
  name: resourceGroupName
  location: location
}

module networking 'modules/networking.bicep' = {
  name: 'networking'
  scope: rg
  params: {
    location: location
    namePrefix: namePrefix
  }
}

module ai 'modules/ai.bicep' = {
  name: 'ai'
  scope: rg
  params: {
    location: location
    namePrefix: namePrefix
    uniqueSuffix: uniqueSuffix
    claudeModelName: claudeModelName
    claudeModelVersion: claudeModelVersion
    claudeDeploymentCapacity: claudeDeploymentCapacity
    embeddingModelName: embeddingModelName
    embeddingModelVersion: embeddingModelVersion
    embeddingDeploymentCapacity: embeddingDeploymentCapacity
    modelProviderIndustry: modelProviderIndustry
    modelProviderOrganizationName: modelProviderOrganizationName
    modelProviderCountryCode: modelProviderCountryCode
  }
}

module data 'modules/data.bicep' = {
  name: 'data'
  scope: rg
  params: {
    location: location
    namePrefix: namePrefix
    uniqueSuffix: uniqueSuffix
    vnetId: networking.outputs.vnetId
    dataSubnetId: networking.outputs.dataSubnetId
    peSubnetId: networking.outputs.peSubnetId
    corsAllowedOrigins: corsAllowedOrigins
    postgresAdminUsername: postgresAdminUsername
    postgresAdminPassword: postgresAdminPassword
  }
}

output resourceGroupName string = rg.name
output vnetId string = networking.outputs.vnetId
output foundryEndpoint string = ai.outputs.foundryEndpoint
output openAiEndpoint string = ai.outputs.openAiEndpoint
output postgresFqdn string = data.outputs.postgresFqdn
output cosmosEndpoint string = data.outputs.cosmosEndpoint
output storageAccountName string = data.outputs.storageAccountName
output keyVaultName string = data.outputs.keyVaultName
