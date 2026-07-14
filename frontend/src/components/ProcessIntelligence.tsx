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

const DOMAINS: { value: PiDomain; label: string }[] = [
  { value: 'recruiting',       label: 'Recruiting' },
  { value: 'onboarding',       label: 'Onboarding' },
  { value: 'self_service',     label: 'Employee Self-Service' },
  { value: 'payroll',          label: 'Payroll' },
  { value: 'job_architecture', label: 'Job Architecture' },
  { value: 'performance',      label: 'Performance' },
];

const AI_OPP_META: Record<PiAiOpportunity, { label: string; colors: string }> = {
  sana_agent:     { label: '⚡ Sana Agent',    colors: 'bg-teal-100 text-teal-800 border-teal-200' },
  workday_native: { label: '🔄 Workday Native', colors: 'bg-green-100 text-green-800 border-green-200' },
  partial_ai:     { label: '🤖 AI-Assisted',   colors: 'bg-amber-100 text-amber-800 border-amber-200' },
  human_only:     { label: '👤 Human Only',    colors: 'bg-slate-100 text-slate-600 border-slate-200' },
};

type Phase = 'upload' | 'uploading' | 'parsing' | 'review' | 'error';

interface Props {
  clientName?: string;
}

export default function ProcessIntelligence({ clientName }: Props) {
  const [phase, setPhase]             = useState<Phase>('upload');
  const [domain, setDomain]           = useState<PiDomain>('onboarding');
  const [file, setFile]               = useState<File | null>(null);
  const [dragOver, setDragOver]       = useState(false);
  const [errorMsg, setErrorMsg]       = useState('');
  const [processId, setProcessId]     = useState('');
  const [parseProgress, setParseProgress] = useState('Initialising…');
  const [graph, setGraph]             = useState<PiGraph | null>(null);

  // Review state: edits indexed by step_id
  const [stepEdits, setStepEdits]     = useState<Record<string, Partial<PiStep>>>({});
  const [laneEdits, setLaneEdits]     = useState<Record<string, { label?: string; persona?: string }>>({});
  const [saving, setSaving]           = useState(false);
  const [saved, setSaved]             = useState(false);
  const [tobeGraph, setTobeGraph]     = useState<PiTobeGraph | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };

  useEffect(() => () => stopPolling(), []);

  const startPolling = useCallback((pid: string) => {
    setParseProgress('Parsing diagram…');
    pollRef.current = setInterval(async () => {
      try {
        const status = await getGraphStatus(pid);
        if (status.parse_status === 'parsing') {
          setParseProgress('Classifying steps with AI…');
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

  function handleFileDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && /\.(vsdx|png|jpe?g)$/i.test(f.name)) setFile(f);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) setFile(f);
  }

  async function handleSaveReview() {
    if (!graph) return;
    setSaving(true);
    try {
      const step_patches: PiStepPatch[] = Object.entries(stepEdits).map(
        ([step_id, edits]) => ({
          step_id,
          ...(edits.label !== undefined ? { label: edits.label } : {}),
          ...(edits.lane_id !== undefined ? { lane_id: edits.lane_id } : {}),
          ...(edits.systems_touched !== undefined ? { systems_touched: edits.systems_touched } : {}),
          ...(edits.ai_opportunity != null ? { ai_opportunity: edits.ai_opportunity } : {}),
        })
      );
      const lane_patches: PiLanePatch[] = Object.entries(laneEdits).map(
        ([lane_id, edits]) => ({ lane_id, ...edits })
      );
      if (step_patches.length || lane_patches.length) {
        await patchProcessGraph(graph.process_id, { step_patches, lane_patches });
      }
      // Re-fetch so the base graph reflects saved values, then clear the diff
      const freshGraph = await getProcessGraph(graph.process_id);
      setGraph(freshGraph);
      setStepEdits({});
      setLaneEdits({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setErrorMsg(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    stopPolling();
    setPhase('upload');
    setFile(null);
    setErrorMsg('');
    setProcessId('');
    setGraph(null);
    setStepEdits({});
    setLaneEdits({});
    setSaved(false);
    setTobeGraph(null);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (phase === 'upload' || phase === 'uploading') {
    return <UploadScreen
      domain={domain} setDomain={setDomain}
      file={file} setFile={setFile}
      dragOver={dragOver} setDragOver={setDragOver}
      uploading={phase === 'uploading'}
      onUpload={handleUpload}
      onDrop={handleFileDrop}
      onFileInput={handleFileInput}
      clientName={clientName}
    />;
  }

  if (phase === 'parsing') {
    return <ParsingScreen message={parseProgress} />;
  }

  if (phase === 'error') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
        <div className="text-red-600 font-medium">{errorMsg}</div>
        <button
          onClick={reset}
          className="px-4 py-2 bg-slate-900 text-white rounded-md text-sm"
        >
          Try again
        </button>
      </div>
    );
  }

  if (phase === 'review' && graph) {
    return <ReviewScreen
      graph={graph}
      stepEdits={stepEdits} setStepEdits={(e) => { setSaved(false); setStepEdits(e); }}
      laneEdits={laneEdits} setLaneEdits={(e) => { setSaved(false); setLaneEdits(e); }}
      saving={saving} saved={saved}
      onSave={handleSaveReview}
      onReset={reset}
      tobeGraph={tobeGraph}
      setTobeGraph={setTobeGraph}
    />;
  }

  return null;
}

// ── Upload screen ─────────────────────────────────────────────────────────────

interface UploadScreenProps {
  domain: PiDomain; setDomain: (d: PiDomain) => void;
  file: File | null; setFile: (f: File | null) => void;
  dragOver: boolean; setDragOver: (v: boolean) => void;
  uploading: boolean;
  onUpload: () => void;
  onDrop: (e: React.DragEvent) => void;
  onFileInput: (e: React.ChangeEvent<HTMLInputElement>) => void;
  clientName?: string;
}

function UploadScreen(p: UploadScreenProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col gap-6 p-6 max-w-lg mx-auto mt-8">
      <div>
        <h2 className="text-sm font-semibold text-slate-800">Process Intelligence</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Upload a Visio swimlane diagram (.vsdx) or a process map image (.png, .jpg) to extract and review the process structure.
          {p.clientName && <span className="ml-1 text-slate-400">— {p.clientName}</span>}
        </p>
      </div>

      {/* Domain selector */}
      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">Workday domain</label>
        <select
          value={p.domain}
          onChange={e => p.setDomain(e.target.value as PiDomain)}
          className="w-full border border-slate-200 rounded-md text-sm px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
        >
          {DOMAINS.map(d => (
            <option key={d.value} value={d.value}>{d.label}</option>
          ))}
        </select>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); p.setDragOver(true); }}
        onDragLeave={() => p.setDragOver(false)}
        onDrop={e => { p.onDrop(e); }}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors
          ${p.dragOver ? 'border-slate-400 bg-slate-50' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".vsdx,.png,.jpg,.jpeg"
          className="hidden"
          onChange={p.onFileInput}
        />
        {p.file ? (
          <div className="flex flex-col items-center gap-2">
            <span className="text-2xl">{/\.(png|jpe?g)$/i.test(p.file.name) ? '🖼️' : '📊'}</span>
            <span className="text-sm font-medium text-slate-700">{p.file.name}</span>
            <span className="text-xs text-slate-400">{(p.file.size / 1024).toFixed(1)} KB</span>
            {/\.(png|jpe?g)$/i.test(p.file.name) && (
              <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded">
                Image mode — AI will read the diagram visually (lower confidence)
              </span>
            )}
            <button
              onClick={e => { e.stopPropagation(); p.setFile(null); }}
              className="text-xs text-slate-400 hover:text-slate-600 underline"
            >
              Remove
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-slate-400">
            <span className="text-3xl">⬆</span>
            <p className="text-sm">Drop a file here, or click to browse</p>
            <p className="text-xs">.vsdx Visio file · .png / .jpg image</p>
          </div>
        )}
      </div>

      <button
        onClick={p.onUpload}
        disabled={!p.file || p.uploading}
        className={`w-full py-2.5 rounded-md text-sm font-medium transition-colors
          ${p.file && !p.uploading
            ? 'bg-slate-900 text-white hover:bg-slate-700'
            : 'bg-slate-100 text-slate-400 cursor-not-allowed'
          }`}
      >
        {p.uploading ? 'Uploading…' : 'Upload & Parse'}
      </button>
    </div>
  );
}

// ── Parsing screen ────────────────────────────────────────────────────────────

function ParsingScreen({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
      <div className="w-8 h-8 border-2 border-slate-300 border-t-slate-800 rounded-full animate-spin" />
      <p className="text-sm text-slate-600">{message}</p>
      <p className="text-xs text-slate-400">This usually takes 15–30 seconds</p>
    </div>
  );
}

// ── Review screen ─────────────────────────────────────────────────────────────

interface ReviewScreenProps {
  graph: PiGraph;
  stepEdits: Record<string, Partial<PiStep>>;
  setStepEdits: (e: Record<string, Partial<PiStep>>) => void;
  laneEdits: Record<string, { label?: string; persona?: string }>;
  setLaneEdits: (e: Record<string, { label?: string; persona?: string }>) => void;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
  onReset: () => void;
  tobeGraph: PiTobeGraph | null;
  setTobeGraph: (g: PiTobeGraph | null) => void;
}

function piGraphToMapGraph(graph: PiGraph, edits: Record<string, Partial<PiStep>>): MapGraph {
  return {
    swimlanes: graph.swimlanes,
    steps: graph.steps.map(s => {
      const e = edits[s.step_id] ?? {};
      return {
        step_id: s.step_id,
        lane_id: (e.lane_id !== undefined ? e.lane_id : s.lane_id) ?? null,
        label: e.label ?? s.label,
        ai_opportunity: (e.ai_opportunity ?? s.ai_opportunity) ?? null,
        tooltip: s.ai_rationale ?? undefined,
      };
    }),
    connectors: graph.connectors.map(c => ({ from: c.from, to: c.to, condition: c.condition })),
  };
}

function tobeToMapGraph(tobe: PiTobeGraph): MapGraph {
  return {
    swimlanes: tobe.swimlanes,
    steps: tobe.steps.map(s => ({
      step_id: s.step_id,
      lane_id: s.lane_id ?? null,
      label: s.label,
      ai_opportunity: s.ai_opportunity ?? null,
      tooltip: s.transformation_note ?? undefined,
    })),
    connectors: tobe.connectors.map(c => ({ from: c.from, to: c.to, condition: c.condition })),
  };
}

function ReviewScreen(p: ReviewScreenProps) {
  const conf = p.graph.parse_confidence ?? 0;
  const confPct = Math.round(conf * 100);
  const warnings = p.graph.parse_warnings || [];
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [tobeLoading, setTobeLoading] = useState(false);
  const [tobeError, setTobeError] = useState('');

  async function handleGenerateTobe() {
    setTobeLoading(true);
    setTobeError('');
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

  function getStep(step: PiStep): PiStep {
    return { ...step, ...p.stepEdits[step.step_id] };
  }

  const laneMap = new Map(p.graph.swimlanes.map(l => [l.lane_id, l]));
  const stepsByLane = new Map<string, PiStep[]>();
  const unassigned: PiStep[] = [];
  for (const step of p.graph.steps) {
    if (step.lane_id && laneMap.has(step.lane_id)) {
      const arr = stepsByLane.get(step.lane_id) || [];
      arr.push(step);
      stepsByLane.set(step.lane_id, arr);
    } else {
      unassigned.push(step);
    }
  }

  const hasEdits = Object.keys(p.stepEdits).length > 0 || Object.keys(p.laneEdits).length > 0;
  const asIsGraph = piGraphToMapGraph(p.graph, p.stepEdits);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="shrink-0 px-4 py-2.5 border-b border-slate-100 bg-white flex items-center gap-3">
        <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-slate-800 truncate">{p.graph.source_name}</span>
          <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
            p.graph.parse_status === 'needs_review' ? 'bg-yellow-100 text-yellow-700' : 'bg-green-100 text-green-700'
          }`}>
            {p.graph.parse_status === 'needs_review' ? 'Needs review' : 'Ready'}
          </span>
          <span className="text-xs text-slate-400 capitalize">{p.graph.domain}</span>
          <span className="text-xs text-slate-400">·</span>
          <span className="text-xs text-slate-400">Confidence: {confPct}%</span>
          {warnings.length > 0 && (
            <span className="text-xs text-amber-600">· {warnings.length} warning{warnings.length !== 1 ? 's' : ''}</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {p.saved && <span className="text-xs text-green-600 font-medium">✓ Saved</span>}
          <button
            onClick={p.onSave}
            disabled={!hasEdits || p.saving || p.saved}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors
              ${hasEdits && !p.saving && !p.saved
                ? 'bg-slate-900 text-white hover:bg-slate-700'
                : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}
          >
            {p.saving ? 'Saving…' : 'Save corrections'}
          </button>
          <button
            onClick={handleGenerateTobe}
            disabled={tobeLoading}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors
              ${tobeLoading ? 'bg-teal-50 text-teal-400 cursor-not-allowed' : 'bg-teal-600 text-white hover:bg-teal-700'}`}
          >
            {tobeLoading ? 'Generating…' : p.tobeGraph ? '⚡ Regenerate To-Be' : '⚡ Generate To-Be Map'}
          </button>
          <button onClick={p.onReset} className="text-xs text-slate-400 hover:text-slate-600">New upload</button>
        </div>
      </div>

      {tobeError && (
        <div className="shrink-0 px-4 py-1.5 bg-red-50 border-b border-red-100 text-xs text-red-600">{tobeError}</div>
      )}

      {/* ── Body: two-panel split ───────────────────────────────────────────── */}
      <div className="flex-1 flex min-h-0 overflow-hidden">

        {/* Left panel: review table (collapsible) */}
        {!leftCollapsed && (
          <div className="w-80 shrink-0 flex flex-col border-r border-slate-100 min-h-0 overflow-hidden">
            {warnings.length > 0 && (
              <div className="shrink-0 px-3 py-2 bg-amber-50 border-b border-amber-100">
                <p className="text-xs text-amber-700 font-medium mb-0.5">
                  {warnings.length} item{warnings.length !== 1 ? 's' : ''} flagged
                </p>
                <ul className="text-xs text-amber-600 space-y-0.5">
                  {warnings.slice(0, 2).map((w, i) => (
                    <li key={i} className="truncate">{w.item_id}: {w.message}</li>
                  ))}
                  {warnings.length > 2 && <li>…and {warnings.length - 2} more</li>}
                </ul>
              </div>
            )}
            <div className="flex-1 min-h-0 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 z-10">
                  <tr className="border-b border-slate-200">
                    <th className="px-2 py-2 text-left font-medium text-slate-500">Step</th>
                    <th className="px-2 py-2 text-left font-medium text-slate-500 w-36">AI Opportunity</th>
                  </tr>
                </thead>
                <tbody>
                  {p.graph.swimlanes.map((lane, laneIdx) => {
                    const steps = stepsByLane.get(lane.lane_id) || [];
                    if (steps.length === 0) return null;
                    return (
                      <React.Fragment key={lane.lane_id}>
                        <tr className="bg-slate-50 border-t border-b border-slate-200">
                          <td colSpan={2} className="px-2 py-1.5">
                            <div className="flex items-center gap-1.5">
                              <span className={`w-2 h-2 rounded-full shrink-0 ${LANE_COLORS[laneIdx % LANE_COLORS.length]}`} />
                              <span className="font-semibold text-slate-700 truncate">{lane.label}</span>
                              {lane.persona && lane.persona !== lane.label && (
                                <span className="text-slate-400 truncate">· {lane.persona}</span>
                              )}
                            </div>
                          </td>
                        </tr>
                        {steps.map(rawStep => {
                          const step = getStep(rawStep);
                          const isWarned = warnings.some(w => w.item_id === step.step_id);
                          return (
                            <StepRow
                              key={step.step_id}
                              step={step}
                              isWarned={isWarned}
                              onLabelChange={v => patchStep(step.step_id, 'label', v)}
                              onAiChange={v => patchStep(step.step_id, 'ai_opportunity', v)}
                            />
                          );
                        })}
                      </React.Fragment>
                    );
                  })}
                  {unassigned.length > 0 && (
                    <>
                      <tr className="bg-slate-50 border-t border-b border-slate-200">
                        <td colSpan={2} className="px-2 py-1.5 text-slate-500 font-medium italic">Unassigned</td>
                      </tr>
                      {unassigned.map(rawStep => {
                        const step = getStep(rawStep);
                        return (
                          <StepRow
                            key={step.step_id}
                            step={step}
                            isWarned={false}
                            onLabelChange={v => patchStep(step.step_id, 'label', v)}
                            onAiChange={v => patchStep(step.step_id, 'ai_opportunity', v)}
                          />
                        );
                      })}
                    </>
                  )}
                </tbody>
              </table>
            </div>
            <div className="shrink-0 border-t border-slate-100 px-3 py-1.5 bg-slate-50">
              <p className="text-xs text-slate-400">
                {p.graph.steps.length} steps · {p.graph.swimlanes.length} lanes
              </p>
            </div>
          </div>
        )}

        {/* Collapse toggle strip */}
        <button
          onClick={() => setLeftCollapsed(v => !v)}
          title={leftCollapsed ? 'Show review table' : 'Hide review table'}
          className="shrink-0 w-5 flex items-center justify-center bg-slate-50 hover:bg-slate-100 border-r border-slate-200 text-slate-400 hover:text-slate-600 transition-colors"
        >
          <span className="text-xs select-none">{leftCollapsed ? '›' : '‹'}</span>
        </button>

        {/* Right panel: process maps stacked vertically */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col">

          {/* ── AS-IS section ──────────────────────────────────────────────── */}
          <div className="shrink-0">
            <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Current Process</span>
              <span className="text-xs text-slate-400">·</span>
              <span className="text-xs text-slate-400">{p.graph.source_name}</span>
            </div>
            <div className="p-4 overflow-x-auto">
              <ProcessMap graph={asIsGraph} />
            </div>
          </div>

          {/* ── Divider / transition ────────────────────────────────────────── */}
          {(p.tobeGraph || tobeLoading) && (
            <div className="shrink-0 flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-slate-100 to-teal-50 border-y border-slate-200">
              <div className="flex-1 h-px bg-slate-300" />
              <span className="text-xs font-semibold text-teal-700 uppercase tracking-wider whitespace-nowrap">
                ⚡ AI Transformation
              </span>
              <div className="flex-1 h-px bg-teal-300" />
            </div>
          )}

          {/* ── TO-BE section ──────────────────────────────────────────────── */}
          {tobeLoading && (
            <div className="shrink-0 flex flex-col items-center justify-center gap-3 py-16 text-slate-400">
              <span className="text-4xl animate-pulse">⚡</span>
              <p className="text-sm font-medium text-slate-600">Generating To-Be Process Map…</p>
              <p className="text-xs text-center max-w-xs">
                Analysing AI opportunities and redesigning your process for the Sana-enabled future state
              </p>
            </div>
          )}

          {!tobeLoading && p.tobeGraph && (
            <div className="shrink-0">
              {/* To-be header: summary + stats */}
              <div className="px-4 py-3 bg-teal-50 border-b border-teal-100">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-semibold text-teal-700 uppercase tracking-wider">To-Be Process</span>
                  <span className="text-xs text-teal-500">· AI-enabled future state</span>
                </div>
                {p.tobeGraph.transformation_summary && (
                  <p className="text-xs text-teal-800 leading-relaxed mb-2">{p.tobeGraph.transformation_summary}</p>
                )}
                {p.tobeGraph.ai_stats && (
                  <div className="flex flex-wrap gap-1.5">
                    {p.tobeGraph.ai_stats.steps_automated != null && (
                      <span className="px-2 py-0.5 rounded-full bg-teal-100 text-teal-800 text-xs font-medium">
                        ⚡ {p.tobeGraph.ai_stats.steps_automated} automated by Sana
                      </span>
                    )}
                    {p.tobeGraph.ai_stats.steps_assisted != null && (
                      <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 text-xs font-medium">
                        🤖 {p.tobeGraph.ai_stats.steps_assisted} AI-assisted
                      </span>
                    )}
                    {p.tobeGraph.ai_stats.steps_unchanged != null && (
                      <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs font-medium">
                        👤 {p.tobeGraph.ai_stats.steps_unchanged} human-only
                      </span>
                    )}
                    {p.tobeGraph.ai_stats.cycle_time_reduction_pct != null && (
                      <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-800 text-xs font-medium">
                        ⏱ ~{p.tobeGraph.ai_stats.cycle_time_reduction_pct}% cycle time reduction
                      </span>
                    )}
                  </div>
                )}
              </div>
              {/* Legend */}
              <div className="px-4 py-1.5 border-b border-slate-100 bg-white flex flex-wrap gap-2">
                {([
                  { key: 'sana_agent', label: '⚡ Sana Agent', c: 'bg-teal-100 text-teal-800' },
                  { key: 'workday_native', label: '🔄 Workday Native', c: 'bg-green-100 text-green-800' },
                  { key: 'partial_ai', label: '🤖 AI-Assisted', c: 'bg-amber-100 text-amber-800' },
                  { key: 'human_only', label: '👤 Human Only', c: 'bg-slate-100 text-slate-600' },
                ] as const).map(l => (
                  <span key={l.key} className={`px-2 py-0.5 rounded text-xs font-medium ${l.c}`}>{l.label}</span>
                ))}
                <span className="text-xs text-slate-400 ml-auto self-center">Hover steps for details</span>
              </div>
              {/* Map */}
              <div className="p-4 overflow-x-auto">
                <ProcessMap graph={tobeToMapGraph(p.tobeGraph)} />
              </div>
            </div>
          )}

          {!tobeLoading && !p.tobeGraph && (
            <div className="shrink-0 flex flex-col items-center justify-center gap-2 py-12 text-slate-300">
              <span className="text-2xl">⚡</span>
              <p className="text-xs">Click <strong className="text-slate-400">Generate To-Be Map</strong> to see the AI-enabled future state</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const LANE_COLORS = [
  'bg-blue-400', 'bg-green-400', 'bg-purple-400', 'bg-orange-400',
  'bg-pink-400', 'bg-teal-400', 'bg-red-400', 'bg-yellow-400',
];

function StepRow({ step, isWarned, onLabelChange, onAiChange }: {
  step: PiStep;
  isWarned: boolean;
  onLabelChange: (v: string) => void;
  onAiChange: (v: PiAiOpportunity) => void;
}) {
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft]     = useState(step.label);
  const confPct = Math.round(step.parse_confidence * 100);
  const opp = step.ai_opportunity;
  const oppMeta = opp ? AI_OPP_META[opp] : null;

  return (
    <tr className={`border-b border-slate-100 hover:bg-slate-50 ${isWarned ? 'bg-amber-50' : ''}`}>
      <td className="px-2 py-1.5">
        {editingLabel ? (
          <input
            autoFocus
            value={labelDraft}
            onChange={e => setLabelDraft(e.target.value)}
            onBlur={() => { setEditingLabel(false); onLabelChange(labelDraft); }}
            onKeyDown={e => { if (e.key === 'Enter') { setEditingLabel(false); onLabelChange(labelDraft); } }}
            className="w-full border border-slate-300 rounded px-1 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-slate-400"
          />
        ) : (
          <div>
            <div className="flex items-center gap-1">
              {isWarned && <span className="text-amber-500 shrink-0" title="Low confidence">!</span>}
              <span
                onClick={() => { setLabelDraft(step.label); setEditingLabel(true); }}
                className="cursor-pointer hover:underline text-slate-700 text-xs"
                title="Click to edit"
              >
                {step.label}
              </span>
            </div>
            {step.ai_rationale && (
              <p className="text-slate-400 mt-0.5 leading-snug" style={{ fontSize: '10px' }}>
                {step.ai_rationale}
              </p>
            )}
          </div>
        )}
      </td>
      <td className="px-2 py-1.5 w-36">
        <select
          value={opp || ''}
          onChange={e => { if (e.target.value) onAiChange(e.target.value as PiAiOpportunity); }}
          className={`w-full border rounded px-1 py-0.5 text-xs font-medium focus:outline-none cursor-pointer ${
            oppMeta ? oppMeta.colors : 'bg-slate-50 text-slate-400 border-slate-200'
          }`}
        >
          <option value="">—</option>
          {(Object.keys(AI_OPP_META) as PiAiOpportunity[]).map(k => (
            <option key={k} value={k}>{AI_OPP_META[k].label}</option>
          ))}
        </select>
        <div className="mt-0.5 text-right">
          <span className={`text-xs ${confPct >= 80 ? 'text-green-500' : confPct >= 60 ? 'text-amber-500' : 'text-red-500'}`}>
            {confPct}%
          </span>
        </div>
      </td>
    </tr>
  );
}
