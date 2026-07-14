import React, { useMemo } from 'react';

// ── Shared graph shape ─────────────────────────────────────────────────────────
// Both PiGraph (as-is) and PiTobeGraph (to-be) are mapped to this before rendering.
export interface MapGraph {
  swimlanes: { lane_id: string; label: string; persona?: string | null; position: number }[];
  steps: { step_id: string; lane_id: string | null; label: string; ai_opportunity?: string | null; tooltip?: string | null }[];
  connectors: { from: string; to: string; condition?: string | null }[];
}

// ── Layout constants ───────────────────────────────────────────────────────────
const LANE_LABEL_W = 126;
const STEP_W = 150;
const STEP_H = 58;
const COL_GAP = 36;
const LANE_H = 100;
const PAD_X = 16;
const PAD_Y = 14;
const COL_W = STEP_W + COL_GAP;
const ARROW_SIZE = 7;

// ── AI opportunity colours ─────────────────────────────────────────────────────
const OPP_STYLE: Record<string, { fill: string; stroke: string; text: string }> = {
  sana_agent:     { fill: '#f0fdfa', stroke: '#0d9488', text: '#0f766e' },
  workday_native: { fill: '#f0fdf4', stroke: '#16a34a', text: '#15803d' },
  partial_ai:     { fill: '#fffbeb', stroke: '#d97706', text: '#92400e' },
  human_only:     { fill: '#f8fafc', stroke: '#94a3b8', text: '#475569' },
};
const DEFAULT_STYLE = OPP_STYLE.human_only;

const LANE_BG = [
  '#f8fafc', '#f0f9ff', '#f0fdf4', '#fefce8',
  '#fdf4ff', '#fff1f2', '#f0fdfa', '#fffbeb',
];
const AI_LANE_BG = '#f0fdfa';

// ── Text wrapping ──────────────────────────────────────────────────────────────
function wrapLabel(label: string, maxChars = 17): [string, string] {
  if (label.length <= maxChars) return [label, ''];
  const words = label.split(' ');
  let l1 = '';
  for (let i = 0; i < words.length; i++) {
    const cand = l1 ? `${l1} ${words[i]}` : words[i];
    if (cand.length <= maxChars) {
      l1 = cand;
    } else {
      let l2 = words.slice(i).join(' ');
      if (l2.length > maxChars + 4) l2 = l2.slice(0, maxChars + 1) + '…';
      return [l1 || cand.slice(0, maxChars), l2];
    }
  }
  return [l1, ''];
}

// ── Topological column assignment ──────────────────────────────────────────────
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
    inDeg.set(c.to, (inDeg.get(c.to) || 0) + 1);
  }

  const col = new Map<string, number>();
  const queue: string[] = [];
  for (const [id, d] of inDeg) {
    if (d === 0) { queue.push(id); col.set(id, 0); }
  }

  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    const c = col.get(id)!;
    for (const next of adj.get(id)!) {
      if ((col.get(next) ?? -1) < c + 1) col.set(next, c + 1);
      const deg = (inDeg.get(next) || 1) - 1;
      inDeg.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  let max = 0;
  for (const c of col.values()) max = Math.max(max, c);
  for (const id of ids) if (!col.has(id)) col.set(id, ++max);

  return col;
}

