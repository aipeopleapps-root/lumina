import React, { useEffect, useState } from 'react';
import {
  generateRecommendations,
  getRecommendations,
  applyRecommendationsAndGenerate,
  getTobeGraphAndAgents,
  type PiGraph,
  type PiIntervention,
  type PiRecommendations,
  type PiTobeGraph,
  type PiAgent,
} from '../lib/api';

const TOBE_POLL_INTERVAL_MS = 2500;
const TOBE_POLL_TIMEOUT_MS = 5 * 60 * 1000;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';

const IMPACT_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  high:   { bg: '#FDE8E8', text: '#C0342A', label: 'High' },
  medium: { bg: '#FFF5E5', text: '#C27D0E', label: 'Medium' },
};

interface Props {
  processId: string;
  graph: PiGraph;
  onApplied: (result: { tobe: PiTobeGraph; proposed_agents: PiAgent[] }) => void;
  onClose: () => void;
}

export function AiRecommendationsPanel({ processId, graph, onApplied, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [recs, setRecs] = useState<PiRecommendations | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [directions, setDirections] = useState('');

  const labelForStep = (stepId: string) => graph.steps.find(s => s.step_id === stepId)?.label ?? stepId;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        let existing = await getRecommendations(processId);
        if (!existing) existing = await generateRecommendations(processId);
        if (cancelled) return;
        setRecs(existing);
        setSelected(new Set(existing.interventions.map(i => i.intervention_id)));
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Failed to load recommendations');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [processId]);

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleApply() {
    setApplying(true);
    setError('');
    try {
      await applyRecommendationsAndGenerate(processId, {
        selected_intervention_ids: [...selected],
        additional_directions: directions.trim() || undefined,
      });

      const deadline = Date.now() + TOBE_POLL_TIMEOUT_MS;
      let result = await getTobeGraphAndAgents(processId);
      while (result.tobe_status === 'generating') {
        if (Date.now() > deadline) throw new Error('Generation is taking longer than expected — try again shortly.');
        await sleep(TOBE_POLL_INTERVAL_MS);
        result = await getTobeGraphAndAgents(processId);
      }
      if (result.tobe_status === 'failed') {
        throw new Error(result.tobe_error || 'Generation failed');
      }
      if (!result.tobe) {
        throw new Error('Generation finished but returned no result — try again.');
      }
      onApplied({ tobe: result.tobe, proposed_agents: result.proposed_agents });
    } catch (err: any) {
      setError(err.message || 'Generation failed');
    } finally {
      setApplying(false);
    }
  }

  const total = recs?.interventions.length ?? 0;

  return (
    <div style={{
      position: 'absolute', top: 0, right: 0, bottom: 0, width: 420, maxWidth: '92%',
      background: '#fff', borderLeft: '1px solid #E5E5EA', boxShadow: '-4px 0 24px rgba(0,0,0,0.08)',
      display: 'flex', flexDirection: 'column', fontFamily: FONT, zIndex: 20,
    }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid #E5E5EA', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <span style={{ fontSize: 16 }}>💡</span>
        <span style={{ fontSize: 15, fontWeight: 700, color: '#1D1D1F', flex: 1 }}>AI Recommendations</span>
        <button onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8E8E93', fontSize: 20, lineHeight: 1, padding: 2 }}>
          ×
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px' }}>
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '40px 0' }}>
            <style>{`@keyframes recs-spin { to { transform: rotate(360deg) } }`}</style>
            <div style={{ width: 32, height: 32, border: '3px solid #E5E5EA', borderTopColor: '#0071E3',
              borderRadius: '50%', animation: 'recs-spin 0.9s linear infinite' }} />
            <p style={{ color: '#6E6E73', fontSize: 13 }}>Analysing the process for AI opportunities…</p>
          </div>
        ) : error ? (
          <div style={{ background: '#FFF0F0', border: '1px solid #FFD5D5', borderRadius: 10, padding: 12 }}>
            <p style={{ color: '#FF3B30', fontSize: 13, margin: 0 }}>{error}</p>
          </div>
        ) : recs ? (
          <>
            <p style={{ color: '#6E6E73', fontSize: 13, lineHeight: 1.6, marginBottom: 16 }}>{recs.intro}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {recs.interventions.map(iv => (
                <InterventionCard key={iv.intervention_id} iv={iv}
                  checked={selected.has(iv.intervention_id)}
                  onToggle={() => toggle(iv.intervention_id)}
                  labelForStep={labelForStep} />
              ))}
            </div>

            <div style={{ marginTop: 20 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#1D1D1F', marginBottom: 8 }}>
                💬 Additional Directions
              </label>
              <textarea value={directions} onChange={e => setDirections(e.target.value)}
                placeholder="Add specific instructions for the AI (e.g., 'Focus on customer-facing steps' or 'Keep manual approvals for orders over $10k')"
                rows={3}
                style={{ width: '100%', border: '1.5px solid #E5E5EA', borderRadius: 10, padding: '10px 12px',
                  fontSize: 13, fontFamily: FONT, color: '#1D1D1F', outline: 'none', resize: 'vertical', background: '#F5F5F7' }} />
            </div>
          </>
        ) : null}
      </div>

      {recs && !loading && (
        <div style={{ padding: '14px 20px', borderTop: '1px solid #E5E5EA', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: '#6E6E73' }}>
              <strong style={{ color: '#1D1D1F' }}>{selected.size}</strong> of {total} selected
            </span>
            <button
              onClick={() => setSelected(selected.size === total ? new Set() : new Set(recs.interventions.map(i => i.intervention_id)))}
              style={{ background: 'none', border: 'none', color: '#0071E3', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
              {selected.size === total ? 'Deselect All' : 'Select All'}
            </button>
          </div>
          {error && <p style={{ color: '#FF3B30', fontSize: 12, marginBottom: 8 }}>{error}</p>}
          <button onClick={handleApply} disabled={applying || selected.size === 0}
            style={{
              width: '100%', padding: '12px', borderRadius: 980, fontSize: 14, fontWeight: 700,
              border: 'none', cursor: applying || selected.size === 0 ? 'not-allowed' : 'pointer',
              background: applying || selected.size === 0 ? '#E5E5EA' : '#0071E3',
              color: applying || selected.size === 0 ? '#C7C7CC' : '#fff', fontFamily: FONT,
            }}>
            {applying ? 'Generating…' : 'Apply & Generate'}
          </button>
        </div>
      )}
    </div>
  );
}

function InterventionCard({ iv, checked, onToggle, labelForStep }: {
  iv: PiIntervention; checked: boolean; onToggle: () => void; labelForStep: (id: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const impact = IMPACT_STYLE[iv.impact] ?? IMPACT_STYLE.medium;

  return (
    <div style={{ border: `1.5px solid ${checked ? '#0071E3' : '#E5E5EA'}`, borderRadius: 12, overflow: 'hidden', transition: 'border-color 0.15s' }}>
      <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <input type="checkbox" checked={checked} onChange={onToggle}
          style={{ marginTop: 3, width: 16, height: 16, flexShrink: 0, cursor: 'pointer', accentColor: '#0071E3' }} />
        <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setOpen(v => !v)}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#1D1D1F', lineHeight: 1.4 }}>{iv.title}</span>
            <span style={{ flexShrink: 0, padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700,
              background: impact.bg, color: impact.text }}>
              {impact.label}
            </span>
          </div>
          <p style={{ margin: '6px 0 0', fontSize: 11.5, color: '#6E6E73', lineHeight: 1.5 }}>
            Replaces: {iv.replaces_step_ids.map((id, i) => (
              <React.Fragment key={id}>
                {i > 0 && ', '}
                <strong style={{ color: '#3A3A3C' }}>{labelForStep(id)}</strong> ({id})
              </React.Fragment>
            ))}
          </p>
        </div>
        <button onClick={() => setOpen(v => !v)}
          style={{ background: 'none', border: 'none', color: '#C7C7CC', cursor: 'pointer', fontSize: 12, padding: 2, flexShrink: 0 }}>
          {open ? '▴' : '▾'}
        </button>
      </div>
      {open && (
        <div style={{ padding: '0 14px 12px 40px', borderTop: '1px solid #F5F5F7' }}>
          <p style={{ fontSize: 12, color: '#3A3A3C', lineHeight: 1.6, margin: '10px 0 0' }}>{iv.description}</p>
        </div>
      )}
    </div>
  );
}
