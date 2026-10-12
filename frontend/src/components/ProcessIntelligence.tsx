import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  getAgentLld,
  getGraphStatus,
  getProcessGraph,
  getTobeGraphAndAgents,
  getDemoGenerate,
  listProcesses,
  applyRecommendationsAndGenerate,
  patchProcessGraph,
  putFileToS3,
  triggerAgentLld,
  triggerParseDiagram,
  uploadProcessDiagram,
  type PiAgent,
  type PiAiOpportunity,
  type PiDomain,
  type PiDemoStatus,
  type PiGraph,
  type PiLanePatch,
  type PiProcessSummary,
  type PiStep,
  type PiStepPatch,
  type PiTobeGraph,
} from '../lib/api';
import { ProcessMap, type MapGraph } from './ProcessMap';
import { AiRecommendationsPanel } from './AiRecommendationsPanel';
import { AgentReviewPanel } from './AgentReviewPanel';
import { AgentDesignDoc } from './AgentDesignDoc';
import { PlanningAssistant } from './PlanningAssistant';
import { PipelineStepper, HomeButton } from './PipelineStepper';
import { Spinner } from './Spinner';
import { downloadBlob } from '../lib/download';

// ── Design tokens (Apple-inspired) ────────────────────────────────────────────
// bg: #F5F5F7  card: #FFFFFF  text: #1D1D1F  secondary: #6E6E73
// separator: #E5E5EA  blue: #0C0D0D

// ── Data ──────────────────────────────────────────────────────────────────────

const DOMAINS: { value: PiDomain; label: string }[] = [
  { value: 'recruiting',       label: 'Recruiting' },
  { value: 'onboarding',       label: 'Onboarding' },
  { value: 'self_service',     label: 'Employee Self-Service' },
  { value: 'payroll',          label: 'Payroll' },
  { value: 'job_architecture', label: 'Job Architecture' },
  { value: 'performance',      label: 'Performance Management' },
];

type OppDef = { label: string; activeBg: string; activeText: string; dot: string };
const OPP_DEFS: Record<PiAiOpportunity, OppDef> = {
  sana_agent:     { label: 'Agentic AI',       activeBg: '#0d9488', activeText: '#fff', dot: '#0d9488' },
  workday_native: { label: 'Workday Native AI', activeBg: '#16a34a', activeText: '#fff', dot: '#16a34a' },
  partial_ai:     { label: 'AI-Assisted',       activeBg: '#d97706', activeText: '#fff', dot: '#d97706' },
  human_only:     { label: 'Human Only',         activeBg: '#64748b', activeText: '#fff', dot: '#94a3b8' },
};
const OPP_ORDER: PiAiOpportunity[] = ['sana_agent', 'workday_native', 'partial_ai', 'human_only'];
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';

// ── Graph adapters ─────────────────────────────────────────────────────────────

function piGraphToMapGraph(graph: PiGraph, edits: Record<string, Partial<PiStep>>): MapGraph {
  return {
    swimlanes: graph.swimlanes,
    steps: graph.steps.map(s => {
      const e = edits[s.step_id] ?? {};
      return {
        step_id:        s.step_id,
        lane_id:        (e.lane_id !== undefined ? e.lane_id : s.lane_id) ?? null,
        label:          e.label ?? s.label,
        step_type:      s.type,
        ai_opportunity: (e.ai_opportunity ?? s.ai_opportunity) ?? null,
        tooltip:        s.ai_rationale ?? undefined,
      };
    }),
    connectors: graph.connectors.map(c => ({ from: c.from, to: c.to, condition: c.condition })),
  };
}

function tobeToMapGraph(tobe: PiTobeGraph): MapGraph {
  return {
    swimlanes: tobe.swimlanes,
    steps: tobe.steps.map(s => ({
      step_id:        s.step_id,
      lane_id:        s.lane_id ?? null,
      label:          s.label,
      step_type:      s.step_type,
      ai_opportunity: s.ai_opportunity ?? null,
      tooltip:        s.transformation_note ?? undefined,
    })),
    connectors: tobe.connectors.map(c => ({ from: c.from, to: c.to, condition: c.condition })),
  };
}

// ── Root ───────────────────────────────────────────────────────────────────────

type LoadPhase = 'upload' | 'uploading' | 'parsing' | 'error';
type WorkPhase = 'asis' | 'agentic';

