// Phase 7 — RBAC role assignments for the Function App's Managed Identity.
//
// Deployed as its own module (not folded into compute.bicep, ai.bicep, or data.bicep) so the
// already-deployed/working ai.bicep and data.bicep modules never need a `functionAppPrincipalId`
// param threaded through them just to add a role assignment — this module takes `existing`
// references to those already-deployed resources by name instead.
//
// ⚠️ Built-in role definition GUIDs below are recalled from memory, not verified against a live
// subscription in this session (no `az` CLI/credentials available — same constraint noted
// throughout this migration's Log). Verify each with
// `az role definition list --name "<role name>" --query "[].{name:roleName,id:name}"`
// before deploying; a wrong GUID fails the specific role assignment resource but does not
// block the rest of this module or main.bicep (per the partial-failure-is-safe-to-iterate-on
// behavior confirmed in the Phase 1-4 deploy — see docs/AZURE_MIGRATION.md Log, session 3).
//
// Microsoft Graph application permissions (needed by functions/common/graph.py — Batch D) are
// NOT here: Graph app-role assignments to a Managed Identity have no ARM/Bicep resource type.
// See bicep/scripts/grant-graph-permissions.sh, run once this module deploys and
// `functionAppPrincipalId` is known.

@description('Function App Managed Identity principal ID (from compute.bicep output)')
param functionAppPrincipalId string

@description('Cosmos DB account name (from data.bicep output)')
param cosmosAccountName string

@description('Storage account name (from data.bicep output) — same account backs docs Blob, jobs Queue, and this Function App\'s own AzureWebJobsStorage')
param storageAccountName string

@description('Azure AI Foundry account name (from ai.bicep output)')
param foundryAccountName string

@description('Azure OpenAI account name (from ai.bicep output)')
param openAiAccountName string

@description('Key Vault name (from data.bicep output) — first real runtime consumer, see functions/common/keyvault.py')
param keyVaultName string

// ---- Cosmos DB: data-plane RBAC (its own system, distinct from Microsoft.Authorization) ----

resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-08-15' existing = {
  name: cosmosAccountName
}

// Built-in "Cosmos DB Built-in Data Contributor" — well-known fixed GUID, not
// subscription-specific (unlike the Microsoft.Authorization built-ins below).
var cosmosDataContributorRoleId = '00000000-0000-0000-0000-000000000002'

resource cosmosDataContributor 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-08-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, functionAppPrincipalId, 'cosmos-data-contributor')
  properties: {
    roleDefinitionId: '${cosmosAccount.id}/sqlRoleDefinitions/${cosmosDataContributorRoleId}'
    principalId: functionAppPrincipalId
    scope: cosmosAccount.id
  }
}

// ---- Storage: Blob Data Owner + Queue/Table Data Contributor ----
// "Owner" (not just Contributor) on Blob specifically because AzureWebJobsStorage's
// identity-based connection needs it for the Functions host's own bookkeeping
// (container creation, leases) — see Microsoft's identity-based-connections docs. This
// same account also serves the app-level docs Blob container and jobs Queue (blob.py,
// queue.py), which Data Owner already covers.

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

var storageBlobDataOwnerRoleId = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var storageQueueDataContributorRoleId = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
var storageTableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

resource storageBlobDataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, functionAppPrincipalId, 'blob-data-owner')
  scope: storageAccount
  properties: {
    principalId: functionAppPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataOwnerRoleId)
  }
}

resource storageQueueDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, functionAppPrincipalId, 'queue-data-contributor')
  scope: storageAccount
  properties: {
    principalId: functionAppPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageQueueDataContributorRoleId)
  }
}

resource storageTableDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, functionAppPrincipalId, 'table-data-contributor')
  scope: storageAccount
  properties: {
    principalId: functionAppPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRoleId)
  }
}

// ---- Cognitive Services: "Cognitive Services User" on both the Foundry (Claude) and
// Azure OpenAI (embeddings) accounts — functions/common/azure_ai.py authenticates to both
// via DefaultAzureCredential, not API keys. ----

resource foundryAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: foundryAccountName
}

resource openAiAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: openAiAccountName
}

var cognitiveServicesUserRoleId = 'a97b65f3-24c7-4388-baec-2e87135dc908'

resource foundryCognitiveServicesUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundryAccount.id, functionAppPrincipalId, 'cognitive-services-user')
  scope: foundryAccount
  properties: {
    principalId: functionAppPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesUserRoleId)
  }
}

resource openAiCognitiveServicesUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(openAiAccount.id, functionAppPrincipalId, 'cognitive-services-user')
  scope: openAiAccount
  properties: {
    principalId: functionAppPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesUserRoleId)
  }
}

// ---- Key Vault: Secrets Officer (read AND write) — functions/common/keyvault.py, the
// Function App is the only thing that ever writes/reads per-tenant Workday credentials
// (admin_tenant_credentials/handler.py, test_automation/handler.py's internal credential
// route). Deliberately Officer (not just User/read-only), unlike postgresAdminPassword
// which never got a grant at all since nothing writes it — a real third-party credential
// driving a live client Workday tenant is a different risk class worth this RBAC grant. ----

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

var keyVaultSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource keyVaultSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, functionAppPrincipalId, 'key-vault-secrets-officer')
  scope: keyVault
  properties: {
    principalId: functionAppPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsOfficerRoleId)
  }
}

// ---- Cost Management: resource-group-scoped reader, for admin_cost_summary ----
// Declared at this module's own deployment scope (the resource group main.bicep deploys
// this module into), matching admin_cost_summary's resource-group-scoped query.

var costManagementReaderRoleId = '72fafb9e-0641-4937-9268-a91bfd8191a3'

resource costManagementReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, functionAppPrincipalId, 'cost-management-reader')
  properties: {
    principalId: functionAppPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', costManagementReaderRoleId)
  }
}
