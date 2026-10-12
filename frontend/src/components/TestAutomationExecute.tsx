import { useEffect, useRef, useState } from 'react';
import {
  listTestAutomationRuns,
  listTestEnvironments,
  triggerTestAutomationExecute,
  updateTestEnvironment,
  getTestAutomationRun,
  type TestAutomationRun,
  type TestEnvironment,
  type TestAutomationExecutionStatus,
} from '../lib/api';
import { ExecBadge, ExecutionResultsList, PhaseBadge, ModuleBadge } from './TestAutomationExecutionResults';

// ── Design tokens (matches TestAutomationSuite.tsx / ProcessIntelligence.tsx) ─
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';
const BG = '#F5F5F7';
const CARD = '#FFFFFF';
const TEXT = '#1D1D1F';
const MUTED = '#6E6E73';
const BORDER = '#E5E5EA';
const INK = '#0C0D0D';

const EXECUTABLE_STATUSES = new Set(['steps_ready', 'completed']);
const EXECUTING: Set<TestAutomationExecutionStatus> = new Set(['pending', 'running']);

function selectStyle(): React.CSSProperties {
  return { fontSize: 12.5, padding: '8px 10px', borderRadius: 8, border: `1px solid ${BORDER}`, background: CARD, fontFamily: FONT, color: TEXT };
}

export default function TestAutomationExecute({ tenantId }: { tenantId?: string }) {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '28px 24px', background: BG }}>
      <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 28 }}>
        <RunNowSection tenantId={tenantId} />
        <ScheduledSection tenantId={tenantId} />
      </div>
    </div>
  );
}

// ── Run Now (ad-hoc execution) ────────────────────────────────────────────────

function RunNowSection({ tenantId }: { tenantId?: string }) {
  const [runs, setRuns] = useState<TestAutomationRun[]>([]);
  const [environments, setEnvironments] = useState<TestEnvironment[]>([]);
  const [selectedRun, setSelectedRun] = useState('');
  const [selectedEnv, setSelectedEnv] = useState('');
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<TestAutomationRun | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    Promise.all([
      listTestAutomationRuns(),
      tenantId ? listTestEnvironments(tenantId) : Promise.resolve({ environments: [] as TestEnvironment[] }),
    ]).then(([runsRes, envsRes]) => {
      const executable = runsRes.runs.filter(r => EXECUTABLE_STATUSES.has(r.status));
      setRuns(executable);
      setEnvironments(envsRes.environments);
      const withCred = envsRes.environments.find(e => e.has_credential);
      if (withCred) setSelectedEnv(withCred.environment_id);
    }).catch(err => setError(err.message || String(err))).finally(() => setLoading(false));
  }, [tenantId]);

  // Poll the active run while its execution is in flight — same self-rescheduling pattern as
  // TestAutomationSuite.tsx's build-wizard poll.
  useEffect(() => {
    if (!activeRun || !EXECUTING.has(activeRun.execution_status)) return;
    const runId = activeRun.run_id;
    let cancelled = false;
    async function poll() {
      if (cancelled) return;
      try {
        const fresh = await getTestAutomationRun(runId);
        if (cancelled) return;
        setActiveRun(fresh);
        if (!cancelled && EXECUTING.has(fresh.execution_status)) {
          pollRef.current = setTimeout(poll, 3000);
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Failed to check execution status');
      }
    }
    pollRef.current = setTimeout(poll, 3000);
    return () => { cancelled = true; if (pollRef.current) clearTimeout(pollRef.current); };
  }, [activeRun?.run_id, activeRun?.execution_status]);

  const selectedHasCred = environments.find(e => e.environment_id === selectedEnv)?.has_credential ?? false;
  const isExecuting = !!activeRun && EXECUTING.has(activeRun.execution_status);
  const canExecute = !!selectedRun && !!selectedEnv && selectedHasCred && !triggering && !isExecuting;

  async function handleExecute() {
    setTriggering(true); setError(null);
    try {
      await triggerTestAutomationExecute(selectedRun, selectedEnv);
      const fresh = await getTestAutomationRun(selectedRun);
      setActiveRun(fresh);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setTriggering(false);
    }
  }

  return (
    <div>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: TEXT, margin: '0 0 4px' }}>Run Now</h2>
      <p style={{ fontSize: 12.5, color: MUTED, margin: '0 0 14px', lineHeight: 1.5 }}>
        Execute any completed build's scenarios against a Workday environment on demand.
      </p>

      {error && (
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 14px', marginBottom: 14 }}>
          <p style={{ fontSize: 12, color: '#B91C1C', margin: 0 }}>{error}</p>
        </div>
      )}

      <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 20 }}>
        {loading ? (
          <p style={{ fontSize: 12.5, color: MUTED, margin: 0 }}>Loading…</p>
        ) : runs.length === 0 ? (
          <p style={{ fontSize: 12.5, color: MUTED, margin: 0 }}>No completed builds yet — finish a run in the Build tab first.</p>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: activeRun ? 16 : 0 }}>
              <select value={selectedRun} onChange={e => { setSelectedRun(e.target.value); setActiveRun(null); }} style={{ ...selectStyle(), flex: 1, minWidth: 220 }}>
                <option value="">Select a run…</option>
                {runs.map(r => (
                  <option key={r.run_id} value={r.run_id}>{r.run_name || r.file_name} ({r.run_id.slice(0, 8)})</option>
                ))}
              </select>
              <select value={selectedEnv} onChange={e => setSelectedEnv(e.target.value)} style={selectStyle()}>
                <option value="">Select environment…</option>
                {environments.map(env => (
                  <option key={env.environment_id} value={env.environment_id} disabled={!env.has_credential}>
                    {env.name}{!env.has_credential ? ' (no credential)' : ''}
                  </option>
                ))}
              </select>
              <button onClick={handleExecute} disabled={!canExecute} style={{
                padding: '8px 18px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, border: 'none',
                cursor: canExecute ? 'pointer' : 'not-allowed', fontFamily: FONT,
                background: canExecute ? INK : BORDER, color: canExecute ? '#fff' : '#C7C7CC',
              }}>{isExecuting ? 'Executing…' : triggering ? 'Starting…' : 'Execute Now'}</button>
            </div>

            {activeRun && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: TEXT }}>{activeRun.run_name || activeRun.file_name}</span>
                  <ExecBadge status={activeRun.execution_status} />
                </div>
                <ExecutionResultsList runId={activeRun.run_id} scenarios={activeRun.scenarios ?? []} steps={activeRun.steps ?? []} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Scheduled (nightly) ───────────────────────────────────────────────────────

