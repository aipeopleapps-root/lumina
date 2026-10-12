'use strict';
// POST /api/sessions — parse files, enrich with LLM, generate DOCX, persist to Blob + Cosmos.
const { app } = require('@azure/functions');
const { v4: uuidv4 } = require('uuid');

const { parseVisio }              = require('../lib/visioParser');
const { parseSecurityPolicy }     = require('../lib/securityParser');
const { parseSystemNotifications } = require('../lib/systemNotifParser');
const { parseCustomNotifications } = require('../lib/customNotifParser');
const { parseInstructions }       = require('../lib/instructionParser');
const { enrich }                  = require('../lib/llmEnricher');
const { buildDocx }               = require('../lib/docxBuilder');
const { uploadBlob, generateDownloadUrl, tenantPath } = require('../lib/blobClient');
const { createSession }           = require('../lib/cosmosClient');
const { getTenantContext, TenantError } = require('../lib/tenantContext');

// Derive processId from the original filename.
function extractProcessId(filename = '') {
  const m = filename.match(/([A-Z]+-\d+-\d+)/);
  return m ? m[1] : 'BP';
}

// Derive a human-readable process name from the filename and processId.
function deriveProcessName(filename, processId) {
  try {
    let name = filename.replace(/\.vsdx$/i, '');
    // Strip leading processId prefix (case-insensitive)
    if (name.toLowerCase().startsWith(processId.toLowerCase() + '_')) {
      name = name.slice(processId.length + 1);
    } else if (name.toLowerCase().startsWith(processId.toLowerCase())) {
      name = name.slice(processId.length);
    }
    // Strip trailing version tag (_v1, _v2, etc.) then digits-only timestamp segment.
    name = name.replace(/_v\d+$/i, '');
    name = name.replace(/_\d+$/, '');
    // Clean up leading/trailing underscores and spaces
    name = name.replace(/^[_\s]+|[_\s]+$/g, '');
    return name || filename;
  } catch {
    return filename;
  }
}

