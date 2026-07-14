import React, { useMemo, useId } from 'react';

// ── Shared graph shape ─────────────────────────────────────────────────────────
export interface MapGraph {
  swimlanes: { lane_id: string; label: string; persona?: string | null; position: number }[];
  steps: {
    step_id: string;
    lane_id: string | null;
    label: string;
    step_type?: string | null;
    ai_opportunity?: string | null;
    tooltip?: string | null;
  }[];
  connectors: { from: string; to: string; condition?: string | null }[];
}

// ── Layout ─────────────────────────────────────────────────────────────────────
const LANE_LABEL_W = 140;
const STEP_W       = 152;
const STEP_H       = 60;
const COL_GAP      = 44;
const LANE_H       = 108;
const PAD_X        = 20;
const PAD_Y        = 18;
const COL_W        = STEP_W + COL_GAP;

// ── AI opportunity palette ─────────────────────────────────────────────────────
const OPP: Record<string, { fill: string; stroke: string; text: string; badge: string }> = {
  sana_agent:     { fill: '#f0fdfa', stroke: '#0d9488', text: '#0f766e', badge: '#ccfbf1' },
  workday_native: { fill: '#f0fdf4', stroke: '#16a34a', text: '#15803d', badge: '#dcfce7' },
  partial_ai:     { fill: '#fffbeb', stroke: '#d97706', text: '#92400e', badge: '#fef3c7' },
  human_only:     { fill: '#f8fafc', stroke: '#cbd5e1', text: '#475569', badge: '#f1f5f9' },
};
const OPP_DEFAULT = OPP.human_only;

// Per-lane alternating background tones
const LANE_BG   = ['#f8fafc', '#f0f9ff', '#f5f3ff', '#fdf4ff', '#fff7ed', '#f0fdf4'];
const AI_LANE_BG = '#ecfdf5';

// ── Helpers ────────────────────────────────────────────────────────────────────
function wrapText(label: string, maxCh = 18): string[] {
  const words = label.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxCh && cur) {
      lines.push(cur);
      cur = w.length > maxCh ? w.slice(0, maxCh - 1) + '…' : w;
    } else {
      cur = next.length > maxCh ? next.slice(0, maxCh - 1) + '…' : next;
    }
    if (lines.length === 2) { lines.push(cur.slice(0, maxCh - 1) + '…'); return lines; }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

function topoColumns(
  steps: { step_id: string }[],
  connectors: { from: string; to: string }[],
): Map<string, number> {
  const ids = new Set(steps.map(s => s.step_id));
  const adj = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const id of ids) { adj.set(id, []); inDeg.set(id, 0); }
  for (const c of connectors) {
    if (!ids.has(c.from) || !ids.has(c.to) || c.from === c.to) continue;
    adj.get(c.from)!.push(c.to);
    inDeg.set(c.to, (inDeg.get(c.to) ?? 0) + 1);
  }
  const col = new Map<string, number>();
  const q: string[] = [];
  for (const [id, d] of inDeg) if (d === 0) { q.push(id); col.set(id, 0); }
  let h = 0;
  while (h < q.length) {
    const id = q[h++];
    const c = col.get(id)!;
    for (const nxt of adj.get(id)!) {
      if ((col.get(nxt) ?? -1) < c + 1) col.set(nxt, c + 1);
      const d = (inDeg.get(nxt) ?? 1) - 1;
      inDeg.set(nxt, d);
      if (d === 0) q.push(nxt);
    }
  }
  let max = 0;
  for (const c of col.values()) max = Math.max(max, c);
  for (const id of ids) if (!col.has(id)) col.set(id, ++max);
  return col;
}