function ScheduledSection({ tenantId }: { tenantId?: string }) {
  const [environments, setEnvironments] = useState<TestEnvironment[]>([]);
  const [runs, setRuns] = useState<TestAutomationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function reload() {
    if (!tenantId) { setLoading(false); return; }
    Promise.all([listTestEnvironments(tenantId), listTestAutomationRuns()])
      .then(([envsRes, runsRes]) => {
        setEnvironments(envsRes.environments);
        setRuns(runsRes.runs.filter(r => EXECUTABLE_STATUSES.has(r.status)));
      })
      .catch(err => setError(err.message || String(err)))
      .finally(() => setLoading(false));
  }
  useEffect(reload, [tenantId]);

  return (
    <div>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: TEXT, margin: '0 0 4px' }}>Scheduled (Nightly)</h2>
      <p style={{ fontSize: 12.5, color: MUTED, margin: '0 0 14px', lineHeight: 1.5 }}>
        Re-runs a run's already-generated scenarios against live Workday every night — no regeneration.
      </p>

      {error && (
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 14px', marginBottom: 14 }}>
          <p style={{ fontSize: 12, color: '#B91C1C', margin: 0 }}>{error}</p>
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 12.5, color: MUTED }}>Loading…</p>
      ) : environments.length === 0 ? (
        <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 20 }}>
          <p style={{ fontSize: 12.5, color: MUTED, margin: 0 }}>No Workday environments configured for this client yet.</p>
        </div>
      ) : (
        <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, overflow: 'hidden' }}>
          {environments.map((env, idx) => (
            <ScheduleCard key={env.environment_id} environment={env} runs={runs} onChanged={reload} first={idx === 0} />
          ))}
        </div>
      )}
    </div>
  );
}

function ScheduleCard({ environment, runs, onChanged, first }: {
  environment: TestEnvironment; runs: TestAutomationRun[]; onChanged: () => void; first?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(nightly_enabled: boolean, nightly_run_id: string) {
    setSaving(true); setError(null);
    try {
      await updateTestEnvironment(environment.environment_id, { nightly_enabled, nightly_run_id: nightly_run_id || null });
      onChanged();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ padding: '16px 20px', borderTop: first ? 'none' : `1px solid ${BORDER}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: TEXT }}>{environment.name}</span>
        {!environment.has_credential && (
          <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 999, padding: '2px 8px', background: '#FEF3C7', color: '#92400E' }}>No credential</span>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', fontSize: 12.5, color: TEXT }}>
          <input type="checkbox" checked={environment.nightly_enabled} disabled={saving || !environment.has_credential}
            onChange={e => handleChange(e.target.checked, environment.nightly_run_id || '')} />
          Run nightly
        </label>
      </div>
      {error && <p style={{ fontSize: 11.5, color: '#B91C1C', margin: '8px 0 0' }}>{error}</p>}
      {environment.nightly_enabled && (
        <div style={{ marginTop: 12 }}>
          <select value={environment.nightly_run_id || ''} disabled={saving}
            onChange={e => handleChange(true, e.target.value)} style={{ ...selectStyle(), width: '100%' }}>
            <option value="">— select the nightly regression suite —</option>
            {runs.map(r => (
              <option key={r.run_id} value={r.run_id}>{r.run_name || r.file_name} ({r.run_id.slice(0, 8)})</option>
            ))}
          </select>
          {environment.nightly_run_id && (() => {
            const r = runs.find(x => x.run_id === environment.nightly_run_id);
            return r ? (
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                {r.test_phase && <PhaseBadge phase={r.test_phase} />}
                {r.module && <ModuleBadge module={r.module} />}
              </div>
            ) : null;
          })()}
        </div>
      )}
    </div>
  );
}
