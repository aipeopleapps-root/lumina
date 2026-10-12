import { useEffect, useRef, useState } from 'react';
import {
  getTestAutomationUploadUrl,
  createTestAutomationRun,
  getTestAutomationRun,
  listTestAutomationRuns,
  triggerTestAutomationScenarios,
  triggerTestAutomationSteps,
  exportTestAutomationRun,
  triggerTestAutomationExecute,
  listTestEnvironments,
  putFileToS3,
  TEST_PHASES,
  TEST_MODULES,
  type TestAutomationRun,
  type TestAutomationRunStatus,
  type TestAutomationScenario,
  type TestAutomationStep,
  type TestAutomationExecutionStatus,
  type TestEnvironment,
  type TestPhase,
  type TestModule,
} from '../lib/api';
import { ExecBadge, ExecutionResultsList, PhaseBadge, ModuleBadge } from './TestAutomationExecutionResults';
import TestAutomationReports from './TestAutomationReports';
import TestAutomationExecute from './TestAutomationExecute';
import { Spinner } from './Spinner';

// ── Design tokens (matches ProcessIntelligence.tsx / RfpReimagine.tsx) ───────
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';
const BG = '#F5F5F7';
const CARD = '#FFFFFF';
const TEXT = '#1D1D1F';
const MUTED = '#6E6E73';
const BORDER = '#E5E5EA';
const INK = '#0C0D0D';

const GENERATING: Set<TestAutomationRunStatus> = new Set([
  'parsing', 'generating_stories', 'generating_scenarios', 'generating_steps', 'exporting',
]);

const STAGE_LABEL: Record<TestAutomationRunStatus, string> = {
  parsing: 'Parsing file…',
  generating_stories: 'Writing user stories…',
  needs_review: 'Review stage 1',
  generating_scenarios: 'Writing test scenarios…',
  scenarios_ready: 'Review test scenarios',
  generating_steps: 'Writing test steps…',
  steps_ready: 'Review test steps',
  exporting: 'Building export…',
  completed: 'Export ready',
  failed: 'Failed',
};

const INPUT_TYPE_LABEL: Record<string, string> = {
  requirements: 'Requirements',
  user_stories: 'User Stories',
  config_workbook: 'Config Workbook',
  bpw: 'Business Process Workbook',
};

function fieldStyle(): React.CSSProperties {
  return {
    width: '100%', border: `1.5px solid ${BORDER}`, borderRadius: 8, fontSize: 13,
    padding: '7px 10px', background: BG, color: TEXT, outline: 'none', fontFamily: FONT,
  };
}

