'use strict';
// LLM gateway — calls Claude via Lumina's Azure AI Foundry deployment.
// Returns structured enrichment data matching the populate_workbook tool schema.
//
// Ported from the colleague's standalone app, which dual-routed between a direct
// Anthropic API key and Azure OpenAI (the latter specifically to work around the
// Anthropic endpoint being unreachable on the Deloitte corporate VPN). Lumina already
// solves that problem — functions/common/azure_ai.py calls the same Claude deployment via
// Azure AI Foundry's native Anthropic Messages API passthrough, reachable from inside the
// Azure subscription regardless of the caller's network — so this now does the Node
// equivalent of that one call, same endpoint/model/auth, instead of needing a second
// provider or a separate Anthropic key. TOOL_SCHEMA/buildSystemPrompt/buildUserMessage
// below are unchanged from the original — the real prompt-engineering content, not
// provider-specific.
const { DefaultAzureCredential } = require('@azure/identity');

const _credential = new DefaultAzureCredential();
let _cachedToken = null;

async function _foundryToken() {
  // Cache until ~5 min before expiry rather than fetching a fresh AAD token on every call.
  const now = Date.now();
  if (_cachedToken && _cachedToken.expiresOnTimestamp - now > 5 * 60 * 1000) {
    return _cachedToken.token;
  }
  _cachedToken = await _credential.getToken('https://cognitiveservices.azure.com/.default');
  return _cachedToken.token;
}

// ── Shared tool definition ────────────────────────────────────────────────────

const TOOL_SCHEMA = {
  type: 'object',
  required: ['section2', 'section3', 'section4', 'section5', 'section14', 'section15', 'section18', 'section19', 'section20', 'stepDescriptions'],
  properties: {
    section2: {
      type: 'object',
      required: ['overview', 'objective', 'trigger', 'key_decisions', 'additional_considerations'],
      properties: {
        overview:                  { type: 'string' },
        objective:                 { type: 'string' },
        trigger:                   { type: 'string' },
        key_decisions:             { type: 'string' },
        additional_considerations: { type: 'string' },
      },
    },
    section3: {
      type: 'array',
      items: {
        type: 'object',
        required: ['role', 'description'],
        properties: { role: { type: 'string' }, description: { type: 'string' } },
      },
    },
    section4: {
      type: 'array',
      description: 'Initiators and Approvers rows. Include Primary Route, Alternate Route (if applicable), and Web Service / Integration route (if security policy lists a web service initiating action). Minimum 2 rows.',
      items: {
        type: 'object',
        required: ['route', 'initiator', 'approval', 'comments'],
        properties: {
          route:    { type: 'string', description: 'Route label: Primary Route | Alternate Route | Web Service / Integration | or a descriptive label' },
          initiator: { type: 'string', description: 'Security group(s) who initiate this process on this route' },
          approval:  { type: 'string', description: 'Security group(s) who approve, or N/A if no approval step' },
          comments:  { type: 'string', description: 'One sentence: who initiates, who approves, and any key conditions or exceptions for this route' },
        },
      },
    },
    section5: {
      type: 'array',
      description: 'Process Inputs: 3-5 rows of data inputs required before or at process start. Derive from upstream sub-processes, the first 2-3 steps, and swim lane participant needs.',
      items: {
        type: 'object',
        required: ['input', 'description', 'classification'],
        properties: {
          input:          { type: 'string', description: 'Short name for the input' },
          description:    { type: 'string', description: 'One sentence: what it is, where it comes from, why it is needed' },
          classification: { type: 'string', enum: ['Manual', 'Automated', 'Automated / Manual'] },
        },
      },
    },
    section14: {
      type: 'array',
      description: 'Help Text: 2-4 rows for steps where additional user guidance is most valuable (data-entry steps with format requirements, non-obvious Workday navigation, or steps with downstream consequences if done incorrectly). Do not include sub-process or approval steps.',
      items: {
        type: 'object',
        required: ['step', 'text', 'conditions'],
        properties: {
          step:       { type: 'string', description: 'Full step label matching Section 7, e.g. HR-020-010-040 Fill out Job Requisition details' },
          text:       { type: 'string', description: '2-4 sentences: what to do, Workday navigation or field guidance, consequence of error' },
          conditions: { type: 'string', description: 'N/A if always applies; COND reference or role condition if conditional' },
        },
      },
    },
    section15: {
      type: 'array',
      description: 'Validation Text: 2-3 rows for mandatory or format-sensitive data entry steps. Focus on missing mandatory fields, format violations, and regulatory obligations.',
      items: {
        type: 'object',
        required: ['step', 'condition_rule', 'error_or_warning', 'text'],
        properties: {
          step:             { type: 'string', description: 'Full step label matching Section 7' },
          condition_rule:   { type: 'string', description: 'Plain English data condition, e.g. Bank account details missing (not a COND-XXX reference)' },
          error_or_warning: { type: 'string', enum: ['Error', 'Warning'], description: 'Error if user is blocked; Warning if they can proceed but should be alerted' },
          text:             { type: 'string', description: 'One sentence: what is wrong and what to do (Error) or what will happen (Warning)' },
        },
      },
    },
    section18: {
      type: 'array',
      items: {
        type: 'object',
        required: ['item', 'consideration'],
        properties: { item: { type: 'string' }, consideration: { type: 'string' } },
      },
    },
    section19: {
      type: 'array',
      items: {
        type: 'object',
        required: ['item', 'description', 'next_steps', 'owner'],
        properties: {
          item:        { type: 'string' },
          description: { type: 'string' },
          next_steps:  { type: 'string' },
          owner:       { type: 'string' },
        },
      },
    },
    section20: {
      type: 'array',
      description: 'Local & Regulatory Requirements: map step content to applicable Australian regulations. Only include requirements triggered by steps in this process. Use placeholder row if none apply.',
      items: {
        type: 'object',
        required: ['country', 'requirement'],
        properties: {
          country:     { type: 'string', description: 'Country or jurisdiction, e.g. Australia' },
          requirement: { type: 'string', description: '1-2 sentences naming the regulation and the obligation for this process' },
        },
      },
    },
    stepDescriptions: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Map of full step name (the quoted value shown after [X] in the step list, e.g. "HR-020-030-010 Browse Posted Jobs") to a 1-2 sentence description of the Workday action. Use the step name exactly as shown — do not use the [X] letter as the key.',
    },
  },
};