// ── Main component ─────────────────────────────────────────────────────────────
export function ProcessMap({ graph }: { graph: MapGraph }) {
  const layout = useMemo(() => {
    const lanes = [...graph.swimlanes].sort((a, b) => a.position - b.position);
    const laneRowMap = new Map(lanes.map((l, i) => [l.lane_id, i]));

    const cols = topoColumns(graph.steps, graph.connectors);
    let maxCol = 0;
    for (const c of cols.values()) maxCol = Math.max(maxCol, c);

    const occupancy = new Map<string, number>();
    const finalCols = new Map<string, number>();
    const stepsSorted = [...graph.steps].sort((a, b) =>
      (cols.get(a.step_id) ?? 0) - (cols.get(b.step_id) ?? 0)
    );
    for (const step of stepsSorted) {
      const laneKey = step.lane_id ?? '__none__';
      let c = cols.get(step.step_id) ?? 0;
      while (occupancy.get(`${laneKey}:${c}`)) c++;
      occupancy.set(`${laneKey}:${c}`, 1);
      finalCols.set(step.step_id, c);
      if (c > maxCol) maxCol = c;
    }

    const stepPos = new Map<string, { x: number; y: number }>();
    for (const step of graph.steps) {
      const c = finalCols.get(step.step_id) ?? 0;
      const row = step.lane_id ? (laneRowMap.get(step.lane_id) ?? lanes.length) : lanes.length;
      stepPos.set(step.step_id, {
        x: LANE_LABEL_W + PAD_X + c * COL_W,
        y: PAD_Y + row * LANE_H + (LANE_H - STEP_H) / 2,
      });
    }

    type ConnPath = { d: string; condition?: string | null; labelX: number; labelY: number };
    const connPaths: ConnPath[] = [];
    for (const conn of graph.connectors) {
      const from = stepPos.get(conn.from);
      const to = stepPos.get(conn.to);
      if (!from || !to) continue;

      const x1 = from.x + STEP_W;
      const y1 = from.y + STEP_H / 2;
      const x2 = to.x;
      const y2 = to.y + STEP_H / 2;

      let d: string;
      if (x2 < x1 + 10) {
        const above = PAD_Y - 20;
        d = `M ${x1} ${y1} L ${x1 + 10} ${above} L ${x2 - 10} ${above} L ${x2} ${y2}`;
      } else {
        const cx = x1 + (x2 - x1) / 2;
        d = `M ${x1} ${y1} C ${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`;
      }

      connPaths.push({ d, condition: conn.condition, labelX: (x1 + x2) / 2, labelY: (y1 + y2) / 2 - 6 });
    }

    const svgW = LANE_LABEL_W + PAD_X + (maxCol + 1) * COL_W - COL_GAP + PAD_X;
    const svgH = PAD_Y + lanes.length * LANE_H + PAD_Y;

    return { lanes, stepPos, connPaths, svgW, svgH };
  }, [graph]);

  const { lanes, stepPos, connPaths, svgW, svgH } = layout;

  return (
    <div style={{ overflowX: 'auto', overflowY: 'visible' }}>
      <svg width={svgW} height={svgH} style={{ display: 'block', minWidth: svgW }}>
        <defs>
          <marker id="map-arrow" markerWidth={ARROW_SIZE} markerHeight={ARROW_SIZE}
            refX={ARROW_SIZE - 1} refY={ARROW_SIZE / 2} orient="auto">
            <path d={`M0,0 L0,${ARROW_SIZE} L${ARROW_SIZE},${ARROW_SIZE / 2} z`} fill="#94a3b8" />
          </marker>
        </defs>

        {lanes.map((lane, i) => {
          const isAiLane = lane.lane_id === 'ai_lane' || lane.label.toLowerCase().includes('sana');
          const bg = isAiLane ? AI_LANE_BG : LANE_BG[i % LANE_BG.length];
          const y = PAD_Y + i * LANE_H;
          return (
            <g key={lane.lane_id}>
              <rect x={0} y={y} width={svgW} height={LANE_H} fill={bg} stroke="#e2e8f0" strokeWidth={1} />
              <rect x={0} y={y} width={LANE_LABEL_W} height={LANE_H}
                fill={isAiLane ? '#ccfbf1' : '#f1f5f9'} stroke="#e2e8f0" strokeWidth={1} />
              <text x={LANE_LABEL_W / 2}
                y={y + LANE_H / 2 - (lane.persona && lane.persona !== lane.label ? 8 : 0)}
                textAnchor="middle" dominantBaseline="middle"
                fontSize={11} fontWeight="600"
                fill={isAiLane ? '#0f766e' : '#475569'}
                style={{ userSelect: 'none' }}>
                {lane.label.length > 15 ? lane.label.slice(0, 14) + '…' : lane.label}
              </text>
              {lane.persona && lane.persona !== lane.label && (
                <text x={LANE_LABEL_W / 2} y={y + LANE_H / 2 + 10}
                  textAnchor="middle" dominantBaseline="middle"
                  fontSize={9} fill={isAiLane ? '#5eead4' : '#94a3b8'}
                  style={{ userSelect: 'none' }}>
                  {lane.persona.length > 17 ? lane.persona.slice(0, 16) + '…' : lane.persona}
                </text>
              )}
            </g>
          );
        })}

        {connPaths.map((p, i) => (
          <g key={i}>
            <path d={p.d} fill="none" stroke="#94a3b8" strokeWidth={1.5} markerEnd="url(#map-arrow)" />
            {p.condition && (
              <text x={p.labelX} y={p.labelY} textAnchor="middle"
                fontSize={9} fill="#94a3b8" style={{ userSelect: 'none' }}>
                {p.condition}
              </text>
            )}
          </g>
        ))}

        {graph.steps.map(step => {
          const pos = stepPos.get(step.step_id);
          if (!pos) return null;
          const style = OPP_STYLE[step.ai_opportunity || ''] ?? DEFAULT_STYLE;
          const [line1, line2] = wrapLabel(step.label);
          const hasTwo = Boolean(line2);
          const textY1 = pos.y + (hasTwo ? STEP_H / 2 - 9 : STEP_H / 2);
          const textY2 = pos.y + STEP_H / 2 + 9;
          return (
            <g key={step.step_id}>
              <rect x={pos.x} y={pos.y} width={STEP_W} height={STEP_H} rx={7} ry={7}
                fill={style.fill} stroke={style.stroke} strokeWidth={1.5} />
              <text x={pos.x + STEP_W / 2} y={textY1}
                textAnchor="middle" dominantBaseline="middle"
                fontSize={11} fontWeight="500" fill={style.text} style={{ userSelect: 'none' }}>
                {line1}
              </text>
              {hasTwo && (
                <text x={pos.x + STEP_W / 2} y={textY2}
                  textAnchor="middle" dominantBaseline="middle"
                  fontSize={11} fontWeight="500" fill={style.text} style={{ userSelect: 'none' }}>
                  {line2}
                </text>
              )}
              <title>{step.label}{step.tooltip ? `\n\n${step.tooltip}` : ''}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
