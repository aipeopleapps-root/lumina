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

@description('Name of the application database on the Postgres Flexible Server — must match compute.bicep\'s postgresDbName / the DB_NAME app setting')
param postgresDbName string = 'platform'

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

// Postgres Flexible Server names are globally unique across all Azure customers (same as
// Storage/Cosmos/Key Vault), unlike this module's other "just namePrefix" resources — a bare
// 'lumina-pg' collided with an unrelated existing server on first deploy (ServerNameAlreadyExists).
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${namePrefix}-pg-${uniqueSuffix}'
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

// Application database — Flexible Server only provisions 'postgres'/'azure_maintenance'/'azure_sys'
// by default; without this the app's DB_NAME setting (postgresDbName) points at a database that
// doesn't exist. Discovered live: functions/common/db.py's connection failed with
// 'FATAL: database "platform" does not exist' until this was created out-of-band via
// `az postgres flexible-server db create` — this resource makes that step reproducible.
resource postgresAppDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: postgresDbName
}

// pgvector powers Process Intelligence's capability-ledger/pattern-library similarity search
// (migrations/003_pi_schema.sql). Azure Postgres extensions are deny-by-default — CREATE EXTENSION
// vector fails with "not allow-listed" until this server parameter explicitly enables it.
resource postgresExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgres
  name: 'azure.extensions'
  properties: {
    value: 'VECTOR'
    source: 'user-override'
  }
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

// RFP Reimagine's knowledge base — deliberately NOT partitioned by /tenant_id like `vectors`.
// This holds Deloitte's own firm knowledge (past RFP excerpts, proposal content, case studies),
// shared across every client engagement within an industry, not scoped to any one client
// tenant. Partitioned by /industry since that's RFP Reimagine's actual query shape (retrieve
// everything for "Healthcare", not everything for tenant X).
resource industryKnowledgeContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-08-15' = {
  parent: cosmosDb
  name: 'industry_knowledge'
  properties: {
    resource: {
      id: 'industry_knowledge'
      partitionKey: {
        paths: [
          '/industry'
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
    // Deliberately public-reachable, unlike Cosmos/Postgres above — the private endpoint
    // (storageBlobPrivateEndpoint below) still exists for the Function App's own in-VNet access,
    // but this account also needs to be reachable directly from the browser: both the per-tenant
    // ingest flow (upload_url/handler.py) and the admin industry-knowledge upload flow
    // (admin_industry_docs/handler.py) hand the client a SAS URL for a direct PUT, the same
    // pattern S3 presigned URLs use in the AWS original. With publicNetworkAccess Disabled that
    // PUT can never reach the account at all, from any browser, regardless of how correctly the
    // SAS is scoped — confirmed live (a correctly-signed SAS still got AuthorizationFailure).
    // Per-request authorization is still enforced by each SAS's own signature, permissions, and
    // short expiry (see blob.py's generate_upload_sas), not by network-level IP filtering —
    // allowBlobPublicAccess above stays false, so anonymous/no-SAS requests are still rejected.
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
    }
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

// Flex Consumption's deployment package container (compute.bicep's Function App reads its
// code package from here via managed identity, not a connection string — see Phase 7 SKU
// history note in compute.bicep for why this replaced the Premium v3 plan). Deliberately its
// own container, not reusing `docs`, so app-code blobs never share a namespace with
// consultant-uploaded documents.
resource deploymentPackageContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'app-package-lumina-func'
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

// Separate from 'jobs' — backs the Workday-execution engine (Container Apps
// Job, KEDA queue-scaled, NOT this Function App's own worker_handler
// dispatch). A fundamentally different consumer and a much heavier/longer
// unit of work (one live Chromium session per message) than the LLM-call
// jobs sharing 'jobs' today — see functions/common/queue.py's
// enqueue_execution() docstring.
resource executionQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'execution'
}

// 'table' added in Phase 7 (not just 'blob'/'queue'): the Function App's
// AzureWebJobsStorage — its own runtime/host bookkeeping storage, reusing
// this same account rather than provisioning a second one — is
// identity-based (see compute.bicep) and the Functions host uses Table
// Storage internally for some of that bookkeeping even though this app has
// no timer triggers of its own.
//
// Three SEPARATE private endpoints, one per sub-resource — a single private endpoint with
// groupIds: ['blob','queue','table'] looks valid in Bicep/ARM's schema but fails at deploy time
// with "OnlyOneGroupIdPermitted... Only one group Id is permitted when connecting to a
// first-party resource" (confirmed live, not a documentation read). This is the
// Microsoft-documented pattern for Storage private endpoints anyway (one per blob/queue/table/file).
resource storageBlobPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: '${namePrefix}-storage-blob-pe'
  location: location
  properties: {
    subnet: {
      id: peSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${namePrefix}-storage-blob-plsc'
        properties: {
          privateLinkServiceId: storage.id
          groupIds: [
            'blob'
          ]
        }
      }
    ]
  }
}

resource storageQueuePrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: '${namePrefix}-storage-queue-pe'
  location: location
  properties: {
    subnet: {
      id: peSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${namePrefix}-storage-queue-plsc'
        properties: {
          privateLinkServiceId: storage.id
          groupIds: [
            'queue'
          ]
        }
      }
    ]
  }
}

resource storageTablePrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: '${namePrefix}-storage-table-pe'
  location: location
  properties: {
    subnet: {
      id: peSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${namePrefix}-storage-table-plsc'
        properties: {
          privateLinkServiceId: storage.id
          groupIds: [
            'table'
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

resource tablePrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  #disable-next-line no-hardcoded-env-urls
  name: 'privatelink.table.core.windows.net'
  location: 'global'
}

resource tablePrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: tablePrivateDnsZone
  name: '${namePrefix}-table-dns-link'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnetId
    }
    registrationEnabled: false
  }
}

resource storageBlobPrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: storageBlobPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob'
        properties: {
          privateDnsZoneId: storagePrivateDnsZone.id
        }
      }
    ]
  }
}

resource storageQueuePrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: storageQueuePrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'queue'
        properties: {
          privateDnsZoneId: queuePrivateDnsZone.id
        }
      }
    ]
  }
}

resource storageTablePrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: storageTablePrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'table'
        properties: {
          privateDnsZoneId: tablePrivateDnsZone.id
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
output executionQueueName string = executionQueue.name
output keyVaultUri string = keyVault.properties.vaultUri

