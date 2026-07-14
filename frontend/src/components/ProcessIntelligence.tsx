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
import { ProcessMap, MapLegend, type MapGraph } from './ProcessMap';

// ── Constants ──────────────────────────────────────────────────────────────────

const DOMAINS: { value: PiDomain; label: string }[] = [
  { value: 'recruiting',       label: 'Recruiting' },
  { value: 'onboarding',       label: 'Onboarding' },
  { value: 'self_service',     label: 'Employee Self-Service' },
  { value: 'payroll',          label: 'Payroll' },
  { value: 'job_architecture', label: 'Job Architecture' },
  { value: 'performance',      label: 'Performance Management' },
];

const AI_OPP_META: Record<PiAiOpportunity, { label: string; short: string; pill: string }> = {
  sana_agent:     { label: '⚡ Sana Agent',    short: 'Sana Agent',    pill: 'bg-teal-50 text-teal-700 border border-teal-200' },
  workday_native: { label: '🔄 Workday Native', short: 'WD Native',     pill: 'bg-green-50 text-green-700 border border-green-200' },
  partial_ai:     { label: '🤖 AI-Assisted',   short: 'AI-Assisted',   pill: 'bg-amber-50 text-amber-700 border border-amber-200' },
  human_only:     { label: '👤 Human Only',    short: 'Human Only',    pill: 'bg-slate-50 text-slate-500 border border-slate-200' },
};

const LANE_DOT_COLORS = [
  'bg-blue-400', 'bg-violet-400', 'bg-pink-400', 'bg-orange-400',
  'bg-teal-400', 'bg-emerald-400', 'bg-rose-400', 'bg-amber-400',
];

// ── Graph adapters ─────────────────────────────────────────────────────────────

function piGraphToMapGraph(graph: PiGraph, edits: Record<string, Partial<PiStep>>): MapGraph {
  return {
    swimlanes: graph.swimlanes,
    steps: graph.steps.map(s => {
      const e = edits[s.step_id] ?? {};
      return {
        step_id:      s.step_id,
        lane_id:      (e.lane_id !== undefined ? e.lane_id : s.lane_id) ?? null,
        label:        e.label ?? s.label,
        step_type:    s.type,
        ai_opportunity: (e.ai_opportunity ?? s.ai_opportunity) ?? null,
        tooltip:      s.ai_rationale ?? undefined,
      };
    }),
    connectors: graph.connectors.map(c => ({ from: c.from, to: c.to, condition: c.condition })),
  };
}

function tobeToMapGraph(tobe: PiTobeGraph): MapGraph {
  return {
    swimlanes: tobe.swimlanes,
    steps: tobe.steps.map(s => ({
      step_id:      s.step_id,
      lane_id:      s.lane_id ?? null,
      label:        s.label,
      step_type:    s.step_type,
      ai_opportunity: s.ai_opportunity ?? null,
      tooltip:      s.transformation_note ?? undefined,
    })),
    connectors: tobe.connectors.map(c => ({ from: c.from, to: c.to, condition: c.condition })),
  };
}

// ── Root component ─────────────────────────────────────────────────────────────

type Phase = 'upload' | 'uploading' | 'parsing' | 'review' | 'error';

