import { useCallback, useEffect, useRef, useState } from 'react';
import { getAgentLld, triggerAgentLld, type PiAgent, type PiAgenticMetadata } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { downloadBlob } from '../lib/download';
import { HomeButton } from './PipelineStepper';
import { Spinner } from './Spinner';

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';

const MATURITY_LABELS = ['AI Assisted', 'AI Augmented', 'AI Powered'];

function AgenticMetadataBadges({ metadata }: { metadata: PiAgenticMetadata }) {
  const position = metadata.maturity?.position ?? null;
  return (
    <div style={{ marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid #E5E5EA' }}>
      {position !== null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          {MATURITY_LABELS.map((label, i) => {
            const active = position >= i / (MATURITY_LABELS.length - 1) - 0.17
              && position < (i + 1) / (MATURITY_LABELS.length - 1) + 0.001;
            return (
              <span key={label} style={{ fontSize: 11, fontWeight: active ? 700 : 500,
                color: active ? '#0071E3' : '#8E8E93',
                padding: '3px 9px', borderRadius: 980,
                background: active ? '#E8F1FE' : '#F5F5F7' }}>
                {label}
              </span>
            );
          })}
          {metadata.maturity?.note && (
            <span style={{ fontSize: 11, color: '#8E8E93', fontStyle: 'italic' }}>{metadata.maturity.note}</span>
          )}
        </div>
      )}
      {metadata.stages?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {metadata.stages.map((s, i) => (
            <span key={i}
              title={s.groundingRef ? `Grounded in: ${s.groundingRef}` : 'No grounding source cited'}
              style={{ fontSize: 11, fontWeight: 500, color: '#3A3A3C', background: '#F5F5F7',
                border: '1px solid #E5E5EA', borderRadius: 8, padding: '4px 8px', display: 'flex',
                alignItems: 'center', gap: 5 }}>
              <strong style={{ color: '#1D1D1F' }}>{s.stage}</strong>
              <span style={{ color: '#8E8E93' }}>·</span>
              {s.builtOn}
              <span style={{ color: '#C7C7CC' }}>({s.agentType}/{s.executionMode})</span>
              {!s.groundingRef && <span style={{ color: '#FF9500' }}>⚠</span>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  processId: string;
  agentId: string;
  agentName: string;
  onBack: () => void;
  // Leaves Process Intelligence entirely — distinct from onBack, which stays
  // one level up at the agent list. Optional since this component predates
  // that consistent affordance; falls back to onBack where a caller hasn't
  // been updated to pass it.
  onHome?: () => void;
}

export function AgentDesignDoc({ processId, agentId, agentName, onBack, onHome }: Props) {
  const [agent, setAgent] = useState<PiAgent | null>(null);
  const [error, setError] = useState('');
  // Distinct from agent?.lld_status === 'generating': this covers just the
  // trigger click itself, before the first status refetch confirms the
  // server has picked it up, so the button disables instantly instead of
  // having a window where a second click could double-fire.
  const [triggering, setTriggering] = useState(false);
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

    // Only ever loads the current status here — never auto-triggers
    // generation. Opening an agent's design doc used to kick off LLD
    // generation as a side effect of the click, which meant just glancing at
    // an agent silently started a ~minute-long job. Generation now requires
    // the explicit "Generate Design Doc" button below; this effect just
    // resumes polling if a run from an earlier open (or a reload) is still
    // in flight.
    async function start() {
      try {
        const initial = await getAgentLld(processId, agentId);
        if (cancelled) return;
        setAgent(initial);
        if (initial.lld_status === 'generating') {
          pollRef.current = setInterval(poll, 2500);
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Failed to load document');
      }
    }

    start();
    return () => { cancelled = true; stopPolling(); };
  }, [processId, agentId, stopPolling]);

  async function handleGenerate() {
    if (!agent) return;
    setTriggering(true);
    setError('');
    try {
      await triggerAgentLld(processId, agentId);
      setAgent({ ...agent, lld_status: 'generating' });
      pollRef.current = setInterval(async () => {
        try {
          const a = await getAgentLld(processId, agentId);
          setAgent(a);
          if (a.lld_status === 'done' || a.lld_status === 'failed') stopPolling();
        } catch (err: any) {
          setError(err.message || 'Failed to load document'); stopPolling();
        }
      }, 2500);
    } catch (err: any) {
      setError(err.message || 'Failed to start document generation');
    } finally {
      setTriggering(false);
    }
  }

  function handleExport() {
    if (!agent?.lld_markdown) return;
    const filename = `Agent Design — ${agentName}.md`;
    downloadBlob(filename, agent.lld_markdown, 'text/markdown');
  }

  // null (agent still loading) is its own case now, distinct from
  // 'not_generated' — the latter shows the explicit Generate button, the
  // former just shows a bare loading state while the initial fetch is out.
  const status = agent?.lld_status ?? null;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#F5F5F7', fontFamily: FONT, overflow: 'hidden' }}>
      {/* Top bar */}
      <div style={{ background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(12px)', borderBottom: '1px solid #E5E5EA',
        padding: '12px 24px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <HomeButton onClick={onHome ?? onBack} />
        <span style={{ width: 1, height: 18, background: '#E5E5EA', flexShrink: 0 }} />
        <button onClick={onBack}
          style={{ padding: '7px 14px', borderRadius: 999, fontSize: 13, fontWeight: 500, border: '1px solid #E5E5EA',
            cursor: 'pointer', background: '#fff', color: '#6E6E73', display: 'flex', alignItems: 'center', gap: 5, fontFamily: FONT }}>
          <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
          Agentic Workflow
        </button>
        <div style={{ flex: 1 }} />
        <button onClick={handleExport} disabled={status !== 'done'}
          style={{ padding: '7px 16px', borderRadius: 999, fontSize: 13, fontWeight: 600, border: 'none',
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

          {agent?.agentic_metadata && <AgenticMetadataBadges metadata={agent.agentic_metadata} />}

          {error && (
            <div style={{ background: '#FFF0F0', border: '1px solid #FFD5D5', borderRadius: 10, padding: 14, marginBottom: 16 }}>
              <p style={{ color: '#FF3B30', fontSize: 13, margin: 0 }}>{error}</p>
            </div>
          )}

          {status === 'failed' && (
            <div style={{ background: '#FFF0F0', border: '1px solid #FFD5D5', borderRadius: 10, padding: 14, marginBottom: 16 }}>
              <p style={{ color: '#FF3B30', fontSize: 13, margin: '0 0 10px' }}>{agent?.lld_error || 'Document generation failed.'}</p>
              <button onClick={handleGenerate} disabled={triggering}
                style={{ padding: '8px 16px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, border: 'none',
                  cursor: triggering ? 'default' : 'pointer', background: '#FF3B30', color: '#fff', fontFamily: FONT }}>
                Try again
              </button>
            </div>
          )}

          {status === null && !error && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}>
              <Spinner size={28} />
            </div>
          )}

          {status === 'not_generated' && !error && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '48px 24px', textAlign: 'center' }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: '#F5F5F7', color: '#8E8E93',
                display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 2.5h8l4 4v10a1 1 0 01-1 1H4a1 1 0 01-1-1v-13a1 1 0 011-1z" />
                  <path d="M12 2.5V6h4M6.5 10.5h7M6.5 13h5" />
                </svg>
              </div>
              <div>
                <p style={{ color: '#1D1D1F', fontSize: 14, fontWeight: 600, margin: 0 }}>No design document yet</p>
                <p style={{ color: '#6E6E73', fontSize: 12.5, marginTop: 4, maxWidth: 340 }}>
                  Generate a low-level design for {agentName} — grounded in this process's steps and covering the platform build approach. Takes up to a minute.
                </p>
              </div>
              <button onClick={handleGenerate} disabled={triggering}
                style={{ padding: '10px 22px', borderRadius: 999, fontSize: 13.5, fontWeight: 700, border: 'none',
                  cursor: triggering ? 'default' : 'pointer', background: triggering ? '#E5E5EA' : '#0C0D0D',
                  color: triggering ? '#C7C7CC' : '#fff', fontFamily: FONT,
                  display: 'flex', alignItems: 'center', gap: 8 }}>
                {triggering && <Spinner size={13} color="#8E8E93" trackColor="#D1D1D6" />}
                {triggering ? 'Starting…' : 'Generate Design Doc'}
              </button>
            </div>
          )}

          {status === 'generating' && !error && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '48px 0' }}>
              <style>{`@keyframes lld-spin { to { transform: rotate(360deg) } }`}</style>
              <div style={{ width: 40, height: 40, border: '3px solid #E5E5EA', borderTopColor: '#0C0D0D',
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
