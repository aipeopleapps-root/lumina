import { useCallback, useEffect, useRef, useState } from 'react';
import { getAgentLld, triggerAgentLld, type PiAgent } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { downloadBlob } from '../lib/download';

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';

interface Props {
  processId: string;
  agentId: string;
  agentName: string;
  onBack: () => void;
}

export function AgentDesignDoc({ processId, agentId, agentName, onBack }: Props) {
  const [agent, setAgent] = useState<PiAgent | null>(null);
  const [error, setError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPolling = useCallback(() => { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null; }, []);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const a = await getAgentLld(processId, agentId);
        if (cancelled) return;
        setAgent(a);
        if (a.lld_status === 'done' || a.lld_status === 'failed') stopPolling();
      } catch (err: any) {
        if (!cancelled) { setError(err.message || 'Failed to load document'); stopPolling(); }
      }
    }

    async function start() {
      try {
        const initial = await getAgentLld(processId, agentId);
        if (cancelled) return;
        setAgent(initial);
        if (initial.lld_status === 'not_generated') {
          await triggerAgentLld(processId, agentId);
          if (cancelled) return;
          setAgent({ ...initial, lld_status: 'generating' });
          pollRef.current = setInterval(poll, 2500);
        } else if (initial.lld_status === 'generating') {
          pollRef.current = setInterval(poll, 2500);
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Failed to start document generation');
      }
    }

    start();
    return () => { cancelled = true; stopPolling(); };
  }, [processId, agentId, stopPolling]);

  function handleExport() {
    if (!agent?.lld_markdown) return;
    const filename = `Agent Design — ${agentName}.md`;
    downloadBlob(filename, agent.lld_markdown, 'text/markdown');
  }

  const status = agent?.lld_status ?? 'generating';

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#F5F5F7', fontFamily: FONT, overflow: 'hidden' }}>
      {/* Top bar */}
      <div style={{ background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(12px)', borderBottom: '1px solid #E5E5EA',
        padding: '12px 24px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <button onClick={onBack}
          style={{ padding: '7px 14px', borderRadius: 980, fontSize: 13, fontWeight: 500, border: '1px solid #E5E5EA',
            cursor: 'pointer', background: '#fff', color: '#6E6E73', display: 'flex', alignItems: 'center', gap: 5, fontFamily: FONT }}>
          <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
          Agentic Workflow
        </button>
        <div style={{ flex: 1 }} />
        <button onClick={handleExport} disabled={status !== 'done'}
          style={{ padding: '7px 16px', borderRadius: 980, fontSize: 13, fontWeight: 600, border: 'none',
            cursor: status === 'done' ? 'pointer' : 'not-allowed',
            background: status === 'done' ? '#1D1D1F' : '#E5E5EA',
            color: status === 'done' ? '#fff' : '#C7C7CC', fontFamily: FONT }}>
          Export as .md file
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '28px 0' }}>
        <div style={{ maxWidth: 840, margin: '0 auto', background: '#fff', borderRadius: 16,
          boxShadow: '0 1px 8px rgba(0,0,0,0.06)', padding: '32px 40px' }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: '#8E8E93', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 4px' }}>
            Low-Level Design Document
          </p>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1D1D1F', margin: '0 0 20px' }}>
            Agent Design: {agentName}
          </h1>

          {error && (
            <div style={{ background: '#FFF0F0', border: '1px solid #FFD5D5', borderRadius: 10, padding: 14, marginBottom: 16 }}>
              <p style={{ color: '#FF3B30', fontSize: 13, margin: 0 }}>{error}</p>
            </div>
          )}

          {status === 'failed' && (
            <div style={{ background: '#FFF0F0', border: '1px solid #FFD5D5', borderRadius: 10, padding: 14 }}>
              <p style={{ color: '#FF3B30', fontSize: 13, margin: 0 }}>{agent?.lld_error || 'Document generation failed.'}</p>
            </div>
          )}

          {(status === 'generating' || status === 'not_generated') && !error && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '48px 0' }}>
              <style>{`@keyframes lld-spin { to { transform: rotate(360deg) } }`}</style>
              <div style={{ width: 40, height: 40, border: '3px solid #E5E5EA', borderTopColor: '#0071E3',
                borderRadius: '50%', animation: 'lld-spin 0.9s linear infinite' }} />
              <div style={{ textAlign: 'center' }}>
                <p style={{ color: '#1D1D1F', fontSize: 14, fontWeight: 600, margin: 0 }}>Drafting the technical design…</p>
                <p style={{ color: '#6E6E73', fontSize: 12, marginTop: 4 }}>This can take up to a minute for a full document.</p>
              </div>
            </div>
          )}

          {status === 'done' && agent?.lld_markdown && renderMarkdown(agent.lld_markdown)}
        </div>
      </div>
    </div>
  );
}
