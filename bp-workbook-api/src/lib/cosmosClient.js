'use strict';
// Thin wrapper around @azure/cosmos for session document CRUD.
//
// Ported from the colleague's standalone app, which used its own Cosmos DB account
// (`bp-workbooks`/`sessions`, connection-string auth, partitioned by /userId, no tenant
// concept at all). Lumina is multi-tenant, so this now points at Lumina's existing Cosmos
// account (same one functions/common/cosmos_vectors.py / industry_knowledge.py use,
// COSMOS_ENDPOINT + Managed Identity, matching their exact auth pattern) and partitions
// by /tenant_id first — every read/write here takes a tenant_id and scopes to it, the same
// invariant functions/common/tenant.py enforces everywhere else in Lumina. userId is still
// recorded (who within the tenant created the session) but is no longer the partition key.
const { CosmosClient } = require('@azure/cosmos');
const { DefaultAzureCredential } = require('@azure/identity');

let _client = null;
function getClient() {
  if (!_client) {
    _client = new CosmosClient({
      endpoint: process.env.COSMOS_ENDPOINT,
      aadCredentials: new DefaultAzureCredential(),
    });
  }
  return _client;
}

const DB        = () => process.env.COSMOS_DATABASE  || 'lumina';
const CONTAINER = () => process.env.COSMOS_CONTAINER || 'bp_workbook_sessions';

// Returns the container, creating the database and container if they don't exist.
async function getContainer() {
  const { database } = await getClient().databases.createIfNotExists({ id: DB() });
  const { container } = await database.containers.createIfNotExists({
    id: CONTAINER(),
    partitionKey: { paths: ['/tenant_id'] },
    defaultTtl: -1,
  });
  return container;
}

// Persist a new session document. doc must include tenant_id (the partition key).
async function createSession(doc) {
  if (!doc.tenant_id) throw new Error('createSession: doc.tenant_id is required');
  const container = await getContainer();
  const { resource } = await container.items.create(doc);
  return resource;
}

// Update a session document (patch status, blobPath, etc.) — tenant_id required so a
// cross-tenant id guess can't patch another tenant's session.
async function updateSession(id, tenantId, patch) {
  const container = await getContainer();
  const { resource } = await container.item(id, tenantId).patch(
    Object.entries(patch).map(([path, value]) => ({ op: 'set', path: `/${path}`, value }))
  );
  return resource;
}

// List sessions for a tenant, newest first. userId is an optional additional filter
// (e.g. "my sessions only" vs. "everyone on this engagement's sessions") — omit it to
// list every session in the tenant.
async function listSessions(tenantId, userId) {
  const container = await getContainer();
  const query = userId
    ? {
        query: 'SELECT * FROM c WHERE c.tenant_id = @tenantId AND c.userId = @userId ORDER BY c.createdAt DESC',
        parameters: [{ name: '@tenantId', value: tenantId }, { name: '@userId', value: userId }],
      }
    : {
        query: 'SELECT * FROM c WHERE c.tenant_id = @tenantId ORDER BY c.createdAt DESC',
        parameters: [{ name: '@tenantId', value: tenantId }],
      };
  const { resources } = await container.items.query(query).fetchAll();
  return resources;
}

// Fetch a single session by id + tenant_id (partition key) — a session belonging to a
// different tenant simply isn't found, the same tenant-isolation shape as every other
// Lumina data access path.
async function getSession(id, tenantId) {
  const container = await getContainer();
  try {
    const { resource } = await container.item(id, tenantId).read();
    return resource;
  } catch (err) {
    if (err.code === 404) return null;
    throw err;
  }
}

module.exports = { createSession, updateSession, listSessions, getSession };
