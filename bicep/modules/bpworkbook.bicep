// BP Workbook Generation — its own small Node.js Function App.
//
// Ported from a colleague's complete, working standalone app (see bp-workbook-api/'s own
// file comments for what changed and why — storage/auth/LLM swapped to Lumina's existing
// resources, real tenant isolation added). Deployed as its OWN Function App rather than
// folded into the main Python one, same reasoning as execution-worker's separate Container
// App: a genuinely different runtime (Node, not Python) isn't worth rewriting ~4,600 lines
// of proven-working code just for deployable-unit consistency. Needs its own Flex
// Consumption plan — FC1 is one-Function-App-per-plan, unlike classic Premium plans, so it
// can't share compute.bicep's `lumina-plan`.
//
// RBAC role assignments live in this same file (not rbac.bicep, which is scoped to the main
// Function App's principal) — self-contained, matching this app's separate-deployable-unit
// decision end to end.

@description('Azure region')
param location string

@description('Naming prefix for all resources (e.g. "lumina")')
param namePrefix string

@description('Globally-unique suffix (Function App name must be globally unique too) — same suffix as the main stack for consistency, not a fresh one')
param uniqueSuffix string

@description('App subnet ID for regional VNet integration (snet-app, from networking.bicep) — same subnet the main Function App uses')
param appSubnetId string

@description('Storage account name (from data.bicep outputs) — reused for this app\'s own AzureWebJobsStorage AND the docs container (tenant-scoped bp-workbook paths), not a second account')
param storageAccountName string

@description('Cosmos DB endpoint (from data.bicep outputs)')
param cosmosEndpoint string

@description('Cosmos database name — matches data.bicep\'s cosmosDb resource')
param cosmosDatabase string = 'lumina'

@description('Azure AI Foundry endpoint (from ai.bicep outputs)')
param foundryEndpoint string

@description('Claude model/deployment name (from ai.bicep — GENERATION_MODEL_NAME)')
param generationModelName string

// Reuses the main stack's Log Analytics workspace (compute.bicep's '${namePrefix}-logs')
// by existing-reference-by-name rather than a new param threaded through compute.bicep's
// outputs — avoids touching that already-deployed/working file for a one-line addition.
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: '${namePrefix}-logs'
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${namePrefix}-bpworkbook-insights'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${namePrefix}-bpworkbook-plan'
  location: location
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  kind: 'functionapp'
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: '${namePrefix}-bpworkbook-${uniqueSuffix}'
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    virtualNetworkSubnetId: appSubnetId
    vnetRouteAllEnabled: true
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: 'https://${storageAccountName}.blob.${environment().suffixes.storage}/app-package-lumina-bpworkbook'
          authentication: {
            type: 'SystemAssignedIdentity'
          }
        }
      }
      runtime: {
        name: 'node'
        version: '20'
      }
      scaleAndConcurrency: {
        instanceMemoryMB: 2048
        maximumInstanceCount: 40
      }
    }
    siteConfig: {
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }

        { name: 'AzureWebJobsStorage__accountName', value: storageAccountName }
        { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }

        // Same names as functions/common/*.py's env var contract — this app shares those
        // resources, not standalone ones. See bp-workbook-api/local.settings.json.example.
        { name: 'AZURE_AI_FOUNDRY_ENDPOINT', value: foundryEndpoint }
        { name: 'GENERATION_MODEL_NAME', value: generationModelName }
        { name: 'COSMOS_ENDPOINT', value: cosmosEndpoint }
        { name: 'COSMOS_DATABASE', value: cosmosDatabase }
        { name: 'COSMOS_CONTAINER', value: 'bp_workbook_sessions' }
        { name: 'CONFIG_CONTAINER_NAME', value: 'config' }
        { name: 'AZURE_STORAGE_ACCOUNT_URL', value: 'https://${storageAccountName}.blob.${environment().suffixes.storage}' }
        { name: 'STORAGE_CONTAINER', value: 'docs' }
      ]
    }
  }
}

// RBAC role assignments for this Function App's identity live in bpworkbookRbac.bicep, a
// separate module deployed after this one (same functionAppPrincipalId-as-output-param
// pattern as compute.bicep/rbac.bicep) — see that file's own comment for why it can't be
// inlined here.

output functionAppName string = functionApp.name
output functionAppDefaultHostName string = functionApp.properties.defaultHostName
output functionAppPrincipalId string = functionApp.identity.principalId
output functionAppId string = functionApp.id
