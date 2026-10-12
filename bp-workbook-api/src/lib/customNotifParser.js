'use strict';
// Parse Custom Notifications xlsx; returns array of 6-element string arrays.
const XLSX = require('xlsx');

// Expand worksheet !ref to cover all populated cells (Workday exports often set a truncated !ref).
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

function parseCustomNotifications(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  fixRef(ws);

  const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (rawRows.length < 2) return [];

  // Row 0 is the section title; row 1 is the actual column header row.
  const REQUIRED = ['disabled', 'notification'];
  let hdrIdx = -1;
  for (let i = 0; i < Math.min(rawRows.length, 5); i++) {
    const cells = rawRows[i].map(c => String(c || '').toLowerCase().trim());
    if (REQUIRED.every(e => cells.includes(e))) { hdrIdx = i; break; }
  }
  if (hdrIdx === -1) return [];

  const headers  = rawRows[hdrIdx].map(c => String(c || '').toLowerCase().trim());
  const dataRows = rawRows.slice(hdrIdx + 1).filter(r => r.some(c => c !== ''));

  // Exact match first, then prefix match — handles the full "Trigger on Status / On Entry / ..." column name.
  const col = name => {
    const exact = headers.indexOf(name);
    if (exact >= 0) return exact;
    return headers.findIndex(h => h.startsWith(name));
  };
  const get = (row, name) => { const i = col(name); return i >= 0 ? String(row[i] ?? '').trim() : ''; };

  return dataRows
    .filter(r => get(r, 'disabled').toLowerCase() !== 'yes')
    .map(r => [
      get(r, 'notification')               || '<placeholder>',
      get(r, 'business process condition') || '<placeholder>',
      get(r, 'trigger')                    || '<placeholder>',
      get(r, 'recipients')                 || '<placeholder>',
      get(r, 'subject')                    || '<placeholder>',
      (get(r, 'body').replace(/\r\n/g, '\n').replace(/\r/g, '\n')) || '<placeholder>',
    ]);
}

module.exports = { parseCustomNotifications };
