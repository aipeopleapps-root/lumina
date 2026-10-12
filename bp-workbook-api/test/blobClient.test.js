'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AZURE_STORAGE_ACCOUNT_URL = process.env.AZURE_STORAGE_ACCOUNT_URL || 'https://test.blob.core.windows.net';

const { tenantPath } = require('../src/lib/blobClient');

test('tenantPath: builds a tenants/{tenantId}/bp-workbook/... path, matching Lumina convention', () => {
  assert.equal(
    tenantPath('yellow-bank', 'sessions', 'abc-123', 'input.vsdx'),
    'tenants/yellow-bank/bp-workbook/sessions/abc-123/input.vsdx',
  );
});

test('tenantPath: different tenants never produce overlapping prefixes', () => {
  const a = tenantPath('acme-co', 'sessions', 's1');
  const b = tenantPath('yellow-bank', 'sessions', 's1');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('tenants/acme-co/'));
  assert.ok(b.startsWith('tenants/yellow-bank/'));
});
