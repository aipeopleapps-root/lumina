'use strict';
// Server-side port of the Visio Econ Map parser; uses @xmldom/xmldom instead of browser DOMParser.
const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');

// ── DOM helpers ──────────────────────────────────────────────────────────────

function allByTag(node, tag) {
  const list = node.getElementsByTagName(tag);
  const arr = [];
  for (let i = 0; i < list.length; i++) arr.push(list[i]);
  return arr;
}

function directChildrenByTag(node, tag) {
  const result = [];
  for (let i = 0; i < node.childNodes.length; i++) {
    const c = node.childNodes[i];
    if (c.nodeType === 1 && c.tagName === tag) result.push(c);
  }
  return result;
}

function attr(node, name) {
  return node.getAttribute(name) || '';
}

// getCellValue is intentionally recursive — fill colour and pin coordinates may live on child shapes.
function getCellValue(shape, cellName) {
  for (const cell of allByTag(shape, 'Cell')) {
    if (attr(cell, 'N') === cellName) return attr(cell, 'V') || attr(cell, 'F');
  }
  return '';
}

// getShapeText is recursive — text may be in a child shape (e.g. swim-lane label).
function getShapeText(shape) {
  const texts = allByTag(shape, 'Text');
  if (!texts.length) return '';
  return (texts[0].textContent || '').trim().replace(/\s+/g, ' ');
}

// Get text from a named sub-shape (NameU or Name attribute match, case-insensitive).
function getSubShapeText(shape, nameU) {
  for (const shapesEl of directChildrenByTag(shape, 'Shapes')) {
    for (const child of directChildrenByTag(shapesEl, 'Shape')) {
      const n = (attr(child, 'NameU') || attr(child, 'Name')).toLowerCase();
      if (n === nameU.toLowerCase()) {
        const texts = allByTag(child, 'Text');
        if (texts.length) return (texts[0].textContent || '').trim().replace(/\s+/g, ' ');
      }
    }
  }
  return '';
}

// ── Main parser ──────────────────────────────────────────────────────────────