// ── Shared prompt builders ────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are a Workday implementation consultant helping to author a Business Process Workbook for a Deloitte / Sonic Healthcare implementation.
You will be given a list of business process steps parsed from a Visio Econ Map, plus the list of security groups and their permissions.
Return accurate, professional workbook content using the populate_workbook tool.
Write in third person, present tense. Keep descriptions concise.
Do not invent security groups or system names not evident from the step names or security policy.

Section-specific guidance:
- section4 (Initiators and Approvers): Use the provided initiators/approvers from the security policy. Identify Primary Route, Alternate Route (if a confidential or secondary path exists), and Web Service / Integration route (if web service roles are present). Write a one-sentence Comments value for each route covering who initiates, who approves, and any key conditions.
- section5 (Process Inputs): Derive 3–5 inputs from upstream sub-process connections, the first 2–3 steps, swim lane participants, and the process name. Classify each as Manual, Automated, or Automated / Manual.
- section14 (Help Text): Include 2–4 steps where user guidance materially helps. Prioritise: steps requiring specific data formats (TFN, BSB, compensation bands), non-obvious Workday navigation, and steps with downstream consequences. Exclude approval and sub-process steps.
- section15 (Validation Text): Include 2–3 mandatory or format-sensitive steps. Classify each as Error (blocks submission) or Warning (alerts but allows submission). Write the Condition Rule as a plain English data condition, not a COND-XXX reference.
- section19 (Identified Gaps): Flag any configuration, integration, or data dependencies that are unclear or unresolved. If nothing is identifiable, return a single item with all fields set to "N/A".
- section20 (Local & Regulatory Requirements): Map step content to Australian regulations only. Include TFN/ATO, superannuation, bank/payment, Fair Work Act, Migration Act, or Privacy Act obligations where triggered by steps in this process. If none apply, return a single item with country "<Country>" and requirement "<Requirement>".
Sections 11.1, 11.2 (Notifications) and Section 12 (To Dos) come from uploaded Excel files — do NOT generate content for them.`;
}

function buildUserMessage(visioData, securityData) {
  const stepsText = visioData.steps.map(s =>
    `[${s[0]}] "${s[1]}" | Type: ${s[2]} | Swim Lane: ${s[5] || '(none)'}`
  ).join('\n');

  const condText = visioData.conditionRules.length
    ? visioData.conditionRules.map(r => `${r.id}: ${r.name}`).join('\n')
    : '(none)';

  // Summarise security policy into initiator and approver lists for Section 4 context.
  let securitySummary = '';
  if (securityData && securityData.length) {
    const initiators = securityData.filter(r => r[1] === 'Y').map(r => r[0]);
    const approvers  = securityData.filter(r => r[5] === 'Y').map(r => r[0]);
    // Web service initiators are those with roles containing 'administrator' or 'integration' but not in standard swim lanes.
    const swimSet = new Set((visioData.swimLanes || []).map(l => l.toLowerCase()));
    const wsRoles = initiators.filter(r => !swimSet.has(r.toLowerCase()) && /admin|integration/i.test(r));
    securitySummary = `
