@description('Azure region for all resources')
param location string = resourceGroup().location

@description('Base name used for all resource names')
param appName string

@description('Azure Container Registry login server (e.g. myacr.azurecr.io)')
param acrLoginServer string

@description('LLM gateway URL')
param llmGatewayUrl string

@description('LLM gateway API key (sensitive)')
@secure()
param llmGatewayApiKey string

// ── Derived names ────────────────────────────────────────────────────────────
var storageAccountName = toLower(replace('${appName}stor', '-', ''))
var acrName = replace('${appName}acr', '-', '')
var caeName = '${appName}-cae'
var caName = '${appName}-ca'

// ── Storage Account ──────────────────────────────────────────────────────────
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource inputContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'input-files'
  properties: {
    publicAccess: 'None'
  }
}

resource outputContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'output-files'
  properties: {
    publicAccess: 'None'
  }
}

// ── Container Registry ───────────────────────────────────────────────────────
resource acr 'Microsoft.ContainerRegistry/registries@2023-01-01-preview' = {
  name: acrName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

// ── Container Apps Environment ───────────────────────────────────────────────
resource cae 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: caeName
  location: location
  properties: {
    zoneRedundant: false
  }
}

// ── Container App ────────────────────────────────────────────────────────────
resource containerApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: caName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: cae.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8000
        transport: 'http'
      }
      secrets: [
        {
          name: 'llm-gateway-api-key'
          value: llmGatewayApiKey
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'req-to-test'
          image: '${acrLoginServer}/req-to-test:latest'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'LLM_GATEWAY_URL'
              value: llmGatewayUrl
            }
            {
              name: 'LLM_GATEWAY_API_KEY'
              secretRef: 'llm-gateway-api-key'
            }
            {
              name: 'LLM_MODEL'
              value: 'gpt-4o'
            }
            {
              name: 'LLM_MAX_TOKENS'
              value: '4096'
            }
            {
              name: 'LLM_TIMEOUT_SECONDS'
              value: '60'
            }
            {
              name: 'AZURE_STORAGE_ACCOUNT_URL'
              value: 'https://${storageAccountName}.blob.${environment().suffixes.storage}'
            }
            {
              name: 'AZURE_STORAGE_INPUT_CONTAINER'
              value: 'input-files'
            }
            {
              name: 'AZURE_STORAGE_OUTPUT_CONTAINER'
              value: 'output-files'
            }
            {
              name: 'USE_MANAGED_IDENTITY'
              value: 'true'
            }
            {
              name: 'APP_ENV'
              value: 'production'
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 5
      }
    }
  }
}

// ── Role Assignment: Storage Blob Data Contributor ───────────────────────────
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, containerApp.id, storageBlobDataContributorRoleId)
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: containerApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── Outputs ──────────────────────────────────────────────────────────────────
output containerAppFqdn string = containerApp.properties.configuration.ingress.fqdn
output storageAccountUrl string = 'https://${storageAccountName}.blob.${environment().suffixes.storage}'
output acrLoginServer string = acr.properties.loginServer
