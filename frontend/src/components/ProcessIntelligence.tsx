import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  getGraphStatus,
  getProcessGraph,
  getTobeGraphAndAgents,
  applyRecommendationsAndGenerate,
  patchProcessGraph,
  putFileToS3,
  triggerParseDiagram,
  uploadProcessDiagram,
  type PiAgent,
  type PiAiOpportunity,
  type PiDomain,
  type PiGraph,
  type PiLanePatch,
  type PiStep,
  type PiStepPatch,
  type PiTobeGraph,
} from '../lib/api';
import { ProcessMap, type MapGraph } from './ProcessMap';
import { AiRecommendationsPanel } from './AiRecommendationsPanel';
import { AgentDesignDoc } from './AgentDesignDoc';
import { PlanningAssistant } from './PlanningAssistant';
import { downloadBlob } from '../lib/download';

// ── Design tokens (Apple-inspired) ────────────────────────────────────────────
// bg: #F5F5F7  card: #FFFFFF  text: #1D1D1F  secondary: #6E6E73
// separator: #E5E5EA  blue: #0071E3

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
  clientName, initialFile, initialDomain, onBack,
}: {
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

  // Once a graph is available, silently check for a previously-generated
  // agentic workflow so revisiting the process doesn't lose it.
  useEffect(() => {
    if (!graph || graph.parse_status === 'parsing') return;
    (async () => {
      try {
        const result = await getTobeGraphAndAgents(graph.process_id);
        if (result.tobe) setAgenticGraph(result.tobe);
        if (result.proposed_agents.length) setAgents(result.proposed_agents);
      } catch {
        // Non-fatal — the Agentic Workflow tab just starts gated/empty.
      }
    })();
  }, [graph?.process_id]);

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
    setWorkPhase('asis');
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
      return <PlanningAssistant processId={graph.process_id} onBack={() => setShowPlan(false)} />;
    }
    if (viewingAgentId) {
      const agent = agents.find(a => a.agent_id === viewingAgentId);
      return (
        <AgentDesignDoc
          processId={graph.process_id}
          agentId={viewingAgentId}
          agentName={agent?.name ?? 'Agent'}
          onBack={() => setViewingAgentId(null)}
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
        <div className="w-16 h-16 rounded-full bg-red-50 flex items-center justify-center text-3xl">⚠</div>
        <div>
          <p style={{ color: '#1D1D1F', fontSize: 16, fontWeight: 600 }}>Something went wrong</p>
          <p style={{ color: '#6E6E73', fontSize: 13, marginTop: 4 }} className="max-w-sm">{errorMsg}</p>
        </div>
        <button onClick={reset}
          style={{ background: '#0071E3', color: '#fff', border: 'none', borderRadius: 980,
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
    />
  );
}

// ── Upload screen ──────────────────────────────────────────────────────────────

function UploadScreen(p: {
  domain: PiDomain; setDomain: (d: PiDomain) => void;
  file: File | null; setFile: (f: File | null) => void;
  dragOver: boolean; setDragOver: (v: boolean) => void;
  onUpload: () => void;
  onDrop: (e: React.DragEvent) => void;
  onFileInput: (e: React.ChangeEvent<HTMLInputElement>) => void;
  clientName?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isImage = p.file && /\.(png|jpe?g)$/i.test(p.file.name);
  const isPdf = p.file && /\.pdf$/i.test(p.file.name);
  const isVisionMode = isImage || isPdf;

  return (
    <div style={{ background: '#F5F5F7', fontFamily: FONT }}
      className="flex flex-col items-center justify-center h-full p-6 overflow-y-auto">
      <div style={{ maxWidth: 440, width: '100%' }} className="flex flex-col gap-6">

        <div className="text-center" style={{ marginBottom: 4 }}>
          <h1 style={{ color: '#1D1D1F', fontSize: 26, fontWeight: 700, letterSpacing: '-0.3px', margin: 0 }}>
            Process Intelligence
          </h1>
          <p style={{ color: '#6E6E73', marginTop: 8, fontSize: 14, lineHeight: 1.6 }}>
            Upload a process diagram — Visio, image, or PDF — to extract steps,<br />
            classify AI opportunities, and preview the agentic future state.
          </p>
        </div>

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
                border: `2px dashed ${p.dragOver ? '#0071E3' : p.file ? '#34C759' : '#C7C7CC'}`,
                borderRadius: 14, background: p.dragOver ? '#F0F8FF' : '#F5F5F7',
                cursor: 'pointer', transition: 'all 0.2s', padding: 20,
              }}>
              <input ref={inputRef} type="file" accept=".vsdx,.png,.jpg,.jpeg,.pdf"
                style={{ display: 'none' }} onChange={p.onFileInput} />
              {p.file ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 28 }}>{isPdf ? '📄' : isImage ? '🖼️' : '📊'}</span>
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
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '12px 0', textAlign: 'center' }}>
                  <span style={{ fontSize: 32 }}>📂</span>
                  <p style={{ color: '#1D1D1F', fontWeight: 500, fontSize: 14, margin: 0 }}>Drop your diagram here</p>
                  <p style={{ color: '#6E6E73', fontSize: 12, margin: 0 }}>or click to browse — .vsdx, .png, .jpg, .pdf</p>
                </div>
              )}
            </div>
          </div>
        </div>

        <button onClick={p.onUpload} disabled={!p.file}
          style={{
            width: '100%', padding: '14px', borderRadius: 980, fontSize: 15, fontWeight: 600,
            border: 'none', cursor: p.file ? 'pointer' : 'not-allowed', fontFamily: FONT,
            background: p.file ? '#0071E3' : '#E5E5EA',
            color: p.file ? '#fff' : '#C7C7CC', transition: 'all 0.2s',
          }}>
          Analyse Process
        </button>

        {p.clientName && (
          <p style={{ color: '#C7C7CC', fontSize: 12, textAlign: 'center', margin: 0 }}>{p.clientName}</p>
        )}
      </div>
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
      <div style={{ width: 52, height: 52, border: '3px solid #E5E5EA', borderTopColor: '#0071E3',
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
              background: i < idx ? '#0071E3' : i === idx ? '#90C8F9' : '#E5E5EA',
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
        borderBottom: '1px solid #E5E5EA', padding: '10px 20px',
        display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: '#1D1D1F', fontWeight: 700, fontSize: 15,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>
              {p.graph.source_name}
            </span>
            <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, flexShrink: 0,
              background: p.graph.parse_status === 'needs_review' ? '#FFF5E5' : '#E8F8EF',
              color: p.graph.parse_status === 'needs_review' ? '#C27D0E' : '#1A7F4B' }}>
              {p.graph.parse_status === 'needs_review' ? 'Needs review' : 'Ready'}
            </span>
          </div>
          <div style={{ color: '#6E6E73', fontSize: 11, marginTop: 1, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ textTransform: 'capitalize' }}>{p.graph.domain.replace('_', ' ')}</span>
            <span>·</span><span>{p.graph.steps.length} steps</span>
            <span>·</span>
            <span style={{ fontWeight: 500,
              color: confPct >= 80 ? '#34C759' : confPct >= 60 ? '#FF9F0A' : '#FF3B30' }}>
              {confPct}% confidence
            </span>
          </div>
        </div>

        {/* Underlined tabs */}
        <div style={{ display: 'flex', gap: 22, flexShrink: 0, alignSelf: 'stretch', alignItems: 'flex-end' }}>
          <TabButton label="As-Is Process Flow" active={p.workPhase === 'asis'} onClick={() => p.setWorkPhase('asis')} />
          <TabButton label="Agentic Workflow" active={p.workPhase === 'agentic'}
            disabled={!agenticUnlocked}
            onClick={() => agenticUnlocked && p.setWorkPhase('agentic')} />
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
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
                style={{ padding: '7px 16px', borderRadius: 980, fontSize: 13, fontWeight: 600,
                  border: 'none', cursor: hasEdits && !p.saving && !p.saved ? 'pointer' : 'not-allowed',
                  background: hasEdits && !p.saving && !p.saved ? '#1D1D1F' : '#E5E5EA',
                  color: hasEdits && !p.saving && !p.saved ? '#fff' : '#C7C7CC',
                  transition: 'all 0.15s', fontFamily: FONT }}>
                {p.saving ? 'Saving…' : 'Save corrections'}
              </button>
              {p.onBack ? (
                <button onClick={p.onBack}
                  style={{ padding: '7px 12px', borderRadius: 980, fontSize: 13, fontWeight: 500,
                    border: 'none', cursor: 'pointer', background: 'transparent', color: '#6E6E73', fontFamily: FONT }}>
                  ← Workspace
                </button>
              ) : (
                <button onClick={p.onReset}
                  style={{ padding: '7px 12px', borderRadius: 980, fontSize: 13, fontWeight: 500,
                    border: 'none', cursor: 'pointer', background: 'transparent', color: '#6E6E73', fontFamily: FONT }}>
                  New upload
                </button>
              )}
            </>
          ) : (
            <>
              <button onClick={() => p.onExportDiagram(tobeToMapGraph(p.agenticGraph!), p.graph.source_name + ' — Agentic Workflow')}
                disabled={!p.agenticGraph}
                style={{ padding: '7px 14px', borderRadius: 980, fontSize: 13, fontWeight: 600,
                  border: '1px solid #E5E5EA', cursor: p.agenticGraph ? 'pointer' : 'not-allowed',
                  background: '#fff', color: p.agenticGraph ? '#1D1D1F' : '#C7C7CC', fontFamily: FONT }}>
                Export
              </button>
              <button onClick={p.onOpenPlan}
                style={{ padding: '7px 16px', borderRadius: 980, fontSize: 13, fontWeight: 600,
                  border: 'none', cursor: 'pointer', background: '#0071E3', color: '#fff', fontFamily: FONT }}>
                Generate Plan
              </button>
              <button onClick={p.onReset}
                style={{ padding: '7px 12px', borderRadius: 980, fontSize: 13, fontWeight: 500,
                  border: 'none', cursor: 'pointer', background: 'transparent', color: '#6E6E73', fontFamily: FONT }}>
                New Process
              </button>
            </>
          )}
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
            onOpenAgent={p.onOpenAgent} />
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