function sectionHeadingStyle(): React.CSSProperties {
  return { fontSize: 11.5, fontWeight: 700, color: TEXT, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 10px' };
}

const EXECUTING: Set<TestAutomationExecutionStatus> = new Set(['pending', 'running']);

export default function TestAutomationSuite({
  tenantId, clientName, onBack, runId, onRunIdChange, view, onViewChange, reportRunId, onReportRunIdChange,
}: {
  tenantId?: string;
  clientName?: string;
  onBack?: () => void;
  // Resume a specific run on mount (deep link / refresh) — and report back whenever a run gets
  // opened (including via the recent-runs picker below) so the caller can keep the URL in sync.
  runId?: string;
  onRunIdChange?: (runId: string) => void;
  // Build (the upload -> review -> scenarios -> steps -> export wizard) vs. Schedule/Execute
  // (ad-hoc "run it now" + nightly schedule config) vs. Reports (the cross-run dashboard) —
  // three sibling top-level views, not stages of one wizard, since executing/reviewing results
  // shouldn't require passing through wizard chrome to get there.
  view: 'build' | 'execute' | 'reports';
  onViewChange: (view: 'build' | 'execute' | 'reports') => void;
  reportRunId?: string;
  onReportRunIdChange?: (runId: string) => void;
}) {
  const [run, setRun] = useState<TestAutomationRun | null>(null);
  const [recentRuns, setRecentRuns] = useState<TestAutomationRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [downloadingAgain, setDownloadingAgain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editedItems, setEditedItems] = useState<any>(null);
  const [editedScenarios, setEditedScenarios] = useState<TestAutomationScenario[] | null>(null);
  const [runConfig, setRunConfig] = useState({ runName: '', testPhase: '' as TestPhase | '', module: '' as TestModule | '', description: '' });
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function refreshRunList() {
    listTestAutomationRuns().then(r => setRecentRuns(r.runs)).catch(() => {}).finally(() => setLoadingRuns(false));
  }
  useEffect(() => { refreshRunList(); }, []);

  // Poll while the run is mid-generation on any stage, or while a Workday execution is in flight.
  // Self-rescheduling: each cycle decides whether to schedule the next one from the FRESH status
  // just fetched, not from the effect's own dependency array. A single setTimeout gated only by
  // [run?.status] fires once and never reschedules if that fetch's status comes back unchanged
  // (e.g. a run still 'generating_stories' after 3s) — status only ever CHANGES value at the
  // moment generation finishes, so the effect's dependencies stop updating and no further poll
  // is ever scheduled, leaving the UI stuck on a stage that already completed server-side.
  useEffect(() => {
    if (!run || (!GENERATING.has(run.status) && !EXECUTING.has(run.execution_status))) return;
    const runId = run.run_id;
    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      try {
        const fresh = await getTestAutomationRun(runId);
        if (cancelled) return;
        setRun(fresh);
        if (fresh.status === 'needs_review') setEditedItems(fresh.input_items);
        if (fresh.status === 'scenarios_ready') setEditedScenarios(fresh.scenarios ?? []);
        if (!cancelled && (GENERATING.has(fresh.status) || EXECUTING.has(fresh.execution_status))) {
          pollRef.current = setTimeout(poll, 3000);
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Failed to check run status');
      }
    }

    pollRef.current = setTimeout(poll, 3000);
    return () => { cancelled = true; if (pollRef.current) clearTimeout(pollRef.current); };
  }, [run?.run_id, run?.status, run?.execution_status]);

  async function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) setFile(f);
  }

  async function onUpload() {
    if (!file || !runConfig.testPhase || !runConfig.module) return;
    setUploading(true); setError(null);
    try {
      const { url, key } = await getTestAutomationUploadUrl(file.name);
      await putFileToS3(url, file);
      const created = await createTestAutomationRun({
        s3_key: key, filename: file.name,
        run_name: runConfig.runName || undefined, test_phase: runConfig.testPhase,
        module: runConfig.module, description: runConfig.description || undefined,
      });
      const full = await getTestAutomationRun(created.run_id);
      setRun(full);
      setEditedItems(full.status === 'needs_review' ? full.input_items : null);
      setFile(null);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setUploading(false);
    }
  }

  async function openRun(runIdToOpen: string) {
    setError(null);
    try {
      const full = await getTestAutomationRun(runIdToOpen);
      setRun(full);
      setEditedItems(full.status === 'needs_review' ? full.input_items : null);
      setEditedScenarios(full.status === 'scenarios_ready' ? (full.scenarios ?? []) : null);
      onRunIdChange?.(runIdToOpen);
    } catch (err: any) {
      setError(err.message || String(err));
    }
  }

  // Resume a run from a deep link / page refresh.
  useEffect(() => {
    if (runId && run?.run_id !== runId) openRun(runId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  async function onGenerateScenarios() {
    if (!run) return;
    setError(null);
    try {
      const r = await triggerTestAutomationScenarios(run.run_id, editedItems ?? undefined);
      setRun({ ...run, status: r.status as TestAutomationRunStatus });
    } catch (err: any) {
      setError(err.message || String(err));
    }
  }

  async function onGenerateSteps() {
    if (!run) return;
    setError(null);
    try {
      const r = await triggerTestAutomationSteps(run.run_id, editedScenarios ?? undefined);
      setRun({ ...run, status: r.status as TestAutomationRunStatus });
    } catch (err: any) {
      setError(err.message || String(err));
    }
  }

  async function onExport() {
    if (!run) return;
    setError(null);
    try {
      const r = await exportTestAutomationRun(run.run_id);
      window.open(r.download_url, '_blank');
      const fresh = await getTestAutomationRun(run.run_id);
      setRun(fresh);
    } catch (err: any) {
      setError(err.message || String(err));
    }
  }

  async function onDownloadAgain() {
    if (!run) return;
    setDownloadingAgain(true);
    try {
      const r = await exportTestAutomationRun(run.run_id);
      window.open(r.download_url, '_blank');
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setDownloadingAgain(false);
    }
  }

  async function onExecute(environmentId: string) {
    if (!run) return;
    setError(null);
    try {
      const r = await triggerTestAutomationExecute(run.run_id, environmentId);
      setRun({ ...run, execution_status: r.execution_status });
    } catch (err: any) {
      setError(err.message || String(err));
    }
  }

  function startOver() {
    setRun(null); setEditedItems(null); setEditedScenarios(null); setError(null); setFile(null);
    setRunConfig({ runName: '', testPhase: '', module: '', description: '' });
    refreshRunList();
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: BG, fontFamily: FONT }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '14px 24px',
        borderBottom: `1px solid ${BORDER}`, background: CARD, flexShrink: 0,
      }}>
        {onBack && (
          <button onClick={onBack} style={{
            border: 'none', background: 'none', cursor: 'pointer', color: MUTED, fontSize: 13,
            display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 8, fontFamily: FONT,
          }}>← Home</button>
        )}
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 16, fontWeight: 700, color: TEXT, margin: 0, letterSpacing: '-0.2px' }}>Test Automation Suite</h1>
          {clientName && <p style={{ fontSize: 12, color: MUTED, margin: '1px 0 0' }}>{clientName}</p>}
        </div>
        {view === 'build' && run && (
          <button onClick={startOver} style={{
            border: `1px solid ${BORDER}`, background: CARD, cursor: 'pointer', color: TEXT, fontSize: 12.5,
            fontWeight: 600, padding: '7px 14px', borderRadius: 999, fontFamily: FONT,
          }}>New Run</button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 4, padding: '0 24px', borderBottom: `1px solid ${BORDER}`, background: CARD, flexShrink: 0 }}>
        <ViewTabBtn active={view === 'build'} label="Build" onClick={() => onViewChange('build')} />
        <ViewTabBtn active={view === 'execute'} label="Schedule / Execute" onClick={() => onViewChange('execute')} />
        <ViewTabBtn active={view === 'reports'} label="Reports" onClick={() => onViewChange('reports')} />
      </div>

      {view === 'reports' ? (
        <TestAutomationReports tenantId={tenantId} runId={reportRunId} onRunIdChange={onReportRunIdChange} />
      ) : view === 'execute' ? (
        <TestAutomationExecute tenantId={tenantId} />
      ) : (
      <div style={{ flex: 1, overflowY: 'auto', padding: '28px 24px' }}>
        {!run ? (
          <UploadStage
            file={file} setFile={setFile} dragOver={dragOver} setDragOver={setDragOver}
            uploading={uploading} onUpload={onUpload} onDrop={onDrop}
            recentRuns={recentRuns} loadingRuns={loadingRuns} onOpenRun={openRun}
            runConfig={runConfig} setRunConfig={setRunConfig}
          />
        ) : (
          <div style={{ maxWidth: 900, margin: '0 auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: TEXT }}>{run.run_name || run.file_name}</span>
              {run.test_phase && <PhaseBadge phase={run.test_phase} />}
              {run.module && <ModuleBadge module={run.module} />}
            </div>
            <StageProgress status={run.status} />
            {error && (
              <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 14px', marginBottom: 16 }}>
                <p style={{ fontSize: 12.5, color: '#B91C1C', margin: 0 }}>{error}</p>
              </div>
            )}

            {GENERATING.has(run.status) && <LoadingCard label={STAGE_LABEL[run.status]} />}

            {run.status === 'failed' && (
              <div style={{ background: CARD, border: '1px solid #FECACA', borderRadius: 14, padding: 24, textAlign: 'center' }}>
                <p style={{ fontSize: 14, fontWeight: 600, color: '#B91C1C', margin: '0 0 6px' }}>Run failed</p>
                <p style={{ fontSize: 12.5, color: MUTED, margin: '0 0 16px' }}>{run.error || 'Unknown error'}</p>
                <button onClick={startOver} style={primaryBtnStyle()}>Start Over</button>
              </div>
            )}

            {run.status === 'needs_review' && (
              <ReviewStage
                inputType={run.input_type}
                items={editedItems}
                setItems={setEditedItems}
                onGenerate={onGenerateScenarios}
              />
            )}

            {run.status === 'scenarios_ready' && editedScenarios && (
              <ScenariosStage
                scenarios={editedScenarios}
                setScenarios={setEditedScenarios}
                onGenerate={onGenerateSteps}
              />
            )}

            {run.status === 'steps_ready' && (
              <StepsStage
                scenarios={run.scenarios ?? []}
                steps={run.steps ?? []}
                onExport={onExport}
              />
            )}

            {run.status === 'completed' && (
              <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 32, textAlign: 'center' }}>
                <div style={{ width: 48, height: 48, borderRadius: '50%', background: '#EAFBF1', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                </div>
                <p style={{ fontSize: 15, fontWeight: 600, color: TEXT, margin: '0 0 4px' }}>Export ready</p>
                <p style={{ fontSize: 12.5, color: MUTED, margin: '0 0 20px' }}>{run.file_name}</p>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                  <button onClick={onDownloadAgain} disabled={downloadingAgain} style={{ ...primaryBtnStyle(), display: 'flex', alignItems: 'center', gap: 7 }}>
                    {downloadingAgain && <Spinner size={13} color="#fff" trackColor="rgba(255,255,255,0.35)" />}
                    {downloadingAgain ? 'Downloading…' : 'Download Excel'}
                  </button>
                  <button onClick={startOver} style={secondaryBtnStyle()}>New Run</button>
                </div>
              </div>
            )}

            {(run.status === 'steps_ready' || run.status === 'completed') && (
              <ExecutionPanel run={run} tenantId={tenantId} onExecute={onExecute} />
            )}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

function ViewTabBtn({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      border: 'none', background: 'none', cursor: 'pointer', fontFamily: FONT,
      padding: '10px 16px', marginBottom: -1, fontSize: 13, fontWeight: 600,
      color: active ? INK : MUTED, borderBottom: `2px solid ${active ? INK : 'transparent'}`,
    }}>{label}</button>
  );
}

// ── Stage progress bar ───────────────────────────────────────────────────────

const STAGES: { key: TestAutomationRunStatus[]; label: string }[] = [
  { key: ['parsing', 'generating_stories', 'needs_review'], label: 'Review' },
  { key: ['generating_scenarios', 'scenarios_ready'], label: 'Scenarios' },
  { key: ['generating_steps', 'steps_ready'], label: 'Steps' },
  { key: ['exporting', 'completed'], label: 'Export' },
];

function StageProgress({ status }: { status: TestAutomationRunStatus }) {
  if (status === 'failed') return null;
  const activeIdx = STAGES.findIndex(s => s.key.includes(status));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24 }}>
      {STAGES.map((s, i) => (
        <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: i < STAGES.length - 1 ? 1 : undefined }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
            fontWeight: i <= activeIdx ? 700 : 500, color: i <= activeIdx ? INK : '#C7C7CC',
          }}>
            <span style={{
              width: 18, height: 18, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: i < activeIdx ? INK : i === activeIdx ? '#fff' : BG,
              border: i === activeIdx ? `2px solid ${INK}` : i < activeIdx ? 'none' : `1.5px solid ${BORDER}`,
              color: i < activeIdx ? '#fff' : i === activeIdx ? INK : '#C7C7CC', fontSize: 10, fontWeight: 700,
            }}>{i < activeIdx ? '✓' : i + 1}</span>
            {s.label}
          </div>
          {i < STAGES.length - 1 && <div style={{ flex: 1, height: 1.5, background: i < activeIdx ? INK : BORDER }} />}
        </div>
      ))}
    </div>
  );
}

