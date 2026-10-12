'use strict';
// Parse Workday Security Policy .xlsx (flat key-value export) into a role×permissions matrix + Section 10 values.
const XLSX = require('xlsx');

const PERM_NAMES = [
  'Initiate', 'Review', 'View All', 'View Completed Only',
  'Approve', 'Ad-Hoc Approve', 'Cancel', 'Rescind',
  'Correct', 'Reassign Task', 'Deny',
];

// Map an Action label (normalised, web-service suffix stripped) to a PERM_NAMES index.
function actionToPerm(label, rowType) {
  if (rowType === 'initiating action') return 0; // always → Initiate
  const l = label.toLowerCase().replace(/\s*\(web service\)/i, '').trim();
  const MAP = {
    'view all':            2,
    'view completed only': 3,
    'approve':             4,
    'ad hoc approve':      5,
    'ad-hoc approve':      5,
    'cancel':              6,
    'rescind':             7,
    'correct':             8,
    'reassign tasks':      9,
    'reassign task':       9,
    'deny':               10,
  };
  return MAP[l] ?? -1;
}

// Workday exports "Person" in some tenants and "Employee" in others — normalise to our canonical label.
const S10_MAP = {
  'allow business process delegation': 'Allow Business Process Delegation',
  'hide comments from person':         'Hide Comments from Employee',
  'hide comments from employee':       'Hide Comments from Employee',
  'hide details from person':          'Hide Details from Employee',
  'hide details from employee':        'Hide Details from Employee',
  'disable comments':                  'Disable Comments',
  'allow attachments within emails':   'Allow Attachments within Emails',
};

// Section headings that end an action block (reset the active perm context).
const RESET_ROWS = new Set([
  'who can start the business process',
  'who can do action steps in the business process',
  'who can do actions on entire business process',
  'policy restrictions',
  'attachment settings in bp toolbar',
  'security group types allowed for initiating actions',
  'security group types allowed for processing actions',
]);

// Expand the worksheet !ref to cover all populated cells (Workday exports sometimes set a truncated !ref).
function fixRef(ws) {
  const cellKeys = Object.keys(ws).filter(k => /^[A-Z]+\d+$/.test(k));
  if (!cellKeys.length) return;
  let maxR = 0, maxC = 0;
  for (const k of cellKeys) {
    const { r, c } = XLSX.utils.decode_cell(k);
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: maxC, r: maxR } });
}

// Returns { matrix: [[role, Y/-, ...], ...], section10: { 'Setting': 'Yes/No', ... } }
function parseSecurityPolicy(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  fixRef(ws);

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const rolePerms = new Map(); // role name → Set of PERM_NAMES indices
  const section10 = {};
  let currentPermIdx = -1;

  for (const row of rows) {
    const label      = String(row[0] || '').trim();
    const value      = String(row[1] || '').trim();
    const labelLower = label.toLowerCase();
    if (!label) continue;

    // Section 10 policy settings
    const s10Key = S10_MAP[labelLower];
    if (s10Key) { section10[s10Key] = value; currentPermIdx = -1; continue; }

    // Hard reset on section heading rows
    if (RESET_ROWS.has(labelLower)) { currentPermIdx = -1; continue; }

    // Action-type rows set the active permission column
    if (labelLower === 'initiating action' || labelLower === 'action') {
      currentPermIdx = actionToPerm(value, labelLower);
      continue;
    }

    // Security Groups row: record each role for the active perm column
    if (labelLower === 'security groups' && currentPermIdx >= 0) {
      const roles = value.split('\n').map(r => r.trim()).filter(Boolean);
      for (const role of roles) {
        if (!rolePerms.has(role)) rolePerms.set(role, new Set());
        rolePerms.get(role).add(currentPermIdx);
      }
      continue;
    }
    // Note / Description / Service Operations rows are silently skipped (perm context preserved).
  }

  const matrix = Array.from(rolePerms.entries()).map(([role, perms]) => [
    role,
    ...PERM_NAMES.map((_, i) => (perms.has(i) ? 'Y' : '-')),
  ]);

  return { matrix, section10 };
}

module.exports = { parseSecurityPolicy };
