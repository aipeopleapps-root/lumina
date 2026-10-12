// RBAC role assignments for the BP Workbook Generation Function App's Managed Identity.
//
// A separate module from bpworkbook.bicep, same reason rbac.bicep is separate from
// compute.bicep: a role-assignment `name` (a guid()) must be resolvable at deployment
// start, and a SystemAssigned identity's principalId isn't known until that resource
// actually deploys — referencing it inline in the same file that creates the Function App
// fails to compile ("requires a value that can be calculated at the start of the
// deployment"). Takes the principal ID as a plain output-of-a-prior-module param instead.
//
// Same three roles the main Function App's identity already has and is proven working with
// live — see rbac.bicep for the identical grants on that principal, including the note on
// why Storage Blob Data Owner covers generateUserDelegationKey despite the name.

@description('BP Workbook Function App Managed Identity principal ID (from bpworkbook.bicep output)')
param functionAppPrincipalId string

@description('Cosmos DB account name (from data.bicep output)')
param cosmosAccountName string

@description('Storage account name (from data.bicep output)')
param storageAccountName string

@description('Azure AI Foundry account name (from ai.bicep output)')
param foundryAccountName string

resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-08-15' existing = {
  name: cosmosAccountName
}

var cosmosDataContributorRoleId = '00000000-0000-0000-0000-000000000002'

resource cosmosDataContributor 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-08-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, functionAppPrincipalId, 'bpworkbook-cosmos-data-contributor')
  properties: {
    roleDefinitionId: '${cosmosAccount.id}/sqlRoleDefinitions/${cosmosDataContributorRoleId}'
    principalId: functionAppPrincipalId
    scope: cosmosAccount.id
  }
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

var storageBlobDataOwnerRoleId = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'

resource storageBlobDataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, functionAppPrincipalId, 'bpworkbook-blob-data-owner')
  scope: storageAccount
  properties: {
    principalId: functionAppPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataOwnerRoleId)
  }
}

resource foundryAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: foundryAccountName
}

var cognitiveServicesUserRoleId = 'a97b65f3-24c7-4388-baec-2e87135dc908'

resource foundryCognitiveServicesUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundryAccount.id, functionAppPrincipalId, 'bpworkbook-cognitive-services-user')
  scope: foundryAccount
  properties: {
    principalId: functionAppPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesUserRoleId)
  }
}