function LoadingCard({ label }: { label: string }) {
  return (
    <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: '20px 24px', display: 'flex', alignItems: 'center', gap: 14 }}>
      <Spinner size={20} color={INK} trackColor={BORDER} />
      <div>
        <p style={{ fontSize: 13.5, fontWeight: 600, color: TEXT, margin: 0 }}>{label}</p>
        <p style={{ fontSize: 11.5, color: MUTED, margin: '2px 0 0' }}>This can take a minute or two — feel free to leave this open.</p>
      </div>
    </div>
  );
}

function primaryBtnStyle(): React.CSSProperties {
  return { padding: '10px 20px', borderRadius: 999, fontSize: 13.5, fontWeight: 600, border: 'none', cursor: 'pointer', background: INK, color: '#fff', fontFamily: FONT };
}
function secondaryBtnStyle(): React.CSSProperties {
  return { padding: '10px 20px', borderRadius: 999, fontSize: 13.5, fontWeight: 600, border: `1px solid ${BORDER}`, cursor: 'pointer', background: CARD, color: TEXT, fontFamily: FONT };
}

// ── Upload stage ──────────────────────────────────────────────────────────────

type RunConfig = { runName: string; testPhase: TestPhase | ''; module: TestModule | ''; description: string };

function UploadStage(p: {
  file: File | null; setFile: (f: File | null) => void;
  dragOver: boolean; setDragOver: (v: boolean) => void;
  uploading: boolean; onUpload: () => void; onDrop: (e: React.DragEvent) => void;
  recentRuns: TestAutomationRun[]; loadingRuns: boolean; onOpenRun: (runId: string) => void | Promise<void>;
  runConfig: RunConfig; setRunConfig: (v: RunConfig | ((prev: RunConfig) => RunConfig)) => void;
}) {
  const configReady = !!p.runConfig.testPhase && !!p.runConfig.module;
  const canAnalyse = !!p.file && configReady && !p.uploading;
  const [openingRunId, setOpeningRunId] = useState<string | null>(null);

  async function handleOpenRun(runId: string) {
    setOpeningRunId(runId);
    try { await p.onOpenRun(runId); } finally { setOpeningRunId(null); }
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', gap: 28 }}>
      <div style={{ flex: 1, maxWidth: 460 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: TEXT, margin: '0 0 6px', letterSpacing: '-0.2px' }}>New Run</h2>
        <p style={{ fontSize: 13, color: MUTED, margin: '0 0 20px', lineHeight: 1.6 }}>
          Define the suite, then upload the source document — the input type is detected
          automatically from the file.
        </p>

        <h3 style={sectionHeadingStyle()}>1. Run Details</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 22 }}>
          <div>
            <label style={labelStyle()}>Run Name</label>
            <input style={fieldStyle()} placeholder="e.g. HCM Absence — Sprint 4"
              value={p.runConfig.runName}
              onChange={e => p.setRunConfig(prev => ({ ...prev, runName: e.target.value }))} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={labelStyle()}>Test Phase *</label>
              <select style={fieldStyle()} value={p.runConfig.testPhase}
                onChange={e => p.setRunConfig(prev => ({ ...prev, testPhase: e.target.value as TestPhase }))}>
                <option value="">Select…</option>
                {TEST_PHASES.map(ph => <option key={ph} value={ph}>{ph}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle()}>Module *</label>
              <select style={fieldStyle()} value={p.runConfig.module}
                onChange={e => p.setRunConfig(prev => ({ ...prev, module: e.target.value as TestModule }))}>
                <option value="">Select…</option>
                {TEST_MODULES.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label style={labelStyle()}>Notes</label>
            <textarea style={{ ...fieldStyle(), minHeight: 52, resize: 'vertical' }}
              placeholder="Optional — scope, context for reviewers, anything worth flagging up front."
              value={p.runConfig.description}
              onChange={e => p.setRunConfig(prev => ({ ...prev, description: e.target.value }))} />
          </div>
        </div>

        <h3 style={sectionHeadingStyle()}>2. Upload File</h3>
        <div
          onDragOver={e => { e.preventDefault(); p.setDragOver(true); }}
          onDragLeave={() => p.setDragOver(false)}
          onDrop={p.onDrop}
          onClick={() => document.getElementById('ta-file-input')?.click()}
          style={{
            border: `2px dashed ${p.dragOver ? INK : p.file ? '#34C759' : '#C7C7CC'}`,
            borderRadius: 14, background: p.dragOver ? '#F0F8FF' : CARD, cursor: 'pointer',
            padding: 24, transition: 'all 0.2s',
          }}>
          <input id="ta-file-input" type="file" accept=".xlsx,.docx" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) p.setFile(f); }} />
          {p.file ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: '#ECF4EE', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 18 }}>📄</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ color: TEXT, fontWeight: 600, fontSize: 13.5, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.file.name}</p>
                <p style={{ color: MUTED, fontSize: 11.5, margin: '3px 0 0' }}>{(p.file.size / 1024).toFixed(1)} KB</p>
              </div>
              <button onClick={e => { e.stopPropagation(); p.setFile(null); }} style={{ color: '#C7C7CC', fontSize: 20, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>×</button>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '10px 0' }}>
              <p style={{ color: TEXT, fontWeight: 500, fontSize: 13.5, margin: 0 }}>Drop a file here</p>
              <p style={{ color: MUTED, fontSize: 11.5, margin: '4px 0 0' }}>or click to browse — .xlsx or .docx</p>
            </div>
          )}
        </div>

        <button onClick={p.onUpload} disabled={!canAnalyse} style={{
          width: '100%', marginTop: 16, padding: '12px', borderRadius: 999, fontSize: 14, fontWeight: 600,
          border: 'none', cursor: canAnalyse ? 'pointer' : 'not-allowed', fontFamily: FONT,
          background: canAnalyse ? INK : BORDER, color: canAnalyse ? '#fff' : '#C7C7CC',
        }}>{p.uploading ? 'Uploading…' : !configReady ? 'Select test phase & module to continue' : 'Analyse File'}</button>
      </div>

      <div style={{ flex: 1 }}>
        <h3 style={{ fontSize: 12, fontWeight: 600, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px' }}>Recent Runs</h3>
        {p.loadingRuns ? (
          <p style={{ fontSize: 12.5, color: MUTED }}>Loading…</p>
        ) : p.recentRuns.length === 0 ? (
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: '20px', textAlign: 'center' }}>
            <p style={{ fontSize: 12.5, color: MUTED, margin: 0 }}>No runs yet.</p>
          </div>
        ) : (
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden' }}>
            {p.recentRuns.map((r, idx) => (
              <button key={r.run_id} onClick={() => handleOpenRun(r.run_id)} disabled={openingRunId === r.run_id} style={{
                width: '100%', textAlign: 'left', background: 'none', border: 'none',
                borderTop: idx > 0 ? '1px solid #F5F5F7' : 'none',
                padding: '12px 18px', cursor: openingRunId === r.run_id ? 'default' : 'pointer', fontFamily: FONT,
                opacity: openingRunId === r.run_id ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 13, fontWeight: 600, color: TEXT, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.run_name || r.file_name}</p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
                    {r.test_phase && <PhaseBadge phase={r.test_phase} />}
                    {r.module && <ModuleBadge module={r.module} />}
                    <span style={{ fontSize: 10.5, color: MUTED }}>{INPUT_TYPE_LABEL[r.input_type] ?? r.input_type}</span>
                    <span style={{ fontSize: 10.5, color: '#C7C7CC' }}>·</span>
                    <span style={{ fontSize: 10.5, color: r.status === 'failed' ? '#DC2626' : r.status === 'completed' ? '#16A34A' : MUTED, fontWeight: 600 }}>{STAGE_LABEL[r.status]}</span>
                  </div>
                </div>
                {openingRunId === r.run_id && <Spinner size={14} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Review stage (stage-1 content, shape depends on input_type) ─────────────

function ReviewStage({ inputType, items, setItems, onGenerate }: {
  inputType: string; items: any; setItems: (v: any) => void; onGenerate: () => void | Promise<void>;
}) {
  const isBpw = inputType === 'bpw';
  const list: any[] = isBpw ? (items?.bpw_steps ?? []) : (Array.isArray(items) ? items : []);
  const [busy, setBusy] = useState(false);

  async function handleGenerate() {
    setBusy(true);
    try { await onGenerate(); } finally { setBusy(false); }
  }

  function updateStoryField(idx: number, field: string, value: string) {
    setItems((prev: any[]) => prev.map((it, i) => i === idx ? { ...it, [field]: value } : it));
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: TEXT, margin: 0 }}>Review {INPUT_TYPE_LABEL[inputType] ?? inputType}</h2>
          <p style={{ fontSize: 12, color: MUTED, margin: '2px 0 0' }}>{list.length} item{list.length !== 1 ? 's' : ''} — edit anything before generating test scenarios.</p>
        </div>
        <button onClick={handleGenerate} disabled={list.length === 0 || busy} style={{ ...primaryBtnStyle(), display: 'flex', alignItems: 'center', gap: 7 }}>
          {busy && <Spinner size={13} color="#fff" trackColor="rgba(255,255,255,0.35)" />}
          {busy ? 'Generating…' : 'Generate Scenarios →'}
        </button>
      </div>

      <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden' }}>
        {(inputType === 'requirements' || inputType === 'user_stories') && Array.isArray(items) && items.map((story: any, idx: number) => (
          <div key={idx} style={{ padding: '16px 18px', borderTop: idx > 0 ? '1px solid #F5F5F7' : 'none' }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: MUTED, margin: '0 0 10px', letterSpacing: '0.04em' }}>US-{String(idx + 1).padStart(3, '0')} · {story.requirement_id}</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 8 }}>
              <div><label style={labelStyle()}>As a</label><input style={fieldStyle()} value={story.as_a ?? ''} onChange={e => updateStoryField(idx, 'as_a', e.target.value)} /></div>
              <div><label style={labelStyle()}>I want</label><input style={fieldStyle()} value={story.i_want ?? ''} onChange={e => updateStoryField(idx, 'i_want', e.target.value)} /></div>
              <div><label style={labelStyle()}>So that</label><input style={fieldStyle()} value={story.so_that ?? ''} onChange={e => updateStoryField(idx, 'so_that', e.target.value)} /></div>
            </div>
            <label style={labelStyle()}>Acceptance Criteria (one per line)</label>
            <textarea style={{ ...fieldStyle(), minHeight: 52, resize: 'vertical' }}
              value={(story.acceptance_criteria ?? []).join('\n')}
              onChange={e => updateStoryField(idx, 'acceptance_criteria', e.target.value.split('\n').filter(Boolean) as any)} />
          </div>
        ))}

        {inputType === 'config_workbook' && Array.isArray(items) && items.map((it: any, idx: number) => (
          <div key={idx} style={{ padding: '14px 18px', borderTop: idx > 0 ? '1px solid #F5F5F7' : 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: MUTED }}>{it.item_id}</span>
              <span style={{ fontSize: 10.5, fontWeight: 600, color: INK, background: BG, borderRadius: 6, padding: '1px 6px' }}>{it.action}</span>
              <span style={{ fontSize: 11.5, color: MUTED }}>{it.sheet_name}</span>
            </div>
            <p style={{ fontSize: 13.5, fontWeight: 600, color: TEXT, margin: '0 0 4px' }}>{it.display_name}</p>
            <p style={{ fontSize: 11.5, color: MUTED, margin: 0 }}>Ref: {it.reference_id}</p>
          </div>
        ))}

        {isBpw && list.map((step: any, idx: number) => (
          <div key={idx} style={{ padding: '14px 18px', borderTop: idx > 0 ? '1px solid #F5F5F7' : 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: MUTED }}>{step.process_name} · Step {step.step_number}</span>
              <span style={{ fontSize: 10.5, fontWeight: 600, color: INK, background: BG, borderRadius: 6, padding: '1px 6px' }}>{step.step_type}</span>
            </div>
            <p style={{ fontSize: 13.5, fontWeight: 600, color: TEXT, margin: '0 0 4px' }}>{step.step_name} <span style={{ color: MUTED, fontWeight: 400 }}>({step.role})</span></p>
            {step.description && <p style={{ fontSize: 12, color: MUTED, margin: 0 }}>{step.description}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function labelStyle(): React.CSSProperties {
  return { display: 'block', fontSize: 10.5, fontWeight: 600, color: MUTED, marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.03em' };
}

// ── Scenarios stage ───────────────────────────────────────────────────────────

function ScenariosStage({ scenarios, setScenarios, onGenerate }: {
  scenarios: TestAutomationScenario[]; setScenarios: (v: TestAutomationScenario[]) => void; onGenerate: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  async function handleGenerate() {
    setBusy(true);
    try { await onGenerate(); } finally { setBusy(false); }
  }

  function update(idx: number, field: keyof TestAutomationScenario, value: any) {
    setScenarios(scenarios.map((s, i) => i === idx ? { ...s, [field]: value } : s));
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: TEXT, margin: 0 }}>Review Test Scenarios</h2>
          <p style={{ fontSize: 12, color: MUTED, margin: '2px 0 0' }}>{scenarios.length} scenario{scenarios.length !== 1 ? 's' : ''} — edit anything before generating test steps.</p>
        </div>
        <button onClick={handleGenerate} disabled={scenarios.length === 0 || busy} style={{ ...primaryBtnStyle(), display: 'flex', alignItems: 'center', gap: 7 }}>
          {busy && <Spinner size={13} color="#fff" trackColor="rgba(255,255,255,0.35)" />}
          {busy ? 'Generating…' : 'Generate Steps →'}
        </button>
      </div>
      <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden' }}>
        {scenarios.map((sc, idx) => (
          <div key={sc.scenario_id ?? idx} style={{ padding: '16px 18px', borderTop: idx > 0 ? '1px solid #F5F5F7' : 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: MUTED }}>{sc.scenario_label ?? `TS-${String(idx + 1).padStart(3, '0')}`}</span>
              <span style={{ fontSize: 10.5, color: MUTED }}>· {sc.source_ref}</span>
              <select value={sc.scenario_type} onChange={e => update(idx, 'scenario_type', e.target.value as any)}
                style={{
                  marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, border: 'none', borderRadius: 999,
                  padding: '2px 10px', cursor: 'pointer', fontFamily: FONT,
                  background: sc.scenario_type === 'Positive' ? '#EAFBF1' : '#FEF2F2',
                  color: sc.scenario_type === 'Positive' ? '#16A34A' : '#DC2626',
                }}>
                <option value="Positive">Positive</option>
                <option value="Negative">Negative</option>
              </select>
            </div>
            <input style={{ ...fieldStyle(), fontWeight: 600, marginBottom: 8 }} value={sc.title} onChange={e => update(idx, 'title', e.target.value)} />
            <textarea style={{ ...fieldStyle(), minHeight: 44, resize: 'vertical', marginBottom: 8 }} value={sc.description} onChange={e => update(idx, 'description', e.target.value)} />
            <label style={labelStyle()}>Preconditions (one per line)</label>
            <textarea style={{ ...fieldStyle(), minHeight: 44, resize: 'vertical' }}
              value={(sc.preconditions ?? []).join('\n')}
              onChange={e => update(idx, 'preconditions', e.target.value.split('\n').filter(Boolean))} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Steps stage (read-only, grouped by scenario; export triggers here) ──────

function StepsStage({ scenarios, steps, onExport }: {
  scenarios: TestAutomationScenario[]; steps: TestAutomationStep[]; onExport: () => void | Promise<void>;
}) {
  const byScenario = new Map<string, TestAutomationStep[]>();
  for (const st of steps) {
    if (!byScenario.has(st.scenario_id)) byScenario.set(st.scenario_id, []);
    byScenario.get(st.scenario_id)!.push(st);
  }
  const [busy, setBusy] = useState(false);

  async function handleExport() {
    setBusy(true);
    try { await onExport(); } finally { setBusy(false); }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: TEXT, margin: 0 }}>Review Test Steps</h2>
          <p style={{ fontSize: 12, color: MUTED, margin: '2px 0 0' }}>{steps.length} step{steps.length !== 1 ? 's' : ''} across {scenarios.length} scenario{scenarios.length !== 1 ? 's' : ''}.</p>
        </div>
        <button onClick={handleExport} disabled={busy} style={{ ...primaryBtnStyle(), display: 'flex', alignItems: 'center', gap: 7 }}>
          {busy && <Spinner size={13} color="#fff" trackColor="rgba(255,255,255,0.35)" />}
          {busy ? 'Exporting…' : 'Export to Excel →'}
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {scenarios.map(sc => (
          <div key={sc.scenario_id} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '10px 16px', background: BG, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: MUTED }}>{sc.scenario_label}</span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: TEXT }}>{sc.title}</span>
              <span style={{
                marginLeft: 'auto', fontSize: 10, fontWeight: 700, borderRadius: 999, padding: '1px 8px',
                background: sc.scenario_type === 'Positive' ? '#EAFBF1' : '#FEF2F2',
                color: sc.scenario_type === 'Positive' ? '#16A34A' : '#DC2626',
              }}>{sc.scenario_type}</span>
            </div>
            <div style={{ padding: '4px 16px' }}>
              {(byScenario.get(sc.scenario_id) ?? []).map(st => (
                <div key={st.step_id} style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: `1px solid ${BORDER}` }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: MUTED, width: 34, flexShrink: 0 }}>#{st.step_number}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 12.5, color: TEXT, margin: 0 }}>{st.action}</p>
                    <p style={{ fontSize: 11.5, color: MUTED, margin: '3px 0 0' }}><strong>Expected:</strong> {st.expected_result}</p>
                    {st.test_data && <p style={{ fontSize: 11.5, color: '#8E8E93', margin: '3px 0 0' }}><strong>Data:</strong> {st.test_data}</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Execution panel (Workday-execution engine — appears once steps are ready) ──

function ExecutionPanel({ run, tenantId, onExecute }: {
  run: TestAutomationRun; tenantId?: string; onExecute: (environmentId: string) => void;
}) {
  const [environments, setEnvironments] = useState<TestEnvironment[]>([]);
  const [selectedEnv, setSelectedEnv] = useState<string>('');
  const [loadingEnvs, setLoadingEnvs] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) { setLoadingEnvs(false); return; }
    listTestEnvironments(tenantId)
      .then(({ environments }) => {
        setEnvironments(environments);
        const withCred = environments.find(e => e.has_credential);
        if (withCred) setSelectedEnv(withCred.environment_id);
      })
      .catch(() => setEnvironments([]))
      .finally(() => setLoadingEnvs(false));
  }, [tenantId]);

  const isExecuting = EXECUTING.has(run.execution_status);
  const hasRun = run.execution_status !== 'not_executed';
  const scenarios = run.scenarios ?? [];
  const steps = run.steps ?? [];
  const selectedHasCred = environments.find(e => e.environment_id === selectedEnv)?.has_credential ?? false;
  const canExecute = !!selectedEnv && selectedHasCred && !triggering && !isExecuting;

  async function handleExecute() {
    setTriggering(true); setError(null);
    try {
      await onExecute(selectedEnv);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setTriggering(false);
    }
  }

  return (
    <div style={{ marginTop: 20, background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: hasRun ? 16 : 0, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: TEXT, margin: 0 }}>Execute in Workday</h3>
            {hasRun && <ExecBadge status={run.execution_status} />}
          </div>
          <p style={{ fontSize: 11.5, color: MUTED, margin: '4px 0 0', maxWidth: 480, lineHeight: 1.5 }}>
            Runs each scenario against the selected Workday environment in a headless browser —
            best-effort: a screenshot and completion signal per step for human review, not a
            guaranteed pass/fail verdict. Sandbox/preview environments only (no MFA/SSO support yet).
          </p>
        </div>
        {!loadingEnvs && environments.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <select value={selectedEnv} onChange={e => setSelectedEnv(e.target.value)}
              style={{ fontSize: 12, padding: '7px 10px', borderRadius: 8, border: `1px solid ${BORDER}`, background: '#FFF' }}>
              {environments.map(env => (
                <option key={env.environment_id} value={env.environment_id} disabled={!env.has_credential}>
                  {env.name}{!env.has_credential ? ' (no credential)' : ''}
                </option>
              ))}
            </select>
            <button onClick={handleExecute} disabled={!canExecute}
              style={{
                ...primaryBtnStyle(),
                opacity: !canExecute ? 0.4 : 1,
                cursor: !canExecute ? 'not-allowed' : 'pointer',
              }}>
              {isExecuting ? 'Executing…' : hasRun ? 'Re-run Execution' : 'Execute in Workday'}
            </button>
          </div>
        )}
      </div>

      {!loadingEnvs && environments.length === 0 && (
        <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 10, padding: '10px 14px', marginTop: 14 }}>
          <p style={{ fontSize: 12, color: '#9A3412', margin: 0 }}>
            No Workday environments configured for this client — ask an admin to add one under
            Clients → Workday Creds.
          </p>
        </div>
      )}
      {error && (
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 14px', marginTop: 14 }}>
          <p style={{ fontSize: 12, color: '#B91C1C', margin: 0 }}>{error}</p>
        </div>
      )}

      {hasRun && <ExecutionResultsList runId={run.run_id} scenarios={scenarios} steps={steps} />}
    </div>
  );
}
