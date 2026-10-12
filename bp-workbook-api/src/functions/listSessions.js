'use strict';
// GET /api/sessions — return this tenant's sessions for the authenticated user, with
// fresh SAS download URLs. Scoped by tenant first (BP Workbook Generation is a
// 'client'-scoped app) and by userId within it — same "my own recent runs" shape as Test
// Automation Suite's Recent Runs panel.
const { app } = require('@azure/functions');
const { listSessions }       = require('../lib/cosmosClient');
const { generateDownloadUrl } = require('../lib/blobClient');
const { getTenantContext, TenantError } = require('../lib/tenantContext');

app.http('listSessions', {
  methods:   ['GET'],
  authLevel: 'function',
  route:     'sessions',
  handler:   async (request, context) => {
    let ctx;
    try {
      ctx = await getTenantContext(request);
    } catch (err) {
      if (err instanceof TenantError) return { status: 403, jsonBody: { error: err.message } };
      throw err;
    }
    try {
      const sessions = await listSessions(ctx.tenantId, ctx.userId);

      // Attach fresh SAS URLs (1-hour expiry) for completed sessions that have a stored blob
      const enriched = await Promise.all(sessions.map(async s => {
        let downloadUrl = null;
        if (s.status === 'completed' && s.blobPath) {
          try { downloadUrl = await generateDownloadUrl(s.blobPath, 1); } catch { /* blob may have been deleted */ }
        }
        return {
          id:            s.id,
          processId:     s.processId,
          fileName:      s.fileName,
          createdAt:     s.createdAt,
          status:        s.status,
          stepCount:     s.stepCount,
          enriched:      s.enriched,
          downloadUrl,
        };
      }));

      return { status: 200, jsonBody: { sessions: enriched } };
    } catch (err) {
      context.log(`listSessions error: ${err.message}`);
      return { status: 500, jsonBody: { error: err.message } };
    }
  },
});