Security policy summary (for Section 4):
- Initiators (Initiate permission): ${initiators.join(', ') || 'none'}
- Approvers (Approve permission): ${approvers.join(', ') || 'none'}
${wsRoles.length ? `- Possible web service / integration initiators: ${wsRoles.join(', ')}` : ''}`;
  }

  return `Business process: ${visioData.meta?.processId || ''} ${visioData.meta?.processName || ''}

Business process steps extracted from the Visio Econ Map:

${stepsText}

Condition / Gateway rules:
${condText}

Swim lanes (roles / participants):
${visioData.swimLanes.join(', ') || '(none)'}
${securitySummary}

Using the populate_workbook tool, generate ALL of the following sections:
- section2: overview, objective, business trigger, key decisions, and additional considerations
- section3: one entry per swim lane with role name and description of their responsibilities
- section4: Initiators and Approvers rows — Primary Route (use security policy initiators/approvers), Alternate Route if applicable, Web Service / Integration route if web service roles exist. Include a Comments sentence for each route.
- section5: 3–5 process inputs required before or at process start — derive from upstream sub-processes, first 2–3 steps, swim lane participant needs, and the process name
- section14: 2–4 Help Text entries for steps where user guidance materially helps (data entry with format requirements, non-obvious navigation, downstream consequences of errors)
- section15: 2–3 Validation Text entries for mandatory or format-sensitive steps
- section18: go-live implications or considerations inferred from the process
- section19: gaps or risks identified from the process — flag missing configuration, integrations, or dependencies; return a single N/A row if none are identifiable
- section20: Australian regulatory requirements triggered by steps in this process (TFN/ATO, superannuation, bank/payment, Fair Work Act, Migration Act, Privacy Act); return a single placeholder row if none apply
- stepDescriptions: a 1-2 sentence description for every step listed above. Use the full step name (e.g. "HR-020-030-010 Browse Posted Jobs") as the key — NOT the [X] letter prefix.
Do NOT populate notifications (11.1/11.2) or To Dos (12) — these come from uploaded Excel files.`;
}

// ── Claude via Azure AI Foundry (same deployment functions/common/azure_ai.py uses) ────

const _FOUNDRY_API_VERSION = process.env.AZURE_AI_FOUNDRY_API_VERSION || '2024-05-01-preview';
const _ANTHROPIC_VERSION = '2023-06-01';
const _RETRY_STATUS_CODES = new Set([429, 503]);
const _RETRY_DELAYS_MS = [2000, 4000, 8000];

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry on transient failures only (429/503/network error) — same policy as
// functions/common/azure_ai.py's generate(), ported here since this app makes the same
// kind of call against the same endpoint. A persistent failure (400/401/403/404) raises
// immediately, unretried.
async function _foundryMessagesCall(body) {
  const endpoint = process.env.AZURE_AI_FOUNDRY_ENDPOINT.replace(/\/$/, '');
  const url = `${endpoint}/anthropic/v1/messages?api-version=${_FOUNDRY_API_VERSION}`;

  let lastErr;
  for (let attempt = 0; attempt <= _RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await _sleep(_RETRY_DELAYS_MS[attempt - 1]);
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await _foundryToken()}`,
          'anthropic-version': _ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastErr = err;
      continue;
    }
    if (_RETRY_STATUS_CODES.has(resp.status)) {
      lastErr = new Error(`Foundry ${resp.status} ${resp.statusText}`);
      continue;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Foundry request failed: ${resp.status} ${resp.statusText} — ${text.slice(0, 500)}`);
    }
    return resp.json();
  }
  throw lastErr;
}

async function enrichWithFoundry(visioData, securityData) {
  const data = await _foundryMessagesCall({
    model: process.env.GENERATION_MODEL_NAME,
    max_tokens: 8192,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: buildUserMessage(visioData, securityData) }],
    tools: [{ name: 'populate_workbook', description: 'Populate all BP Workbook sections.', input_schema: TOOL_SCHEMA }],
    tool_choice: { type: 'tool', name: 'populate_workbook' },
  });

  const toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === 'populate_workbook');
  if (!toolUse) throw new Error('Claude did not return a populate_workbook tool call');
  return { data: toolUse.input, usage: data.usage };
}

// ── Public entry point ────────────────────────────────────────────────────────

// Enrich visioData with LLM-generated section content; returns { data, usage, provider }.
async function enrich(visioData, securityData) {
  const result = await enrichWithFoundry(visioData, securityData);
  return { ...result, provider: 'azure-ai-foundry' };
}

module.exports = { enrich };