export default function ProcessIntelligence({ clientName }: { clientName?: string }) {
  const [phase, setPhase]       = useState<Phase>('upload');
  const [domain, setDomain]     = useState<PiDomain>('onboarding');
  const [file, setFile]         = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [processId, setProcessId] = useState('');
  const [parseMsg, setParseMsg] = useState('');
  const [graph, setGraph]       = useState<PiGraph | null>(null);
  const [stepEdits, setStepEditsRaw] = useState<Record<string, Partial<PiStep>>>({});
  const [laneEdits, setLaneEditsRaw] = useState<Record<string, { label?: string; persona?: string }>>({});
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [tobeGraph, setTobeGraph] = useState<PiTobeGraph | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPolling = () => { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null; };
  useEffect(() => () => stopPolling(), []);

  // Wrappers that reset "saved" on any new edit
  function setStepEdits(e: Record<string, Partial<PiStep>>) { setSaved(false); setStepEditsRaw(e); }
  function setLaneEdits(e: Record<string, { label?: string; persona?: string }>) { setSaved(false); setLaneEditsRaw(e); }

  const startPolling = useCallback((pid: string) => {
    setParseMsg('Parsing diagram structure…');
    let ticks = 0;
    pollRef.current = setInterval(async () => {
      ticks++;
      try {
        const status = await getGraphStatus(pid);
        if (status.parse_status === 'parsing') {
          if (ticks >= 3) setParseMsg('Classifying steps with AI…');
          if (ticks >= 6) setParseMsg('Almost there — finalising…');
          return;
        }
        stopPolling();
        if (status.parse_status === 'failed') {
          setErrorMsg(status.parse_error || 'Parse failed');
          setPhase('error');
          return;
        }
        const g = await getProcessGraph(pid);
        setGraph(g);
        setPhase('review');
      } catch (err: any) {
        stopPolling();
        setErrorMsg(err.message || 'Status check failed');
        setPhase('error');
      }
    }, 3000);
  }, []);

  async function handleUpload() {
    if (!file) return;
    setPhase('uploading');
    setErrorMsg('');
    try {
      const { process_id, upload_url } = await uploadProcessDiagram({
        filename: file.name,
        domain,
        source_name: file.name.replace(/\.(vsdx|png|jpe?g)$/i, ''),
      });
      await putFileToS3(upload_url, file);
      await triggerParseDiagram(process_id);
      setProcessId(process_id);
      setPhase('parsing');
      startPolling(process_id);
    } catch (err: any) {
      setErrorMsg(err.message || 'Upload failed');
      setPhase('error');
    }
  }

  async function handleSave() {
    if (!graph) return;
    setSaving(true);
    try {
      const step_patches: PiStepPatch[] = Object.entries(stepEdits).map(([step_id, e]) => ({
        step_id,
        ...(e.label             !== undefined ? { label:           e.label }            : {}),
        ...(e.lane_id           !== undefined ? { lane_id:         e.lane_id }          : {}),
        ...(e.systems_touched   !== undefined ? { systems_touched: e.systems_touched }  : {}),
        ...(e.ai_opportunity    != null       ? { ai_opportunity:  e.ai_opportunity }   : {}),
      }));
      const lane_patches: PiLanePatch[] = Object.entries(laneEdits).map(([lane_id, e]) => ({ lane_id, ...e }));
      if (step_patches.length || lane_patches.length) {
        await patchProcessGraph(graph.process_id, { step_patches, lane_patches });
      }
      const fresh = await getProcessGraph(graph.process_id);
      setGraph(fresh);
      setStepEditsRaw({});
      setLaneEditsRaw({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err: any) {
      setErrorMsg(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    stopPolling();
    setPhase('upload'); setFile(null); setErrorMsg(''); setProcessId('');
    setGraph(null); setStepEditsRaw({}); setLaneEditsRaw({});
    setSaved(false); setTobeGraph(null);
  }

  function handleFileDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && /\.(vsdx|png|jpe?g)$/i.test(f.name)) setFile(f);
  }

  if (phase === 'upload' || phase === 'uploading') {
    return <UploadScreen
      domain={domain} setDomain={setDomain}
      file={file} setFile={setFile}
      dragOver={dragOver} setDragOver={setDragOver}
      uploading={phase === 'uploading'}
      onUpload={handleUpload}
      onDrop={handleFileDrop}
      onFileInput={e => { const f = e.target.files?.[0]; if (f) setFile(f); }}
      clientName={clientName}
    />;
  }

  if (phase === 'parsing') return <ParsingScreen message={parseMsg} />;

  if (phase === 'error') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
        <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center text-xl">⚠</div>
        <div>
          <p className="text-sm font-medium text-slate-800">Something went wrong</p>
          <p className="text-xs text-slate-500 mt-1 max-w-sm">{errorMsg}</p>
        </div>
        <button onClick={reset}
          className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-700 transition-colors">
          Try again
        </button>
      </div>
    );
  }

  if (phase === 'review' && graph) {
    return <ReviewScreen
      graph={graph}
      stepEdits={stepEdits} setStepEdits={setStepEdits}
      laneEdits={laneEdits} setLaneEdits={setLaneEdits}
      saving={saving} saved={saved}
      onSave={handleSave}
      onReset={reset}
      tobeGraph={tobeGraph}
      setTobeGraph={setTobeGraph}
    />;
  }

  return null;
}

