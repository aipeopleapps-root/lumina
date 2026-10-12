// Phase 7 — Function App
// Hosts every ported handler as one Azure Function App (functions/function_app.py),
// replacing AWS's 37 separate Lambda functions (infra/lib/stack.ts's `makeFn`).
// Flex Consumption (FC1) plan with regional VNet integration into snet-app (already delegated
// to Microsoft.Web/serverFarms in networking.bicep) — every data store this app talks to
// (Cosmos/Postgres/Key Vault/Storage) is private-endpoint-only (see data.bicep).
// SKU history on this fresh Pilot subscription (see docs/AZURE_MIGRATION.md Log for the full
// trail): every *classic* App Service SKU (Y1, EP1-3, B1-3, S1-3, P1-3v2/v3) hit an identical
// "SubscriptionIsOverQuotaForSku, Total VMs: 0" wall — traced to the underlying VM-family
// vCPU quota (`az vm list-usage`) being 0 for every hardware generation these plans draw from
// on a brand-new subscription, regardless of which classic SKU tier was requested. **Flex
// Consumption draws from a completely different quota pool** (SKU family `FC`, not any
// `Microsoft.Compute` VM family) and was confirmed live in this exact subscription/region with
// zero quota friction: a real Function App (VNet-integrated into snet-app, managed-identity
// deployment-storage auth against a private/network-restricted storage account) reached
// `state: Running` with no quota error at any step. This is the real fix, not a workaround —
// Flex Consumption is Azure's current-generation Functions hosting model, not a downgrade.
//
// RBAC role assignments granting this Function App's Managed Identity access to
// Cosmos/Key Vault/Storage/Cognitive Services/Cost Management live in rbac.bicep (a separate
// module, deployed after this one) rather than here, so this file and the already-deployed
// ai.bicep/data.bicep don't need to be touched to wire a principal ID through them.
//
// Microsoft Graph application permissions (User.ReadWrite.All,
// UserAuthenticationMethod.ReadWrite.All) for Batch D's graph.py are NOT representable in
// ARM/Bicep — see bicep/scripts/grant-graph-permissions.sh, run once this module's
// `functionAppPrincipalId` output exists.

@description('Azure region')
param location string

@description('Naming prefix for all resources (e.g. "lumina")')
param namePrefix string

@description('Globally-unique suffix (Function App name must be globally unique too)')
param uniqueSuffix string

@description('App subnet ID for regional VNet integration (snet-app, from networking.bicep)')
param appSubnetId string

@description('Application Insights / Log Analytics workspace region — same as location unless overridden')
param logAnalyticsSku string = 'PerGB2018'

// ---- Env var contract (mirrors Phase 5/6 docs/AZURE_MIGRATION.md "Env var contract" notes) ----

@description('Azure AI Foundry endpoint (from ai.bicep outputs)')
param foundryEndpoint string

@description('Claude model/deployment name (from ai.bicep — GENERATION_MODEL_NAME)')
param generationModelName string

@description('Azure OpenAI endpoint (from ai.bicep outputs)')
param openAiEndpoint string

@description('Embedding model/deployment name (from ai.bicep — EMBEDDING_MODEL_NAME)')
param embeddingModelName string

@description('Embedding dimensionality — must match ai.bicep\'s embedding deployment')
param embeddingDim int = 1024

@description('Cosmos DB endpoint (from data.bicep outputs)')
param cosmosEndpoint string

@description('Cosmos database name — matches data.bicep\'s cosmosDb resource')
param cosmosDatabase string = 'lumina'

@description('Storage account name (from data.bicep outputs) — backs docs Blob, jobs Queue, AND this Function App\'s own AzureWebJobsStorage runtime storage (reused rather than provisioning a second account)')
param storageAccountName string

@description('Postgres FQDN (from data.bicep outputs)')
param postgresFqdn string

@description('Postgres database name — matches stack.ts\'s defaultDatabaseName')
param postgresDbName string = 'platform'

@description('Postgres admin username (must match data.bicep\'s postgresAdminUsername)')
param postgresAdminUsername string = 'platformadmin'

@secure()
@description('Postgres admin password — same value passed to data.bicep; injected directly as an app setting rather than a Key Vault reference (KV is private-endpoint-only, and wiring VNet-integrated KV references is unnecessary complexity for this single-Function-App, 2-tenant-demo scale — revisit if this ever needs real secret rotation)')
param postgresAdminPassword string

@description('Entra app registration client ID (dashes included) — graph.py strips them itself to derive extension_<appId>_tenant_id/_role. See Phase 3a/6 in docs/AZURE_MIGRATION.md; re-point this at the Deloitte app registration\'s client ID when that re-run happens.')
param entraAppClientId string

