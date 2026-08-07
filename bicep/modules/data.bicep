// Phase 4 — Data stores
// Postgres Flexible Server, Cosmos DB (brute-force cosine similarity, no native vector index — locked-in
// decision), Blob Storage (CORS ported from stack.ts:42-55), Key Vault. Private endpoints into snet-pe
// for Cosmos/Storage/Key Vault; Postgres uses VNet-integrated (delegated subnet) private access instead.

@description('Azure region for all data resources')
param location string

@description('Naming prefix for all resources (e.g. "lumina")')
param namePrefix string

@description('Globally-unique suffix for resources with global name uniqueness requirements (Key Vault, Storage, Cosmos)')
param uniqueSuffix string

@description('VNet resource ID (from the networking module)')
param vnetId string

@description('Delegated subnet ID for Postgres Flexible Server VNet integration (snet-data)')
param dataSubnetId string

@description('Private endpoint subnet ID (snet-pe)')
param peSubnetId string

@description('CORS allowed origins for the docs storage container — mirrors stack.ts:42-55. Update once Phase 8 Static Web Apps domain is known.')
param corsAllowedOrigins array = [
  'http://localhost:5173'
  'http://localhost:3000'
]

@description('Postgres Flexible Server admin username')
param postgresAdminUsername string = 'platformadmin'

@secure()
@description('Postgres Flexible Server admin password — pass at deploy time, never commit a default')
param postgresAdminPassword string

// ---- Key Vault ----

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${namePrefix}-kv-${uniqueSuffix}'
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Disabled'
  }
}

resource postgresAdminSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'postgres-admin-password'
  properties: {
    value: postgresAdminPassword
  }
}

resource kvPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: '${namePrefix}-kv-pe'
  location: location
  properties: {
    subnet: {
      id: peSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${namePrefix}-kv-plsc'
        properties: {
          privateLinkServiceId: keyVault.id
          groupIds: [
            'vault'
          ]
        }
      }
    ]
  }
}

resource kvPrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'privatelink.vaultcore.azure.net'
  location: 'global'
}

resource kvPrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: kvPrivateDnsZone
  name: '${namePrefix}-kv-dns-link'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnetId
    }
    registrationEnabled: false
  }
}

resource kvPrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: kvPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'vaultcore'
        properties: {
          privateDnsZoneId: kvPrivateDnsZone.id
        }
      }
    ]
  }
}

// ---- Postgres Flexible Server ----
// Mirrors DatabaseCluster (stack.ts:71-86): Aurora Postgres 16.4 Serverless v2, min 0.5/max 1 ACU.
// Flexible Server's closest parity is Burstable B1ms/B2s tier, private-access-only via VNet integration.

resource postgresDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: '${namePrefix}-pg.private.postgres.database.azure.com'
  location: 'global'
}

resource postgresDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: postgresDnsZone
  name: '${namePrefix}-pg-dns-link'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnetId
    }
    registrationEnabled: false
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${namePrefix}-pg'
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: postgresAdminUsername
    administratorLoginPassword: postgresAdminPassword
    network: {
      delegatedSubnetResourceId: dataSubnetId
      privateDnsZoneArmResourceId: postgresDnsZone.id
    }
    storage: {
      storageSizeGB: 32
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
  dependsOn: [
    postgresDnsLink
  ]
}

// ---- Cosmos DB ----
// Mirrors VectorTable/ConfigTable/AuditTable (stack.ts:88-126). Cosmos indexes all properties by
// default, so the DynamoDB GSIs (doc_id-index, action-index) don't need an explicit equivalent —
// queries on doc_id / action are covered by the default indexing policy.

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-08-15' = {
  name: '${namePrefix}-cosmos-${uniqueSuffix}'
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    publicNetworkAccess: 'Disabled'
    capabilities: [
      {
        name: 'EnableServerless'
      }
    ]
  }
}

resource cosmosDb 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-08-15' = {
  parent: cosmos
  name: 'lumina'
  properties: {
    resource: {
      id: 'lumina'
    }
  }
}

resource vectorsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-08-15' = {
  parent: cosmosDb
  name: 'vectors'
  properties: {
    resource: {
      id: 'vectors'
      partitionKey: {
        paths: [
          '/tenant_id'
        ]
        kind: 'Hash'
      }
    }
  }
}