// ── Upload screen ──────────────────────────────────────────────────────────────

function UploadScreen(p: {
  domain: PiDomain; setDomain: (d: PiDomain) => void;
  file: File | null; setFile: (f: File | null) => void;
  dragOver: boolean; setDragOver: (v: boolean) => void;
  uploading: boolean;
  onUpload: () => void;
  onDrop: (e: React.DragEvent) => void;
  onFileInput: (e: React.ChangeEvent<HTMLInputElement>) => void;
  clientName?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isImage = p.file && /\.(png|jpe?g)$/i.test(p.file.name);

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-slate-50">
      <div className="max-w-lg mx-auto w-full px-6 py-10 flex flex-col gap-7">

        {/* Title */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-base font-bold text-slate-900">Process Intelligence</span>
            {p.clientName && (
              <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">{p.clientName}</span>
            )}
          </div>
          <p className="text-sm text-slate-500 leading-relaxed">
            Upload a process diagram to extract steps, classify AI opportunities,
            and generate a Sana-enabled future-state map.
          </p>
        </div>

        {/* Workflow steps */}
        <div className="flex items-start gap-0">
          {[
            { n: '1', label: 'Choose domain', sub: 'Select the Workday area' },
            { n: '2', label: 'Upload diagram', sub: 'Visio .vsdx or image' },
            { n: '3', label: 'AI classifies', sub: 'Steps + opportunities' },
          ].map((step, i) => (
            <React.Fragment key={step.n}>
              <div className="flex flex-col items-center text-center flex-1">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold mb-1.5
                  ${i === 0 ? 'bg-slate-900 text-white' : i === 1 ? (p.file ? 'bg-slate-900 text-white' : 'bg-slate-200 text-slate-500') : 'bg-slate-200 text-slate-400'}`}>
                  {step.n}
                </div>
                <p className="text-xs font-semibold text-slate-700">{step.label}</p>
                <p className="text-xs text-slate-400">{step.sub}</p>
              </div>
              {i < 2 && <div className="h-px bg-slate-200 flex-1 mt-3.5 mx-1" />}
            </React.Fragment>
          ))}
        </div>

        {/* Domain selector */}
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5 uppercase tracking-wide">
            Workday Domain
          </label>
          <select
            value={p.domain}
            onChange={e => p.setDomain(e.target.value as PiDomain)}
            className="w-full border border-slate-200 rounded-lg text-sm px-3 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400 shadow-sm"
          >
            {DOMAINS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </div>

        {/* Drop zone */}
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5 uppercase tracking-wide">
            Process Diagram
          </label>
          <div
            onDragOver={e => { e.preventDefault(); p.setDragOver(true); }}
            onDragLeave={() => p.setDragOver(false)}
            onDrop={p.onDrop}
            onClick={() => inputRef.current?.click()}
            className={`rounded-xl border-2 border-dashed transition-all cursor-pointer
              ${p.dragOver
                ? 'border-slate-400 bg-slate-100'
                : p.file
                  ? 'border-slate-300 bg-white'
                  : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'}`}
          >
            <input ref={inputRef} type="file" accept=".vsdx,.png,.jpg,.jpeg"
              className="hidden" onChange={p.onFileInput} />

            {p.file ? (
              <div className="p-6 flex items-start gap-4">
                <div className={`w-12 h-12 rounded-lg flex items-center justify-center text-2xl shrink-0
                  ${isImage ? 'bg-blue-50' : 'bg-slate-100'}`}>
                  {isImage ? '🖼️' : '📊'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-800 truncate">{p.file.name}</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {(p.file.size / 1024).toFixed(1)} KB
                    {isImage && ' · Image mode'}
                  </p>
                  {isImage && (
                    <p className="text-xs text-amber-600 mt-1.5 bg-amber-50 rounded-md px-2 py-1 inline-block">
                      AI will read the diagram visually — confidence will be lower than .vsdx
                    </p>
                  )}
                </div>
                <button
                  onClick={e => { e.stopPropagation(); p.setFile(null); }}
                  className="text-slate-300 hover:text-slate-500 transition-colors shrink-0 text-lg leading-none"
                  title="Remove file"
                >
                  ×
                </button>
              </div>
            ) : (
              <div className="p-8 flex flex-col items-center gap-3 text-center">
                <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
                    className="w-6 h-6 text-slate-400">
                    <path strokeLinecap="round" strokeLinejoin="round"
                      d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-700">Drop your diagram here</p>
                  <p className="text-xs text-slate-400 mt-0.5">or click to browse</p>
                </div>
                <div className="flex gap-2 mt-1">
                  {['.vsdx', '.png', '.jpg'].map(ext => (
                    <span key={ext} className="px-2 py-0.5 rounded bg-slate-100 text-slate-500 text-xs font-mono">
                      {ext}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Upload button */}
        <button
          onClick={p.onUpload}
          disabled={!p.file || p.uploading}
          className={`w-full py-3 rounded-lg text-sm font-semibold transition-all
            ${p.file && !p.uploading
              ? 'bg-slate-900 text-white hover:bg-slate-700 shadow-sm'
              : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}
        >
          {p.uploading
            ? <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Uploading…
              </span>
            : 'Analyse Process'}
        </button>
      </div>
    </div>
  );
}

// ── Parsing screen ─────────────────────────────────────────────────────────────

function ParsingScreen({ message }: { message: string }) {
  const steps = [
    'Parsing diagram structure…',
    'Classifying steps with AI…',
    'Almost there — finalising…',
  ];
  const activeIdx = steps.findIndex(s => s === message);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-8 p-8 bg-slate-50">
      <div className="w-14 h-14 border-[3px] border-slate-200 border-t-slate-700 rounded-full animate-spin" />
      <div className="text-center">
        <p className="text-sm font-semibold text-slate-800">{message || 'Processing…'}</p>
        <p className="text-xs text-slate-400 mt-1">Usually takes 20–40 seconds</p>
      </div>
      <div className="flex gap-3">
        {steps.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full transition-colors
              ${i < activeIdx ? 'bg-slate-700' : i === activeIdx ? 'bg-slate-400 animate-pulse' : 'bg-slate-200'}`} />
            {i < steps.length - 1 && <div className="w-6 h-px bg-slate-200" />}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Review screen ──────────────────────────────────────────────────────────────

interface ReviewScreenProps {
  graph: PiGraph;
  stepEdits: Record<string, Partial<PiStep>>;
  setStepEdits: (e: Record<string, Partial<PiStep>>) => void;
  laneEdits: Record<string, { label?: string; persona?: string }>;
  setLaneEdits: (e: Record<string, { label?: string; persona?: string }>) => void;
  saving: boolean; saved: boolean;
  onSave: () => void; onReset: () => void;
  tobeGraph: PiTobeGraph | null;
  setTobeGraph: (g: PiTobeGraph | null) => void;
}

function ReviewScreen(p: ReviewScreenProps) {
  const conf = p.graph.parse_confidence ?? 0;
  const confPct = Math.round(conf * 100);
  const warnings = p.graph.parse_warnings || [];
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [tobeLoading, setTobeLoading]     = useState(false);
  const [tobeError, setTobeError]         = useState('');

  async function handleGenerateTobe() {
    setTobeLoading(true); setTobeError('');
    try {
      const result = await generateTobeGraph(p.graph.process_id);
      p.setTobeGraph(result);
    } catch (err: any) {
      setTobeError(err.message || 'Generation failed');
    } finally {
      setTobeLoading(false);
    }
  }

  function patchStep(step_id: string, field: keyof PiStep, value: unknown) {
    p.setStepEdits({ ...p.stepEdits, [step_id]: { ...p.stepEdits[step_id], [field]: value } });
  }

  function getStep(s: PiStep): PiStep { return { ...s, ...p.stepEdits[s.step_id] }; }

  // Group steps by lane
  const laneMap = new Map(p.graph.swimlanes.map(l => [l.lane_id, l]));
  const byLane = new Map<string, PiStep[]>();
  const unassigned: PiStep[] = [];
  for (const s of p.graph.steps) {
    if (s.lane_id && laneMap.has(s.lane_id)) {
      const arr = byLane.get(s.lane_id) ?? []; arr.push(s); byLane.set(s.lane_id, arr);
    } else unassigned.push(s);
  }

  const hasEdits = Object.keys(p.stepEdits).length > 0 || Object.keys(p.laneEdits).length > 0;

  // AI opportunity summary counts (from graph + edits)
  const oppCounts: Record<string, number> = { sana_agent: 0, workday_native: 0, partial_ai: 0, human_only: 0 };
  for (const s of p.graph.steps) {
    const opp = (p.stepEdits[s.step_id]?.ai_opportunity ?? s.ai_opportunity) ?? 'human_only';
    if (opp in oppCounts) oppCounts[opp]++;
  }

  const asIsGraph = piGraphToMapGraph(p.graph, p.stepEdits);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-white">

      {/* ── Header bar ────────────────────────────────────────────────────── */}
      <div className="shrink-0 px-4 py-2 border-b border-slate-100 bg-white flex items-center gap-3 min-h-[52px]">
        {/* Title + meta */}
        <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-slate-900 truncate max-w-[200px]">
            {p.graph.source_name}
          </span>
          <span className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${
            p.graph.parse_status === 'needs_review'
              ? 'bg-amber-50 text-amber-700 border border-amber-200'
              : 'bg-green-50 text-green-700 border border-green-200'}`}>
            {p.graph.parse_status === 'needs_review' ? 'Needs review' : 'Ready'}
          </span>
          <span className="text-xs text-slate-400 capitalize">{p.graph.domain.replace('_', ' ')}</span>
          <span className="text-xs text-slate-300">·</span>
          <span className={`text-xs font-medium ${
            confPct >= 80 ? 'text-green-600' : confPct >= 60 ? 'text-amber-600' : 'text-red-500'}`}>
            {confPct}% confidence
          </span>
          {warnings.length > 0 && (
            <span className="text-xs text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full border border-amber-200">
              {warnings.length} warning{warnings.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* AI opportunity summary chips */}
        <div className="hidden lg:flex items-center gap-1.5 shrink-0">
          {oppCounts.sana_agent > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200 font-medium">
              ⚡ {oppCounts.sana_agent}
            </span>
          )}
          {oppCounts.workday_native > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200 font-medium">
              🔄 {oppCounts.workday_native}
            </span>
          )}
          {oppCounts.partial_ai > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-medium">
              🤖 {oppCounts.partial_ai}
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {p.saved && (
            <span className="text-xs text-green-600 font-medium flex items-center gap-1">
              <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              Saved
            </span>
          )}
          <button
            onClick={p.onSave}
            disabled={!hasEdits || p.saving || p.saved}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all
              ${hasEdits && !p.saving && !p.saved
                ? 'bg-slate-900 text-white hover:bg-slate-700 shadow-sm'
                : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}
          >
            {p.saving ? (
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 border border-slate-400 border-t-transparent rounded-full animate-spin" />
                Saving…
              </span>
            ) : 'Save corrections'}
          </button>
          <button
            onClick={handleGenerateTobe}
            disabled={tobeLoading}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all
              ${tobeLoading
                ? 'bg-teal-50 text-teal-400 cursor-not-allowed'
                : 'bg-teal-600 text-white hover:bg-teal-700 shadow-sm'}`}
          >
            {tobeLoading ? (
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 border border-teal-300 border-t-teal-100 rounded-full animate-spin" />
                Generating…
              </span>
            ) : p.tobeGraph ? '⚡ Regenerate To-Be' : '⚡ Generate To-Be Map'}
          </button>
          <button onClick={p.onReset}
            className="text-xs text-slate-400 hover:text-slate-600 px-2 py-1.5 rounded-lg hover:bg-slate-50 transition-colors">
            New upload
          </button>
        </div>
      </div>

      {/* Error banner */}
      {tobeError && (
        <div className="shrink-0 px-4 py-2 bg-red-50 border-b border-red-100 text-xs text-red-600 flex items-center gap-2">
          <span>⚠</span> {tobeError}
          <button onClick={() => setTobeError('')} className="ml-auto text-red-400 hover:text-red-600">×</button>
        </div>
      )}

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      <div className="flex-1 flex min-h-0 overflow-hidden">

        {/* Left: review table */}
        {!leftCollapsed && (
          <div className="w-[340px] shrink-0 flex flex-col border-r border-slate-100 min-h-0 bg-white">
            {/* Panel header */}
            <div className="shrink-0 px-3 py-2 bg-slate-50 border-b border-slate-100 flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Review Table</span>
              <span className="ml-auto text-xs text-slate-400">
                {p.graph.steps.length} steps · {p.graph.swimlanes.length} lanes
              </span>
            </div>

            {/* Warning strip */}
            {warnings.length > 0 && (
              <div className="shrink-0 px-3 py-2 bg-amber-50 border-b border-amber-100 flex gap-2 items-start">
                <span className="text-amber-500 text-sm shrink-0 mt-px">⚠</span>
                <div>
                  <p className="text-xs font-semibold text-amber-700">{warnings.length} low-confidence item{warnings.length > 1 ? 's' : ''}</p>
                  {warnings.slice(0, 2).map((w, i) => (
                    <p key={i} className="text-xs text-amber-600 truncate">{w.item_id}: {w.message}</p>
                  ))}
                  {warnings.length > 2 && <p className="text-xs text-amber-500">…+{warnings.length - 2} more</p>}
                </div>
              </div>
            )}

            {/* Edit hint */}
            <div className="shrink-0 px-3 py-1.5 bg-blue-50 border-b border-blue-100 text-xs text-blue-600">
              ✏ Click any step label to edit. Changes update the map live.
            </div>

            {/* Table */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              <table className="w-full text-xs border-collapse">
                <tbody>
                  {p.graph.swimlanes.map((lane, li) => {
                    const steps = byLane.get(lane.lane_id) ?? [];
                    if (steps.length === 0) return null;
                    return (
                      <React.Fragment key={lane.lane_id}>
                        <tr className="bg-slate-50 border-y border-slate-200 sticky top-0 z-10">
                          <td colSpan={2} className="px-3 py-1.5">
                            <div className="flex items-center gap-2">
                              <span className={`w-2 h-2 rounded-full shrink-0 ${LANE_DOT_COLORS[li % LANE_DOT_COLORS.length]}`} />
                              <span className="font-semibold text-slate-700 truncate">{lane.label}</span>
                              {lane.persona && lane.persona !== lane.label && (
                                <span className="text-slate-400 truncate text-xs">· {lane.persona}</span>
                              )}
                              <span className="ml-auto text-slate-400 shrink-0">{steps.length}</span>
                            </div>
                          </td>
                        </tr>
                        {steps.map(raw => {
                          const step = getStep(raw);
                          const warned = warnings.some(w => w.item_id === step.step_id);
                          return <StepRow key={step.step_id} step={step} warned={warned}
                            onLabelChange={v => patchStep(step.step_id, 'label', v)}
                            onAiChange={v => patchStep(step.step_id, 'ai_opportunity', v)} />;
                        })}
                      </React.Fragment>
                    );
                  })}
                  {unassigned.length > 0 && (
                    <>
                      <tr className="bg-slate-50 border-y border-slate-200">
                        <td colSpan={2} className="px-3 py-1.5 text-slate-500 italic font-medium">Unassigned steps</td>
                      </tr>
                      {unassigned.map(raw => {
                        const step = getStep(raw);
                        return <StepRow key={step.step_id} step={step} warned={false}
                          onLabelChange={v => patchStep(step.step_id, 'label', v)}
                          onAiChange={v => patchStep(step.step_id, 'ai_opportunity', v)} />;
                      })}
                    </>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Collapse toggle */}
        <button
          onClick={() => setLeftCollapsed(v => !v)}
          title={leftCollapsed ? 'Show review table' : 'Hide review table'}
          className="shrink-0 w-6 flex items-center justify-center bg-slate-50 hover:bg-slate-100 border-r border-slate-200 text-slate-400 hover:text-slate-600 transition-colors group"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 group-hover:scale-110 transition-transform">
            {leftCollapsed
              ? <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
              : <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
            }
          </svg>
        </button>

        {/* Right: maps */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col">

          {/* AS-IS */}
          <div className="shrink-0">
            <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center gap-3">
              <div>
                <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Current Process</p>
                <p className="text-xs text-slate-400">{p.graph.source_name}</p>
              </div>
              <div className="ml-auto">
                <MapLegend />
              </div>
            </div>
            <div className="p-4 overflow-x-auto bg-white">
              <ProcessMap graph={asIsGraph} />
            </div>
          </div>

          {/* Transformation divider */}
          {(p.tobeGraph || tobeLoading) && (
            <div className="shrink-0 relative">
              <div className="absolute inset-0 flex items-center px-4">
                <div className="w-full h-px bg-gradient-to-r from-slate-200 via-teal-300 to-slate-200" />
              </div>
              <div className="relative flex justify-center py-3">
                <span className="px-4 py-1 bg-white border border-teal-200 rounded-full text-xs font-semibold text-teal-700 shadow-sm">
                  ⚡ AI Transformation
                </span>
              </div>
            </div>
          )}

          {/* TO-BE loading */}
          {tobeLoading && (
            <div className="shrink-0 flex flex-col items-center gap-4 py-14 bg-gradient-to-b from-teal-50/50 to-white">
              <div className="w-10 h-10 border-[3px] border-teal-100 border-t-teal-500 rounded-full animate-spin" />
              <div className="text-center">
                <p className="text-sm font-semibold text-slate-700">Generating To-Be Process Map</p>
                <p className="text-xs text-slate-400 mt-1">Redesigning your process for the Sana-enabled future state…</p>
              </div>
            </div>
          )}

          {/* TO-BE map */}
          {!tobeLoading && p.tobeGraph && (
            <div className="shrink-0">
              {/* To-be header */}
              <div className="px-4 py-3 bg-gradient-to-r from-teal-50 to-white border-b border-teal-100">
                <div className="flex items-center gap-2 mb-2">
                  <p className="text-xs font-semibold text-teal-700 uppercase tracking-wide">To-Be Process</p>
                  <span className="text-xs text-teal-500">· AI-enabled future state</span>
                </div>
                {p.tobeGraph.transformation_summary && (
                  <p className="text-xs text-slate-600 leading-relaxed mb-2.5">
                    {p.tobeGraph.transformation_summary}
                  </p>
                )}
                {p.tobeGraph.ai_stats && (
                  <div className="flex flex-wrap gap-2">
                    {p.tobeGraph.ai_stats.steps_automated != null && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-teal-100 text-teal-800 text-xs font-semibold">
                        ⚡ {p.tobeGraph.ai_stats.steps_automated} steps automated by Sana
                      </span>
                    )}
                    {p.tobeGraph.ai_stats.steps_assisted != null && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue-100 text-blue-800 text-xs font-semibold">
                        🤖 {p.tobeGraph.ai_stats.steps_assisted} AI-assisted
                      </span>
                    )}
                    {p.tobeGraph.ai_stats.steps_unchanged != null && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 text-xs font-semibold">
                        👤 {p.tobeGraph.ai_stats.steps_unchanged} human-only
                      </span>
                    )}
                    {p.tobeGraph.ai_stats.cycle_time_reduction_pct != null && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-green-100 text-green-800 text-xs font-semibold">
                        ⏱ ~{p.tobeGraph.ai_stats.cycle_time_reduction_pct}% cycle time reduction
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="px-4 py-2 border-b border-slate-100 bg-white">
                <MapLegend />
              </div>
              <div className="p-4 overflow-x-auto bg-white">
                <ProcessMap graph={tobeToMapGraph(p.tobeGraph)} />
              </div>
            </div>
          )}

          {/* Empty to-be prompt */}
          {!tobeLoading && !p.tobeGraph && (
            <div className="shrink-0 flex flex-col items-center gap-2 py-10">
              <p className="text-xs text-slate-400">
                Save your corrections, then click{' '}
                <span className="font-semibold text-teal-600">⚡ Generate To-Be Map</span>{' '}
                to see the AI-enabled future state
              </p>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

// ── Step row ───────────────────────────────────────────────────────────────────

function StepRow({ step, warned, onLabelChange, onAiChange }: {
  step: PiStep; warned: boolean;
  onLabelChange: (v: string) => void;
  onAiChange: (v: PiAiOpportunity) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(step.label);
  const confPct = Math.round(step.parse_confidence * 100);
  const opp = step.ai_opportunity;
  const meta = opp ? AI_OPP_META[opp] : null;

  return (
    <tr className={`border-b border-slate-100 align-top transition-colors
      ${warned ? 'bg-amber-50 hover:bg-amber-50' : 'hover:bg-slate-50'}`}>

      {/* Step label */}
      <td className="px-3 py-2 w-[180px]">
        {editing ? (
          <input autoFocus value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={() => { setEditing(false); onLabelChange(draft); }}
            onKeyDown={e => { if (e.key === 'Enter') { setEditing(false); onLabelChange(draft); } if (e.key === 'Escape') { setEditing(false); setDraft(step.label); } }}
            className="w-full border border-blue-300 rounded-md px-1.5 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200 bg-white shadow-sm"
          />
        ) : (
          <div onClick={() => { setDraft(step.label); setEditing(true); }}
            className="cursor-pointer group">
            <div className="flex items-start gap-1">
              {warned && <span className="text-amber-500 shrink-0 text-xs mt-px">!</span>}
              <span className="text-xs text-slate-700 group-hover:text-slate-900 leading-snug">
                {step.label}
              </span>
            </div>
            {step.ai_rationale && (
              <p className="text-slate-400 mt-0.5 leading-snug line-clamp-2" style={{ fontSize: '10px' }}>
                {step.ai_rationale}
              </p>
            )}
          </div>
        )}
      </td>

      {/* AI opportunity + confidence */}
      <td className="px-2 py-2">
        <select
          value={opp ?? ''}
          onChange={e => { if (e.target.value) onAiChange(e.target.value as PiAiOpportunity); }}
          className={`w-full rounded-md px-1.5 py-1 text-xs font-medium focus:outline-none cursor-pointer border transition-colors ${
            meta ? meta.pill : 'bg-slate-50 text-slate-500 border-slate-200'}`}
        >
          <option value="">— unclassified —</option>
          {(Object.keys(AI_OPP_META) as PiAiOpportunity[]).map(k => (
            <option key={k} value={k}>{AI_OPP_META[k].label}</option>
          ))}
        </select>
        <div className="flex justify-end mt-1">
          <span className={`text-xs tabular-nums ${
            confPct >= 80 ? 'text-green-500' : confPct >= 60 ? 'text-amber-500' : 'text-red-500'}`}>
            {confPct}%
          </span>
        </div>
      </td>
    </tr>
  );
}
