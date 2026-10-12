// Workday-execution engine — Playwright-driving Container Apps Job.
//
// Runs the Test Automation Suite's generated scenarios against a real
// (sandbox/preview) Workday tenant's UI. First container workload in this
// repo (no ACR/ACA/Dockerfile existed anywhere before this) — see the
// approved design: one headless Chromium session per scenario, KEDA-scaled
// off a dedicated Storage Queue (`execution`, data.bicep), triggered by
// functions/test_automation/handler.py's `_trigger_execute`.
//
// Deliberately NOT VNet-integrated. Postgres/Cosmos/Key Vault stay exactly
// as private as they are today — this container only ever talks to (a) the
// public internet (Workday's own UI), (b) this Function App's public,
// function-key-gated endpoint (functions/test_automation/handler.py's
// /test-automation/internal/... routes) to fetch work and report status, and
// (c) Blob Storage via a SAS URL, the same pattern every upload flow in this
// app already uses. This sidesteps needing a second delegated subnet
// entirely (`snet-app` is already claimed by the Function App's own Flex
// Consumption VNet integration — see networking.bicep).

@description('Azure region')
param location string

@description('Naming prefix for all resources (e.g. "lumina")')
param namePrefix string

@description('Globally-unique suffix for resources with global name uniqueness requirements')
param uniqueSuffix string

@description('Storage account name backing the execution queue (from data.bicep outputs)')
param storageAccountName string

@description('Execution queue name (from data.bicep outputs) — KEDA polls this for scale-out')
param executionQueueName string = 'execution'

@description('Function App name (from compute.bicep output) — used to look up its host key via listKeys(), same mechanism apim.bicep already uses, and to build the callback URL')
param functionAppName string

@secure()
@description('Shared secret the container sends as x-execution-key on every internal call — checked by functions/test_automation/handler.py._require_execution_key, same value as compute.bicep\'s EXECUTION_WORKER_KEY app setting.')
param executionWorkerKey string

@description('Container image tag to deploy — bumped on each build-and-push (see the Dockerfile in the same PR); "latest" for the first bring-up, pin explicitly once this has a real release process')
param containerImageTag string = 'latest'

@description('Max concurrent scenario executions (headless Chromium sessions) across the whole job — start conservative, tune once real usage is observed')
param maxParallelism int = 5

// Function host key, looked up directly rather than threaded through compute.bicep as a
// secure output — same mechanism apim.bicep already uses for the same reason (that module
// avoiding a param just for this). The container authenticates with this SAME "default" key
// every other caller (APIM) uses; the real internal-route authorization boundary is the
// x-execution-key secret checked in code (functions/test_automation/handler.py's
// _require_execution_key), not a second dedicated function key.
var functionHostKeys = listKeys(resourceId('Microsoft.Web/sites/host', functionAppName, 'default'), '2023-12-01')
var functionAppUrl = 'https://${functionAppName}.azurewebsites.net'

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: '${namePrefix}acr${uniqueSuffix}'
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    // Managed-identity-based pull only (registries[].identity below) — no admin
    // user/password, matching this migration's managed-identity-over-secrets
    // preference everywhere else (Cosmos/Foundry/OpenAI/Storage all use
    // DefaultAzureCredential too).
    adminUserEnabled: false
  }
}

// User-assigned (not system-assigned) identity — lets us pass AZURE_CLIENT_ID explicitly to
// the container so ManagedIdentityCredential(client_id=...) skips IMDS's identity-discovery
// probe entirely, one of the two remaining hypotheses (alongside SAS-based queue auth) for why
// the container appears to hang for its full replicaTimeout with zero observable progress.
resource executionIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-workday-exec-id'
  location: location
}

