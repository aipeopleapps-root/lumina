import React, { useState, useRef, useEffect } from 'react';
import {
  triggerDemoGenerate,
  getDemoGenerate,
  type PiAgent,
  type PiDemoStatus,
} from '../lib/api';
import { Spinner } from './Spinner';

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';

interface Props {
  processId: string;
  agents: PiAgent[];
  onDemoStatusChange: (status: { demo_status: PiDemoStatus; download_url: string | null }) => void;
  initialStatus?: PiDemoStatus;
  initialDownloadUrl?: string | null;
}

export function AgentReviewPanel({ processId, agents, onDemoStatusChange, initialStatus, initialDownloadUrl }: Props) {
  const [reviewed, setReviewed] = useState<PiAgent[]>(agents);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<PiDemoStatus>(initialStatus ?? 'not_generated');
  const [downloadUrl, setDownloadUrl] = useState<string | null>(initialDownloadUrl ?? null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Resume polling if the panel is reopened while a run from an earlier
    // open (or a page reload) is still in flight.
    if (initialStatus === 'generating') startPolling();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const included = reviewed.filter(a => !removed.has(a.agent_id));

  function toggleOpen(id: string) {
    setOpen(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleRemoved(id: string) {
    setRemoved(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function move(id: string, dir: -1 | 1) {
    setReviewed(prev => {
      const idx = prev.findIndex(a => a.agent_id === id);
      const swapWith = idx + dir;
      if (idx < 0 || swapWith < 0 || swapWith >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
      return next;
    });
  }

  function updateAgent(id: string, patch: Partial<PiAgent>) {
    setReviewed(prev => prev.map(a => (a.agent_id === id ? { ...a, ...patch } : a)));
  }

  function startPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const result = await getDemoGenerate(processId);
        setStatus(result.demo_status);
        setDownloadUrl(result.download_url);
        onDemoStatusChange({ demo_status: result.demo_status, download_url: result.download_url });
        if (result.demo_status === 'done' || result.demo_status === 'failed') {
          if (result.demo_status === 'failed') setError(result.demo_error || 'Demo generation failed');
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch (err: any) {
        setError(err.message || 'Failed to check demo status');
        if (pollRef.current) clearInterval(pollRef.current);
      }
    }, 3000);
  }

  async function handleConfirm() {
    setApplying(true);
    setError('');
    try {
      const result = await triggerDemoGenerate(processId, {
        agents: included.map(a => ({
          agent_id: a.agent_id,
          kind: a.kind ?? 'workspace',
          name: a.name,
          description: a.description ?? '',
        })),
      });
      setStatus(result.demo_status);
      onDemoStatusChange({ demo_status: result.demo_status, download_url: null });
      startPolling();
    } catch (err: any) {
      setError(err.message || 'Failed to start demo generation');
    } finally {
      setApplying(false);
    }
  }

  const busy = applying || status === 'generating';

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', fontFamily: FONT }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <p style={{ color: '#6E6E73', fontSize: 12.5, lineHeight: 1.6, margin: '14px 18px 4px' }}>
          Edit, reorder, or remove agents before generating the client-facing demo. The order below is the order agents appear in the demo's sidebar.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {reviewed.map((agent, idx) => (
            <AgentReviewCard
              key={agent.agent_id}
              agent={agent}
              index={idx}
              total={reviewed.length}
              isRemoved={removed.has(agent.agent_id)}
              isOpen={open.has(agent.agent_id)}
              onToggleOpen={() => toggleOpen(agent.agent_id)}
              onToggleRemoved={() => toggleRemoved(agent.agent_id)}
              onMove={dir => move(agent.agent_id, dir)}
              onChange={patch => updateAgent(agent.agent_id, patch)}
            />
          ))}
        </div>

        {status === 'done' && downloadUrl && (
          <div style={{ margin: '14px 18px 0', background: '#F0FBF4', border: '1px solid #C8EBD4', borderRadius: 10, padding: 12 }}>
            <p style={{ color: '#1B8A5A', fontSize: 12.5, fontWeight: 600, margin: '0 0 8px' }}>Demo ready</p>
            <button onClick={() => window.open(downloadUrl, '_blank')}
              style={{ width: '100%', padding: '9px', borderRadius: 999, fontSize: 12.5, fontWeight: 700,
                border: 'none', cursor: 'pointer', background: '#1B8A5A', color: '#fff', fontFamily: FONT }}>
              Download Demo
            </button>
          </div>
        )}
      </div>

      <div style={{ padding: '14px 20px', borderTop: '1px solid #E5E5EA', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: '#6E6E73' }}>
            <strong style={{ color: '#1D1D1F' }}>{included.length}</strong> of {reviewed.length} agents included
          </span>
        </div>
        {error && <p style={{ color: '#FF3B30', fontSize: 12, marginBottom: 8 }}>{error}</p>}
        <button onClick={handleConfirm} disabled={busy || included.length === 0}
          style={{
            width: '100%', padding: '12px', borderRadius: 999, fontSize: 14, fontWeight: 700,
            border: 'none', cursor: busy || included.length === 0 ? 'not-allowed' : 'pointer',
            background: busy || included.length === 0 ? '#E5E5EA' : '#0C0D0D',
            color: busy || included.length === 0 ? '#C7C7CC' : '#fff', fontFamily: FONT,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}>
          {busy && <Spinner size={14} color={included.length === 0 ? '#C7C7CC' : '#8E8E93'} trackColor="#D1D1D6" />}
          {busy ? 'Generating…' : status === 'done' ? 'Regenerate Demo' : 'Confirm & Generate Demo'}
        </button>
      </div>
    </div>
  );
}

function AgentReviewCard({ agent, index, total, isRemoved, isOpen, onToggleOpen, onToggleRemoved, onMove, onChange }: {
  agent: PiAgent;
  index: number;
  total: number;
  isRemoved: boolean;
  isOpen: boolean;
  onToggleOpen: () => void;
  onToggleRemoved: () => void;
  onMove: (dir: -1 | 1) => void;
  onChange: (patch: Partial<PiAgent>) => void;
}) {
  const kind = agent.kind ?? 'workspace';

  // Flat row + top divider, matching the Agents tab's browse list exactly
  // (same badge shape/colors, same row padding) — the two tabs are the same
  // list in two modes, not two differently-designed surfaces.
  return (
    <div style={{ borderTop: '1px solid #F5F5F7' }}>
      <div style={{ padding: '12px 18px', display: 'flex', alignItems: 'flex-start', gap: 8,
        opacity: isRemoved ? 0.45 : 1, transition: 'opacity 0.15s' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0, paddingTop: 1 }}>
          <button onClick={() => onMove(-1)} disabled={index === 0}
            style={{ background: 'none', border: 'none', cursor: index === 0 ? 'default' : 'pointer',
              color: index === 0 ? '#E5E5EA' : '#8E8E93', fontSize: 11, padding: 0, lineHeight: 1 }}>▲</button>
          <button onClick={() => onMove(1)} disabled={index === total - 1}
            style={{ background: 'none', border: 'none', cursor: index === total - 1 ? 'default' : 'pointer',
              color: index === total - 1 ? '#E5E5EA' : '#8E8E93', fontSize: 11, padding: 0, lineHeight: 1 }}>▼</button>
        </div>
        <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={onToggleOpen}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#1D1D1F', flex: 1, minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              textDecoration: isRemoved ? 'line-through' : 'none' }}>{agent.name}</span>
            <span style={{ padding: '1px 7px', borderRadius: 20, fontSize: 9, fontWeight: 700, flexShrink: 0,
              background: kind === 'conversational' ? '#E7F1FD' : '#FCF1DC',
              color: kind === 'conversational' ? '#0660BE' : '#B8790A' }}>
              {kind === 'conversational' ? 'Conversational' : 'Workspace'}
            </span>
          </div>
          {agent.description && (
            <p style={{ fontSize: 11, color: '#8E8E93', margin: '4px 0 0',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: isOpen ? 'normal' : 'nowrap', lineHeight: 1.5 }}>
              {agent.description}
            </p>
          )}
          {!isRemoved && (
            <span style={{ display: 'inline-block', marginTop: 6, fontSize: 10.5, color: '#ACACB2', fontWeight: 600 }}>
              {isOpen ? 'Hide details ⌃' : 'Edit details ⌄'}
            </span>
          )}
        </div>
        <button onClick={onToggleRemoved}
          style={{ background: 'none', border: 'none', color: isRemoved ? '#C7C7CC' : '#FF3B30', cursor: 'pointer',
            fontSize: 14, padding: 2, flexShrink: 0, marginTop: 1 }}>
          {isRemoved ? '↺' : '×'}
        </button>
      </div>
      {isOpen && !isRemoved && (
        <div style={{ padding: '0 18px 14px 30px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: '#6E6E73' }}>
            Name
            <input value={agent.name} onChange={e => onChange({ name: e.target.value })}
              style={{ display: 'block', width: '100%', marginTop: 4, border: '1.5px solid #E5E5EA', borderRadius: 8,
                padding: '7px 10px', fontSize: 12.5, fontFamily: FONT, color: '#1D1D1F', outline: 'none' }} />
          </label>
          <label style={{ fontSize: 11, fontWeight: 600, color: '#6E6E73' }}>
            Description
            <textarea value={agent.description ?? ''} onChange={e => onChange({ description: e.target.value })} rows={2}
              style={{ display: 'block', width: '100%', marginTop: 4, border: '1.5px solid #E5E5EA', borderRadius: 8,
                padding: '7px 10px', fontSize: 12.5, fontFamily: FONT, color: '#1D1D1F', outline: 'none', resize: 'vertical' }} />
          </label>
          <label style={{ fontSize: 11, fontWeight: 600, color: '#6E6E73' }}>
            Demo pattern
            <select value={kind} onChange={e => onChange({ kind: e.target.value as PiAgent['kind'] })}
              style={{ display: 'block', width: '100%', marginTop: 4, border: '1.5px solid #E5E5EA', borderRadius: 8,
                padding: '7px 10px', fontSize: 12.5, fontFamily: FONT, color: '#1D1D1F', outline: 'none', background: '#fff' }}>
              <option value="conversational">Conversational — genuine back-and-forth dialogue</option>
              <option value="workspace">Workspace — a document/dashboard a human reviews</option>
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
