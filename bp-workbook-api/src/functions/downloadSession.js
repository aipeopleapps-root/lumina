'use strict';
// GET /api/sessions/{id}/download — return a fresh SAS download URL for a specific session.
const { app } = require('@azure/functions');
const { getSession }          = require('../lib/cosmosClient');
const { generateDownloadUrl } = require('../lib/blobClient');
const { getTenantContext, TenantError } = require('../lib/tenantContext');

app.http('downloadSession', {
  methods:   ['GET'],
  authLevel: 'function',
  route:     'sessions/{id}/download',
  handler:   async (request, context) => {
    let ctx;
    try {
      ctx = await getTenantContext(request);
    } catch (err) {
      if (err instanceof TenantError) return { status: 403, jsonBody: { error: err.message } };
      throw err;
    }
    const { id } = request.params;

    try {
      // getSession looks up by (id, tenantId) partition key — a session belonging to a
      // different tenant is simply not found here, not leaked and then rejected.
      const session = await getSession(id, ctx.tenantId);
      if (!session)           return { status: 404, jsonBody: { error: 'Session not found' } };
      if (!session.blobPath)  return { status: 404, jsonBody: { error: 'No output file for this session' } };

      const downloadUrl = await generateDownloadUrl(session.blobPath, 1);
      return { status: 200, jsonBody: { downloadUrl, filename: `${session.processId}-BP-Workbook.docx` } };
    } catch (err) {
      context.log(`downloadSession error: ${err.message}`);
      return { status: 500, jsonBody: { error: err.message } };
    }
  },
});