@description('Key Vault URI (from data.bicep outputs) — functions/common/keyvault.py, first real runtime consumer of Key Vault (see admin_tenant_credentials/handler.py). Needs the "Key Vault Secrets Officer" RBAC grant in rbac.bicep to read AND write, unlike postgresAdminPassword above which only ever needed a read nobody actually wired up.')
param keyVaultUri string

@secure()
@description('Shared secret the Workday-execution Container Apps Job authenticates internal /test-automation/internal/... calls with — no real user JWT exists for a container-to-Function call, so this replaces tenant_from_event() for that one code path. Same value is passed to execution.bicep\'s ACA Job as a job secret.')
param executionWorkerKey string

@description('Subscription ID — admin_cost_summary scopes its Cost Management query to this resource group')
param subscriptionId string = subscription().subscriptionId

@description('Resource group name — see subscriptionId param note')
param resourceGroupName string = resourceGroup().name

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-logs'
  location: location
  properties: {
    sku: {
      name: logAnalyticsSku
    }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${namePrefix}-insights'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${namePrefix}-plan'
  location: location
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  kind: 'functionapp'
  properties: {
    reserved: true // required for Linux plans
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: '${namePrefix}-func-${uniqueSuffix}'
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
          value: 'https://${storageAccountName}.blob.${environment().suffixes.storage}/app-package-lumina-func'
          authentication: {
            type: 'SystemAssignedIdentity'
          }
        }
      }
      runtime: {
        name: 'python'
        version: '3.12'
      }
      scaleAndConcurrency: {
        instanceMemoryMB: 2048
        maximumInstanceCount: 100
      }
    }
    siteConfig: {
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        { name: 'LOG_LEVEL', value: 'INFO' }

        // Identity-based AzureWebJobsStorage — reuses the same storage account as
        // docs/jobs (see storageAccountName param doc) instead of a connection string,
        // matching this migration's managed-identity-over-secrets preference everywhere
        // else (Cosmos/Foundry/OpenAI all use DefaultAzureCredential too).
        { name: 'AzureWebJobsStorage__accountName', value: storageAccountName }
        { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }

        // ---- Phase 5/6 env var contract ----
        { name: 'AZURE_AI_FOUNDRY_ENDPOINT', value: foundryEndpoint }
        { name: 'GENERATION_MODEL_NAME', value: generationModelName }
        { name: 'AZURE_OPENAI_ENDPOINT', value: openAiEndpoint }
        { name: 'AZURE_OPENAI_API_VERSION', value: '2024-06-01' }
        { name: 'EMBEDDING_MODEL_NAME', value: embeddingModelName }
        { name: 'EMBEDDING_DIM', value: string(embeddingDim) }
        { name: 'COSMOS_ENDPOINT', value: cosmosEndpoint }
        { name: 'COSMOS_DATABASE', value: cosmosDatabase }
        { name: 'VECTOR_CONTAINER_NAME', value: 'vectors' }
        { name: 'CONFIG_CONTAINER_NAME', value: 'config' }
        { name: 'AUDIT_CONTAINER_NAME', value: 'audit' }
        { name: 'INDUSTRY_KNOWLEDGE_CONTAINER_NAME', value: 'industry_knowledge' }
        { name: 'DB_HOST', value: postgresFqdn }
        { name: 'DB_NAME', value: postgresDbName }
        { name: 'DB_USER', value: postgresAdminUsername }
        { name: 'DB_PASSWORD', value: postgresAdminPassword }
        { name: 'AZURE_STORAGE_ACCOUNT_URL', value: 'https://${storageAccountName}.blob.${environment().suffixes.storage}' }
        { name: 'AZURE_STORAGE_QUEUE_URL', value: 'https://${storageAccountName}.queue.${environment().suffixes.storage}' }
        { name: 'DOCS_CONTAINER_NAME', value: 'docs' }
        { name: 'JOBS_QUEUE_NAME', value: 'jobs' }
        { name: 'EXECUTION_QUEUE_NAME', value: 'execution' }
        { name: 'KEY_VAULT_URL', value: keyVaultUri }
        { name: 'EXECUTION_WORKER_KEY', value: executionWorkerKey }

        // ---- Phase 6 addition (Batch D — Microsoft Graph) ----
        { name: 'ENTRA_APP_CLIENT_ID', value: entraAppClientId }

        // ---- admin_cost_summary (Batch E) ----
        { name: 'AZURE_SUBSCRIPTION_ID', value: subscriptionId }
        { name: 'AZURE_RESOURCE_GROUP', value: resourceGroupName }
      ]
    }
  }
}

output functionAppName string = functionApp.name
output functionAppDefaultHostName string = functionApp.properties.defaultHostName
output functionAppPrincipalId string = functionApp.identity.principalId
output functionAppId string = functionApp.id