app.http('generateSession', {
  methods:   ['POST'],
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
    const { tenantId, userId, email: userEmail } = ctx;
    const sessionId = uuidv4();
    const warnings  = [];

    try {
      // ── Parse request body ───────────────────────────────────────────────
      const body = await request.json();
      const { visioFile, securityFile, systemNotifFile, customNotifFile, templateFile, customInstructions } = body;

      if (!visioFile?.data) {
        return { status: 400, jsonBody: { error: 'visioFile.data is required' } };
      }

      const visioBuffer       = Buffer.from(visioFile.data,    'base64');
      const securityBuffer    = securityFile?.data    ? Buffer.from(securityFile.data,    'base64') : null;
      const systemNotifBuffer = systemNotifFile?.data ? Buffer.from(systemNotifFile.data, 'base64') : null;
      const customNotifBuffer = customNotifFile?.data ? Buffer.from(customNotifFile.data, 'base64') : null;
      const templateBuffer    = templateFile?.data    ? Buffer.from(templateFile.data,    'base64') : null;

      const processId = extractProcessId(visioFile.name);

      // ── Upload raw inputs to Blob ────────────────────────────────────────
      const blobPrefix = tenantPath(tenantId, 'sessions', sessionId);
      await Promise.all([
        uploadBlob(`${blobPrefix}/input.vsdx`,     visioBuffer,    'application/vnd.ms-visio.drawing'),
        securityBuffer    && uploadBlob(`${blobPrefix}/security.xlsx`,     securityBuffer,    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
        systemNotifBuffer && uploadBlob(`${blobPrefix}/sys-notif.xlsx`,    systemNotifBuffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
        customNotifBuffer && uploadBlob(`${blobPrefix}/cust-notif.xlsx`,   customNotifBuffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
        templateBuffer    && uploadBlob(`${blobPrefix}/template.docx`,     templateBuffer,    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      ].filter(Boolean));

      // ── Parse Visio ──────────────────────────────────────────────────────
      context.log(`[${sessionId}] Parsing Visio…`);
      const visioData = await parseVisio(visioBuffer);
      context.log(`[${sessionId}] ${visioData.steps.length} steps, ${visioData.swimLanes.length} lanes`);

      // ── Inject meta (workstream name + process name) into visioData ──────
      const workstreamName = processId.includes('-') ? processId.split('-')[0] : processId;
      const processName    = deriveProcessName(visioFile.name, processId);
      visioData.meta = { workstreamName, processId, processName };

      // ── Parse optional xlsx files (each wrapped so one failure doesn't abort) ─
      let securityData = [];
      let securitySection10 = {};
      if (securityBuffer) {
        try {
          const parsed = parseSecurityPolicy(securityBuffer);
          securityData      = parsed.matrix;
          securitySection10 = parsed.section10 || {};
          warnings.push(securityData.length
            ? `Security Policy: ${securityData.length} rows loaded`
            : '⚠ Security Policy: file parsed but no data rows found — check column headers match the expected format');
        } catch (e) {
          warnings.push(`⚠ Security Policy parse failed: ${e.message} — Section 9 will show placeholders`);
          context.log(`[${sessionId}] Security parser error: ${e.message}`);
        }
      }

      let sysNotifData = [];
      if (systemNotifBuffer) {
        try {
          sysNotifData = parseSystemNotifications(systemNotifBuffer);
          warnings.push(sysNotifData.length
            ? `System Notifications: ${sysNotifData.length} rows loaded`
            : '⚠ System Notifications: file parsed but no rows found — check column headers and Disabled flag');
        } catch (e) {
          warnings.push(`⚠ System Notifications parse failed: ${e.message} — Section 11.1 will show placeholders`);
          context.log(`[${sessionId}] Sys-notif parser error: ${e.message}`);
        }
      }

      let custNotifData = [];
      if (customNotifBuffer) {
        try {
          custNotifData = parseCustomNotifications(customNotifBuffer);
          warnings.push(custNotifData.length
            ? `Custom Notifications: ${custNotifData.length} rows loaded`
            : '⚠ Custom Notifications: file parsed but no rows found — check column headers and Disabled flag');
        } catch (e) {
          warnings.push(`⚠ Custom Notifications parse failed: ${e.message} — Section 11.2 will show placeholders`);
          context.log(`[${sessionId}] Cust-notif parser error: ${e.message}`);
        }
      }

      // ── Apply custom instructions ────────────────────────────────────────
      let ov = { sections: {}, stepOverrides: [], rowAdditions: {}, section10: {} };
      if (customInstructions?.trim()) {
        const result = parseInstructions(customInstructions, visioData);
        ov = result.ov;
        warnings.push(...result.warnings);
      }
      // Merge security xlsx Section 10 values as defaults (custom instructions take precedence).
      ov.section10 = { ...securitySection10, ...ov.section10 };

      // ── LLM enrichment ───────────────────────────────────────────────────
      let enrichData = {};
      let enrichMeta = {};
      try {
        context.log(`[${sessionId}] LLM enrichment…`);
        const result = await enrich(visioData, securityData);
        enrichData = result.data;
        enrichMeta = { provider: result.provider, usage: result.usage };
        context.log(`[${sessionId}] Enrichment complete (${result.provider})`);
      } catch (e) {
        warnings.push(`LLM enrichment failed: ${e.message} — generating without enrichment`);
        context.log(`[${sessionId}] Enrichment failed: ${e.message}`);
      }

      // ── Build DOCX ───────────────────────────────────────────────────────
      context.log(`[${sessionId}] Building DOCX…`);
      const docxBuffer = await buildDocx(visioData, securityData, sysNotifData, custNotifData, ov, enrichData, customInstructions || '', templateBuffer);

      // ── Save DOCX to Blob ────────────────────────────────────────────────
      const outputBlobPath = `${blobPrefix}/${processId}-BP-Workbook.docx`;
      await uploadBlob(outputBlobPath, docxBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

      // ── Generate download URL (24 h SAS) ─────────────────────────────────
      const downloadUrl = await generateDownloadUrl(outputBlobPath, 24);

      // ── Write Cosmos audit record ─────────────────────────────────────────
      const cosmosDoc = {
        id:               sessionId,
        tenant_id:        tenantId,
        userId,
        userEmail,
        processId,
        fileName:         visioFile.name,
        createdAt:        new Date().toISOString(),
        status:           'completed',
        stepCount:         visioData.steps.length,
        swimLaneCount:     visioData.swimLanes.length,
        conditionCount:    visioData.conditionRules?.length ?? 0,
        systemNotifCount:  sysNotifData.length,
        customNotifCount:  custNotifData.length,
        enriched:          Object.keys(enrichData).length > 0,
        enrichmentModel:   enrichMeta.provider || null,
        tokenUsage:        enrichMeta.usage    || null,
        blobPath:          outputBlobPath,
        customInstructions: customInstructions || null,
        warnings,
      };
      await createSession(cosmosDoc);

      return {
        status: 200,
        jsonBody: {
          sessionId,
          processId,
          downloadUrl,
          filename:  `${processId}-BP-Workbook.docx`,
          summary: {
            stepCount:      visioData.steps.length,
            swimLaneCount:  visioData.swimLanes.length,
            conditionCount: visioData.conditionRules.length,
            enriched:       Object.keys(enrichData).length > 0,
          },
          warnings,
        },
      };

    } catch (err) {
      context.log(`[${sessionId}] Fatal error: ${err.message}\n${err.stack}`);

      // Persist a failed record so the consultant can see what went wrong
      try {
        await createSession({
          id: sessionId, tenant_id: tenantId, userId, userEmail,
          processId: 'UNKNOWN', fileName: '',
          createdAt: new Date().toISOString(),
          status: 'failed', error: err.message,
        });
      } catch { /* ignore secondary failure */ }

      return { status: 500, jsonBody: { error: err.message, sessionId } };
    }
  },
});