export default function ProcessIntelligence({
  tenantId, clientName, initialFile, initialDomain, onBack,
}: {
  tenantId?: string;
  clientName?: string;
  initialFile?: File;
  initialDomain?: PiDomain;
  onBack?: () => void;
}) {
  const [loadPhase, setLoadPhase] = useState<LoadPhase>(initialFile ? 'uploading' : 'upload');
  const [domain, setDomain]       = useState<PiDomain>(initialDomain ?? 'onboarding');
  const [file, setFile]           = useState<File | null>(initialFile ?? null);
  const [dragOver, setDragOver]   = useState(false);
  const [errorMsg, setErrorMsg]   = useState('');
  const [parseMsg, setParseMsg]   = useState('');

  // Recent Processes — an explicit, informed choice of which process to
  // reopen, replacing a previous mechanism that silently auto-resumed a
  // single process_id remembered in localStorage keyed only by tenant. That
  // key was never cleared on logout, so any consultant opening a shared
  // client's Process Intelligence could be dropped into another
  // consultant's (or their own stale/abandoned) in-flight analysis with no
  // confirmation UI — reported live as "sometimes goes to analysing
  // document" after logging back in.
  const [recentProcesses, setRecentProcesses] = useState<PiProcessSummary[]>([]);
  const [loadingRecent, setLoadingRecent]     = useState(true);
  const [openingProcessId, setOpeningProcessId] = useState<string | null>(null);

  const [graph, setGraph]             = useState<PiGraph | null>(null);
  const [workPhase, setWorkPhase]     = useState<WorkPhase>('asis');
  const [stepEdits, setStepEditsRaw]  = useState<Record<string, Partial<PiStep>>>({});
  const [laneEdits, setLaneEditsRaw]  = useState<Record<string, { label?: string; persona?: string }>>({});
  const [saving, setSaving]           = useState(false);
  const [saved, setSaved]             = useState(false);

  const [agenticGraph, setAgenticGraph]   = useState<PiTobeGraph | null>(null);
  const [agents, setAgents]               = useState<PiAgent[]>([]);
  const [agenticLoading, setAgenticLoading] = useState(false);
  const [agenticError, setAgenticError]   = useState('');

  const [showRecommendations, setShowRecommendations] = useState(false);
  const [showPlan, setShowPlan]           = useState(false);
  const [viewingAgentId, setViewingAgentId] = useState<string | null>(null);
  const [editingStepId, setEditingStepId] = useState<string | null>(null);

  const [showAgentReview, setShowAgentReview] = useState(false);
  const [demoStatus, setDemoStatus]       = useState<PiDemoStatus>('not_generated');
  const [demoDownloadUrl, setDemoDownloadUrl] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPolling = () => { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null; };
  useEffect(() => () => stopPolling(), []);

  function setStepEdits(e: Record<string, Partial<PiStep>>) { setSaved(false); setStepEditsRaw(e); }
  function setLaneEdits(e: Record<string, { label?: string; persona?: string }>) { setSaved(false); setLaneEditsRaw(e); }

  const startPolling = useCallback((pid: string) => {
    setParseMsg('Reading your diagram…');
    let ticks = 0;
    pollRef.current = setInterval(async () => {
      ticks++;
      if (ticks === 3) setParseMsg('Identifying process steps…');
      if (ticks === 6) setParseMsg('Classifying AI opportunities…');
      if (ticks === 9) setParseMsg('Finalising…');
      try {
        const status = await getGraphStatus(pid);
        if (status.parse_status === 'parsing') return;
        stopPolling();
        if (status.parse_status === 'failed') {
          setErrorMsg(status.parse_error || 'Parse failed'); setLoadPhase('error'); return;
        }
        const g = await getProcessGraph(pid);
        setGraph(g); setWorkPhase('asis');
      } catch (err: any) {
        stopPolling(); setErrorMsg(err.message || 'Status check failed'); setLoadPhase('error');
      }
    }, 3000);
  }, []);

  // Once a graph is available: check for a previously-generated agentic
  // workflow so revisiting the process loses neither the map nor the agentic
  // work already done on it. Wrapped in agenticLoading so switching to the
  // Agentic Workflow tab before this lands shows the "Building the agentic
  // workflow…" spinner instead of a flash of "No agentic workflow yet".
  useEffect(() => {
    if (!graph || graph.parse_status === 'parsing') return;
    (async () => {
      setAgenticLoading(true);
      try {
        const result = await getTobeGraphAndAgents(graph.process_id);
        if (result.tobe) setAgenticGraph(result.tobe);
        if (result.proposed_agents.length) setAgents(result.proposed_agents);
      } catch {
        // Non-fatal — the Agentic Workflow tab just starts gated/empty.
      }
      try {
        const demo = await getDemoGenerate(graph.process_id);
        setDemoStatus(demo.demo_status);
        setDemoDownloadUrl(demo.download_url);
      } catch {
        // Non-fatal — demo generation just starts fresh (not_generated).
      }
      setAgenticLoading(false);
    })();
  }, [graph?.process_id]);

  // On first load with no fresh upload in hand, fetch this tenant's recent
  // processes so the upload screen can show them — never auto-navigate.
  useEffect(() => {
    if (initialFile) return;
    let cancelled = false;
    (async () => {
      try {
        const { processes } = await listProcesses();
        if (!cancelled) setRecentProcesses(processes);
      } catch {
        // Non-fatal — the upload screen just shows an empty recent list.
      } finally {
        if (!cancelled) setLoadingRecent(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId]);

  // Explicit, user-initiated reopen of a process the consultant picked from
  // the Recent Processes list — the informed replacement for the old silent
  // localStorage auto-resume.
  async function openProcess(processId: string) {
    setOpeningProcessId(processId);
    try {
      const status = await getGraphStatus(processId);
      if (status.parse_status === 'parsing') { setLoadPhase('parsing'); startPolling(processId); return; }
      if (status.parse_status === 'failed') { throw new Error(status.parse_error || 'Parse failed'); }
      const g = await getProcessGraph(processId);
      setGraph(g); setWorkPhase('asis');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to open process'); setLoadPhase('error');
    } finally {
      setOpeningProcessId(null);
    }
  }

  async function handleUpload() {
    if (!file) return;
    setLoadPhase('uploading');
    try {
      const { process_id, upload_url } = await uploadProcessDiagram({
        filename: file.name, domain,
        source_name: file.name.replace(/\.(vsdx|png|jpe?g|pdf)$/i, ''),
      });
      await putFileToS3(upload_url, file);
      await triggerParseDiagram(process_id);
      setLoadPhase('parsing');
      startPolling(process_id);
    } catch (err: any) {
      setErrorMsg(err.message || 'Upload failed'); setLoadPhase('error');
    }
  }

  async function handleSave() {
    if (!graph) return;
    setSaving(true);
    try {
      const step_patches: PiStepPatch[] = Object.entries(stepEdits).map(([step_id, e]) => ({
        step_id,
        ...(e.label           !== undefined ? { label:           e.label }           : {}),
        ...(e.lane_id         !== undefined ? { lane_id:         e.lane_id }         : {}),
        ...(e.systems_touched !== undefined ? { systems_touched: e.systems_touched } : {}),
        ...(e.ai_opportunity  != null       ? { ai_opportunity:  e.ai_opportunity }  : {}),
      }));
      const lane_patches: PiLanePatch[] = Object.entries(laneEdits).map(([lane_id, e]) => ({ lane_id, ...e }));
      if (step_patches.length || lane_patches.length) {
        await patchProcessGraph(graph.process_id, { step_patches, lane_patches });
      }
      const fresh = await getProcessGraph(graph.process_id);
      setGraph(fresh); setStepEditsRaw({}); setLaneEditsRaw({});
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (err: any) {
      setErrorMsg(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function handleRecommendationsApplied(result: { tobe: PiTobeGraph; proposed_agents: PiAgent[] }) {
    setAgenticGraph(result.tobe);
    setAgents(result.proposed_agents);
    setAgenticError('');
    setShowRecommendations(false);
    setWorkPhase('agentic');
  }

  // Per-agent LLD generation, triggered inline from the Proposed AI Agents
  // row rather than as a side effect of opening a new screen — clicking a
  // not-yet-generated agent used to navigate to Agent Design Doc AND kick
  // off generation as one motion; now the row itself drafts in place (its
  // "Drafting design…" state), and only a *generated* doc opens the
  // full-screen view. Tracks one interval per agent since more than one
  // could be drafting at once.
  const agentPollRefs = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  useEffect(() => () => { agentPollRefs.current.forEach(clearInterval); agentPollRefs.current.clear(); }, []);

  async function generateAgentDoc(agentId: string) {
    if (!graph) return;
    const existing = agentPollRefs.current.get(agentId);
    if (existing) clearInterval(existing);
    setAgents(prev => prev.map(a => (a.agent_id === agentId ? { ...a, lld_status: 'generating' } : a)));
    try {
      await triggerAgentLld(graph.process_id, agentId);
    } catch (err: any) {
      setAgents(prev => prev.map(a => (a.agent_id === agentId
        ? { ...a, lld_status: 'failed', lld_error: err.message || 'Failed to start document generation' } : a)));
      return;
    }
    const interval = setInterval(async () => {
      try {
        const a = await getAgentLld(graph.process_id, agentId);
        setAgents(prev => prev.map(p => (p.agent_id === agentId ? a : p)));
        if (a.lld_status === 'done' || a.lld_status === 'failed') {
          clearInterval(interval);
          agentPollRefs.current.delete(agentId);
        }
      } catch {
        clearInterval(interval);
        agentPollRefs.current.delete(agentId);
      }
    }, 2500);
    agentPollRefs.current.set(agentId, interval);
  }

  function handleExportDiagram(svgGraph: MapGraph, name: string) {
    // Minimal client-side export of the current diagram's data as a JSON
    // description — there is no server-side rendering pipeline for this yet.
    downloadBlob(`${name}.json`, JSON.stringify(svgGraph, null, 2), 'application/json');
  }

  function reset() {
    stopPolling();
    setLoadPhase('upload'); setFile(null); setErrorMsg('');
    setGraph(null); setStepEditsRaw({}); setLaneEditsRaw({});
    setSaved(false);
    setAgenticGraph(null); setAgents([]); setAgenticError('');
    setShowRecommendations(false); setShowPlan(false); setViewingAgentId(null);
    setShowAgentReview(false); setDemoStatus('not_generated'); setDemoDownloadUrl(null);
    setWorkPhase('asis');
    // Refresh the recent list — the process just left behind (or one being
    // abandoned mid-analysis) should show up/update the next time this screen
    // is shown, not just on first mount.
    listProcesses().then(({ processes }) => setRecentProcesses(processes)).catch(() => {});
  }

  const autoStarted = useRef(false);
  useEffect(() => {
    if (initialFile && !autoStarted.current) {
      autoStarted.current = true;
      handleUpload();
    }
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loadPhase !== 'error' && graph) {
    if (showPlan) {
      return (
        <PlanningAssistant
          processId={graph.process_id}
          onHome={onBack ?? reset}
          stepper={{
            agenticUnlocked: agents.length > 0,
            stepCount: graph.steps.length,
            confPct: Math.round((graph.parse_confidence ?? 0) * 100),
            agentCount: agents.length,
            // Closing Planning Assistant and landing on a specific screen in
            // one action — clicking "As-Is Analysis"/"Agentic Redesign" from
            // within Plan shouldn't require a separate back-then-click.
            onNavigate: (screen) => { setWorkPhase(screen); setShowPlan(false); },
          }}
        />
      );
    }
    if (viewingAgentId) {
      const agent = agents.find(a => a.agent_id === viewingAgentId);
      return (
        <AgentDesignDoc
          processId={graph.process_id}
          agentId={viewingAgentId}
          agentName={agent?.name ?? 'Agent'}
          onBack={() => setViewingAgentId(null)}
          onHome={onBack ?? reset}
        />
      );
    }
    return (
      <WorkspaceScreen
        graph={graph}
        workPhase={workPhase} setWorkPhase={setWorkPhase}
        stepEdits={stepEdits} setStepEdits={setStepEdits}
        laneEdits={laneEdits} setLaneEdits={setLaneEdits}
        saving={saving} saved={saved} onSave={handleSave}
        onReset={reset}
        agenticGraph={agenticGraph} agents={agents}
        agenticLoading={agenticLoading} agenticError={agenticError}
        showRecommendations={showRecommendations} setShowRecommendations={setShowRecommendations}
        onRecommendationsApplied={handleRecommendationsApplied}
        onOpenAgent={setViewingAgentId}
        onGenerateAgent={generateAgentDoc}
        showAgentReview={showAgentReview} setShowAgentReview={setShowAgentReview}
        demoStatus={demoStatus} demoDownloadUrl={demoDownloadUrl}
        onDemoStatusChange={({ demo_status, download_url }) => { setDemoStatus(demo_status); setDemoDownloadUrl(download_url); }}
        onOpenPlan={() => setShowPlan(true)}
        onExportDiagram={handleExportDiagram}
        editingStepId={editingStepId} setEditingStepId={setEditingStepId}
        clientName={clientName}
        onBack={onBack}
      />
    );
  }

  if (loadPhase === 'parsing' || loadPhase === 'uploading') {
    return <LoadingScreen message={parseMsg} uploading={loadPhase === 'uploading'} />;
  }

  if (loadPhase === 'error') {
    return (
      <div style={{ background: '#F5F5F7', fontFamily: FONT }}
        className="flex flex-col items-center justify-center h-full gap-5 p-8 text-center">
        <div className="w-16 h-16 rounded-full bg-red-50 flex items-center justify-center text-red-500">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
        </div>
        <div>
          <p style={{ color: '#1D1D1F', fontSize: 16, fontWeight: 600 }}>Something went wrong</p>
          <p style={{ color: '#6E6E73', fontSize: 13, marginTop: 4 }} className="max-w-sm">{errorMsg}</p>
        </div>
        <button onClick={reset}
          style={{ background: '#0C0D0D', color: '#fff', border: 'none', borderRadius: 999,
            padding: '12px 28px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <UploadScreen
      domain={domain} setDomain={setDomain}
      file={file} setFile={setFile}
      dragOver={dragOver} setDragOver={setDragOver}
      onUpload={handleUpload}
      onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f && /\.(vsdx|png|jpe?g|pdf)$/i.test(f.name)) setFile(f); }}
      onFileInput={e => { const f = e.target.files?.[0]; if (f) setFile(f); }}
      clientName={clientName}
      recentProcesses={recentProcesses} loadingRecent={loadingRecent}
      openingProcessId={openingProcessId} onOpenProcess={openProcess}
    />
  );
}

// ── Upload screen ──────────────────────────────────────────────────────────────

function IcUploadCloud() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 18a4.5 4.5 0 01-.5-8.97A5.5 5.5 0 0117 8.5a4 4 0 010 8H7z" />
      <path d="M12 11.5v6m0-6l-2.5 2.5M12 11.5l2.5 2.5" />
    </svg>
  );
}

function IcFile() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 1.5h6l3 3v9a1 1 0 01-1 1H4a1 1 0 01-1-1v-11a1 1 0 011-1z" />
      <path d="M10 1.5V5h3M5.5 8h5M5.5 10.5h5M5.5 5.5h1.5" />
    </svg>
  );
}

function UploadScreen(p: {
  domain: PiDomain; setDomain: (d: PiDomain) => void;
  file: File | null; setFile: (f: File | null) => void;
  dragOver: boolean; setDragOver: (v: boolean) => void;
  onUpload: () => void;
  onDrop: (e: React.DragEvent) => void;
  onFileInput: (e: React.ChangeEvent<HTMLInputElement>) => void;
  clientName?: string;
  recentProcesses: PiProcessSummary[]; loadingRecent: boolean;
  openingProcessId: string | null; onOpenProcess: (processId: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isVisionMode = p.file && /\.(png|jpe?g|pdf)$/i.test(p.file.name);

  return (
    <div style={{ background: '#F5F5F7', fontFamily: FONT }}
      className="flex flex-col items-center justify-center h-full p-6 overflow-y-auto">
      <div style={{ maxWidth: 820, width: '100%' }} className="flex flex-col gap-6">

        <div className="text-center" style={{ marginBottom: 4 }}>
          <h1 style={{ color: '#1D1D1F', fontSize: 26, fontWeight: 700, letterSpacing: '-0.3px', margin: 0 }}>
            Process Intelligence
          </h1>
          <p style={{ color: '#6E6E73', marginTop: 8, fontSize: 14, lineHeight: 1.6 }}>
            Upload a process diagram — Visio, image, or PDF — to extract steps,<br />
            classify AI opportunities, and preview the agentic future state.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ maxWidth: 440, width: '100%', flex: '1 1 380px' }} className="flex flex-col gap-6">

            <div style={{ background: '#fff', borderRadius: 18, boxShadow: '0 2px 16px rgba(0,0,0,0.08)', padding: 24 }}
              className="flex flex-col gap-5">

              <div>
                <label style={{ display: 'block', color: '#1D1D1F', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                  Workday Domain
                </label>
                <select value={p.domain} onChange={e => p.setDomain(e.target.value as PiDomain)}
                  style={{ width: '100%', border: '1.5px solid #E5E5EA', borderRadius: 10, fontSize: 14,
                    padding: '10px 12px', background: '#F5F5F7', color: '#1D1D1F', outline: 'none',
                    fontFamily: FONT, appearance: 'none', cursor: 'pointer' }}>
                  {DOMAINS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', color: '#1D1D1F', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                  Process Diagram
                </label>
                <div
                  onDragOver={e => { e.preventDefault(); p.setDragOver(true); }}
                  onDragLeave={() => p.setDragOver(false)}
                  onDrop={p.onDrop}
                  onClick={() => inputRef.current?.click()}
                  style={{
                    border: `2px dashed ${p.dragOver ? '#0C0D0D' : p.file ? '#34C759' : '#C7C7CC'}`,
                    borderRadius: 14, background: p.dragOver ? '#F0F8FF' : '#F5F5F7',
                    cursor: 'pointer', transition: 'all 0.2s', padding: 20,
                  }}>
                  <input ref={inputRef} type="file" accept=".vsdx,.png,.jpg,.jpeg,.pdf"
                    style={{ display: 'none' }} onChange={p.onFileInput} />
                  {p.file ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 10, background: '#ECF4EE', color: '#0C0D0D',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <IcFile />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ color: '#1D1D1F', fontWeight: 600, fontSize: 14, margin: 0,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.file.name}</p>
                        <p style={{ color: '#6E6E73', fontSize: 12, margin: '3px 0 0' }}>
                          {(p.file.size / 1024).toFixed(1)} KB
                          {isVisionMode ? ' · Vision mode (lower confidence)' : ''}
                        </p>
                      </div>
                      <button onClick={e => { e.stopPropagation(); p.setFile(null); }}
                        style={{ color: '#C7C7CC', fontSize: 22, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                        ×
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '12px 0', textAlign: 'center' }}>
                      <div style={{ color: '#8E8E93' }}><IcUploadCloud /></div>
                      <p style={{ color: '#1D1D1F', fontWeight: 500, fontSize: 14, margin: 0 }}>Drop your diagram here</p>
                      <p style={{ color: '#6E6E73', fontSize: 12, margin: 0 }}>or click to browse — .vsdx, .png, .jpg, .pdf</p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <button onClick={p.onUpload} disabled={!p.file}
              style={{
                width: '100%', padding: '14px', borderRadius: 999, fontSize: 15, fontWeight: 600,
                border: 'none', cursor: p.file ? 'pointer' : 'not-allowed', fontFamily: FONT,
                background: p.file ? '#0C0D0D' : '#E5E5EA',
                color: p.file ? '#fff' : '#C7C7CC', transition: 'all 0.2s',
              }}>
              Analyse Process
            </button>

            {p.clientName && (
              <p style={{ color: '#C7C7CC', fontSize: 12, textAlign: 'center', margin: 0 }}>{p.clientName}</p>
            )}
          </div>

          <RecentProcessesPanel processes={p.recentProcesses} loading={p.loadingRecent}
            openingProcessId={p.openingProcessId} onOpen={p.onOpenProcess} />
        </div>
      </div>
    </div>
  );
}

// ── Recent Processes — an explicit choice, not a silent auto-resume ────────────

const PI_STATUS_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  needs_review: { bg: '#FFF5E5', color: '#C27D0E', label: 'Needs review' },
  ready:        { bg: '#E8F8EF', color: '#1A7F4B', label: 'Ready' },
  parsing:      { bg: '#E7F1FD', color: '#0660BE', label: 'Parsing…' },
  uploading:    { bg: '#E7F1FD', color: '#0660BE', label: 'Uploading…' },
  failed:       { bg: '#FEF2F2', color: '#DC2626', label: 'Failed' },
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function RecentProcessesPanel({ processes, loading, openingProcessId, onOpen }: {
  processes: PiProcessSummary[]; loading: boolean;
  openingProcessId: string | null; onOpen: (processId: string) => void;
}) {
  return (
    <div style={{ width: 320, flexShrink: 0, flex: '1 1 300px' }}>
      <h3 style={{ fontSize: 12, fontWeight: 600, color: '#6E6E73', textTransform: 'uppercase',
        letterSpacing: '0.06em', margin: '0 0 10px' }}>
        Recent Processes
      </h3>
      {loading ? (
        <p style={{ fontSize: 12.5, color: '#6E6E73' }}>Loading…</p>
      ) : processes.length === 0 ? (
        <div style={{ background: '#fff', border: '1px solid #E5E5EA', borderRadius: 12, padding: 20, textAlign: 'center' }}>
          <p style={{ fontSize: 12.5, color: '#6E6E73', margin: 0 }}>No previous analyses for this client yet.</p>
        </div>
      ) : (
        // Flat rows + hairline dividers inside one bordered container —
        // matches the Proposed AI Agents / Review & Demo lists rather than
        // each process getting its own individually-bordered card.
        <div style={{ background: '#fff', border: '1px solid #E5E5EA', borderRadius: 12, overflow: 'hidden' }}>
          {processes.map((proc, idx) => {
            const status = PI_STATUS_STYLE[proc.parse_status] ?? PI_STATUS_STYLE.ready;
            const isOpening = openingProcessId === proc.process_id;
            return (
              <button key={proc.process_id} onClick={() => onOpen(proc.process_id)} disabled={isOpening}
                style={{
                  width: '100%', textAlign: 'left', background: 'none', border: 'none',
                  borderTop: idx > 0 ? '1px solid #F5F5F7' : 'none',
                  padding: '12px 18px', cursor: isOpening ? 'default' : 'pointer', fontFamily: FONT,
                  opacity: isOpening ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 10,
                }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 13, fontWeight: 700, color: '#1D1D1F', margin: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{proc.source_name}</p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                      background: status.bg, color: status.color }}>
                      {status.label}
                    </span>
                    <span style={{ fontSize: 11, color: '#8E8E93', textTransform: 'capitalize' }}>
                      {proc.domain.replace('_', ' ')}
                    </span>
                    <span style={{ fontSize: 11, color: '#C7C7CC' }}>·</span>
                    <span style={{ fontSize: 11, color: '#8E8E93' }}>{relativeTime(proc.created_at)}</span>
                  </div>
                  {proc.agent_count > 0 && (
                    <p style={{ fontSize: 11, color: '#8E8E93', margin: '4px 0 0' }}>
                      {proc.agent_count} agent{proc.agent_count !== 1 ? 's' : ''} proposed
                    </p>
                  )}
                </div>
                {isOpening && <Spinner size={14} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Loading screen ─────────────────────────────────────────────────────────────

function LoadingScreen({ message, uploading }: { message: string; uploading: boolean }) {
  const stages = ['Reading your diagram…', 'Identifying process steps…', 'Classifying AI opportunities…', 'Finalising…'];
  const idx = stages.indexOf(message);
  return (
    <div style={{ background: '#F5F5F7', fontFamily: FONT }}
      className="flex flex-col items-center justify-center h-full gap-8 p-8 text-center">
      <style>{`@keyframes pi-spin { to { transform: rotate(360deg) } }`}</style>
      <div style={{ width: 52, height: 52, border: '3px solid #E5E5EA', borderTopColor: '#0C0D0D',
        borderRadius: '50%', animation: 'pi-spin 0.9s linear infinite' }} />
      <div>
        <p style={{ color: '#1D1D1F', fontSize: 17, fontWeight: 600, margin: 0 }}>
          {uploading ? 'Uploading…' : (message || 'Processing…')}
        </p>
        <p style={{ color: '#6E6E73', fontSize: 13, marginTop: 6 }}>
          {uploading ? 'Sending your diagram to the platform' : 'Usually takes 20–40 seconds'}
        </p>
      </div>
      {!uploading && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {stages.map((_, i) => (
            <div key={i} style={{
              width: 8, height: 8, borderRadius: '50%', transition: 'background 0.3s',
              background: i < idx ? '#0C0D0D' : i === idx ? '#90C8F9' : '#E5E5EA',
            }} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Workspace ──────────────────────────────────────────────────────────────────

interface WorkspaceProps {
  graph: PiGraph;
  workPhase: WorkPhase; setWorkPhase: (p: WorkPhase) => void;
  stepEdits: Record<string, Partial<PiStep>>; setStepEdits: (e: Record<string, Partial<PiStep>>) => void;
  laneEdits: Record<string, { label?: string; persona?: string }>; setLaneEdits: (e: Record<string, { label?: string; persona?: string }>) => void;
  saving: boolean; saved: boolean; onSave: () => void; onReset: () => void;
  agenticGraph: PiTobeGraph | null; agents: PiAgent[];
  agenticLoading: boolean; agenticError: string;
  showRecommendations: boolean; setShowRecommendations: (v: boolean) => void;
  onRecommendationsApplied: (result: { tobe: PiTobeGraph; proposed_agents: PiAgent[] }) => void;
  onOpenAgent: (agentId: string) => void;
  onGenerateAgent: (agentId: string) => void;
  showAgentReview: boolean; setShowAgentReview: (v: boolean) => void;
  demoStatus: PiDemoStatus; demoDownloadUrl: string | null;
  onDemoStatusChange: (status: { demo_status: PiDemoStatus; download_url: string | null }) => void;
  onOpenPlan: () => void;
  onExportDiagram: (graph: MapGraph, name: string) => void;
  editingStepId: string | null; setEditingStepId: (id: string | null) => void;
  clientName?: string;
  onBack?: () => void;
}

function WorkspaceScreen(p: WorkspaceProps) {
  const hasEdits = Object.keys(p.stepEdits).length > 0 || Object.keys(p.laneEdits).length > 0;

  function patchStep(step_id: string, field: keyof PiStep, value: unknown) {
    p.setStepEdits({ ...p.stepEdits, [step_id]: { ...p.stepEdits[step_id], [field]: value } });
  }
  function getStep(s: PiStep): PiStep { return { ...s, ...p.stepEdits[s.step_id] }; }

  const oppCounts: Record<PiAiOpportunity, number> = { sana_agent: 0, workday_native: 0, partial_ai: 0, human_only: 0 };
  for (const s of p.graph.steps) {
    const opp = (p.stepEdits[s.step_id]?.ai_opportunity ?? s.ai_opportunity) ?? 'human_only';
    if (opp in oppCounts) oppCounts[opp as PiAiOpportunity]++;
  }
  const aiCount = oppCounts.sana_agent + oppCounts.workday_native + oppCounts.partial_ai;
  const confPct = Math.round((p.graph.parse_confidence ?? 0) * 100);
  const asIsGraph = piGraphToMapGraph(p.graph, p.stepEdits);
  const agenticUnlocked = p.agents.length > 0;

  const editingStep = p.editingStepId ? p.graph.steps.find(s => s.step_id === p.editingStepId) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#F5F5F7', fontFamily: FONT, overflow: 'hidden' }}>

      {/* Top bar */}
      <div style={{ background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(12px)',
        borderBottom: '1px solid #E5E5EA', padding: '12px 20px', flexShrink: 0,
        display: 'flex', flexDirection: 'column', gap: 12 }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* Home always lives here — top-left, ahead of the page's own
              content — so it reads as a constant way out of the whole
              feature rather than one more button competing with the
              stage-specific actions (Save/Export/Start Over) on the right. */}
          {p.onBack && (
            <>
              <HomeButton onClick={p.onBack} />
              <span style={{ width: 1, height: 18, background: '#E5E5EA', flexShrink: 0 }} />
            </>
          )}
          <span style={{ color: '#1D1D1F', fontWeight: 700, fontSize: 15,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>
            {p.graph.source_name}
          </span>
          <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, flexShrink: 0,
            background: p.graph.parse_status === 'needs_review' ? '#FFF5E5' : '#E8F8EF',
            color: p.graph.parse_status === 'needs_review' ? '#C27D0E' : '#1A7F4B' }}>
            {p.graph.parse_status === 'needs_review' ? 'Needs review' : 'Ready'}
          </span>
          <span style={{ color: '#6E6E73', fontSize: 11, textTransform: 'capitalize' }}>
            {p.graph.domain.replace('_', ' ')}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap', rowGap: 12 }}>
          <PipelineStepper
            activeScreen={p.workPhase} onNavigate={p.setWorkPhase}
            agenticUnlocked={agenticUnlocked} stepCount={p.graph.steps.length}
            confPct={confPct} agentCount={p.agents.length}
            onOpenPlan={p.onOpenPlan} />

          <div style={{ flex: 1 }} />

          {/* Actions — weighted by consequence: one dark primary for the stage's
              forward action, an outline for a safe secondary, Start Over demoted
              into an overflow menu that names what it costs before it fires. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, paddingTop: 2 }}>
            {p.workPhase === 'asis' ? (
              <>
                {p.saved && (
                  <span style={{ color: '#34C759', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 3 }}>
                    <svg width="13" height="13" viewBox="0 0 20 20" fill="#34C759">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    Saved
                  </span>
                )}
                <button onClick={p.onSave} disabled={!hasEdits || p.saving || p.saved}
                  style={{ padding: '7px 16px', borderRadius: 999, fontSize: 13, fontWeight: 600,
                    border: 'none', cursor: hasEdits && !p.saving && !p.saved ? 'pointer' : 'not-allowed',
                    background: hasEdits && !p.saving && !p.saved ? '#1D1D1F' : '#E5E5EA',
                    color: hasEdits && !p.saving && !p.saved ? '#fff' : '#C7C7CC',
                    transition: 'all 0.15s', fontFamily: FONT }}>
                  {p.saving ? 'Saving…' : 'Save corrections'}
                </button>
                <StartOverMenu onReset={p.onReset} />
              </>
            ) : (
              <>
                {/* Generate Demo and Generate Plan are now steps in the
                    pipeline stepper itself (they're deliverables gated on the
                    same "agents exist" precondition as Agentic Redesign) —
                    Export stays here since it's an ad-hoc artifact export,
                    not a milestone in the sequence. */}
                <button onClick={() => p.onExportDiagram(tobeToMapGraph(p.agenticGraph!), p.graph.source_name + ' — Agentic Workflow')}
                  disabled={!p.agenticGraph}
                  style={{ padding: '7px 14px', borderRadius: 999, fontSize: 13, fontWeight: 600,
                    border: '1px solid #E5E5EA', cursor: p.agenticGraph ? 'pointer' : 'not-allowed',
                    background: '#fff', color: p.agenticGraph ? '#1D1D1F' : '#C7C7CC', fontFamily: FONT,
                    display: 'flex', alignItems: 'center', gap: 6 }}>
                  <IcExport /> Export
                </button>
                <StartOverMenu onReset={p.onReset} />
              </>
            )}
          </div>
        </div>
      </div>

      {/* Phase content */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        {p.workPhase === 'asis' && (
          <AsIsPhase graph={p.graph} asIsGraph={asIsGraph}
            oppCounts={oppCounts} aiCount={aiCount} confPct={confPct}
            onOpenRecommendations={() => p.setShowRecommendations(true)}
            onStepClick={p.setEditingStepId} />
        )}
        {p.workPhase === 'agentic' && (
          <AgenticWorkflowPhase agenticGraph={p.agenticGraph} agents={p.agents}
            loading={p.agenticLoading} error={p.agenticError}
            onOpenAgent={p.onOpenAgent} onGenerateAgent={p.onGenerateAgent}
            processId={p.graph.process_id}
            showReview={p.showAgentReview} onSetShowReview={p.setShowAgentReview}
            demoStatus={p.demoStatus} demoDownloadUrl={p.demoDownloadUrl}
            onDemoStatusChange={p.onDemoStatusChange} />
        )}

        {p.showRecommendations && p.workPhase === 'asis' && (
          <AiRecommendationsPanel
            processId={p.graph.process_id}
            graph={p.graph}
            onApplied={p.onRecommendationsApplied}
            onClose={() => p.setShowRecommendations(false)}
          />
        )}
      </div>

      {editingStep && (
        <StepEditPopover
          step={getStep(editingStep)}
          swimlanes={p.graph.swimlanes}
          onChange={(field, value) => patchStep(editingStep.step_id, field, value)}
          onClose={() => p.setEditingStepId(null)}
        />
      )}
    </div>
  );
}

// ── Small stroke icons for the stage-action buttons, matching the icon
// convention already used elsewhere (ConsultantPanel's IcDocs/IcUpload/etc). ──

function IcExport() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M8 10V2M5 5l3-3 3 3" /><path d="M2.5 9.5V13a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9.5" />
    </svg>
  );
}
// ── Start Over — demoted into an overflow menu that names what it costs,
// rather than a plain-text link sitting next to generative actions. ──────────

function StartOverMenu({ onReset }: { onReset: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function close(e: MouseEvent) { if (!ref.current?.contains(e.target as Node)) setOpen(false); }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(v => !v)} title="More"
        style={{ width: 30, height: 30, borderRadius: 999, border: 'none',
          background: open ? '#F5F5F7' : 'transparent', color: '#8E8E93', cursor: 'pointer',
          fontSize: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
        ⋯
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: 36, background: '#fff', border: '1px solid #E5E5EA',
          borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.1)', minWidth: 190, padding: 5, zIndex: 10 }}>
          <button onClick={() => { setOpen(false); onReset(); }}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 11px', borderRadius: 6,
              border: 'none', background: 'none', color: '#B91C1C', fontWeight: 600, fontSize: 12.5,
              cursor: 'pointer', fontFamily: FONT }}>
            Start Over
            <span style={{ display: 'block', fontWeight: 400, color: '#9CA0A6', fontSize: 11, marginTop: 1 }}>
              Discards this analysis
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

// ── Step edit popover (replaces the old full-screen AI Review phase) ────────

function StepEditPopover({ step, swimlanes, onChange, onClose }: {
  step: PiStep;
  swimlanes: PiGraph['swimlanes'];
  onChange: (field: keyof PiStep, value: unknown) => void;
  onClose: () => void;
}) {
  const [draftLabel, setDraftLabel] = useState(step.label);

  return (
    <div onClick={onClose} style={{
      position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.25)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 30,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#fff', borderRadius: 16, padding: 20, width: 360, maxWidth: '92%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.2)', fontFamily: FONT,
      }}>
        <p style={{ fontSize: 13, fontWeight: 700, color: '#1D1D1F', margin: '0 0 14px' }}>Edit step</p>

        <label style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: '#6E6E73', marginBottom: 5 }}>Label</label>
        <input value={draftLabel}
          onChange={e => setDraftLabel(e.target.value)}
          onBlur={() => { if (draftLabel.trim() && draftLabel.trim() !== step.label) onChange('label', draftLabel.trim()); }}
          style={{ width: '100%', border: '1.5px solid #E5E5EA', borderRadius: 8, padding: '8px 10px',
            fontSize: 13, fontFamily: FONT, color: '#1D1D1F', outline: 'none', marginBottom: 14 }} />

        <label style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: '#6E6E73', marginBottom: 5 }}>Lane</label>
        <select value={step.lane_id ?? ''} onChange={e => onChange('lane_id', e.target.value || null)}
          style={{ width: '100%', border: '1.5px solid #E5E5EA', borderRadius: 8, padding: '8px 10px',
            fontSize: 13, fontFamily: FONT, color: '#1D1D1F', outline: 'none', marginBottom: 14, background: '#F5F5F7' }}>
          <option value="">Unassigned</option>
          {swimlanes.map(l => <option key={l.lane_id} value={l.lane_id}>{l.label}</option>)}
        </select>

        <label style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: '#6E6E73', marginBottom: 6 }}>AI opportunity</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 18 }}>
          {OPP_ORDER.map(k => {
            const def = OPP_DEFS[k];
            const active = step.ai_opportunity === k;
            return (
              <button key={k} onClick={() => onChange('ai_opportunity', k)}
                style={{ padding: '6px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600,
                  border: active ? 'none' : '1px solid #E5E5EA', cursor: 'pointer',
                  background: active ? def.activeBg : '#F5F5F7',
                  color: active ? def.activeText : '#6E6E73', fontFamily: FONT }}>
                {def.label}
              </button>
            );
          })}
        </div>

        <button onClick={onClose}
          style={{ width: '100%', padding: '10px', borderRadius: 999, fontSize: 13, fontWeight: 600,
            border: 'none', cursor: 'pointer', background: '#1D1D1F', color: '#fff', fontFamily: FONT }}>
          Done
        </button>
      </div>
    </div>
  );
}

// ── Phase 1: As-Is ─────────────────────────────────────────────────────────────

function maturityLabel(position: number): string {
  if (position < 0.33) return 'AI Assisted';
  if (position < 0.67) return 'AI Augmented';
  return 'AI Powered';
}

function StatBlock({ value, label, color = '#1D1D1F' }: { value: string | number; label: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, minWidth: 70 }}>
      <span style={{ fontSize: 30, fontWeight: 700, color, letterSpacing: '-1px', lineHeight: 1 }}>{value}</span>
      <span style={{ fontSize: 11, color: '#6E6E73', fontWeight: 500, textAlign: 'center', lineHeight: 1.3 }}>{label}</span>
    </div>
  );
}

function IcSparkSmall() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5l1.1 3.4L12.5 6l-3.4 1.1L8 10.5l-1.1-3.4L3.5 6l3.4-1.1L8 1.5z" />
      <path d="M13 10.5l.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6.6-1.8z" />
    </svg>
  );
}

function AsIsPhase({ graph, asIsGraph, oppCounts, aiCount, confPct, onOpenRecommendations, onStepClick }: {
  graph: PiGraph; asIsGraph: MapGraph;
  oppCounts: Record<PiAiOpportunity, number>; aiCount: number; confPct: number;
  onOpenRecommendations: () => void;
  onStepClick: (stepId: string) => void;
}) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Stats + primary action — one row, not echoed again elsewhere */}
      <div style={{ background: '#fff', borderBottom: '1px solid #E5E5EA', padding: '18px 28px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
            <StatBlock value={graph.steps.length} label="Process steps" />
            <div style={{ width: 1, background: '#E5E5EA', alignSelf: 'stretch' }} />
            <StatBlock value={graph.swimlanes.length} label="Roles involved" />
            <div style={{ width: 1, background: '#E5E5EA', alignSelf: 'stretch' }} />
            <StatBlock value={`${confPct}%`} label="AI confidence"
              color={confPct >= 80 ? '#34C759' : confPct >= 60 ? '#FF9F0A' : '#FF3B30'} />
            <div style={{ width: 1, background: '#E5E5EA', alignSelf: 'stretch' }} />
            <StatBlock value={aiCount} label="AI opportunities" color="#0C0D0D" />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            {aiCount > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {OPP_ORDER.filter(k => oppCounts[k] > 0).map(k => {
                  const def = OPP_DEFS[k];
                  return (
                    <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px',
                      borderRadius: 20, background: `${def.activeBg}12`, border: `1px solid ${def.activeBg}30` }}>
                      <div style={{ width: 6, height: 6, borderRadius: '50%', background: def.dot, flexShrink: 0 }} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: def.activeBg }}>{oppCounts[k]}</span>
                      <span style={{ fontSize: 11, color: '#6E6E73' }}>{def.label}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <button onClick={onOpenRecommendations}
              style={{ padding: '9px 18px', borderRadius: 999, fontSize: 13.5, fontWeight: 600,
                border: 'none', cursor: 'pointer', background: '#0C0D0D', color: '#fff',
                display: 'flex', alignItems: 'center', gap: 6, fontFamily: FONT, flexShrink: 0 }}
              onMouseOver={e => (e.currentTarget.style.opacity = '0.85')}
              onMouseOut={e => (e.currentTarget.style.opacity = '1')}>
              <IcSparkSmall /> AI Recommendations
            </button>
          </div>
        </div>
      </div>

      {/* Map */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px 28px' }}>
        <div style={{ background: '#fff', borderRadius: 16, padding: '20px 16px',
          boxShadow: '0 1px 8px rgba(0,0,0,0.06)', display: 'inline-block', minWidth: '100%' }}>
          <ProcessMap graph={asIsGraph} onStepClick={onStepClick} />
        </div>
        <p style={{ color: '#C7C7CC', fontSize: 11, marginTop: 8, textAlign: 'center' }}>Click any step to edit its label, lane, or AI classification</p>
      </div>
    </div>
  );
}

// ── Phase 2: Agentic Workflow ────────────────────────────────────────────────

function AgenticWorkflowPhase({
  agenticGraph, agents, loading, error, onOpenAgent, onGenerateAgent,
  processId, showReview, onSetShowReview, demoStatus, demoDownloadUrl, onDemoStatusChange,
}: {
  agenticGraph: PiTobeGraph | null; agents: PiAgent[];
  loading: boolean; error: string;
  onOpenAgent: (agentId: string) => void;
  onGenerateAgent: (agentId: string) => void;
  processId: string;
  showReview: boolean; onSetShowReview: (v: boolean) => void;
  demoStatus: PiDemoStatus; demoDownloadUrl: string | null;
  onDemoStatusChange: (status: { demo_status: PiDemoStatus; download_url: string | null }) => void;
}) {
  const mapGraph = agenticGraph ? tobeToMapGraph(agenticGraph) : null;
  const stats = agenticGraph?.ai_stats;

  if (loading) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <style>{`@keyframes agentic-spin { to { transform: rotate(360deg) } }`}</style>
        <div style={{ width: 44, height: 44, border: '3px solid #E5E5EA', borderTopColor: '#0C0D0D',
          borderRadius: '50%', animation: 'agentic-spin 0.9s linear infinite' }} />
        <p style={{ color: '#6E6E73', fontSize: 13 }}>Building the agentic workflow…</p>
      </div>
    );
  }

  if (!mapGraph) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, textAlign: 'center' }}>
        <div>
          <p style={{ color: '#1D1D1F', fontSize: 15, fontWeight: 600, margin: 0 }}>No agentic workflow yet</p>
          <p style={{ color: '#6E6E73', fontSize: 13, marginTop: 6 }}>
            {error || 'Use AI Recommendations on the As-Is tab and Apply & Generate.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', overflow: 'hidden' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {stats && (
          <div style={{ background: '#fff', borderBottom: '1px solid #E5E5EA', padding: '16px 24px', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              {stats.steps_automated != null && <StatBlock value={stats.steps_automated} label="Agent-automated" color="#0d9488" />}
              {stats.steps_assisted != null && <StatBlock value={stats.steps_assisted} label="AI-assisted" color="#0C0D0D" />}
              {stats.steps_unchanged != null && <StatBlock value={stats.steps_unchanged} label="Human-only" color="#6E6E73" />}
              {stats.cycle_time_reduction_pct != null && (
                <StatBlock value={`~${stats.cycle_time_reduction_pct}%`} label="Cycle time saved" color="#34C759" />
              )}
            </div>
            {agenticGraph?.transformation_summary && (
              <p style={{ color: '#6E6E73', fontSize: 12.5, marginTop: 10, lineHeight: 1.6, maxWidth: 640 }}>
                {agenticGraph.transformation_summary}
              </p>
            )}
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px 24px' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: '16px 12px',
            boxShadow: '0 2px 12px rgba(0,113,227,0.08)', overflowX: 'auto', display: 'inline-block', minWidth: '100%' }}>
            <ProcessMap graph={mapGraph} />
          </div>
        </div>
      </div>

      {/* Agents rail — a single surface that switches between browsing the
          proposed agents and reviewing/generating the demo, via tabs, rather
          than a floating "Review Agents for Demo" panel that used to cover
          the browse list outright (opening Review made the agent list
          disappear with no way to see both). */}
      <div style={{ width: 340, flexShrink: 0, borderLeft: '1px solid #E5E5EA', background: '#fff',
        display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', borderBottom: '1px solid #E5E5EA', flexShrink: 0 }}>
          <RailTab label="Agents" active={!showReview} onClick={() => onSetShowReview(false)} />
          <RailTab label="Review & Demo" active={showReview} onClick={() => onSetShowReview(true)}
            dot={demoStatus === 'generating' ? '#0F6FEC' : demoStatus === 'done' ? '#16A34A' : undefined} />
        </div>

        {showReview ? (
          <AgentReviewPanel
            processId={processId}
            agents={agents}
            onDemoStatusChange={onDemoStatusChange}
            initialStatus={demoStatus}
            initialDownloadUrl={demoDownloadUrl}
          />
        ) : (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <div style={{ padding: '14px 18px 6px' }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: '#8E8E93', textTransform: 'uppercase', letterSpacing: 0.5, margin: 0 }}>
                Proposed AI Agents
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {agents.map(a => {
                const kind = a.kind ?? 'workspace';
                const busy = a.lld_status === 'generating';
                // Clicking a not-yet-generated (or failed) agent drafts the
                // doc in place — no navigation. Only a finished doc opens
                // the full-screen view; that's the one state where there's
                // something to actually go look at.
                function handleClick() {
                  if (a.lld_status === 'done') onOpenAgent(a.agent_id);
                  else if (!busy) onGenerateAgent(a.agent_id);
                }
                return (
                  <button key={a.agent_id} onClick={handleClick} disabled={busy}
                    style={{ textAlign: 'left', background: 'none', border: 'none', borderTop: '1px solid #F5F5F7',
                      padding: '12px 18px', cursor: busy ? 'default' : 'pointer', fontFamily: FONT }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#1D1D1F', flex: 1, minWidth: 0,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                      <span style={{ padding: '1px 7px', borderRadius: 20, fontSize: 9, fontWeight: 700, flexShrink: 0,
                        background: kind === 'conversational' ? '#E7F1FD' : '#FCF1DC',
                        color: kind === 'conversational' ? '#0660BE' : '#B8790A' }}>
                        {kind === 'conversational' ? 'Conversational' : 'Workspace'}
                      </span>
                    </div>
                    {a.agentic_metadata?.maturity && (
                      <p style={{ fontSize: 10.5, fontWeight: 600, color: '#0071E3', margin: '5px 0 0' }}>
                        {maturityLabel(a.agentic_metadata.maturity.position)}
                      </p>
                    )}
                    {a.model && (
                      <p style={{ fontSize: 11, color: '#8E8E93', margin: '5px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        Model: {a.model}
                      </p>
                    )}
                    {a.tools.length > 0 && (
                      <p style={{ fontSize: 11, color: '#8E8E93', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        Tools: {a.tools.map(t => t.name).join(', ')}
                      </p>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 6 }}>
                      {a.lld_status === 'done' ? (
                        <>
                          <svg width="11" height="11" viewBox="0 0 20 20" fill="#16A34A">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                          <span style={{ fontSize: 10.5, color: '#16A34A', fontWeight: 600 }}>Design doc ready</span>
                        </>
                      ) : a.lld_status === 'generating' ? (
                        <>
                          <Spinner size={10} color="#8E8E93" trackColor="#E5E5EA" />
                          <span style={{ fontSize: 10.5, color: '#8E8E93', fontWeight: 600 }}>Drafting design…</span>
                        </>
                      ) : a.lld_status === 'failed' ? (
                        <span style={{ fontSize: 10.5, color: '#FF3B30', fontWeight: 600 }}>Generation failed — click to retry</span>
                      ) : (
                        <span style={{ fontSize: 10.5, color: '#ACACB2', fontWeight: 600 }}>Click to generate design doc</span>
                      )}
                      <span style={{ marginLeft: 'auto', color: '#C7C7CC', fontSize: 12 }}>›</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function RailTab({ label, active, onClick, dot }: { label: string; active: boolean; onClick: () => void; dot?: string }) {
  return (
    <button onClick={onClick}
      style={{ flex: 1, padding: '11px 8px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: FONT,
        fontSize: 12.5, fontWeight: 700, color: active ? '#1D1D1F' : '#8E8E93',
        borderBottom: `2px solid ${active ? '#0F6FEC' : 'transparent'}`, marginBottom: -1,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
      {label}
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, flexShrink: 0 }} />}
    </button>
  );
}