async function parseVisio(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const domParser = new DOMParser({ onError: () => {} });

  // Resolve master names (used to identify shape types)
  const mastersMap = {};
  const mastersXml = zip.file('visio/masters/masters.xml');
  if (mastersXml) {
    const mDoc = domParser.parseFromString(await mastersXml.async('string'), 'text/xml');
    for (const m of allByTag(mDoc, 'Master')) {
      mastersMap[attr(m, 'ID')] = (attr(m, 'NameU') || attr(m, 'Name')).toLowerCase();
    }
  }

  // Locate page XML — prefer page1.xml, fall back to first available
  const pageKeys = Object.keys(zip.files)
    .filter(k => /visio\/pages\/page\d+\.xml/.test(k))
    .sort();
  if (!pageKeys.length) throw new Error('No page XML found inside .vsdx');
  const pageDoc = domParser.parseFromString(await zip.file(pageKeys[0]).async('string'), 'text/xml');

  // Iterate only top-level shapes — child sub-shapes are accessed deliberately via getSubShapeText.
  const topLevelShapes = directChildrenByTag(pageDoc.documentElement, 'Shapes')
    .flatMap(s => directChildrenByTag(s, 'Shape'));

  // Fall back to the shape's own NameU for shapes whose master has no NameU (e.g. ECON_Swimlane).
  const masterName = s => mastersMap[attr(s, 'Master')] || attr(s, 'NameU').toLowerCase();
  const fillColor  = s => getCellValue(s, 'FillForegnd').toUpperCase().replace(/^#/, '');
  const px = s => parseFloat(getCellValue(s, 'PinX') || '0');
  const py = s => parseFloat(getCellValue(s, 'PinY') || '0');

  const tasks = [], integrations = [], conditions = [], swimLanes = [];

  // Build sub-shape → top-level parent map so page-level Connects can be resolved.
  const subToParent = new Map();
  for (const shape of topLevelShapes) {
    for (const sub of allByTag(shape, 'Shape')) {
      subToParent.set(attr(sub, 'ID'), attr(shape, 'ID'));
    }
  }
  // Resolve a shape ID (possibly sub-shape) to the top-level parent ID.
  const resolveId = id => subToParent.get(id) || id;

  for (const shape of topLevelShapes) {
    const mn = masterName(shape);
    const fc = fillColor(shape);
    const id = attr(shape, 'ID');

    if (mn.includes('swimlane') || mn.includes('econ_swimlane') || mn.includes('lane')) {
      swimLanes.push({ id, text: getShapeText(shape), px: px(shape), py: py(shape) });
      continue;
    }

    if (mn.includes('diamond') || mn.includes('decision') || mn.includes('gateway') || mn.includes('decisionpoint')) {
      conditions.push({ id, text: getShapeText(shape), px: px(shape), py: py(shape) });
      continue;
    }

    if (mn.includes('ec_task') || (fc === 'EEF8DD' && getSubShapeText(shape, 'ipcode'))) {
      // Only treat a green fill shape as a task when it has an IpCode sub-shape (filters bare Rect anchors).
      const nameText = getSubShapeText(shape, 'name') || getShapeText(shape);
      const ipCode   = getSubShapeText(shape, 'ipcode');
      tasks.push({ id, text: nameText, ipCode, px: px(shape), py: py(shape) });
      continue;
    }

    if (mn.includes('ec_integration') || mn.includes('integrationnode') || fc === 'E7F1FE' || fc.startsWith('E7F')) {
      const nameText = getSubShapeText(shape, 'name') || getShapeText(shape);
      const ipCode   = getSubShapeText(shape, 'ipcode');
      integrations.push({ id, text: nameText, ipCode, px: px(shape), py: py(shape) });
      continue;
    }
  }

  // Parse page-level Connects section (connector endpoints stored here in many Visio versions).
  const connectors = [];
  for (const connEl of allByTag(pageDoc, 'Connects').flatMap(el => directChildrenByTag(el, 'Connect'))) {
    connectors.push({
      fromSheet: attr(connEl, 'FromSheet'),
      fromPart:  attr(connEl, 'FromPart'),
      toSheet:   attr(connEl, 'ToSheet'),
    });
  }

  // Group page-level Connect entries by FromSheet to reconstruct each connector's src→dst pair.
  const connBySheet = new Map();
  for (const c of connectors) {
    if (!connBySheet.has(c.fromSheet)) connBySheet.set(c.fromSheet, { src: null, dst: null });
    if (c.fromPart === '9')  connBySheet.get(c.fromSheet).src = resolveId(c.toSheet);
    if (c.fromPart === '12') connBySheet.get(c.fromSheet).dst = resolveId(c.toSheet);
  }

  // Build sets of shapes with at least one incoming or outgoing connector.
  const hasIncoming = new Set(Array.from(connBySheet.values()).filter(c => c.dst).map(c => c.dst));
  const hasOutgoing = new Set(Array.from(connBySheet.values()).filter(c => c.src).map(c => c.src));

  // Include integration nodes that have at least one connector (incoming OR outgoing).
  // Triggering sub-processes sit before step -010 and have outgoing connectors but no incoming;
  // pure context shapes shown for reference have neither — those alone are excluded.
  const filteredIntegrations = integrations.filter(s => hasIncoming.has(s.id) || hasOutgoing.has(s.id));

  // Discard blank swim lane entries (Swimlane List master shapes have no text); sort top→bottom.
  const validLanes = swimLanes.filter(l => l.text.trim());
  validLanes.sort((a, b) => b.py - a.py);

  // Assign each step's Security Group column from the nearest swim lane by PinY.
  const nearestLane = pinY => {
    if (!validLanes.length) return '';
    return validLanes.reduce((best, lane) =>
      Math.abs(lane.py - pinY) < Math.abs(best.py - pinY) ? lane : best
    ).text;
  };

  // Determine step type from name prefix; EC_Task default is Action, EC_IntegrationNode default is Sub Process.
  const stepTypeFromText = (text, cat) => {
    const prefixes = [
      ['Initiation:',          'Initiation'],
      ['Action:',              'Action'],
      ['Approval:',            'Approval'],
      ['System Notification:', 'System Notification'],
      ['Custom Notification:', 'Custom Notification'],
      ['To Do:',               'To Do'],
      ['Service:',             'Sub Process'],
    ];
    for (const [pfx, type] of prefixes) {
      if (text.startsWith(pfx)) return { type, name: text.slice(pfx.length).trim() };
    }
    return { type: cat === 'integration' ? 'Sub Process' : 'Action', name: text };
  };

  // Convert 0-based index to sequential letter(s): 0→a, 25→z, 26→aa, etc.
  const toLetter = i => {
    let s = '';
    let n = i + 1;
    while (n > 0) {
      s = String.fromCharCode(96 + (n % 26 || 26)) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };

  // Extract the trailing numeric ID from a same-process IpCode (e.g. "HR-020-160-080" → 80).
  // Cross-process references like "HR-060-030" have only 3 segments → return null so they sort by connector graph.
  const extractIpNum = s => {
    if (!s.ipCode) return null;
    const parts = s.ipCode.split('-');
    if (parts.length < 4) return null;
    const m = s.ipCode.match(/[-](\d+)$/);
    return m ? parseInt(m[1], 10) : null;
  };

  // Build incoming and outgoing adjacency maps: shape ID → list of connected shape IDs.
  const incomingFrom = new Map();
  const outgoingFrom = new Map();
  for (const { src, dst } of connBySheet.values()) {
    if (src && dst) {
      if (!incomingFrom.has(dst)) incomingFrom.set(dst, []);
      incomingFrom.get(dst).push(src);
      if (!outgoingFrom.has(src)) outgoingFrom.set(src, []);
      outgoingFrom.get(src).push(dst);
    }
  }
  const ipShapeMap = new Map([...tasks, ...filteredIntegrations].map(s => [s.id, s]));
  // Walk back through the incomingFrom graph to find the highest IpCode rank reachable from a node.
  const findMaxIpRank = (startId, depth = 0) => {
    if (depth > 8) return -1;
    let maxRank = -1;
    for (const predId of (incomingFrom.get(startId) || [])) {
      const pred = ipShapeMap.get(predId);
      if (pred) { const r = extractIpNum(pred); if (r !== null && r > maxRank) maxRank = r; }
      if (!pred || extractIpNum(pred) === null) {
        const deeper = findMaxIpRank(predId, depth + 1);
        if (deeper > maxRank) maxRank = deeper;
      }
    }
    return maxRank;
  };
  // A triggering sub-process has an outgoing connector to a numbered step but no same-process IpCode.
  const isTriggering = id => (outgoingFrom.get(id) || [])
    .some(dst => { const s = ipShapeMap.get(dst); return s && extractIpNum(s) !== null; });
  // Unified sort key: numbered steps by IpCode suffix; triggering subs before first step (-1);
  // gateway-adjacent shapes by predecessor rank (+0.5); all others at the end (1e9).
  const sortKey = shape => {
    const ipNum = extractIpNum(shape);
    if (ipNum !== null) return ipNum;
    const maxRank = findMaxIpRank(shape.id);
    if (maxRank >= 0) return maxRank + 0.5;
    if (isTriggering(shape.id)) return -1;
    return 1e9;
  };

  const allShapes = [
    ...tasks.map(s => ({ ...s, cat: 'task' })),
    ...filteredIntegrations.map(s => ({ ...s, cat: 'integration' })),
    ...conditions.map(s => ({ ...s, cat: 'condition' })),
  ].sort((a, b) => {
    const ak = sortKey(a), bk = sortKey(b);
    if (ak !== bk) return ak - bk;
    return a.px - b.px;
  });

  // Build a shape-by-ID lookup over all top-level shapes (includes connector line shapes).
  const shapeById = new Map(topLevelShapes.map(s => [attr(s, 'ID'), s]));

  // Extract branch labels from connector shapes (the "Yes" / "No" text on connector lines).
  const connectorBranchLabel = new Map();
  for (const [fromSheet] of connBySheet) {
    const connShape = shapeById.get(fromSheet);
    if (connShape) {
      const label = getShapeText(connShape).trim();
      if (label) connectorBranchLabel.set(fromSheet, label);
    }
  }

  // Assign COND-XXX IDs in flow order — conditions are already sorted in allShapes via sortKey.
  const condIdMap = new Map(
    allShapes
      .filter(s => s.cat === 'condition')
      .map((c, i) => [c.id, { condId: `COND-${String(i + 1).padStart(3, '0')}`, label: c.text || `Condition ${i + 1}` }]),
  );

  // Build stepConditions: for each step, collect all gateway branch strings pointing to it.
  // Format: "COND-001: <Gateway label> = <Branch label>"
  const stepConditions = new Map();
  for (const [fromSheet, conn] of connBySheet) {
    if (!conn.src || !conn.dst) continue;
    const condInfo = condIdMap.get(conn.src);
    if (!condInfo) continue; // source is not a gateway shape
    const branchLabel = connectorBranchLabel.get(fromSheet) || '';
    const condStr = branchLabel
      ? `${condInfo.condId}: ${condInfo.label} = ${branchLabel}`
      : `${condInfo.condId}: ${condInfo.label}`;
    if (!stepConditions.has(conn.dst)) stepConditions.set(conn.dst, []);
    stepConditions.get(conn.dst).push(condStr);
  }

  // Build steps array: [Order, Name, Type, Desc, CondRules, SecGroup, Routing, Optional, DueDate, Delay, WorkdayStep]
  const steps = allShapes.map((shape, i) => {
    if (shape.cat === 'condition') {
      // Condition Rule rows are excluded from Section 7 in docxBuilder — kept here for conditionRules return only.
      return [toLetter(i), shape.text || `Condition ${i + 1}`, 'Condition Rule', '', 'N/A', '', 'N/A', 'No', 'N/A', 'N/A', 'Yes'];
    }
    const { type, name } = stepTypeFromText(shape.text || '', shape.cat);
    // Prepend IpCode to step name: "HR-020-030-010 Browse Posted Jobs"
    const stepName    = shape.ipCode ? `${shape.ipCode} ${name}` : name;
    const workdayStep = type === 'To Do' ? 'Off System Process' : 'Yes';
    const condText    = stepConditions.has(shape.id)
      ? stepConditions.get(shape.id).join('\n')
      : 'N/A';
    return [toLetter(i), stepName, type, '', condText, nearestLane(shape.py), 'N/A', 'No', 'N/A', 'N/A', workdayStep];
  });

  // Condition rules in flow order (matching the condIdMap COND-XXX assignment above).
  const conditionRules = allShapes
    .filter(s => s.cat === 'condition')
    .map((s, i) => ({
      id:   `COND-${String(i + 1).padStart(3, '0')}`,
      name: s.text || `Condition ${i + 1}`,
    }));

  return {
    steps,
    bpSteps:             steps.filter(s => !['System Notification', 'Custom Notification', 'To Do', 'Condition Rule'].includes(s[2])),
    systemNotifications: steps.filter(s => s[2] === 'System Notification'),
    customNotifications: steps.filter(s => s[2] === 'Custom Notification'),
    todos:               steps.filter(s => s[2] === 'To Do'),
    conditionRules,
    swimLanes:           validLanes.map(s => s.text),
  };
}

module.exports = { parseVisio };
