'use strict';
// Server-side DOCX generator — 20-section BP Workbook per the Master Prompt spec.
const docx = require('docx');
const {
  Document, Paragraph, Table, TableRow, TableCell, TextRun,
  WidthType, ShadingType, VerticalAlign, Packer, AlignmentType,
  Footer, PageNumber, LevelFormat, BorderStyle,
  patchDocument, PatchType,
} = docx;

// Colour palette
const C = { NAVY: '252C3F', DARK: '11316E', ALT: 'CED6E4', WHITE: 'FFFFFF', GRAY: '404041', MUTED: '888888' };

// Thin cell border reused by every table cell
const thinB   = { style: BorderStyle.SINGLE, size: 1, color: 'BBBBBB' };
const borders = { top: thinB, bottom: thinB, left: thinB, right: thinB };

// ── Table helpers ─────────────────────────────────────────────────────────────

// Header row: navy fill, white bold 18-unit Calibri, DXA column widths.
function hdrRow(cols, colWidths) {
  return new TableRow({
    tableHeader: true,
    children: cols.map((t, i) => new TableCell({
      width:         { size: colWidths[i], type: WidthType.DXA },
      shading:       { fill: C.DARK, type: ShadingType.CLEAR, color: C.DARK },
      verticalAlign: VerticalAlign.CENTER,
      borders,
      children: [new Paragraph({ children: [new TextRun({ text: String(t), bold: true, color: C.WHITE, size: 18, font: 'Calibri' })] })],
    })),
  });
}

// Data row: alternating fill on odd index, 18-unit Calibri, DXA column widths.
function dataRow(cells, colWidths, idx) {
  const fill = idx % 2 === 0 ? C.WHITE : C.ALT;
  return new TableRow({
    children: cells.map((c, i) => new TableCell({
      width:         { size: colWidths[i], type: WidthType.DXA },
      shading:       { fill, type: ShadingType.CLEAR, color: fill },
      verticalAlign: VerticalAlign.CENTER,
      borders,
      children: [new Paragraph({ children: [new TextRun({ text: String(c ?? ''), size: 18, font: 'Calibri' })] })],
    })),
  });
}

// Build a Table from headers, DXA column widths, and pre-built TableRow objects.
function buildTable(headers, colWidths, rows) {
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  return new Table({
    width:        { size: totalWidth, type: WidthType.DXA },
    columnWidths: colWidths,
    rows:         [hdrRow(headers, colWidths), ...rows],
  });
}

// ── Paragraph helpers ─────────────────────────────────────────────────────────

// Section-heading paragraph: bold 48-unit Calibri, navy, spaced.
function sectionHeading(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 48, font: 'Calibri', color: C.NAVY })],
    spacing:  { before: 360, after: 120 },
  });
}

// Sub-heading paragraph: bold 28-unit Calibri, navy, spaced.
function subHeading(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 28, font: 'Calibri', color: C.NAVY })],
    spacing:  { before: 240, after: 80 },
  });
}

// Body paragraph: 22-unit Calibri, optionally italic.
function body(text, italic) {
  return new Paragraph({
    children: [new TextRun({ text: String(text || ''), size: 22, font: 'Calibri', italics: italic || false })],
    spacing:  { before: 60, after: 60 },
  });
}

// Bullet list paragraph referencing the 'bullets' numbering config.
function bullet(text) {
  return new Paragraph({
    numbering: { reference: 'bullets', level: 0 },
    children:  [new TextRun({ text, size: 22, font: 'Calibri' })],
  });
}

// Table-of-contents line: 22-unit Calibri, optional left indent.
function tocLine(text, indent) {
  return new Paragraph({
    children: [new TextRun({ text, size: 22, font: 'Calibri' })],
    spacing:  { before: 40, after: 40 },
    ...(indent ? { indent: { left: 360 } } : {}),
  });
}

// Page-break paragraph.
function pgBreak() {
  return new Paragraph({ children: [new TextRun({ break: 1 })] });
}

