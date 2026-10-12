import { useState } from 'react';
import {
  getTestAutomationScreenshotUrl,
  type TestAutomationScenario,
  type TestAutomationStep,
  type TestAutomationExecutionStatus,
} from '../lib/api';
import { Spinner } from './Spinner';

// ── Design tokens (matches TestAutomationSuite.tsx / ProcessIntelligence.tsx) ─
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';
const BG = '#F5F5F7';
const TEXT = '#1D1D1F';
const MUTED = '#6E6E73';
const BORDER = '#E5E5EA';

// Scenario/step execution-outcome rendering — shared between the live in-progress
// view (TestAutomationSuite.tsx's ExecutionPanel) and the Reports detail page
// (TestAutomationReports.tsx), so neither duplicates this JSX.

export const EXEC_STATUS_COLOR: Record<TestAutomationExecutionStatus, { bg: string; fg: string; label: string }> = {
  not_executed: { bg: BORDER, fg: MUTED, label: 'Not executed' },
  pending: { bg: '#FEF3C7', fg: '#92400E', label: 'Queued' },
  running: { bg: '#DBEAFE', fg: '#1D4ED8', label: 'Running…' },
  passed: { bg: '#EAFBF1', fg: '#16A34A', label: 'Passed' },
  failed: { bg: '#FEF2F2', fg: '#DC2626', label: 'Failed' },
  error: { bg: '#FEF2F2', fg: '#DC2626', label: 'Error' },
};

// Run-configuration badges (test_phase/module, migration 009) — shared across the Build tab's
// recent-runs list, Reports table/detail, and AdminPanel's cross-client Test Executions tab.
export function PhaseBadge({ phase }: { phase: string }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 999, padding: '1px 8px', background: '#EEF2FF', color: '#4338CA' }}>
      {phase}
    </span>
  );
}

export function ModuleBadge({ module }: { module: string }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 999, padding: '1px 8px', background: '#F5F5F7', color: '#3A3A3C' }}>
      {module}
    </span>
  );
}

export function ExecBadge({ status }: { status: TestAutomationExecutionStatus }) {
  const c = EXEC_STATUS_COLOR[status];
  return (
    <span style={{ fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: '2px 9px', background: c.bg, color: c.fg }}>
      {c.label}
    </span>
  );
}

function ExecutionScenarioCard({ runId, scenario, steps }: {
  runId: string; scenario: TestAutomationScenario; steps: TestAutomationStep[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const sorted = [...steps].sort((a, b) => a.step_number - b.step_number);

  async function viewScreenshot(key: string) {
    setLoadingKey(key); setErrorKey(null);
    try {
      const { url } = await getTestAutomationScreenshotUrl(runId, key);
      window.open(url, '_blank');
    } catch {
      setErrorKey(key);
    } finally {
      setLoadingKey(null);
    }
  }

  return (
    <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
      <button onClick={() => setExpanded(v => !v)} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
        background: BG, border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: FONT,
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: MUTED }}>{scenario.scenario_label}</span>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: TEXT, flex: 1 }}>{scenario.title}</span>
        <ExecBadge status={scenario.execution_status} />
        <span style={{ color: MUTED, fontSize: 11, transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>›</span>
      </button>
      {expanded && (
        <div style={{ padding: '4px 14px' }}>
          {sorted.map(st => (
            <div key={st.step_id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 0', borderBottom: `1px solid ${BORDER}` }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: MUTED, width: 28, flexShrink: 0 }}>#{st.step_number}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 12, color: TEXT, margin: 0 }}>{st.action}</p>
                {st.execution_result?.note && (
                  <p style={{ fontSize: 11, color: MUTED, margin: '3px 0 0' }}>{st.execution_result.note}</p>
                )}
                {st.execution_result?.screenshot_key && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                    <button onClick={() => viewScreenshot(st.execution_result!.screenshot_key!)}
                      disabled={loadingKey === st.execution_result.screenshot_key} style={{
                        fontSize: 11, color: '#0F6FEC', background: 'none', border: 'none',
                        cursor: loadingKey === st.execution_result.screenshot_key ? 'default' : 'pointer',
                        padding: 0, fontFamily: FONT, textDecoration: 'underline',
                        opacity: loadingKey === st.execution_result.screenshot_key ? 0.6 : 1,
                      }}>View screenshot</button>
                    {loadingKey === st.execution_result.screenshot_key && <Spinner size={11} color="#0F6FEC" trackColor="#DBEAFE" />}
                    {errorKey === st.execution_result.screenshot_key && (
                      <span style={{ fontSize: 10.5, color: '#DC2626' }}>Failed to load — try again</span>
                    )}
                  </div>
                )}
              </div>
              <ExecBadge status={st.execution_status} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ExecutionResultsList({ runId, scenarios, steps }: {
  runId: string; scenarios: TestAutomationScenario[]; steps: TestAutomationStep[];
}) {
  if (scenarios.length === 0) {
    return <p style={{ fontSize: 12.5, color: MUTED, margin: 0 }}>No execution results yet.</p>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {scenarios.map(sc => (
        <ExecutionScenarioCard key={sc.scenario_id} runId={runId} scenario={sc}
          steps={steps.filter(s => s.scenario_id === sc.scenario_id)} />
      ))}
    </div>
  );
}
