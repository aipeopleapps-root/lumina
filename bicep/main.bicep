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
  // Custom domain on the Static Web App (az staticwebapp hostname list — configured directly
  // against DNS, not derivable from any bicep output the way defaultHostname below is).
  // Missing this caused a real outage: the browser's CORS preflight to APIM failed with
  // "No 'Access-Control-Allow-Origin' header" for anyone using this domain instead of the
  // raw *.azurestaticapps.net one, even though the app itself loaded fine.
  'https://lumina.aashish.fyi'
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

@description('Set false to skip the Claude model deployment (see modules/ai.bicep) when GlobalStandard quota isn\'t approved yet — lets the rest of the stack deploy instead of failing preflight validation for the whole subscription-scope deployment')
param deployClaudeModel bool = true

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

@description('Entra app registration client ID (dashes included) — see Phase 3a in docs/AZURE_MIGRATION.md. Drives graph.py\'s extension_<appId>_tenant_id/_role attribute names and APIM\'s JWT audience/claim policy. Re-point when re-registering against a different tenant (e.g. Deloitte).')
param entraAppClientId string

@description('Entra tenant ID (the Workforce tenant the app above is registered in) — see Phase 3a in docs/AZURE_MIGRATION.md')
param entraTenantId string

@description('APIM publisher email — required by Microsoft.ApiManagement/service, not otherwise surfaced anywhere at this scale')
param apimPublisherEmail string

@description('Static Web Apps SKU (see modules/swa.bicep)')
param swaSku string = 'Free'

@secure()
@description('Shared secret the Workday-execution Container Apps Job authenticates internal /test-automation/internal/... calls with — see compute.bicep and modules/execution.bicep')
param executionWorkerKey string

@description('Workday-execution container image tag to deploy (see modules/execution.bicep)')
param executionImageTag string = 'latest'

@description('Max concurrent Workday-execution Chromium sessions (see modules/execution.bicep)')
param executionMaxParallelism int = 5

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
    deployClaudeModel: deployClaudeModel
    embeddingModelName: embeddingModelName
    embeddingModelVersion: embeddingModelVersion
    embeddingDeploymentCapacity: embeddingDeploymentCapacity
    modelProviderIndustry: modelProviderIndustry
    modelProviderOrganizationName: modelProviderOrganizationName
    modelProviderCountryCode: modelProviderCountryCode
  }
}

module swa 'modules/swa.bicep' = {
  name: 'swa'
  scope: rg
  params: {
    location: location
    namePrefix: namePrefix
    sku: swaSku
  }
}

// The Static Web App's default *.azurestaticapps.net hostname is only known post-deploy,
// so it's appended here rather than living in the corsAllowedOrigins param default — this
// is the "add the production Static Web Apps origin once Phase 8 stands it up" follow-up
// data.bicep's own CORS comment already flagged back in Phase 4.
var allCorsOrigins = union(corsAllowedOrigins, ['https://${swa.outputs.defaultHostname}'])

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
    corsAllowedOrigins: allCorsOrigins
    postgresAdminUsername: postgresAdminUsername
    postgresAdminPassword: postgresAdminPassword
  }
}

module compute 'modules/compute.bicep' = {
  name: 'compute'
  scope: rg
  params: {
    location: location
    namePrefix: namePrefix
    uniqueSuffix: uniqueSuffix
    appSubnetId: networking.outputs.appSubnetId
    foundryEndpoint: ai.outputs.foundryEndpoint
    generationModelName: claudeModelName
    openAiEndpoint: ai.outputs.openAiEndpoint
    embeddingModelName: embeddingModelName
    cosmosEndpoint: data.outputs.cosmosEndpoint
    storageAccountName: data.outputs.storageAccountName
    postgresFqdn: data.outputs.postgresFqdn
    postgresAdminUsername: postgresAdminUsername
    postgresAdminPassword: postgresAdminPassword
    entraAppClientId: entraAppClientId
    keyVaultUri: data.outputs.keyVaultUri
    executionWorkerKey: executionWorkerKey
  }
}

module rbac 'modules/rbac.bicep' = {
  name: 'rbac'
  scope: rg
  params: {
    functionAppPrincipalId: compute.outputs.functionAppPrincipalId
    cosmosAccountName: data.outputs.cosmosAccountName
    storageAccountName: data.outputs.storageAccountName
    foundryAccountName: ai.outputs.foundryAccountName
    openAiAccountName: ai.outputs.openAiAccountName
    keyVaultName: data.outputs.keyVaultName
  }
}

module bpworkbook 'modules/bpworkbook.bicep' = {
  name: 'bpworkbook'
  scope: rg
  params: {
    location: location
    namePrefix: namePrefix
    uniqueSuffix: uniqueSuffix
    appSubnetId: networking.outputs.appSubnetId
    storageAccountName: data.outputs.storageAccountName
    cosmosEndpoint: data.outputs.cosmosEndpoint
    foundryEndpoint: ai.outputs.foundryEndpoint
    generationModelName: claudeModelName
  }
}

module bpworkbookRbac 'modules/bpworkbookRbac.bicep' = {
  name: 'bpworkbookRbac'
  scope: rg
  params: {
    functionAppPrincipalId: bpworkbook.outputs.functionAppPrincipalId
    cosmosAccountName: data.outputs.cosmosAccountName
    storageAccountName: data.outputs.storageAccountName
    foundryAccountName: ai.outputs.foundryAccountName
  }
}

module execution 'modules/execution.bicep' = {
  name: 'execution'
  scope: rg
  params: {
    location: location
    namePrefix: namePrefix
    uniqueSuffix: uniqueSuffix
    storageAccountName: data.outputs.storageAccountName
    executionQueueName: data.outputs.executionQueueName
    functionAppName: compute.outputs.functionAppName
    executionWorkerKey: executionWorkerKey
    containerImageTag: executionImageTag
    maxParallelism: executionMaxParallelism
  }
}

module apim 'modules/apim.bicep' = {
  name: 'apim'
  scope: rg
  params: {
    location: location
    namePrefix: namePrefix
    publisherEmail: apimPublisherEmail
    functionAppName: compute.outputs.functionAppName
    bpworkbookFunctionAppName: bpworkbook.outputs.functionAppName
    entraTenantId: entraTenantId
    entraAppClientId: entraAppClientId
    corsAllowedOrigins: allCorsOrigins
  }
}

output resourceGroupName string = rg.name
output staticWebAppName string = swa.outputs.name
output staticWebAppHostname string = swa.outputs.defaultHostname
output vnetId string = networking.outputs.vnetId
output foundryEndpoint string = ai.outputs.foundryEndpoint
output openAiEndpoint string = ai.outputs.openAiEndpoint
output postgresFqdn string = data.outputs.postgresFqdn
output cosmosEndpoint string = data.outputs.cosmosEndpoint
output storageAccountName string = data.outputs.storageAccountName
output bpworkbookFunctionAppName string = bpworkbook.outputs.functionAppName
output bpworkbookFunctionAppHostName string = bpworkbook.outputs.functionAppDefaultHostName
output keyVaultName string = data.outputs.keyVaultName
output functionAppName string = compute.outputs.functionAppName
output functionAppPrincipalId string = compute.outputs.functionAppPrincipalId
output apiGatewayUrl string = apim.outputs.gatewayUrl
output acrLoginServer string = execution.outputs.acrLoginServer
output executionJobName string = execution.outputs.executionJobName