// Table cell that renders multiline text (split on \n) as separate paragraphs.
function multiParaCell(text, fill, colWidth) {
  const lines = String(text ?? '').split('\n');
  // Trim a single trailing empty line produced by a trailing \n.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return new TableCell({
    width:         { size: colWidth, type: WidthType.DXA },
    shading:       { fill, type: ShadingType.CLEAR, color: fill },
    verticalAlign: VerticalAlign.CENTER,
    borders,
    children: lines.length
      ? lines.map(line => new Paragraph({ children: [new TextRun({ text: line, size: 18, font: 'Calibri' })] }))
      : [new Paragraph({ children: [new TextRun({ text: '', size: 18, font: 'Calibri' })] })],
  });
}

// Data row for Custom Notifications — body column (index 5) supports multiline paragraphs.
function custNotifDataRow(cells, colWidths, idx) {
  const fill = idx % 2 === 0 ? C.WHITE : C.ALT;
  return new TableRow({
    children: cells.map((c, i) => {
      if (i === 5) return multiParaCell(c, fill, colWidths[i]);
      return new TableCell({
        width:         { size: colWidths[i], type: WidthType.DXA },
        shading:       { fill, type: ShadingType.CLEAR, color: fill },
        verticalAlign: VerticalAlign.CENTER,
        borders,
        children: [new Paragraph({ children: [new TextRun({ text: String(c ?? ''), size: 18, font: 'Calibri' })] })],
      });
    }),
  });
}

// ── Main builder ──────────────────────────────────────────────────────────────

