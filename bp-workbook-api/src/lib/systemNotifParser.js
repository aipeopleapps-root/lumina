'use strict';
// Parse System Notifications xlsx; returns array of 6-element string arrays.
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

function parseSystemNotifications(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  fixRef(ws);

  const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (rawRows.length < 2) return [];

  // Row 0 is the section title; row 1 is the actual column header row.
  const EXPECTED = ['disabled', 'workflow step', 'order', 'type'];
  let hdrIdx = -1;
  for (let i = 0; i < Math.min(rawRows.length, 5); i++) {
    const cells = rawRows[i].map(c => String(c || '').toLowerCase().trim());
    if (EXPECTED.every(e => cells.includes(e))) { hdrIdx = i; break; }
  }
  if (hdrIdx === -1) return [];

  const headers  = rawRows[hdrIdx].map(c => String(c || '').toLowerCase().trim());
  const dataRows = rawRows.slice(hdrIdx + 1).filter(r => r.some(c => c !== ''));

  const col = name => headers.indexOf(name);
  const get = (row, name) => String(row[col(name)] ?? '').trim();

  return dataRows
    .filter(r => get(r, 'disabled').toLowerCase() !== 'yes')
    .sort((a, b) => String(a[col('order')] ?? '').localeCompare(String(b[col('order')] ?? '')))
    .map(r => [
      get(r, 'workflow step') || '<placeholder>',
      '<placeholder>',
      get(r, 'type')    || '<placeholder>',
      get(r, 'group')   || '<placeholder>',
      get(r, 'specify') || '<placeholder>',
      '<placeholder>',
    ]);
}

module.exports = { parseSystemNotifications };