resource configContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-08-15' = {
  parent: cosmosDb
  name: 'config'
  properties: {
    resource: {
      id: 'config'
      partitionKey: {
        paths: [
          '/pk'
        ]
        kind: 'Hash'
      }
    }
  }
}

resource auditContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-08-15' = {
  parent: cosmosDb
  name: 'audit'
  properties: {
    resource: {
      id: 'audit'
      partitionKey: {
        paths: [
          '/tenant_id'
        ]
        kind: 'Hash'
      }
      defaultTtl: -1
    }
  }
}

resource cosmosPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: '${namePrefix}-cosmos-pe'
  location: location
  properties: {
    subnet: {
      id: peSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${namePrefix}-cosmos-plsc'
        properties: {
          privateLinkServiceId: cosmos.id
          groupIds: [
            'Sql'
          ]
        }
      }
    ]
  }
}

resource cosmosPrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'privatelink.documents.azure.com'
  location: 'global'
}

resource cosmosPrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: cosmosPrivateDnsZone
  name: '${namePrefix}-cosmos-dns-link'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnetId
    }
    registrationEnabled: false
  }
}

resource cosmosPrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: cosmosPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'documents'
        properties: {
          privateDnsZoneId: cosmosPrivateDnsZone.id
        }
      }
    ]
  }
}

// ---- Blob Storage ----
// Mirrors DocsBucket (stack.ts:35-56): CORS GET/PUT/POST/DELETE/HEAD, headers *, exposed ETag.

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: '${namePrefix}docs${uniqueSuffix}'
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    publicNetworkAccess: 'Disabled'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    isVersioningEnabled: true
    cors: {
      corsRules: [
        {
          allowedOrigins: corsAllowedOrigins
          allowedMethods: [
            'GET'
            'PUT'
            'POST'
            'DELETE'
            'HEAD'
          ]
          allowedHeaders: [
            '*'
          ]
          exposedHeaders: [
            'ETag'
          ]
          maxAgeInSeconds: 3000
        }
      ]
    }
  }
}

resource docsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'docs'
  properties: {
    publicAccess: 'None'
  }
}

// ---- Storage Queue ----
// Backs the cross-invoke/async-worker pattern (generate_tests, pi_parse,
// pi_agent_lld): the sync Function enqueues a job message instead of
// `lambda.invoke(InvocationType="Event")`, and the worker is a
// queue-triggered Function. Lives on the same storage account as the docs
// blob container — no separate resource needed for Queue vs. Blob services.

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource jobsQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'jobs'
}

resource storagePrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: '${namePrefix}-storage-pe'
  location: location
  properties: {
    subnet: {
      id: peSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${namePrefix}-storage-plsc'
        properties: {
          privateLinkServiceId: storage.id
          groupIds: [
            'blob'
            'queue'
          ]
        }
      }
    ]
  }
}

resource storagePrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  #disable-next-line no-hardcoded-env-urls
  name: 'privatelink.blob.core.windows.net'
  location: 'global'
}

resource storagePrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: storagePrivateDnsZone
  name: '${namePrefix}-storage-dns-link'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnetId
    }
    registrationEnabled: false
  }
}

resource queuePrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  #disable-next-line no-hardcoded-env-urls
  name: 'privatelink.queue.core.windows.net'
  location: 'global'
}

resource queuePrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: queuePrivateDnsZone
  name: '${namePrefix}-queue-dns-link'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnetId
    }
    registrationEnabled: false
  }
}

resource storagePrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: storagePrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob'
        properties: {
          privateDnsZoneId: storagePrivateDnsZone.id
        }
      }
      {
        name: 'queue'
        properties: {
          privateDnsZoneId: queuePrivateDnsZone.id
        }
      }
    ]
  }
}

output keyVaultName string = keyVault.name
output postgresServerName string = postgres.name
output postgresFqdn string = postgres.properties.fullyQualifiedDomainName
output cosmosAccountName string = cosmos.name
output cosmosEndpoint string = cosmos.properties.documentEndpoint
output storageAccountName string = storage.name
output storageQueueName string = jobsQueue.name

