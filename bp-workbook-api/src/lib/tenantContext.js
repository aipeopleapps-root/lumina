'use strict';
// Tenant scoping — Node port of functions/common/tenant.py's tenant_from_event(), so this
// separately-deployed Function App enforces the exact same isolation invariant as the rest
// of Lumina rather than inventing its own. BP Workbook Generation is a 'client'-scoped app
// (see PlatformHome.tsx's APP_SCOPE), so a consultant must either already be on a client
// tenant (x-tenant-id itself is the client) or switch to one via x-client-tenant, same as
// Process Intelligence/Test Automation Suite.
//
// Identity claims arrive as headers injected by APIM's validate-jwt policy after it has
// already validated the Entra token — this code does not decode or verify the JWT itself,
// same division of responsibility as the Python side.
const { CosmosClient } = require('@azure/cosmos');
const { DefaultAzureCredential } = require('@azure/identity');

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const VALID_ROLES = new Set(['consultant', 'project_admin', 'super_admin']);

class TenantError extends Error {}

let _cosmosClient = null;
function _configContainer() {
  if (!_cosmosClient) {
    _cosmosClient = new CosmosClient({
      endpoint: process.env.COSMOS_ENDPOINT,
      aadCredentials: new DefaultAzureCredential(),
    });
  }
  const database = _cosmosClient.database(process.env.COSMOS_DATABASE || 'lumina');
  return database.container(process.env.CONFIG_CONTAINER_NAME || 'config');
}

// Same '#'-stripping sanitization as cosmos_config.py's _sanitize_id — an ASSIGN# record's
// stored id for "CLIENT#yellow-bank" is physically "CLIENT_yellow-bank" (Cosmos item ids
// forbid '/', '\', '?', '#'), so the lookup here must match that, not the raw value.
function _sanitizeId(raw) {
  return raw.replace(/[/\\?#]/g, '_');
}

// True if userId (consultant or project_admin) has an ASSIGN# record for clientTenantId.
// `container` is injectable (defaults to the real Cosmos config container) purely for
// testability — see test/tenantContext.test.js, which exercises the assignment-check path
// without needing a real Cosmos account.
async function isAssigned(userId, clientTenantId, container = _configContainer()) {
  const pk = `ASSIGN#${userId}`;
  const itemId = _sanitizeId(`CLIENT#${clientTenantId}`);
  try {
    await container.item(itemId, pk).read();
    return true;
  } catch {
    return false;
  }
}

async function _verifyAssignment(userId, clientTenantId, container) {
  if (!(await isAssigned(userId, clientTenantId, container))) {
    throw new TenantError(`caller is not assigned to client tenant '${clientTenantId}'`);
  }
}

// Extract and validate tenant context from an Azure Functions HttpRequest.
async function getTenantContext(request) {
  const h = (name) => (request.headers.get(name) || '').trim();

  const tenantId = h('x-tenant-id').toLowerCase();
  const userId = h('x-user-sub');
  const role = h('x-user-role').toLowerCase();
  const email = h('x-user-email').toLowerCase();

  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new TenantError('invalid or missing tenant_id claim');
  }
  if (!userId) {
    throw new TenantError('missing sub claim');
  }
  if (!VALID_ROLES.has(role)) {
    throw new TenantError(`invalid role claim: ${role}`);
  }

  let effectiveTenantId = tenantId;
  const target = h('x-client-tenant').toLowerCase();
  if (target) {
    if (!TENANT_ID_PATTERN.test(target)) {
      throw new TenantError('invalid x-client-tenant header value');
    }
    if (role === 'consultant' || role === 'project_admin') {
      await _verifyAssignment(userId, target);
    }
    effectiveTenantId = target;
  }

  return { tenantId: effectiveTenantId, userId, role, email };
}

// Raise if a record's tenant_id doesn't match the caller's — same cross-tenant guard as
// assert_belongs_to() on the Python side, for any read path that fetches by id alone
// (e.g. downloadSession) before trusting the result.
function assertBelongsTo(ctx, recordTenantId) {
  if (recordTenantId !== ctx.tenantId) {
    throw new TenantError('record does not belong to caller');
  }
}

module.exports = { getTenantContext, assertBelongsTo, isAssigned, TenantError, VALID_ROLES };