// ── Shape renderers ────────────────────────────────────────────────────────────
function StepBox({
  x, y, label, stepType, aiOpp, tooltip, idx,
}: {
  x: number; y: number; label: string; stepType?: string | null;
  aiOpp?: string | null; tooltip?: string | null; idx: number;
}) {
  const s = OPP[aiOpp ?? ''] ?? OPP_DEFAULT;
  const lines = wrapText(label);
  const isDec = stepType === 'decision';
  const lineH = 14;
  const totalH = lines.length * lineH;
  const textY0 = y + STEP_H / 2 - totalH / 2 + lineH / 2;

  if (isDec) {
    // Diamond shape
    const cx = x + STEP_W / 2, cy = y + STEP_H / 2;
    const pts = `${cx},${y} ${x + STEP_W},${cy} ${cx},${y + STEP_H} ${x},${cy}`;
    return (
      <g>
        <polygon points={pts} fill={s.fill} stroke={s.stroke} strokeWidth={1.5} />
        {lines.map((ln, i) => (
          <text key={i} x={cx} y={textY0 + i * lineH}
            textAnchor="middle" dominantBaseline="middle"
            fontSize={10} fontWeight="500" fill={s.text} style={{ userSelect: 'none' }}>
            {ln}
          </text>
        ))}
        <title>{label}{tooltip ? `\n\n${tooltip}` : ''}</title>
      </g>
    );
  }

  // Standard rounded rectangle
  return (
    <g>
      <rect x={x} y={y} width={STEP_W} height={STEP_H} rx={6} ry={6}
        fill={s.fill} stroke={s.stroke} strokeWidth={1.5} />
      {/* Top-left step index badge */}
      <rect x={x + 4} y={y + 4} width={16} height={14} rx={3} fill={s.badge} />
      <text x={x + 12} y={y + 11} textAnchor="middle" dominantBaseline="middle"
        fontSize={8} fontWeight="700" fill={s.text} style={{ userSelect: 'none' }}>
        {idx + 1}
      </text>
      {lines.map((ln, i) => (
        <text key={i}
          x={x + STEP_W / 2}
          y={textY0 + i * lineH}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={11}
          fontWeight="500"
          fill={s.text}
          style={{ userSelect: 'none' }}>
          {ln}
        </text>
      ))}
      <title>{label}{tooltip ? `\n\n${tooltip}` : ''}</title>
    </g>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export function ProcessMap({ graph }: { graph: MapGraph }) {
  const uid = useId().replace(/:/g, '_');

  const layout = useMemo(() => {
    // Only include lanes that have at least one step
    const stepsWithLanes = new Set(graph.steps.map(s => s.lane_id).filter(Boolean));
    const lanes = [...graph.swimlanes]
      .filter(l => stepsWithLanes.has(l.lane_id))
      .sort((a, b) => a.position - b.position);
    const laneRowMap = new Map(lanes.map((l, i) => [l.lane_id, i]));

    const rawCols = topoColumns(graph.steps, graph.connectors);

    // Per-lane collision resolution: bump steps that share a column in the same lane
    const occupancy = new Map<string, number>();
    const finalCols = new Map<string, number>();
    const sorted = [...graph.steps].sort((a, b) =>
      (rawCols.get(a.step_id) ?? 0) - (rawCols.get(b.step_id) ?? 0));
    let maxCol = 0;
    for (const step of sorted) {
      const key = step.lane_id ?? '__none__';
      let c = rawCols.get(step.step_id) ?? 0;
      while (occupancy.get(`${key}:${c}`)) c++;
      occupancy.set(`${key}:${c}`, 1);
      finalCols.set(step.step_id, c);
      if (c > maxCol) maxCol = c;
    }

    // Pixel positions — centre of each step box
    const stepPos = new Map<string, { x: number; y: number; row: number }>();
    for (const step of graph.steps) {
      const c = finalCols.get(step.step_id) ?? 0;
      const row = step.lane_id ? (laneRowMap.get(step.lane_id) ?? lanes.length) : lanes.length;
      stepPos.set(step.step_id, {
        x: LANE_LABEL_W + PAD_X + c * COL_W,
        y: PAD_Y + row * LANE_H + (LANE_H - STEP_H) / 2,
        row,
      });
    }

    // Connector paths
    type ConnPath = { d: string; label?: string | null; lx: number; ly: number };
    const connPaths: ConnPath[] = [];

    for (const conn of graph.connectors) {
      const src = stepPos.get(conn.from);
      const dst = stepPos.get(conn.to);
      if (!src || !dst) continue;

      const sameLane = src.row === dst.row;
      const goRight  = dst.x >= src.x + STEP_W - 4;
      const goDown   = dst.row > src.row;
      const goUp     = dst.row < src.row;

      let d: string;
      let lx = 0, ly = 0;

      if (sameLane && goRight) {
        // Same lane, forward: S-curve exit right → enter left
        const x1 = src.x + STEP_W, y1 = src.y + STEP_H / 2;
        const x2 = dst.x,           y2 = dst.y + STEP_H / 2;
        const cx = x1 + (x2 - x1) / 2;
        d = `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`;
        lx = (x1 + x2) / 2; ly = (y1 + y2) / 2 - 8;
      } else if (!sameLane && goRight) {
        // Cross-lane, forward: exit bottom → enter top
        const x1 = src.x + STEP_W / 2, y1 = src.y + STEP_H;
        const x2 = dst.x + STEP_W / 2, y2 = dst.y;
        const my = (y1 + y2) / 2;
        d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
        lx = (x1 + x2) / 2; ly = my;
      } else if (!sameLane && !goRight) {
        // Cross-lane, backward: exit top → enter bottom (or similar)
        const x1 = src.x + STEP_W / 2, y1 = goDown ? src.y + STEP_H : src.y;
        const x2 = dst.x + STEP_W / 2, y2 = goDown ? dst.y : dst.y + STEP_H;
        const my = (y1 + y2) / 2;
        d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
        lx = (x1 + x2) / 2; ly = my;
      } else {
        // Same lane, backward: loop arc above the row
        const x1 = src.x + STEP_W / 2, y1 = src.y;
        const x2 = dst.x + STEP_W / 2, y2 = dst.y;
        const above = PAD_Y - 12;
        d = `M${x1},${y1} L${x1},${above} L${x2},${above} L${x2},${y2}`;
        lx = (x1 + x2) / 2; ly = above - 8;
      }

      connPaths.push({ d, label: conn.condition, lx, ly });
    }

    const svgW = LANE_LABEL_W + PAD_X + (maxCol + 1) * COL_W - COL_GAP + PAD_X;
    const svgH = PAD_Y + lanes.length * LANE_H + PAD_Y;

    return { lanes, stepPos, connPaths, svgW, svgH };
  }, [graph]);

  const { lanes, stepPos, connPaths, svgW, svgH } = layout;
  const arrowId = `arrow_${uid}`;

  return (
    <div style={{ overflowX: 'auto', overflowY: 'visible' }}>
      <svg width={svgW} height={svgH} style={{ display: 'block', minWidth: svgW }}>
        <defs>
          <marker id={arrowId} markerWidth={8} markerHeight={8}
            refX={7} refY={4} orient="auto">
            <path d="M1,1 L1,7 L8,4 z" fill="#94a3b8" />
          </marker>
          <filter id={`shadow_${uid}`} x="-5%" y="-5%" width="110%" height="110%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodColor="#00000015" />
          </filter>
        </defs>

        {/* Lane bands */}
        {lanes.map((lane, i) => {
          const isAi = lane.lane_id === 'ai_lane' || lane.label.toLowerCase().includes('sana');
          const bg = isAi ? AI_LANE_BG : LANE_BG[i % LANE_BG.length];
          const y = PAD_Y + i * LANE_H;
          const lbg = isAi ? '#a7f3d0' : '#e2e8f0';
          return (
            <g key={lane.lane_id}>
              {/* Full row fill */}
              <rect x={0} y={y} width={svgW} height={LANE_H} fill={bg} />
              {/* Horizontal divider */}
              <line x1={0} y1={y} x2={svgW} y2={y} stroke="#e2e8f0" strokeWidth={1} />
              {/* Lane label sidebar */}
              <rect x={0} y={y} width={LANE_LABEL_W} height={LANE_H} fill={lbg} />
              {/* Sidebar right border */}
              <line x1={LANE_LABEL_W} y1={y} x2={LANE_LABEL_W} y2={y + LANE_H}
                stroke="#cbd5e1" strokeWidth={1} />
              {/* Lane name */}
              <text x={LANE_LABEL_W / 2}
                y={y + LANE_H / 2 - (lane.persona && lane.persona !== lane.label ? 9 : 0)}
                textAnchor="middle" dominantBaseline="middle"
                fontSize={11} fontWeight="700"
                fill={isAi ? '#065f46' : '#374151'}
                style={{ userSelect: 'none' }}>
                {lane.label.length > 16 ? lane.label.slice(0, 15) + '…' : lane.label}
              </text>
              {/* Persona subtitle */}
              {lane.persona && lane.persona !== lane.label && (
                <text x={LANE_LABEL_W / 2} y={y + LANE_H / 2 + 10}
                  textAnchor="middle" dominantBaseline="middle"
                  fontSize={9} fill={isAi ? '#059669' : '#6b7280'}
                  style={{ userSelect: 'none' }}>
                  {lane.persona.length > 18 ? lane.persona.slice(0, 17) + '…' : lane.persona}
                </text>
              )}
            </g>
          );
        })}

        {/* Bottom border */}
        <line x1={0} y1={PAD_Y + lanes.length * LANE_H}
          x2={svgW} y2={PAD_Y + lanes.length * LANE_H}
          stroke="#e2e8f0" strokeWidth={1} />
        {/* Outer border */}
        <rect x={0} y={PAD_Y} width={svgW} height={lanes.length * LANE_H}
          fill="none" stroke="#cbd5e1" strokeWidth={1} rx={2} />

        {/* Connectors (behind step boxes) */}
        {connPaths.map((p, i) => (
          <g key={i}>
            <path d={p.d} fill="none" stroke="#94a3b8" strokeWidth={1.5}
              strokeDasharray={undefined}
              markerEnd={`url(#${arrowId})`} />
            {p.label && (
              <text x={p.lx} y={p.ly} textAnchor="middle"
                fontSize={9} fill="#6b7280"
                style={{ userSelect: 'none' }}>
                {p.label}
              </text>
            )}
          </g>
        ))}

        {/* Step boxes */}
        {graph.steps.map((step, idx) => {
          const pos = stepPos.get(step.step_id);
          if (!pos) return null;
          return (
            <g key={step.step_id} filter={`url(#shadow_${uid})`}>
              <StepBox
                x={pos.x} y={pos.y}
                label={step.label}
                stepType={step.step_type}
                aiOpp={step.ai_opportunity}
                tooltip={step.tooltip}
                idx={idx}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Standalone legend (reusable) ───────────────────────────────────────────────
export function MapLegend({ className = '' }: { className?: string }) {
  const items = [
    { key: 'sana_agent',     label: 'Sana Agent',     dot: '#0d9488' },
    { key: 'workday_native', label: 'Workday Native',  dot: '#16a34a' },
    { key: 'partial_ai',     label: 'AI-Assisted',     dot: '#d97706' },
    { key: 'human_only',     label: 'Human Only',      dot: '#94a3b8' },
  ];
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${className}`}>
      {items.map(it => (
        <div key={it.key} className="flex items-center gap-1.5">
          <span style={{ background: it.dot }} className="w-2.5 h-2.5 rounded-sm shrink-0 inline-block" />
          <span className="text-xs text-slate-500">{it.label}</span>
        </div>
      ))}
      <span className="text-xs text-slate-400 ml-auto">Hover steps for AI rationale</span>
    </div>
  );
}