function TabButton({ label, active, disabled, onClick }: { label: string; active: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        background: 'none', border: 'none', padding: '4px 0 10px', fontSize: 13.5, fontWeight: 700,
        cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: FONT,
        color: disabled ? '#C7C7CC' : active ? '#0071E3' : '#6E6E73',
        borderBottom: active ? '2px solid #0071E3' : '2px solid transparent',
      }}>
      {label}
    </button>
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
                style={{ padding: '6px 12px', borderRadius: 980, fontSize: 12, fontWeight: 600,
                  border: active ? 'none' : '1px solid #E5E5EA', cursor: 'pointer',
                  background: active ? def.activeBg : '#F5F5F7',
                  color: active ? def.activeText : '#6E6E73', fontFamily: FONT }}>
                {def.label}
              </button>
            );
          })}
        </div>

        <button onClick={onClose}
          style={{ width: '100%', padding: '10px', borderRadius: 980, fontSize: 13, fontWeight: 600,
            border: 'none', cursor: 'pointer', background: '#1D1D1F', color: '#fff', fontFamily: FONT }}>
          Done
        </button>
      </div>
    </div>
  );
}

// ── Phase 1: As-Is ─────────────────────────────────────────────────────────────

function StatBlock({ value, label, color = '#1D1D1F' }: { value: string | number; label: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, minWidth: 70 }}>
      <span style={{ fontSize: 30, fontWeight: 700, color, letterSpacing: '-1px', lineHeight: 1 }}>{value}</span>
      <span style={{ fontSize: 11, color: '#6E6E73', fontWeight: 500, textAlign: 'center', lineHeight: 1.3 }}>{label}</span>
    </div>
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
      {/* Stats */}
      <div style={{ background: '#fff', borderBottom: '1px solid #E5E5EA', padding: '18px 28px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
            <StatBlock value={graph.steps.length} label="Process steps" />
            <div style={{ width: 1, background: '#E5E5EA', alignSelf: 'stretch' }} />
            <StatBlock value={graph.swimlanes.length} label="Roles involved" />
            <div style={{ width: 1, background: '#E5E5EA', alignSelf: 'stretch' }} />
            <StatBlock value={`${confPct}%`} label="AI confidence"
              color={confPct >= 80 ? '#34C759' : confPct >= 60 ? '#FF9F0A' : '#FF3B30'} />
            <div style={{ width: 1, background: '#E5E5EA', alignSelf: 'stretch' }} />
            <StatBlock value={aiCount} label="AI opportunities" color="#0071E3" />
          </div>
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

      {/* CTA */}
      <div style={{ background: '#fff', borderTop: '1px solid #E5E5EA', padding: '14px 28px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div>
          <p style={{ color: '#1D1D1F', fontSize: 14, fontWeight: 600, margin: 0 }}>
            {aiCount > 0 ? `${aiCount} AI opportunities identified` : 'Process extracted successfully'}
          </p>
          <p style={{ color: '#6E6E73', fontSize: 12, marginTop: 2 }}>
            See grouped AI interventions and generate the agentic future state
          </p>
        </div>
        <button onClick={onOpenRecommendations}
          style={{ padding: '11px 22px', borderRadius: 980, fontSize: 14, fontWeight: 600,
            border: 'none', cursor: 'pointer', background: '#0071E3', color: '#fff',
            display: 'flex', alignItems: 'center', gap: 6, fontFamily: FONT }}
          onMouseOver={e => (e.currentTarget.style.opacity = '0.85')}
          onMouseOut={e => (e.currentTarget.style.opacity = '1')}>
          💡 AI Recommendations
        </button>
      </div>
    </div>
  );
}

// ── Phase 2: Agentic Workflow ────────────────────────────────────────────────

function AgenticWorkflowPhase({ agenticGraph, agents, loading, error, onOpenAgent }: {
  agenticGraph: PiTobeGraph | null; agents: PiAgent[];
  loading: boolean; error: string;
  onOpenAgent: (agentId: string) => void;
}) {
  const mapGraph = agenticGraph ? tobeToMapGraph(agenticGraph) : null;
  const stats = agenticGraph?.ai_stats;

  if (loading) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <style>{`@keyframes agentic-spin { to { transform: rotate(360deg) } }`}</style>
        <div style={{ width: 44, height: 44, border: '3px solid #E5E5EA', borderTopColor: '#0071E3',
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
              {stats.steps_assisted != null && <StatBlock value={stats.steps_assisted} label="AI-assisted" color="#0071E3" />}
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

      {/* Proposed AI Agents sidebar */}
      <div style={{ width: 300, flexShrink: 0, borderLeft: '1px solid #E5E5EA', background: '#fff', overflowY: 'auto' }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: '#8E8E93', textTransform: 'uppercase', letterSpacing: 0.5,
          padding: '16px 18px 8px' }}>
          📋 Proposed AI Agents
        </p>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {agents.map(a => (
            <button key={a.agent_id} onClick={() => onOpenAgent(a.agent_id)}
              style={{ textAlign: 'left', background: 'none', border: 'none', borderTop: '1px solid #F5F5F7',
                padding: '12px 18px', cursor: 'pointer', fontFamily: FONT }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#1D1D1F' }}>{a.name}</span>
                <span style={{ color: '#C7C7CC', fontSize: 12 }}>›</span>
              </div>
              {a.model && (
                <p style={{ fontSize: 11, color: '#8E8E93', margin: '4px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  Model: {a.model}
                </p>
              )}
              {a.tools.length > 0 && (
                <p style={{ fontSize: 11, color: '#8E8E93', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  Tools: {a.tools.map(t => t.name).join(', ')}
                </p>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
