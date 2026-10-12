'use strict';
// Tests for tenantContext.js — the tenant-isolation enforcement point for this app,
// ported from functions/common/tenant.py's tenant_from_event(). This is the single most
// security-critical module in this port, so it gets tests before anything else.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT || 'https://test.documents.azure.com:443/';

const { getTenantContext, assertBelongsTo, isAssigned, TenantError } = require('../src/lib/tenantContext');

function fakeRequest(headers) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (name) => map.get(name.toLowerCase()) || null } };
}

// A minimal fake Cosmos container — just enough of the .item(id, pk).read() chain
// isAssigned() calls, so the assignment-check path is testable without a real Cosmos account.
function fakeContainer({ hasAssignment }) {
  return {
    item(_id, _pk) {
      return {
        async read() {
          if (!hasAssignment) throw new Error('404 not found');
          return { resource: { id: _id } };
        },
      };
    },
  };
}

test('getTenantContext: valid consultant headers, no tenant switch', async () => {
  const req = fakeRequest({
    'x-tenant-id': 'acme-co', 'x-user-sub': 'user-1', 'x-user-role': 'consultant', 'x-user-email': 'a@b.com',
  });
  const ctx = await getTenantContext(req);
  assert.equal(ctx.tenantId, 'acme-co');
  assert.equal(ctx.userId, 'user-1');
  assert.equal(ctx.role, 'consultant');
  assert.equal(ctx.email, 'a@b.com');
});

test('getTenantContext: rejects missing tenant_id', async () => {
  const req = fakeRequest({ 'x-user-sub': 'user-1', 'x-user-role': 'consultant' });
  await assert.rejects(() => getTenantContext(req), TenantError);
});

test('getTenantContext: rejects malformed tenant_id shape', async () => {
  const req = fakeRequest({ 'x-tenant-id': 'Not Valid!', 'x-user-sub': 'user-1', 'x-user-role': 'consultant' });
  await assert.rejects(() => getTenantContext(req), TenantError);
});

test('getTenantContext: rejects missing sub claim', async () => {
  const req = fakeRequest({ 'x-tenant-id': 'acme-co', 'x-user-role': 'consultant' });
  await assert.rejects(() => getTenantContext(req), TenantError);
});

test('getTenantContext: rejects invalid role', async () => {
  const req = fakeRequest({ 'x-tenant-id': 'acme-co', 'x-user-sub': 'user-1', 'x-user-role': 'super-user' });
  await assert.rejects(() => getTenantContext(req), TenantError);
});

test('getTenantContext: rejects malformed x-client-tenant', async () => {
  const req = fakeRequest({
    'x-tenant-id': 'platform', 'x-user-sub': 'user-1', 'x-user-role': 'super_admin', 'x-client-tenant': 'BAD!',
  });
  await assert.rejects(() => getTenantContext(req), TenantError);
});

test('getTenantContext: super_admin can switch to any client tenant, no assignment check', async () => {
  // No Cosmos mocking here at all — if super_admin's path accidentally called
  // _verifyAssignment, this would hang/throw trying to reach the fake COSMOS_ENDPOINT,
  // so a clean pass is itself proof the bypass is correct.
  const req = fakeRequest({
    'x-tenant-id': 'platform', 'x-user-sub': 'admin-1', 'x-user-role': 'super_admin', 'x-client-tenant': 'yellow-bank',
  });
  const ctx = await getTenantContext(req);
  assert.equal(ctx.tenantId, 'yellow-bank');
});

test('assertBelongsTo: passes when tenant matches', () => {
  assertBelongsTo({ tenantId: 'acme-co' }, 'acme-co'); // does not throw
});

test('assertBelongsTo: throws on cross-tenant mismatch', () => {
  assert.throws(() => assertBelongsTo({ tenantId: 'acme-co' }, 'other-co'), TenantError);
});

test('isAssigned: true when an ASSIGN# record exists', async () => {
  const result = await isAssigned('user-1', 'yellow-bank', fakeContainer({ hasAssignment: true }));
  assert.equal(result, true);
});

test('isAssigned: false when no ASSIGN# record exists', async () => {
  const result = await isAssigned('user-1', 'yellow-bank', fakeContainer({ hasAssignment: false }));
  assert.equal(result, false);
});

test('isAssigned: sanitizes "#" out of the lookup id the same way cosmos_config.py does', async () => {
  let seenId = null;
  const container = {
    item(id, _pk) {
      seenId = id;
      return { async read() { throw new Error('not found'); } };
    },
  };
  await isAssigned('user-1', 'yellow-bank', container);
  assert.equal(seenId, 'CLIENT_yellow-bank');
  assert.ok(!seenId.includes('#'));
});