// Build the complete 20-section BP Workbook document; returns a Node.js Buffer.
async function buildDocx(visioData, securityData, sysNotifData, custNotifData, ov, ED = {}, rawInstructions = '', templateBuffer = null) {
  const SD = ED.stepDescriptions || {};

  // Field name → column index map used when applying stepOverrides
  const STEP_FIELD_IDX = {
    'Step Order': 0, 'Step Name': 1, 'Type': 2, 'Description': 3,
    'Condition Rules': 4, 'Security Group': 5, 'Routing Restrictions': 6,
    'Optional?': 7, 'Due Date': 8, 'Step Delay': 9, 'Workday Step': 10,
  };

  const children = [];

  // ── Cover page ─────────────────────────────────────────────────────────────
  children.push(
    new Paragraph({ spacing: { before: 1200 }, children: [] }),
    new Paragraph({ children: [new TextRun({ text: 'Business Process Workbook:', bold: true, size: 100, font: 'Calibri', color: C.NAVY })] }),
    new Paragraph({ children: [new TextRun({ text: visioData.meta?.processId || visioData.meta?.workstreamName || '<Process ID>', bold: true, italics: true, size: 100, font: 'Calibri', color: C.NAVY })] }),
    new Paragraph({ children: [new TextRun({ text: visioData.meta?.processName || '<Process Name>', size: 72, font: 'Calibri', color: C.GRAY })] }),
    new Paragraph({ children: [new TextRun({ text: 'Contents',                    bold: true,            size: 40,  font: 'Calibri', color: C.NAVY  })] }),
    tocLine('Document Version Control'),
    tocLine('Document Approval Review'),
    tocLine('1.   Workday Business Processes in Scope of this Workbook'),
    tocLine('2.   Process Supporting Documentation'),
    tocLine('3.   Participants in Process Flow'),
    tocLine('4.   Initiators and Approvers'),
    tocLine('5.   Process Inputs'),
    tocLine('6.   Process Map'),
    tocLine('7.   Business Process Steps'),
    tocLine('8.   Process Outputs'),
    tocLine('9.   Business Process Security Policy'),
    tocLine('10.  Business Policy Restrictions'),
    tocLine('11.  Notifications'),
    tocLine('11.1 System Notifications',  true),
    tocLine('11.2 Custom Notifications',  true),
    tocLine('12.  To Dos'),
    tocLine('13.  Questionnaires'),
    tocLine('14.  Help Text'),
    tocLine('15.  Validation Text'),
    tocLine('16.  Embedded Analytics'),
    tocLine('17.  Alerts'),
    tocLine('18.  Go Live Implications & Considerations'),
    tocLine('19.  Identified Gaps'),
    tocLine('20.  Local & Regulatory Requirements'),
    pgBreak(),
  );

  // ── Document Version Control ───────────────────────────────────────────────
  const verWidths = [900, 1400, 2200, 4860];
  const todayStr = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  children.push(
    sectionHeading('Document Version Control'),
    buildTable(
      ['Version', 'Date', 'Author', 'Modifications/Notes'],
      verWidths,
      Array.from({ length: 11 }, (_, i) =>
        i === 0
          ? dataRow(['1.0', todayStr, 'BP Workbook Generation Application', 'Initial Draft'], verWidths, i)
          : dataRow(['', '', '', ''], verWidths, i),
      ),
    ),
    new Paragraph({ spacing: { before: 120 } }),
  );

  // ── Document Approval Review ───────────────────────────────────────────────
  const appWidths = [1600, 1500, 1900, 1900, 1460];
  children.push(
    sectionHeading('Document Approval Review'),
    buildTable(
      ['Document Status', 'Role', 'Reviewer', 'Reviewed/Approved', 'Date'],
      appWidths,
      Array.from({ length: 11 }, (_, i) => dataRow(['', '', '', '', ''], appWidths, i)),
    ),
    new Paragraph({ spacing: { before: 120 } }),
  );

  // ── Section 1 — Workday Business Processes in Scope ────────────────────────
  const s1Steps = (visioData.bpSteps || []).filter(s => s[2] !== 'Condition Rule');
  children.push(
    sectionHeading('1.   Workday Business Processes in Scope of this Workbook'),
    ...(s1Steps.length
      ? s1Steps.map(s => bullet(s[1]))
      : [bullet('<In-scope process 1>'), bullet('<In-scope process 2>'), bullet('<Add additional in-scope processes as required>')]),
  );

  // ── Section 2 — Process Supporting Documentation ───────────────────────────
  const s2Widths = [2200, 7160];
  children.push(
    sectionHeading('2.   Process Supporting Documentation'),
    buildTable(['Process', 'Process Definition'], s2Widths, [
      dataRow(['Overview',                  ED.section2?.overview                  || ov.sections?.['2']?.overview                  || '<Insert overview>'],                             s2Widths, 0),
      dataRow(['Objective',                 ED.section2?.objective                 || ov.sections?.['2']?.objective                 || '<Insert objective>'],                            s2Widths, 1),
      dataRow(['Business Trigger',          ED.section2?.trigger                   || ov.sections?.['2']?.trigger                   || '<Insert trigger>'],                              s2Widths, 2),
      dataRow(['Key Decisions',             ED.section2?.key_decisions             || ov.sections?.['2']?.key_decisions             || '<Decision 1>  <Decision 2>'],                   s2Widths, 3),
      dataRow(['Additional Considerations', ED.section2?.additional_considerations || ov.sections?.['2']?.additional_considerations || '<Consideration 1>  <Consideration 2>'],         s2Widths, 4),
    ]),
  );

  // ── Section 3 — Participants in Process Flow ───────────────────────────────
  const s3Widths = [2200, 7160];
  let s3Rows;
  if (Array.isArray(ED.section3) && ED.section3.length) {
    s3Rows = ED.section3.map((r, i) => dataRow([r.role, r.description], s3Widths, i));
  } else {
    // Merge Visio swim lane roles with all security groups visible in the process (de-duped).
    // col[3] = View All; any role with View All or higher participates in the flow.
    const swimRoles = visioData.swimLanes || [];
    const swimSet   = new Set(swimRoles.map(r => r.toLowerCase()));
    const secParticipants = (securityData || [])
      .filter(r => r.length > 1 && !swimSet.has((r[0] || '').toLowerCase()))
      .map(r => r[0]);
    const allParticipants = [...swimRoles, ...secParticipants];
    if (allParticipants.length) {
      s3Rows = allParticipants.map((role, i) => dataRow([role, ''], s3Widths, i));
    } else {
      s3Rows = [
        dataRow(['e.g. Manager', "e.g. Direct manager for the worker's BP approval"], s3Widths, 0),
        dataRow(['<Role 2>',     '<Role description>'],                                s3Widths, 1),
      ];
    }
  }
  children.push(
    sectionHeading('3.   Participants in Process Flow'),
    buildTable(['Role', 'Description'], s3Widths, s3Rows),
  );

  // ── Section 4 — Initiators and Approvers ──────────────────────────────────
  const s4Widths = [1800, 2000, 2000, 3560];
  // Helper to build a Section 4 data row; Initiator and 1st Approval columns support multiline.
  const s4DataRow = (route, initiator, approver, comments, idx) => {
    const fill = idx % 2 === 0 ? C.WHITE : C.ALT;
    return new TableRow({ children: [
      new TableCell({ width: { size: s4Widths[0], type: WidthType.DXA }, shading: { fill, type: ShadingType.CLEAR, color: fill }, verticalAlign: VerticalAlign.CENTER, borders,
        children: [new Paragraph({ children: [new TextRun({ text: route, size: 18, font: 'Calibri' })] })] }),
      multiParaCell(initiator, fill, s4Widths[1]),
      multiParaCell(approver,  fill, s4Widths[2]),
      multiParaCell(comments,  fill, s4Widths[3]),
    ]});
  };
  let s4Rows;
  if (Array.isArray(ED.section4) && ED.section4.length) {
    // Use LLM-generated routes with full Comments column
    s4Rows = ED.section4.map((r, i) => s4DataRow(r.route, r.initiator, r.approval, r.comments, i));
  } else {
    // Fallback: derive initiators/approvers from security matrix; Comments left blank
    const secInitiators = (securityData || []).filter(r => r[1] === 'Y').map(r => r[0]).join('\n') || '<Initiator>';
    const secApprovers  = (securityData || []).filter(r => r[5] === 'Y').map(r => r[0]).join('\n') || '<Approver>';
    s4Rows = [
      s4DataRow('Primary Route',   secInitiators,           secApprovers,      '', 0),
      s4DataRow('Alternate Route', '<Alternate initiator>', '<Approver / N/A>', '', 1),
    ];
  }
  children.push(
    sectionHeading('4.   Initiators and Approvers'),
    buildTable(['Route', 'Initiator', '1st Approval', 'Comments'], s4Widths, s4Rows),
  );

  // ── Section 5 — Process Inputs ─────────────────────────────────────────────
  const s5Widths = [2200, 5000, 2160];
  const s5Rows = Array.isArray(ED.section5) && ED.section5.length
    ? ED.section5.map((r, i) => dataRow([r.input, r.description, r.classification], s5Widths, i))
    : [dataRow(['N/A', 'N/A', 'N/A'], s5Widths, 0)];
  children.push(
    sectionHeading('5.   Process Inputs'),
    buildTable(['Input', 'Description', 'Manual or Automated'], s5Widths, s5Rows),
  );

  // ── Section 6 — Process Map ────────────────────────────────────────────────
  children.push(
    sectionHeading('6.   Process Map'),
    body('(Below is just an example: insert process map here)', true),
    new Paragraph({ spacing: { before: 1200, after: 1200 }, children: [] }),
  );

  // ── Section 7 — Business Process Steps ────────────────────────────────────
  const s7Widths     = [700, 900, 900, 1400, 1100, 900, 1200, 700, 700, 700, 700];
  const filteredSteps = (visioData.steps || []).filter(s =>
    s[2] !== 'Custom Notification' && s[2] !== 'System Notification' && s[2] !== 'Condition Rule',
  );
  const s7Rows = filteredSteps.map((s, i) => {
    const row = [...s];
    row[3] = SD[s[1]] || SD[s[0]] || s[3] || '';
    // Apply bulk step overrides from custom instructions
    (ov.stepOverrides || []).forEach(override => {
      if (s[2] === override.type) {
        const idx = STEP_FIELD_IDX[override.field];
        if (idx !== undefined) row[idx] = override.value;
      }
    });
    return dataRow(row, s7Widths, i);
  });
  children.push(
    sectionHeading('7.   Business Process Steps'),
    buildTable(
      ['Step Order', 'Step', 'Type', 'Description', 'Condition Rules', 'Security Group', 'Routing Restrictions', 'Optional?', 'Due Date', 'Step Delay', 'Workday Step'],
      s7Widths,
      s7Rows.length ? s7Rows : [dataRow(['', '', '', '', '', '', '', '', '', '', ''], s7Widths, 0)],
    ),
  );

  // ── Section 8 — Process Outputs ───────────────────────────────────────────
  const s8Widths = [2200, 5000, 2160];
  children.push(
    sectionHeading('8.   Process Outputs'),
    buildTable(['Output', 'Description', 'Manual or Automated'], s8Widths, [
      dataRow(['E.g. Payroll',               'The personal data change is sent to the Payroll system via an integration and/or report', 'Automated'],            s8Widths, 0),
      dataRow(['E.g. SailPoint',             'The personal data change is sent to SailPoint via an integration',                        'Automated'],            s8Widths, 1),
      dataRow(['<Insert any other outputs>', '<insert description>',                                                                    '<Manual or Automated>'], s8Widths, 2),
    ]),
  );

  // ── Section 9 — Business Process Security Policy ──────────────────────────
  const s9Widths  = [1400, 620, 620, 620, 1100, 620, 1000, 620, 620, 620, 900, 620];
  const s9Headers = ['Role', 'Initiate', 'Review', 'View All', 'View Completed Only', 'Approve', 'Ad-Hoc Approve', 'Cancel', 'Rescind', 'Correct', 'Reassign Task', 'Deny'];
  const s9Rows    = securityData?.length
    ? securityData.map((r, i) => dataRow(r, s9Widths, i))
    : [
        dataRow(['', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-'], s9Widths, 0),
        dataRow(['', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-'], s9Widths, 1),
      ];
  children.push(
    sectionHeading('9.   Business Process Security Policy'),
    buildTable(s9Headers, s9Widths, s9Rows),
  );

  // ── Section 10 — Business Policy Restrictions ─────────────────────────────
  const s10Widths = [6800, 2560];
  const s10val    = k => ov.section10?.[k];
  children.push(
    sectionHeading('10.  Business Policy Restrictions'),
    buildTable(['Setting', 'Yes/No'], s10Widths, [
      dataRow(['Allow Business Process Delegation', s10val('Allow Business Process Delegation') || 'No'],  s10Widths, 0),
      dataRow(['Hide Comments from Employee',       s10val('Hide Comments from Employee')       || 'No'],  s10Widths, 1),
      dataRow(['Hide Details from Employee',        s10val('Hide Details from Employee')        || 'No'],  s10Widths, 2),
      dataRow(['Disable Comments',                  s10val('Disable Comments')                  || 'No'],  s10Widths, 3),
      dataRow(['Allow Attachments within Emails',   s10val('Allow Attachments within Emails')   || 'Yes'], s10Widths, 4),
    ]),
  );

  // ── Section 11 — Notifications ────────────────────────────────────────────
  const notifHdr    = ['Business Process Step', 'Business Process Condition', 'Trigger', 'Recipient (Role)', 'Notification Subject', 'Notification Body'];
  const notifWidths = [1500, 1700, 1200, 1400, 1500, 2060];
  const notifEmpty = [
    dataRow(['', '', '', '', '', ''], notifWidths, 0),
    dataRow(['', '', '', '', '', ''], notifWidths, 1),
  ];

  children.push(sectionHeading('11.  Notifications'));

  children.push(
    subHeading('11.1 System Notifications'),
    buildTable(notifHdr, notifWidths,
      sysNotifData?.length
        ? sysNotifData.map((r, i) => dataRow(r, notifWidths, i))
        : notifEmpty,
    ),
    new Paragraph({ spacing: { before: 120 } }),
  );

  children.push(
    subHeading('11.2 Custom Notifications'),
    buildTable(notifHdr, notifWidths,
      custNotifData?.length
        ? custNotifData.map((r, i) => custNotifDataRow(r, notifWidths, i))
        : notifEmpty,
    ),
    new Paragraph({ spacing: { before: 120 } }),
  );

  // ── Section 12 — To Dos ───────────────────────────────────────────────────
  const todoWidths = [1800, 1800, 1800, 2000, 1960];
  const todoSteps  = (visioData.steps || []).filter(s => s[2] === 'To Do');
  const todoRows   = todoSteps.length
    ? todoSteps.map((s, i) => dataRow([s[5], s[0], s[1], SD[s[0]] || s[3] || '', 'No'], todoWidths, i))
    : [dataRow(['N/A', 'N/A', 'N/A', 'N/A', 'N/A'], todoWidths, 0)];
  children.push(
    sectionHeading('12.  To Dos'),
    buildTable(['Role', 'Step Number/Trigger', 'Name', 'To Do', 'Embedded Task'], todoWidths, todoRows),
  );

  // ── Section 13 — Questionnaires ───────────────────────────────────────────
  const s13Widths = [3000, 3000, 3360];
  children.push(
    sectionHeading('13.  Questionnaires'),
    buildTable(['Questionnaire Name', 'Questionnaire Type', 'Step Reference'], s13Widths, [
      dataRow(['N/A', 'N/A', ''], s13Widths, 0),
      dataRow(['',   '',    ''], s13Widths, 1),
    ]),
  );

  // ── Section 14 — Help Text ────────────────────────────────────────────────
  const s14Widths = [2200, 4500, 2660];
  const s14Rows = Array.isArray(ED.section14) && ED.section14.length
    ? ED.section14.map((r, i) => dataRow([r.step, r.text, r.conditions], s14Widths, i))
    : [dataRow(['<Step>', '<Help text>', '<Conditions>'], s14Widths, 0)];
  children.push(
    sectionHeading('14.  Help Text'),
    buildTable(['Business Process Step', 'Text', 'Conditions'], s14Widths, s14Rows),
  );

  // ── Section 15 — Validation Text ─────────────────────────────────────────
  const s15Widths = [2200, 2500, 1600, 3060];
  const s15Rows = Array.isArray(ED.section15) && ED.section15.length
    ? ED.section15.map((r, i) => dataRow([r.step, r.condition_rule, r.error_or_warning, r.text], s15Widths, i))
    : [dataRow(['<Step>', '<Condition>', 'Error', '<Validation text>'], s15Widths, 0)];
  children.push(
    sectionHeading('15.  Validation Text'),
    buildTable(['Business Process Step', 'Condition Rule', 'Error or Warning', 'Text'], s15Widths, s15Rows),
  );

  // ── Section 16 — Embedded Analytics ──────────────────────────────────────
  const s16Widths = [4600, 4760];
  children.push(
    sectionHeading('16.  Embedded Analytics'),
    buildTable(['Business Process Step', 'Report'], s16Widths, [
      dataRow(['<Step>',   '<Report name>'],   s16Widths, 0),
      dataRow(['<Step 2>', '<Report name 2>'], s16Widths, 1),
    ]),
  );

  // ── Section 17 — Alerts ───────────────────────────────────────────────────
  const s17Widths = [2300, 2100, 2000, 2960];
  children.push(
    sectionHeading('17.  Alerts'),
    buildTable(['Trigger', 'Recipient', 'Subject', 'Body'], s17Widths, [
      dataRow(['<Trigger>', '<Recipient>', '<Subject>', '<Body>'], s17Widths, 0),
    ]),
  );

  // ── Section 18 — Go Live Implications & Considerations ───────────────────
  const s18Widths = [3000, 6360];
  let s18Base;
  if (Array.isArray(ED.section18) && ED.section18.length) {
    s18Base = ED.section18.map((r, i) => dataRow([r.item, r.consideration], s18Widths, i));
  } else {
    s18Base = [dataRow(['N/A', 'N/A'], s18Widths, 0)];
  }
  const s18Extra = (ov.rowAdditions?.['18'] || []).map((r, i) =>
    dataRow([r, ''], s18Widths, s18Base.length + i),
  );
  children.push(
    sectionHeading('18.  Go Live Implications & Considerations'),
    buildTable(['Item', 'Consideration'], s18Widths, [...s18Base, ...s18Extra]),
  );

  // ── Section 19 — Identified Gaps ─────────────────────────────────────────
  const s19Widths = [1500, 3000, 2800, 2060];
  let s19Base;
  if (Array.isArray(ED.section19) && ED.section19.length) {
    s19Base = ED.section19.map((r, i) => dataRow([r.item, r.description, r.next_steps, r.owner], s19Widths, i));
  } else {
    s19Base = [dataRow(['N/A', 'N/A', 'N/A', 'N/A'], s19Widths, 0)];
  }
  const s19Extra = (ov.rowAdditions?.['19'] || []).map((r, i) =>
    dataRow([`GAP-${String(i + 1).padStart(3, '0')}`, r, '', ''], s19Widths, s19Base.length + i),
  );
  children.push(
    sectionHeading('19.  Identified Gaps'),
    buildTable(['Item', 'Description', 'Next Steps', 'Owner'], s19Widths, [...s19Base, ...s19Extra]),
  );

  // ── Section 20 — Local & Regulatory Requirements ──────────────────────────
  const s20Widths = [3000, 6360];
  const s20Rows = Array.isArray(ED.section20) && ED.section20.length
    ? ED.section20.map((r, i) => dataRow([r.country, r.requirement], s20Widths, i))
    : [dataRow(['<Country>', '<Requirement>'], s20Widths, 0)];
  children.push(
    sectionHeading('20.  Local & Regulatory Requirements'),
    buildTable(['Country', 'Requirement'], s20Widths, s20Rows),
  );

  // ── Copyright notice ──────────────────────────────────────────────────────
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing:   { before: 480 },
      children:  [new TextRun({ text: '© Deloitte Business Process Workbooks', size: 18, font: 'Calibri', color: C.MUTED })],
    }),
  );

  // ── Audit log (appended when custom instructions were supplied) ───────────
  if (rawInstructions) {
    children.push(
      pgBreak(),
      new Paragraph({ children: [new TextRun({ text: 'Custom Instructions — Audit Log', bold: true, size: 22, font: 'Calibri', color: C.GRAY })] }),
      new Paragraph({ children: [new TextRun({ text: rawInstructions, size: 18, font: 'Calibri', color: 'AAAAAA' })] }),
    );
  }

  // ── Page footer with page number ──────────────────────────────────────────
  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children:  [new TextRun({ children: [PageNumber.CURRENT], font: 'Calibri', size: 18 })],
      }),
    ],
  });

  // ── Assemble document ─────────────────────────────────────────────────────
  const doc = new Document({
    numbering: {
      config: [{
        reference: 'bullets',
        levels: [{
          level:     0,
          format:    LevelFormat.BULLET,
          text:      '•',
          alignment: AlignmentType.LEFT,
          style:     { paragraph: { indent: { left: 540, hanging: 260 } } },
        }],
      }],
    },
    sections: [{
      properties: {
        page: {
          size:   { width: 11906, height: 16838 },
          margin: { top: 1134, right: 1418, bottom: 1134, left: 1418 },
        },
      },
      footers:  { default: footer },
      children,
    }],
  });

  // If a custom template buffer was provided, attempt PatchDocument injection
  if (templateBuffer) {
    try {
      if (typeof patchDocument === 'function') {
        const patched = await patchDocument(templateBuffer, {
          patches: { section_content: { type: PatchType.DOCUMENT, children } },
        });
        return Buffer.from(patched);
      }
    } catch {
      // Fall through to scratch generation on any error
    }
  }

  return Packer.toBuffer(doc);
}

module.exports = { buildDocx };
