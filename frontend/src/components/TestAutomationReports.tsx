import { useEffect, useState } from 'react';
import {
  getTestAutomationReports,
  getTestAutomationRun,
  exportTestAutomationResults,
  listTestEnvironments,
  listTenants,
  TEST_PHASES,
  TEST_MODULES,
  type TestAutomationReportRow,
  type TestAutomationReportSummary,
  type TestAutomationRun,
  type TestEnvironment,
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

type SincePreset = '7d' | '30d' | 'all';

function sinceToISO(preset: SincePreset): string | undefined {
  if (preset === 'all') return undefined;
  const days = preset === '7d' ? 7 : 30;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

export default function TestAutomationReports({ tenantId, runId, onRunIdChange }: {
  tenantId?: string;
  // Drives dashboard-list vs. single-run-detail — pass '' to onRunIdChange to go back to the list.
  runId?: string;
  onRunIdChange?: (runId: string) => void;
}) {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '28px 24px', background: BG }}>
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
        {runId ? (
          <ReportDetail runId={runId} onBack={() => onRunIdChange?.('')} />
        ) : (
          <ReportDashboard tenantId={tenantId} onOpenRun={(id) => onRunIdChange?.(id)} />
        )}
      </div>
    </div>
  );
}

// ── Dashboard (aggregate rollup) — reused as-is by AdminTestExecutionsTab.tsx via `all`,
// which switches the fetch to the cross-client rollup and adds a Client column/filter. ──

