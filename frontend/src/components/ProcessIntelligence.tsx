import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  generateTobeGraph,
  getGraphStatus,
  getProcessGraph,
  patchProcessGraph,
  putFileToS3,
  triggerParseDiagram,
  uploadProcessDiagram,
  type PiAiOpportunity,
  type PiDomain,
  type PiGraph,
  type PiLanePatch,
  type PiStep,
  type PiStepPatch,
  type PiTobeGraph,
} from '../lib/api';
import { ProcessMap, type MapGraph } from './ProcessMap';

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
type WorkPhase = 'asis' | 'review' | 'tobe';

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
  const [tobeGraph, setTobeGraph]     = useState<PiTobeGraph | null>(null);
  const [tobeLoading, setTobeLoading] = useState(false);
  const [tobeError, setTobeError]     = useState('');

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

  async function handleUpload() {
    if (!file) return;
    setLoadPhase('uploading');
    try {
      const { process_id, upload_url } = await uploadProcessDiagram({
        filename: file.name, domain,
        source_name: file.name.replace(/\.(vsdx|png|jpe?g)$/i, ''),
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

  async function handleGenerateTobe() {
    if (!graph) return;
    setTobeLoading(true); setTobeError(''); setWorkPhase('tobe');
    try {
      const result = await generateTobeGraph(graph.process_id);
      setTobeGraph(result);
    } catch (err: any) {
      setTobeError(err.message || 'Generation failed');
    } finally {
      setTobeLoading(false);
    }
  }

  function reset() {
    stopPolling();
    setLoadPhase('upload'); setFile(null); setErrorMsg('');
    setGraph(null); setStepEditsRaw({}); setLaneEditsRaw({});
    setSaved(false); setTobeGraph(null); setWorkPhase('asis');
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
    return (
      <WorkspaceScreen
        graph={graph}
        workPhase={workPhase} setWorkPhase={setWorkPhase}
        stepEdits={stepEdits} setStepEdits={setStepEdits}
        laneEdits={laneEdits} setLaneEdits={setLaneEdits}
        saving={saving} saved={saved} onSave={handleSave}
        onReset={reset}
        tobeGraph={tobeGraph} tobeLoading={tobeLoading} tobeError={tobeError}
        onGenerateTobe={handleGenerateTobe}
        setTobeError={setTobeError}
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
      onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f && /\.(vsdx|png|jpe?g)$/i.test(f.name)) setFile(f); }}
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

  return (
    <div style={{ background: '#F5F5F7', fontFamily: FONT }}
      className="flex flex-col items-center justify-center h-full p-6 overflow-y-auto">
      <div style={{ maxWidth: 440, width: '100%' }} className="flex flex-col gap-6">

        <div className="text-center" style={{ marginBottom: 4 }}>
          <h1 style={{ color: '#1D1D1F', fontSize: 26, fontWeight: 700, letterSpacing: '-0.3px', margin: 0 }}>
            Process Intelligence
          </h1>
          <p style={{ color: '#6E6E73', marginTop: 8, fontSize: 14, lineHeight: 1.6 }}>
            Upload a process diagram — Visio or image — to extract steps,<br />
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
              <input ref={inputRef} type="file" accept=".vsdx,.png,.jpg,.jpeg"
                style={{ display: 'none' }} onChange={p.onFileInput} />
              {p.file ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 28 }}>{isImage ? '🖼️' : '📊'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ color: '#1D1D1F', fontWeight: 600, fontSize: 14, margin: 0,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.file.name}</p>
                    <p style={{ color: '#6E6E73', fontSize: 12, margin: '3px 0 0' }}>
                      {(p.file.size / 1024).toFixed(1)} KB
                      {isImage ? ' · Vision mode (lower confidence)' : ''}
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
                  <p style={{ color: '#6E6E73', fontSize: 12, margin: 0 }}>or click to browse — .vsdx, .png, .jpg</p>
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
  tobeGraph: PiTobeGraph | null; tobeLoading: boolean; tobeError: string;
  onGenerateTobe: () => void; setTobeError: (e: string) => void;
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

  const phases: { id: WorkPhase; label: string }[] = [
    { id: 'asis',   label: 'As-Is'    },
    { id: 'review', label: 'AI Review' },
    { id: 'tobe',   label: 'To-Be'    },
  ];

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

        {/* Segmented control */}
        <div style={{ display: 'flex', background: '#E5E5EA', borderRadius: 9, padding: 3, gap: 2, flexShrink: 0 }}>
          {phases.map(ph => (
            <button key={ph.id} onClick={() => p.setWorkPhase(ph.id)}
              style={{ padding: '5px 14px', borderRadius: 7, fontSize: 13, fontWeight: 600,
                border: 'none', cursor: 'pointer', transition: 'all 0.15s', fontFamily: FONT,
                background: p.workPhase === ph.id ? '#fff' : 'transparent',
                color: p.workPhase === ph.id ? '#1D1D1F' : '#6E6E73',
                boxShadow: p.workPhase === ph.id ? '0 1px 4px rgba(0,0,0,0.1)' : 'none' }}>
              {ph.label}
            </button>
          ))}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
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
        </div>
      </div>

      {/* Phase content */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {p.workPhase === 'asis' && (
          <AsIsPhase graph={p.graph} asIsGraph={asIsGraph}
            oppCounts={oppCounts} aiCount={aiCount} confPct={confPct}
            onNext={() => p.setWorkPhase('review')} />
        )}
        {p.workPhase === 'review' && (
          <ReviewPhase graph={p.graph}
            stepEdits={p.stepEdits} getStep={getStep} patchStep={patchStep}
            hasEdits={hasEdits} saving={p.saving} saved={p.saved}
            onSave={p.onSave} onGenerateTobe={p.onGenerateTobe}
            onBack={() => p.setWorkPhase('asis')} />
        )}
        {p.workPhase === 'tobe' && (
          <ToBePhase graph={p.graph} asIsGraph={asIsGraph}
            tobeGraph={p.tobeGraph} tobeLoading={p.tobeLoading} tobeError={p.tobeError}
            setTobeError={p.setTobeError} onRegenerate={p.onGenerateTobe}
            onBack={() => p.setWorkPhase('review')} />
        )}
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

function AsIsPhase({ graph, asIsGraph, oppCounts, aiCount, confPct, onNext }: {
  graph: PiGraph; asIsGraph: MapGraph;
  oppCounts: Record<PiAiOpportunity, number>; aiCount: number; confPct: number;
  onNext: () => void;
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
          <ProcessMap graph={asIsGraph} />
        </div>
      </div>

      {/* CTA */}
      <div style={{ background: '#fff', borderTop: '1px solid #E5E5EA', padding: '14px 28px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div>
          <p style={{ color: '#1D1D1F', fontSize: 14, fontWeight: 600, margin: 0 }}>
            {aiCount > 0 ? `${aiCount} AI opportunities identified` : 'Process extracted successfully'}
          </p>
          <p style={{ color: '#6E6E73', fontSize: 12, marginTop: 2 }}>
            Review and confirm classifications before generating the To-Be map
          </p>
        </div>
        <button onClick={onNext}
          style={{ padding: '11px 22px', borderRadius: 980, fontSize: 14, fontWeight: 600,
            border: 'none', cursor: 'pointer', background: '#0071E3', color: '#fff',
            display: 'flex', alignItems: 'center', gap: 6, fontFamily: FONT }}
          onMouseOver={e => (e.currentTarget.style.opacity = '0.85')}
          onMouseOut={e => (e.currentTarget.style.opacity = '1')}>
          Review AI Suggestions
          <svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── Phase 2: Review ────────────────────────────────────────────────────────────

function ReviewPhase({ graph, stepEdits, getStep, patchStep, hasEdits, saving, saved, onSave, onGenerateTobe, onBack }: {
  graph: PiGraph;
  stepEdits: Record<string, Partial<PiStep>>;
  getStep: (s: PiStep) => PiStep;
  patchStep: (id: string, field: keyof PiStep, value: unknown) => void;
  hasEdits: boolean; saving: boolean; saved: boolean;
  onSave: () => void; onGenerateTobe: () => void; onBack: () => void;
}) {
  const laneMap = new Map(graph.swimlanes.map(l => [l.lane_id, l]));
  const byLane = new Map<string, PiStep[]>();
  const unassigned: PiStep[] = [];
  for (const s of graph.steps) {
    if (s.lane_id && laneMap.has(s.lane_id)) {
      const arr = byLane.get(s.lane_id) ?? []; arr.push(s); byLane.set(s.lane_id, arr);
    } else unassigned.push(s);
  }

  const oppCounts: Record<PiAiOpportunity, number> = { sana_agent: 0, workday_native: 0, partial_ai: 0, human_only: 0 };
  for (const s of graph.steps) {
    const opp = (stepEdits[s.step_id]?.ai_opportunity ?? s.ai_opportunity) ?? 'human_only';
    if (opp in oppCounts) oppCounts[opp as PiAiOpportunity]++;
  }

  const LANE_COLORS = ['#0071E3', '#34C759', '#FF9F0A', '#AF52DE', '#FF2D55', '#5AC8FA', '#5E5CE6'];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Summary header */}
      <div style={{ background: '#fff', borderBottom: '1px solid #E5E5EA', padding: '14px 28px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ flex: 1 }}>
            <p style={{ color: '#1D1D1F', fontSize: 15, fontWeight: 700, margin: 0 }}>AI Opportunity Review</p>
            <p style={{ color: '#6E6E73', fontSize: 12, marginTop: 2 }}>
              Confirm or adjust each step's classification. Agentic AI steps will recommend whether Sana or a custom agent is the better fit.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
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
        </div>
      </div>

      {/* Cards list */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px 28px' }}>
        <div style={{ maxWidth: 860, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 28 }}>
          {graph.swimlanes.map((lane, li) => {
            const steps = byLane.get(lane.lane_id) ?? [];
            if (steps.length === 0) return null;
            const laneColor = LANE_COLORS[li % LANE_COLORS.length];
            return (
              <div key={lane.lane_id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: laneColor, flexShrink: 0 }} />
                  <span style={{ color: '#1D1D1F', fontSize: 14, fontWeight: 700 }}>{lane.label}</span>
                  {lane.persona && lane.persona !== lane.label && (
                    <span style={{ color: '#6E6E73', fontSize: 12 }}>· {lane.persona}</span>
                  )}
                  <div style={{ flex: 1, height: 1, background: '#E5E5EA', marginLeft: 4 }} />
                  <span style={{ color: '#6E6E73', fontSize: 12, flexShrink: 0 }}>
                    {steps.length} step{steps.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {steps.map(raw => {
                    const step = getStep(raw);
                    const warned = (graph.parse_warnings ?? []).some(w => w.item_id === step.step_id);
                    return (
                      <OpportunityCard key={step.step_id} step={step} warned={warned} laneColor={laneColor}
                        onLabelChange={v => patchStep(step.step_id, 'label', v)}
                        onAiChange={v => patchStep(step.step_id, 'ai_opportunity', v)} />
                    );
                  })}
                </div>
              </div>
            );
          })}
          {unassigned.length > 0 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#C7C7CC', flexShrink: 0 }} />
                <span style={{ color: '#8E8E93', fontSize: 14, fontWeight: 700, fontStyle: 'italic' }}>Unassigned</span>
                <div style={{ flex: 1, height: 1, background: '#E5E5EA', marginLeft: 4 }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {unassigned.map(raw => {
                  const step = getStep(raw);
                  return <OpportunityCard key={step.step_id} step={step} warned={false} laneColor="#C7C7CC"
                    onLabelChange={v => patchStep(step.step_id, 'label', v)}
                    onAiChange={v => patchStep(step.step_id, 'ai_opportunity', v)} />;
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* CTA bar */}
      <div style={{ background: '#fff', borderTop: '1px solid #E5E5EA', padding: '14px 28px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <button onClick={onBack}
          style={{ padding: '9px 16px', borderRadius: 980, fontSize: 13, fontWeight: 500,
            border: '1px solid #E5E5EA', cursor: 'pointer', background: '#fff', color: '#6E6E73',
            display: 'flex', alignItems: 'center', gap: 5, fontFamily: FONT }}>
          <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
          As-Is
        </button>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {saved && <span style={{ color: '#34C759', fontSize: 12, fontWeight: 600 }}>✓ Saved</span>}
          {hasEdits && !saved && (
            <button onClick={onSave} disabled={saving}
              style={{ padding: '9px 18px', borderRadius: 980, fontSize: 13, fontWeight: 600,
                border: 'none', cursor: 'pointer', background: '#1D1D1F', color: '#fff', fontFamily: FONT }}>
              {saving ? 'Saving…' : 'Save corrections'}
            </button>
          )}
          <button onClick={onGenerateTobe}
            style={{ padding: '11px 22px', borderRadius: 980, fontSize: 14, fontWeight: 600,
              border: 'none', cursor: 'pointer', background: '#0071E3', color: '#fff',
              display: 'flex', alignItems: 'center', gap: 6, fontFamily: FONT }}
            onMouseOver={e => (e.currentTarget.style.opacity = '0.85')}
            onMouseOut={e => (e.currentTarget.style.opacity = '1')}>
            Generate To-Be Map
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Opportunity card ───────────────────────────────────────────────────────────

function OpportunityCard({ step, warned, laneColor, onLabelChange, onAiChange }: {
  step: PiStep; warned: boolean; laneColor: string;
  onLabelChange: (v: string) => void; onAiChange: (v: PiAiOpportunity) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(step.label);
  const opp = step.ai_opportunity;
  const confPct = Math.round(step.parse_confidence * 100);

  function commit() {
    setEditing(false);
    if (draft.trim() && draft.trim() !== step.label) onLabelChange(draft.trim());
  }

  return (
    <div style={{ background: '#fff', borderRadius: 14, padding: '16px 18px',
      boxShadow: warned ? '0 0 0 2px #FF9F0A40, 0 1px 6px rgba(0,0,0,0.05)' : '0 1px 6px rgba(0,0,0,0.05)',
      transition: 'box-shadow 0.15s' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
        {/* Lane accent bar */}
        <div style={{ width: 4, borderRadius: 2, alignSelf: 'stretch', background: laneColor, flexShrink: 0, minHeight: 36 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <input autoFocus value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setEditing(false); setDraft(step.label); } }}
              style={{ width: '100%', border: '2px solid #0071E3', borderRadius: 8, padding: '4px 8px',
                fontSize: 15, fontWeight: 600, color: '#1D1D1F', outline: 'none', fontFamily: FONT,
                background: '#F0F8FF' }} />
          ) : (
            <p onClick={() => { setDraft(step.label); setEditing(true); }}
              style={{ color: '#1D1D1F', fontSize: 15, fontWeight: 600, cursor: 'text', lineHeight: 1.3,
                margin: 0, padding: '2px 0', borderRadius: 4 }}
              title="Click to edit">
              {warned && <span style={{ color: '#FF9F0A', marginRight: 6 }}>!</span>}
              {step.label}
            </p>
          )}
          {step.ai_rationale && (
            <p style={{ color: '#6E6E73', fontSize: 12, marginTop: 4, lineHeight: 1.5, margin: '4px 0 0' }}>
              {step.ai_rationale}
            </p>
          )}
        </div>
        {/* Confidence */}
        <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 700,
            color: confPct >= 80 ? '#34C759' : confPct >= 60 ? '#FF9F0A' : '#FF3B30' }}>
            {confPct}%
          </span>
          <div style={{ width: 44, height: 3, borderRadius: 2, background: '#F5F5F7', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${confPct}%`, borderRadius: 2,
              background: confPct >= 80 ? '#34C759' : confPct >= 60 ? '#FF9F0A' : '#FF3B30' }} />
          </div>
        </div>
      </div>

      {/* Chip selectors */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {OPP_ORDER.map(k => {
          const def = OPP_DEFS[k];
          const active = opp === k;
          return (
            <button key={k} onClick={() => onAiChange(k)}
              style={{ padding: '6px 13px', borderRadius: 980, fontSize: 12, fontWeight: 600,
                border: active ? 'none' : '1px solid #E5E5EA', cursor: 'pointer', transition: 'all 0.15s',
                background: active ? def.activeBg : '#F5F5F7',
                color: active ? def.activeText : '#6E6E73', fontFamily: FONT }}>
              {def.label}
            </button>
          );
        })}
      </div>

      {/* Sana vs custom agent note — shown when classified as agentic AI */}
      {opp === 'sana_agent' && (
        <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8,
          background: '#F0FDF9', border: '1px solid #A7F3D0' }}>
          <p style={{ margin: 0, fontSize: 11, color: '#065f46', lineHeight: 1.5 }}>
            <strong>Sana recommended</strong> if this step involves guided user interaction, document review, or
            conversational workflows.{' '}
            <span style={{ color: '#6E6E73' }}>For backend automation or API orchestration, a custom developer agent
            may be more appropriate.</span>
          </p>
        </div>
      )}
    </div>
  );
}

// ── Phase 3: To-Be ─────────────────────────────────────────────────────────────

function ToBePhase({ graph, asIsGraph, tobeGraph, tobeLoading, tobeError, setTobeError, onRegenerate, onBack }: {
  graph: PiGraph; asIsGraph: MapGraph;
  tobeGraph: PiTobeGraph | null; tobeLoading: boolean; tobeError: string;
  setTobeError: (e: string) => void; onRegenerate: () => void; onBack: () => void;
}) {
  const tobeMapGraph = tobeGraph ? tobeToMapGraph(tobeGraph) : null;
  const stats = tobeGraph?.ai_stats;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {tobeError && (
        <div style={{ background: '#FFF0F0', borderBottom: '1px solid #FFD5D5', padding: '10px 28px',
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ color: '#FF3B30' }}>⚠</span>
          <span style={{ color: '#FF3B30', fontSize: 13 }}>{tobeError}</span>
          <button onClick={() => setTobeError('')}
            style={{ marginLeft: 'auto', color: '#FF3B30', background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>
            ×
          </button>
        </div>
      )}

      {tobeLoading ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20 }}>
          <style>{`@keyframes pi-spin2 { to { transform: rotate(360deg) } }`}</style>
          <div style={{ width: 52, height: 52, border: '3px solid #E5E5EA', borderTopColor: '#0071E3',
            borderRadius: '50%', animation: 'pi-spin2 0.9s linear infinite' }} />
          <div style={{ textAlign: 'center' }}>
            <p style={{ color: '#1D1D1F', fontSize: 17, fontWeight: 700, margin: 0 }}>Generating To-Be Process</p>
            <p style={{ color: '#6E6E73', fontSize: 13, marginTop: 6 }}>
              Redesigning for the agentic AI future state…
            </p>
          </div>
        </div>
      ) : !tobeMapGraph && !tobeError ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 40, textAlign: 'center' }}>
          <div>
            <p style={{ color: '#1D1D1F', fontSize: 17, fontWeight: 700, margin: 0 }}>Ready to generate</p>
            <p style={{ color: '#6E6E73', fontSize: 14, marginTop: 6 }}>
              Generate the agentic To-Be process map based on your AI classifications.
            </p>
          </div>
          <button onClick={onRegenerate}
            style={{ padding: '13px 28px', borderRadius: 980, fontSize: 15, fontWeight: 600,
              border: 'none', cursor: 'pointer', background: '#0071E3', color: '#fff', marginTop: 8, fontFamily: FONT }}
            onMouseOver={e => (e.currentTarget.style.opacity = '0.85')}
            onMouseOut={e => (e.currentTarget.style.opacity = '1')}>
            Generate To-Be Map
          </button>
        </div>
      ) : tobeMapGraph && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {/* Stats */}
          {stats && (
            <div style={{ background: '#fff', borderBottom: '1px solid #E5E5EA', padding: '18px 28px', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
                  {stats.steps_automated != null && <StatBlock value={stats.steps_automated} label="Agent-automated" color="#0d9488" />}
                  {stats.steps_automated != null && <div style={{ width: 1, background: '#E5E5EA', alignSelf: 'stretch' }} />}
                  {stats.steps_assisted != null && <StatBlock value={stats.steps_assisted} label="AI-assisted" color="#0071E3" />}
                  {stats.steps_assisted != null && <div style={{ width: 1, background: '#E5E5EA', alignSelf: 'stretch' }} />}
                  {stats.steps_unchanged != null && <StatBlock value={stats.steps_unchanged} label="Human-only" color="#6E6E73" />}
                  {stats.steps_unchanged != null && <div style={{ width: 1, background: '#E5E5EA', alignSelf: 'stretch' }} />}
                  {stats.cycle_time_reduction_pct != null && (
                    <StatBlock value={`~${stats.cycle_time_reduction_pct}%`} label="Cycle time saved" color="#34C759" />
                  )}
                </div>
                <button onClick={onRegenerate}
                  style={{ padding: '8px 16px', borderRadius: 980, fontSize: 13, fontWeight: 600,
                    border: '1px solid #E5E5EA', cursor: 'pointer', background: '#fff', color: '#1D1D1F',
                    flexShrink: 0, fontFamily: FONT }}>
                  Regenerate
                </button>
              </div>
              {tobeGraph?.transformation_summary && (
                <p style={{ color: '#6E6E73', fontSize: 13, marginTop: 12, lineHeight: 1.6, maxWidth: 680 }}>
                  {tobeGraph.transformation_summary}
                </p>
              )}
            </div>
          )}

          {/* Maps */}
          <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Before */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <div style={{ width: 3, height: 14, borderRadius: 2, background: '#C7C7CC' }} />
                <span style={{ color: '#8E8E93', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Before · {graph.source_name}
                </span>
              </div>
              <div style={{ background: '#fff', borderRadius: 16, padding: '16px 12px',
                boxShadow: '0 1px 6px rgba(0,0,0,0.04)', opacity: 0.65, overflowX: 'auto', display: 'inline-block', minWidth: '100%' }}>
                <ProcessMap graph={asIsGraph} />
              </div>
            </div>

            {/* Divider */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, height: 1, background: '#E5E5EA' }} />
              <span style={{ color: '#8E8E93', fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
                textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                AI Transformation
              </span>
              <div style={{ flex: 1, height: 1, background: '#E5E5EA' }} />
            </div>

            {/* After */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <div style={{ width: 3, height: 14, borderRadius: 2, background: '#0071E3' }} />
                <span style={{ color: '#0071E3', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  After · Agentic AI
                </span>
              </div>
              <div style={{ background: '#fff', borderRadius: 16, padding: '16px 12px',
                boxShadow: '0 2px 12px rgba(0,113,227,0.08)', overflowX: 'auto', display: 'inline-block', minWidth: '100%' }}>
                <ProcessMap graph={tobeMapGraph} />
              </div>
            </div>
          </div>
        </div>
      )}

      {!tobeLoading && (
        <div style={{ background: '#fff', borderTop: '1px solid #E5E5EA', padding: '14px 28px', flexShrink: 0 }}>
          <button onClick={onBack}
            style={{ padding: '9px 16px', borderRadius: 980, fontSize: 13, fontWeight: 500,
              border: '1px solid #E5E5EA', cursor: 'pointer', background: '#fff', color: '#6E6E73',
              display: 'flex', alignItems: 'center', gap: 5, fontFamily: FONT }}>
            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            AI Review
          </button>
        </div>
      )}
    </div>
  );
}
