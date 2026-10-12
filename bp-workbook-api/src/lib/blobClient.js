'use strict';
// Thin wrapper around @azure/storage-blob for file upload and SAS URL generation.
//
// Ported from the colleague's standalone app, which used its own Storage account
// (connection-string auth, flat `bp-workbooks` container, no tenant concept). Points at
// Lumina's existing storage account now (same AZURE_STORAGE_ACCOUNT_URL / docs container
// functions/common/blob.py uses), with every path prefixed `tenants/{tenantId}/...` —
// matching that same path convention — and SAS URLs signed with a user-delegation key via
// DefaultAzureCredential (not an account key), mirroring blob.py's own _generate_sas()
// logic exactly rather than reaching for the connection-string shortcut.
const {
  BlobServiceClient,
  BlobSASPermissions,
  generateBlobSASQueryParameters,
} = require('@azure/storage-blob');
const { DefaultAzureCredential } = require('@azure/identity');

const UDK_SAFETY_MARGIN_MS = 5 * 60 * 1000;

let _client = null;
function getClient() {
  if (!_client) {
    _client = new BlobServiceClient(process.env.AZURE_STORAGE_ACCOUNT_URL, new DefaultAzureCredential());
  }
  return _client;
}

const CONTAINER = () => process.env.STORAGE_CONTAINER || 'docs';

// Every blob this app touches lives under one tenant's own prefix — same convention as
// every other Lumina upload path (functions/common/tenant.py's s3_key()-equivalent shape).
function tenantPath(tenantId, ...parts) {
  return ['tenants', tenantId, 'bp-workbook', ...parts].join('/');
}

// Upload a Buffer to Blob Storage; returns the blob path.
async function uploadBlob(blobPath, buffer, contentType = 'application/octet-stream') {
  const container = getClient().getContainerClient(CONTAINER());
  const blockBlob = container.getBlockBlobClient(blobPath);
  await blockBlob.upload(buffer, buffer.length, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
  return blobPath;
}

// Download a blob to a Buffer.
async function downloadBlob(blobPath) {
  const container = getClient().getContainerClient(CONTAINER());
  const blockBlob = container.getBlockBlobClient(blobPath);
  const resp = await blockBlob.download(0);
  const chunks = [];
  for await (const chunk of resp.readableStreamBody) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Generate a time-limited SAS read URL for a stored blob, signed with a user-delegation
// key (not an account key) — see functions/common/blob.py's _generate_sas() for the exact
// same pattern on the Python side.
async function generateDownloadUrl(blobPath, expiryHours = 24) {
  const service = getClient();
  const now = new Date();
  const expiry = new Date(now.getTime() + expiryHours * 3_600_000);
  const udk = await service.getUserDelegationKey(
    new Date(now.getTime() - UDK_SAFETY_MARGIN_MS),
    new Date(expiry.getTime() + UDK_SAFETY_MARGIN_MS),
  );
  const sas = generateBlobSASQueryParameters(
    {
      containerName: CONTAINER(),
      blobName: blobPath,
      permissions: BlobSASPermissions.parse('r'),
      expiresOn: expiry,
    },
    udk,
    service.accountName,
  ).toString();
  return `${service.url}${CONTAINER()}/${blobPath}?${sas}`;
}

module.exports = { uploadBlob, downloadBlob, generateDownloadUrl, tenantPath };