export function ReportDashboard({ tenantId, all, onOpenRun }: {
  tenantId?: string;
  all?: boolean;
  onOpenRun: (runId: string, tenantId?: string) => void;
}) {
  const [rows, setRows] = useState<TestAutomationReportRow[]>([]);
  const [summary, setSummary] = useState<TestAutomationReportSummary | null>(null);
  const [environments, setEnvironments] = useState<TestEnvironment[]>([]);
  const [clients, setClients] = useState<{ tenant_id: string; name: string }[]>([]);
  const [selectedEnv, setSelectedEnv] = useState('');
  const [selectedPhase, setSelectedPhase] = useState('');
  const [selectedModule, setSelectedModule] = useState('');
  const [selectedClient, setSelectedClient] = useState('');
  const [since, setSince] = useState<SincePreset>('30d');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);

  useEffect(() => {
    if (all) {
      listTenants().then(ts => setClients(ts.map((t: any) => ({ tenant_id: t.tenant_id, name: t.name || t.tenant_id })))).catch(() => {});
    } else if (tenantId) {
      listTestEnvironments(tenantId).then(({ environments }) => setEnvironments(environments)).catch(() => {});
    }
  }, [tenantId, all]);

  useEffect(() => {
    setLoading(true); setError(null);
    getTestAutomationReports({
      tenantId: all ? undefined : tenantId, all,
      environmentId: selectedEnv || undefined, testPhase: selectedPhase || undefined,
      module: selectedModule || undefined, since: sinceToISO(since),
    })
      .then(r => { setRows(r.runs); setSummary(r.summary); })
      .catch(err => setError(err.message || String(err)))
      .finally(() => setLoading(false));
  }, [tenantId, all, selectedEnv, selectedPhase, selectedModule, since]);

  const clientNameByTenantId = Object.fromEntries(clients.map(c => [c.tenant_id, c.name]));
  const visibleRows = all && selectedClient ? rows.filter(r => r.tenant_id === selectedClient) : rows;

  async function handleExport(runId: string, tenantId?: string) {
    setExportingId(runId);
    try {
      const { download_url } = await exportTestAutomationResults(runId, tenantId);
      window.open(download_url, '_blank');
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setExportingId(null);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: TEXT, margin: 0, letterSpacing: '-0.2px' }}>
            {all ? 'Test Executions' : 'Execution Reports'}
          </h2>
          <p style={{ fontSize: 12.5, color: MUTED, margin: '2px 0 0' }}>
            {all
              ? 'Pass/fail results across every client — filterable and exportable.'
              : 'Pass/fail results across every Workday execution — filterable and exportable.'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {all && (
            <select value={selectedClient} onChange={e => setSelectedClient(e.target.value)} style={selectStyle()}>
              <option value="">All clients</option>
              {clients.map(c => <option key={c.tenant_id} value={c.tenant_id}>{c.name}</option>)}
            </select>
          )}
          {!all && (
            <select value={selectedEnv} onChange={e => setSelectedEnv(e.target.value)} style={selectStyle()}>
              <option value="">All environments</option>
              {environments.map(env => <option key={env.environment_id} value={env.environment_id}>{env.name}</option>)}
            </select>
          )}
          <select value={selectedPhase} onChange={e => setSelectedPhase(e.target.value)} style={selectStyle()}>
            <option value="">All phases</option>
            {TEST_PHASES.map(ph => <option key={ph} value={ph}>{ph}</option>)}
          </select>
          <select value={selectedModule} onChange={e => setSelectedModule(e.target.value)} style={selectStyle()}>
            <option value="">All modules</option>
            {TEST_MODULES.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <select value={since} onChange={e => setSince(e.target.value as SincePreset)} style={selectStyle()}>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All time</option>
          </select>
        </div>
      </div>

      {error && (
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 14px', marginBottom: 16 }}>
          <p style={{ fontSize: 12.5, color: '#B91C1C', margin: 0 }}>{error}</p>
        </div>
      )}

      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 20 }}>
          <SummaryCard label="Runs Executed" value={String(summary.total_runs)} />
          <SummaryCard label="Pass Rate" value={summary.pass_rate != null ? `${summary.pass_rate}%` : '—'} accent={INK} />
          <SummaryCard label="Passed" value={String(summary.passed)} accent="#16A34A" />
          <SummaryCard label="Failed" value={String(summary.failed)} accent="#DC2626" />
          <SummaryCard label="Error" value={String(summary.error)} accent="#DC2626" />
        </div>
      )}

      <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, overflow: 'hidden' }}>
        {loading ? (
          <p style={{ fontSize: 12.5, color: MUTED, padding: 20, margin: 0 }}>Loading…</p>
        ) : visibleRows.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center' }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: TEXT, margin: '0 0 4px' }}>No executed runs yet</p>
            <p style={{ fontSize: 12, color: MUTED, margin: 0 }}>Results appear here once a run is executed against a Workday environment from the Build tab.</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: BG, textAlign: 'left' }}>
                {[...(all ? ['Client'] : []), 'Run', 'Phase', 'Module', all ? '' : 'Environment', 'Executed', 'Status', 'Passed', 'Failed', 'Error', ''].filter(Boolean).map((h, i) => (
                  <th key={`${h}-${i}`} style={{ padding: '9px 14px', fontSize: 10.5, fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(r => (
                <tr key={r.run_id} style={{ borderTop: `1px solid ${BORDER}` }}>
                  {all && <td style={{ padding: '10px 14px', color: TEXT, fontWeight: 600, whiteSpace: 'nowrap' }}>{clientNameByTenantId[r.tenant_id || ''] || r.tenant_id}</td>}
                  <td style={{ padding: '10px 14px', fontWeight: 600, color: TEXT, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.run_name || r.file_name}</td>
                  <td style={{ padding: '10px 14px' }}>{r.test_phase ? <PhaseBadge phase={r.test_phase} /> : <span style={{ color: MUTED }}>—</span>}</td>
                  <td style={{ padding: '10px 14px' }}>{r.module ? <ModuleBadge module={r.module} /> : <span style={{ color: MUTED }}>—</span>}</td>
                  {!all && <td style={{ padding: '10px 14px', color: MUTED }}>{r.environment_name || '—'}</td>}
                  <td style={{ padding: '10px 14px', color: MUTED, whiteSpace: 'nowrap' }}>{new Date(r.updated_at).toLocaleString()}</td>
                  <td style={{ padding: '10px 14px' }}><ExecBadge status={r.execution_status} /></td>
                  <td style={{ padding: '10px 14px', color: '#16A34A', fontWeight: 600 }}>{r.scenario_counts.passed}</td>
                  <td style={{ padding: '10px 14px', color: '#DC2626', fontWeight: 600 }}>{r.scenario_counts.failed}</td>
                  <td style={{ padding: '10px 14px', color: '#DC2626', fontWeight: 600 }}>{r.scenario_counts.error}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button onClick={() => onOpenRun(r.run_id, r.tenant_id)} style={linkBtnStyle()}>View</button>
                    <button onClick={() => handleExport(r.run_id, r.tenant_id)} disabled={exportingId === r.run_id} style={{ ...linkBtnStyle(), marginLeft: 12 }}>
                      {exportingId === r.run_id ? 'Exporting…' : 'Export'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: '14px 16px' }}>
      <p style={{ fontSize: 10.5, fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.03em', margin: '0 0 6px' }}>{label}</p>
      <p style={{ fontSize: 22, fontWeight: 700, color: accent || TEXT, margin: 0, fontVariantNumeric: 'tabular-nums' }}>{value}</p>
    </div>
  );
}

function selectStyle(): React.CSSProperties {
  return { fontSize: 12, padding: '7px 10px', borderRadius: 8, border: `1px solid ${BORDER}`, background: CARD, fontFamily: FONT, color: TEXT };
}

function linkBtnStyle(): React.CSSProperties {
  return { fontSize: 12, fontWeight: 600, color: '#0F6FEC', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: FONT };
}

// ── Single-run report detail (read-only — no wizard chrome) ─────────────────

export function ReportDetail({ runId, tenantId, onBack }: { runId: string; tenantId?: string; onBack: () => void }) {
  const [run, setRun] = useState<TestAutomationRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setLoading(true); setError(null);
    getTestAutomationRun(runId, tenantId)
      .then(setRun)
      .catch(err => setError(err.message || String(err)))
      .finally(() => setLoading(false));
  }, [runId, tenantId]);

  async function handleExport() {
    setExporting(true);
    try {
      const { download_url } = await exportTestAutomationResults(runId, tenantId);
      window.open(download_url, '_blank');
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setExporting(false);
    }
  }

  const scenarios = run?.scenarios ?? [];
  const steps = run?.steps ?? [];
  const passed = scenarios.filter(s => s.execution_status === 'passed').length;
  const failed = scenarios.filter(s => s.execution_status === 'failed').length;
  const errored = scenarios.filter(s => s.execution_status === 'error').length;

  return (
    <div>
      <button onClick={onBack} style={{
        border: 'none', background: 'none', cursor: 'pointer', color: MUTED, fontSize: 12.5,
        display: 'flex', alignItems: 'center', gap: 4, padding: '0 0 14px', fontFamily: FONT,
      }}>← All Reports</button>

      {loading ? (
        <p style={{ fontSize: 12.5, color: MUTED }}>Loading…</p>
      ) : error ? (
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 14px' }}>
          <p style={{ fontSize: 12.5, color: '#B91C1C', margin: 0 }}>{error}</p>
        </div>
      ) : run && (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <h2 style={{ fontSize: 16, fontWeight: 700, color: TEXT, margin: 0 }}>{run.run_name || run.file_name}</h2>
                <ExecBadge status={run.execution_status} />
                {run.test_phase && <PhaseBadge phase={run.test_phase} />}
                {run.module && <ModuleBadge module={run.module} />}
              </div>
              <p style={{ fontSize: 12, color: MUTED, margin: '3px 0 0' }}>
                {scenarios.length} scenario{scenarios.length !== 1 ? 's' : ''} · {passed} passed · {failed} failed · {errored} error
              </p>
            </div>
            <button onClick={handleExport} disabled={exporting} style={{
              padding: '9px 18px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, border: 'none',
              cursor: exporting ? 'not-allowed' : 'pointer', background: INK, color: '#fff', fontFamily: FONT,
              opacity: exporting ? 0.6 : 1,
            }}>{exporting ? 'Exporting…' : 'Export Report'}</button>
          </div>

          <ExecutionResultsList runId={run.run_id} scenarios={scenarios} steps={steps} />
        </>
      )}
    </div>
  );
}