resource containerAppsEnv 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${namePrefix}-cae'
  location: location
  properties: {
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

resource executionJob 'Microsoft.App/jobs@2025-01-01' = {
  name: '${namePrefix}-workday-exec'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${executionIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Event'
      replicaTimeout: 1800 // 30 min ceiling per scenario execution
      replicaRetryLimit: 1
      eventTriggerConfig: {
        // One replica per execution — each execution dequeues and processes exactly one
        // scenario message (see execution-worker/runner.py), so concurrency comes from
        // scale.maxExecutions (concurrent EXECUTIONS), not parallelism (replicas WITHIN
        // one execution, which we don't use — there's nothing for a second replica in the
        // same execution to coordinate on).
        parallelism: 1
        replicaCompletionCount: 1
        scale: {
          minExecutions: 0
          maxExecutions: maxParallelism
          pollingInterval: 30
          rules: [
            {
              name: 'execution-queue-scale'
              type: 'azure-queue'
              metadata: {
                queueName: executionQueueName
                accountName: storageAccountName
                queueLength: '1'
              }
              identity: executionIdentity.id
            }
          ]
        }
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: executionIdentity.id
        }
      ]
      secrets: [
        {
          name: 'execution-worker-key'
          value: executionWorkerKey
        }
        {
          name: 'execution-worker-function-key'
          value: functionHostKeys.functionKeys.default
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'workday-executor'
          image: '${acr.properties.loginServer}/workday-executor:${containerImageTag}'
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: [
            { name: 'FUNCTION_APP_URL', value: functionAppUrl }
            { name: 'EXECUTION_WORKER_KEY', secretRef: 'execution-worker-key' }
            { name: 'EXECUTION_WORKER_FUNCTION_KEY', secretRef: 'execution-worker-function-key' }
            // Runner dequeues+deletes its own message via this user-assigned identity — see
            // execution-worker/runner.py (ManagedIdentityCredential(client_id=...)) and the
            // queueDataMessageProcessor role assignment below. Passing the client ID explicitly
            // (rather than relying on the container's sole assigned identity implicitly, as
            // system-assigned did) lets the SDK skip IMDS's identity-discovery probe.
            { name: 'AZURE_CLIENT_ID', value: executionIdentity.properties.clientId }
            { name: 'AZURE_STORAGE_QUEUE_URL', value: 'https://${storageAccountName}.queue.${environment().suffixes.storage}' }
            { name: 'EXECUTION_QUEUE_NAME', value: executionQueueName }
          ]
        }
      ]
    }
  }
}

// ---- RBAC: ACR pull (image) + Storage Queue read (KEDA polling the execution queue's length) ----
// Neither Postgres, Cosmos, nor Key Vault are granted here — the job's identity has no
// business touching any of them, see module docstring.

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, executionIdentity.id, 'acr-pull')
  scope: acr
  properties: {
    principalId: executionIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
  }
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

// Needs BOTH roles, confirmed live (an initial deploy with only Message Processor left every
// scenario message sitting in the queue with dequeueCount=0 forever — KEDA's own scale-trigger
// polling never fired a single execution):
//   - "Reader" — KEDA's queue-length scale-trigger polling needs queue-level metadata read
//     (approximate message count) to decide whether to scale out at all; Message Processor's
//     message-level get/peek/delete permissions don't cover that queue-level read.
//   - "Message Processor" — the runner's own code inside the running container (see
//     execution-worker/runner.py) needs get+delete on its one message once an execution starts.
var storageQueueDataReaderRoleId = '19e7f393-937e-4f77-808e-94535e297925'
var storageQueueDataMessageProcessorRoleId = '8a0f0c08-91a1-4084-bc3d-661d67233fed'

resource queueDataReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, executionIdentity.id, 'queue-data-reader')
  scope: storageAccount
  properties: {
    principalId: executionIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageQueueDataReaderRoleId)
  }
}

resource queueDataMessageProcessor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, executionIdentity.id, 'queue-data-message-processor')
  scope: storageAccount
  properties: {
    principalId: executionIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageQueueDataMessageProcessorRoleId)
  }
}

output acrLoginServer string = acr.properties.loginServer
output acrName string = acr.name
output containerAppsEnvName string = containerAppsEnv.name
output executionJobName string = executionJob.name
output executionJobPrincipalId string = executionIdentity.properties.principalId
