import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { analyzeDoc, deleteDoc, publishDoc, validateSow, generateTestScripts, getTestScriptJob, generateStatusReport, api, type Finding, type AnalyzeResponse, type SowFinding, type SowValidateResponse, type StatusReportResponse, type StatusWorkstream, type GenerateTestsResponse } from '../lib/api';
import { FileExplorer, type BulkAction } from './FileExplorer';
import { PublishReviewModal } from './PublishReviewModal';
import { UploadModal } from './UploadModal';
import { PolicyAdvisor } from './PolicyAdvisor';
import { ConsultantChat } from './ConsultantChat';
import { Toast } from './Toast';
import type { FolderTemplate } from './FolderTemplateSelector';

interface Document {
  doc_id: string;
  source_name: string;
  doc_type: string;
  module: string;
  chunk_count: number;
  uploaded_at: string;
  s3_key: string;
  folder_path: string;
  published?: boolean;
}

type Props = { role: string; tenantId: string; clientName?: string };

export default function ConsultantPanel({ role, tenantId, clientName }: Props) {
  const [folderTemplate, setFolderTemplate] = useState<FolderTemplate | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [resultDocName, setResultDocName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [sowResult, setSowResult] = useState<SowValidateResponse | null>(null);
  const [validatingSow, setValidatingSow] = useState(false);
  const [pendingPublishDoc, setPendingPublishDoc] = useState<Document | null>(null);
  const [showGenerateTests, setShowGenerateTests] = useState(false);
  const [selectedDocs, setSelectedDocs] = useState<Document[]>([]);
  const [selectionReset, setSelectionReset] = useState(0);
  const [selectionHint, setSelectionHint] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [statusReport, setStatusReport] = useState<StatusReportResponse | null>(null);
  const [generatingReport, setGeneratingReport] = useState(false);
  const [activeTab, setActiveTab] = useState<'documents' | 'coach' | 'policy'>('documents');
  const [toast, setToast] = useState<{ message: string; id: number } | null>(null);

  const canIngest = role === 'consultant' || role === 'admin';

  const loadDocuments = useCallback(() => {
    setDocsLoading(true);
    api.get('/documents/list')
      .then((data) => setDocuments(data.documents || []))
      .catch((err) => console.error('Failed to load documents:', err))
      .finally(() => setDocsLoading(false));
  }, [tenantId]);

  useEffect(() => {
    // Reset all per-client state when the active client changes
    setDocuments([]);
    setResult(null);
    setResultDocName(null);
    setError(null);
    setShowUploadModal(false);

    Promise.all([
      api.get('/tenant/folder-structure'),
      api.get('/documents/list'),
    ]).then(([structData, docsData]) => {
      setFolderTemplate(structData.template ?? null);
      setDocuments(docsData.documents || []);
    }).catch(console.error).finally(() => setDocsLoading(false));
  }, [tenantId]);

  async function onAnalyse(doc: Document) {
    setError(null);
    setResult(null);
    setSowResult(null);
    setResultDocName(doc.source_name);
    setAnalyzing(true);
    setShowResults(true);
    try {
      const out = await analyzeDoc(doc.doc_id, 'all');
      setResult(out);
    } catch (err: any) {
      setError(err.message || String(err));
      setResultDocName(null);
    } finally {
      setAnalyzing(false);
    }
  }

  async function onValidateSow(doc: Document) {
    setError(null);
    setResult(null);
    setSowResult(null);
    setResultDocName(doc.source_name);
    setValidatingSow(true);
    setShowResults(true);
    try {
      const out = await validateSow(doc.doc_id);
      setSowResult(out);
    } catch (err: any) {
      setError(err.message || String(err));
      setResultDocName(null);
    } finally {
      setValidatingSow(false);
    }
  }

  async function onGenerateReport() {
    setError(null);
    setResult(null);
    setSowResult(null);
    setStatusReport(null);
    setGeneratingReport(true);
    setShowResults(true);
    try {
      const out = await generateStatusReport();
      setStatusReport(out);
      loadDocuments();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setGeneratingReport(false);
    }
  }

  async function handleBulkAction(action: BulkAction, docs: Document[]) {
    switch (action) {
      case 'download':
        for (const doc of docs) {
          try {
            const r = await api.post('/documents/download-url', { s3_key: doc.s3_key });
            window.open(r.url, '_blank');
          } catch { /* skip failed */ }
        }
        break;

      case 'delete': {
        const names = docs.map(d => d.source_name).join('\n  • ');
        if (!confirm(`Delete ${docs.length} document${docs.length > 1 ? 's' : ''}?\n\n  • ${names}\n\nThis cannot be undone.`)) return;
        for (const doc of docs) {
          try { await deleteDoc(doc.doc_id); } catch { /* skip failed */ }
        }
        setSelectionReset(v => v + 1);
        loadDocuments();
        break;
      }

      case 'publish':
        for (const doc of docs.filter(d => !d.published)) {
          // Bulk publish skips the review modal — goes direct
          try { await publishDoc(doc.doc_id, true); } catch { /* skip failed */ }
        }
        loadDocuments();
        break;

      case 'unpublish':
        for (const doc of docs.filter(d => d.published)) {
          try { await publishDoc(doc.doc_id, false); } catch { /* skip failed */ }
        }
        loadDocuments();
        break;

      case 'analyse':
        // Run analysis sequentially; each result replaces the previous in the panel
        setShowResults(true);
        for (const doc of docs) {
          setError(null);
          setResult(null);
          setSowResult(null);
          setResultDocName(doc.source_name);
          setAnalyzing(true);
          try {
            const out = await analyzeDoc(doc.doc_id, 'all');
            setResult(out);
          } catch (err: any) {
            setError(err.message || String(err));
            setResultDocName(null);
          } finally {
            setAnalyzing(false);
          }
        }
        break;

    }
  }

  function showSelectHint() {
    setSelectionHint(true);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setSelectionHint(false), 2000);
  }

  if (!canIngest) {
    return (
      <div className="text-sm text-slate-500 bg-slate-100 p-4 rounded border border-slate-200">
        Your role ({role}) does not have access to consultant insights.
      </div>
    );
  }

  const hasResults = analyzing || !!result;
  const policyDocs = documents.filter(d => d.doc_type === 'hr_policy');

  return (
    <>
    <div className="flex flex-col h-full min-h-0 overflow-hidden">

      {/* ── Tab Toggle ── */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-slate-200 bg-white shrink-0">
        <button
          onClick={() => setActiveTab('documents')}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${activeTab === 'documents' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'}`}
        >
          Documents
        </button>
        <button
          onClick={() => setActiveTab('coach')}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${activeTab === 'coach' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'}`}
        >
          Coach
        </button>
        <button
          onClick={() => setActiveTab('policy')}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${activeTab === 'policy' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'}`}
        >
          PolicyBot
        </button>
        {clientName && (
          <div className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
            <span className="w-1.5 h-1.5 rounded-full bg-[#86BC25]" />
            <span className="font-medium text-slate-600">{clientName}</span>
          </div>
        )}
      </div>

      {activeTab === 'policy' ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <PolicyAdvisor policyDocs={policyDocs} clientName={clientName} />
        </div>
      ) : activeTab === 'coach' ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <ConsultantChat clientName={clientName} />
        </div>
      ) : (
      <div className="flex flex-1 min-h-0 overflow-hidden">

      {/* ── Document Library (fills available space) ── */}
      <div className="flex-1 flex flex-col min-w-0 bg-slate-50 overflow-y-auto">
        {/* ── Row 1: title + upload ── */}
        <div className="px-5 py-3.5 border-b border-slate-100 bg-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Document Library</h2>
              <p className="text-xs text-slate-400 mt-0.5">{documents.length} document{documents.length !== 1 ? 's' : ''}</p>
            </div>
            {canIngest && folderTemplate && (
              <button
                onClick={() => setShowUploadModal(true)}
                className="flex items-center gap-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-700 px-3 py-1.5 rounded-lg transition-colors"
              >
                ↑ Upload
              </button>
            )}
          </div>
          <button
            onClick={loadDocuments}
            disabled={docsLoading}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-700 disabled:opacity-40 px-2 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <span className={docsLoading ? 'animate-spin inline-block' : ''}>↻</span>
          </button>
        </div>

        {/* ── Row 2: persistent action toolbar ── */}
        <div className="px-5 py-2 border-b border-slate-200 bg-slate-50 flex items-center gap-2 shrink-0 flex-wrap">
          {/* Selection state label */}
          <div className="text-xs w-28 shrink-0">
            {selectedDocs.length > 0 ? (
              <span className="flex items-center gap-1.5 font-medium text-indigo-600">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" />
                {selectedDocs.length} selected
                <button onClick={() => setSelectionReset(v => v + 1)} className="text-indigo-400 hover:text-indigo-700 underline font-normal">Clear</button>
              </span>
            ) : selectionHint ? (
              <span className="text-amber-600 font-medium">Select docs first</span>
            ) : (
              <span className="text-slate-400">Select to use:</span>
            )}
          </div>

          {/* Bulk action buttons — always visible, state-aware styling */}
          {(() => {
            const sel = selectedDocs.length > 0;
            const base = 'px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors';
            const active = (color: string) => `${base} ${color}`;
            const idle = `${base} border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-600`;
            const act = (fn: () => void) => sel ? fn : showSelectHint;
            return (
              <>
                <button onClick={act(() => handleBulkAction('analyse', selectedDocs))}
                  className={sel ? active('border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100') : idle}>
                  🔍 Analyse
                </button>
                <button onClick={act(() => handleBulkAction('publish', selectedDocs))}
                  className={sel ? active('border-green-200 bg-green-50 text-green-700 hover:bg-green-100') : idle}>
                  ✓ Publish
                </button>
                <button onClick={act(() => handleBulkAction('unpublish', selectedDocs))}
                  className={sel ? active('border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100') : idle}>
                  ↩ Unpublish
                </button>
                <button onClick={act(() => handleBulkAction('download', selectedDocs))}
                  className={sel ? active('border-slate-300 bg-white text-slate-700 hover:bg-slate-50') : idle}>
                  ↓ Download
                </button>
                <button onClick={act(() => handleBulkAction('delete', selectedDocs))}
                  className={sel ? active('border-red-200 bg-red-50 text-red-600 hover:bg-red-100') : idle}>
                  ✕ Delete
                </button>
              </>
            );
          })()}

          {/* Divider */}
          <div className="h-4 w-px bg-slate-300 mx-1 shrink-0" />

          {/* AI generation — always active */}
          <button
            onClick={() => setShowGenerateTests(true)}
            disabled={documents.length === 0}
            className="flex items-center gap-1.5 text-xs font-medium text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-40 px-3 py-1 rounded-lg transition-colors"
          >
            ⚙ Generate Tests
          </button>
          <button
            onClick={onGenerateReport}
            disabled={generatingReport}
            className="flex items-center gap-1.5 text-xs font-medium text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-40 px-3 py-1 rounded-lg transition-colors"
          >
            {generatingReport
              ? <><span className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />Generating…</>
              : <>📊 Weekly Report</>}
          </button>
        </div>

        <div className="p-5">
          {documents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-12 h-12 bg-slate-100 rounded-2xl flex items-center justify-center text-2xl mb-3">📂</div>
              <p className="text-sm font-medium text-slate-600">No documents yet</p>
              <p className="text-xs text-slate-400 mt-2 max-w-[200px] leading-relaxed">Upload your first document to start analysing your Workday configuration</p>
              {canIngest && folderTemplate && (
                <button
                  onClick={() => setShowUploadModal(true)}
                  className="mt-4 flex items-center gap-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-700 px-3 py-2 rounded-lg transition-colors"
                >
                  ↑ Upload first document
                </button>
              )}
            </div>
          ) : folderTemplate ? (
            <FileExplorer
              template={folderTemplate}
              documents={documents}
              onSelectionChange={setSelectedDocs}
              selectionReset={selectionReset}
              onDownload={async (doc) => {
                try {
                  const r = await api.post('/documents/download-url', { s3_key: doc.s3_key });
                  window.open(r.url, '_blank');
                } catch { alert('Failed to download document'); }
              }}
              onDelete={async (doc) => {
                if (!confirm(`Delete "${doc.source_name}"? This cannot be undone.`)) return;
                try {
                  await deleteDoc(doc.doc_id);
                  loadDocuments();
                } catch { alert('Failed to delete document'); }
              }}
              onAnalyse={onAnalyse}
              onValidateSow={onValidateSow}
              onBulkAction={handleBulkAction}
              onPublish={(doc, published) => {
                if (published) {
                  setPendingPublishDoc(doc);
                } else {
                  publishDoc(doc.doc_id, false).then(loadDocuments).catch(() => alert('Failed to unpublish document'));
                }
              }}
            />
          ) : (
            <p className="text-xs text-slate-400">Loading folder structure…</p>
          )}
        </div>
      </div>

      {/* ── Panel 3: Results — always visible, placeholder when idle ── */}
      <div className={`w-[420px] flex-shrink-0 flex flex-col border-l border-slate-200 bg-white overflow-y-auto ${showResults ? '' : 'hidden'}`}>
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              {statusReport || generatingReport ? 'Weekly Status Report'
                : sowResult || validatingSow ? 'SOW Validation'
                : 'AI Analysis'}
            </h2>
            {statusReport && <p className="text-xs text-violet-500 mt-0.5">Week ending {statusReport.week_ending}</p>}
            {resultDocName && !statusReport && <p className="text-xs text-indigo-500 mt-0.5 truncate max-w-[240px]">{resultDocName}</p>}
          </div>
          <button
            onClick={() => { setShowResults(false); setSowResult(null); setStatusReport(null); setResult(null); setError(null); }}
            title="Close panel"
            className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors text-base leading-none"
          >
            ✕
          </button>
        </div>

        <div className="p-5 space-y-4 flex-1">
          {(analyzing || validatingSow || generatingReport) ? (
            <div className="flex flex-col items-center justify-center h-full gap-4 pb-8">
              <span className={`w-8 h-8 border-2 rounded-full animate-spin ${generatingReport ? 'border-violet-200 border-t-violet-600' : 'border-indigo-200 border-t-indigo-600'}`} />
              <div className="text-center">
                <p className="text-sm font-medium text-slate-700">
                  {validatingSow ? 'Validating against SOW…'
                    : generatingReport ? 'Generating status report…'
                    : 'Analysing document…'}
                </p>
                <p className="text-xs text-slate-400 mt-1">This may take 30–60 seconds</p>
              </div>
            </div>
          ) : sowResult ? (
              <>
                <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4">
                  <p className="text-xs font-medium text-indigo-600 uppercase tracking-wide mb-2">Executive Summary</p>
                  <p className="text-sm text-slate-700 leading-relaxed">{sowResult.summary}</p>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  {(['green', 'yellow', 'red'] as const).map(tl => {
                    const count = sowResult.findings.filter(f => f.traffic_light === tl).length;
                    const colours = { green: 'bg-green-100 text-green-700', yellow: 'bg-amber-100 text-amber-700', red: 'bg-red-100 text-red-700' };
                    const labels = { green: 'Evidenced', yellow: 'Partial', red: 'Gap' };
                    return (
                      <span key={tl} className={`px-2.5 py-1 rounded-full font-medium ${colours[tl]}`}>
                        {count} {labels[tl]}
                      </span>
                    );
                  })}
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
                    Deliverables <span className="text-slate-400 normal-case">({sowResult.findings.length})</span>
                  </p>
                  <div className="space-y-2">
                    {sowResult.findings.map((f, i) => <SowFindingCard key={i} f={f} />)}
                  </div>
                </div>
                <p className="text-xs text-slate-300 pt-2">Model: {sowResult.model_id}</p>
              </>
            ) : statusReport ? (
              <StatusReportPanel report={statusReport} />
            ) : result ? (
              <>
                <div className="bg-slate-50 rounded-xl p-4">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Summary</p>
                  <p className="text-sm text-slate-700 leading-relaxed">{result.summary}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
                    Findings <span className="text-slate-400 normal-case">({result.findings.length})</span>
                  </p>
                  <div className="space-y-2">
                    {result.findings.map((f, i) => (
                      <FindingCard key={i} f={f} />
                    ))}
                  </div>
                </div>
                <p className="text-xs text-slate-300 pt-2">Model: {result.model_id}</p>
              </>
            ) : error ? (
              <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
                <p className="text-sm font-medium text-red-700 mb-1">Analysis failed</p>
                <p className="text-xs text-red-600">{error}</p>
              </div>
            ) : null}
        </div>
      </div>

    </div>
    )}
    </div>

      {showUploadModal && folderTemplate && (
        <UploadModal
          template={folderTemplate}
          onClose={() => setShowUploadModal(false)}
          onUploaded={(msg) => { loadDocuments(); setToast({ message: msg, id: Date.now() }); }}
        />
      )}

      {toast && (
        <Toast
          key={toast.id}
          message={toast.message}
          type="success"
          onDismiss={() => setToast(null)}
        />
      )}

      {showGenerateTests && (
        <GenerateTestsModal
          documents={documents}
          onClose={() => setShowGenerateTests(false)}
          onGenerated={() => { setShowGenerateTests(false); loadDocuments(); }}
        />
      )}

      {pendingPublishDoc && (
        <PublishReviewModal
          doc={pendingPublishDoc}
          onConfirmPublish={async () => {
            try {
              await publishDoc(pendingPublishDoc!.doc_id, true);
              loadDocuments();
            } catch {
              alert('Failed to publish document');
            } finally {
              setPendingPublishDoc(null);
            }
          }}
          onCancel={() => setPendingPublishDoc(null)}
        />
      )}
    </>
  );
}

// ── Helpers for test generation modal ────────────────────────────────────────

function topCategory(doc: { doc_type: string; folder_path: string; module: string }): string {
  if (doc.folder_path && doc.folder_path !== '/') {
    const parts = doc.folder_path.replace(/^\//, '').split('/');
    if (parts[0]) return parts[0];
  }
  switch (doc.doc_type) {
    case 'sow':           return 'Statement of Work';
    case 'hr_policy':     return 'HR Policies & Knowledge';
    case 'config-workbook': return 'Configuration Workbooks';
    default:              return 'Other Documents';
  }
}

function isIntegrationDoc(doc: { module: string; folder_path: string; doc_type: string }): boolean {
  const m  = (doc.module      || '').toLowerCase();
  const fp = (doc.folder_path || '').toLowerCase();
  const dt = (doc.doc_type    || '').toLowerCase();
  return m.includes('integration') || fp.includes('integration') || dt.includes('integration');
}

// ── New multi-doc Generate Tests modal ───────────────────────────────────────

function GenerateTestsModal({
  documents,
  onClose,
  onGenerated,
}: {
  documents: Document[];
  onClose: () => void;
  onGenerated: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateTestsResponse | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!jobId) return;
    const currentJobId = jobId;
    let cancelled = false;

    function scheduleNextPoll() {
      pollRef.current = setTimeout(async () => {
        if (cancelled) return;
        try {
          const status = await getTestScriptJob(currentJobId);
          if (cancelled) return;
          if (status.status === 'done') {
            setResult({
              doc_id: status.doc_id!,
              source_name: status.source_name!,
              functional_count: status.functional_count ?? 0,
              integration_count: status.integration_count ?? 0,
              total_count: status.total_count ?? 0,
              test_type: status.test_type ?? 'functional',
              latency_ms: status.latency_ms ?? 0,
            });
            setGenerating(false);
            setJobId(null);
          } else if (status.status === 'error') {
            setError(status.error || 'Generation failed — please try again');
            setGenerating(false);
            setJobId(null);
          } else {
            scheduleNextPoll();
          }
        } catch (err: any) {
          if (!cancelled) {
            setError(err.message || 'Failed to check job status');
            setGenerating(false);
            setJobId(null);
          }
        }
      }, 3000);
    }

    scheduleNextPoll();
    return () => { cancelled = true; if (pollRef.current) clearTimeout(pollRef.current); };
  }, [jobId]);

  // Exclude generated/auto docs from picker
  const eligibleDocs = useMemo(() =>
    documents.filter(d => d.doc_type !== 'test-script' && d.doc_type !== 'status-report'),
    [documents]
  );

  // Group by category
  const grouped = useMemo(() => {
    const map = new Map<string, Document[]>();
    for (const doc of eligibleDocs) {
      const cat = topCategory(doc);
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(doc);
    }
    return map;
  }, [eligibleDocs]);

  const selectedDocs   = eligibleDocs.filter(d => selected.has(d.doc_id));
  const integrationSel = selectedDocs.filter(isIntegrationDoc);
  const functionalSel  = selectedDocs.filter(d => !isIntegrationDoc(d));
  const hasIntegration = integrationSel.length > 0;

  function toggle(docId: string) {
    setSelected(prev => { const n = new Set(prev); n.has(docId) ? n.delete(docId) : n.add(docId); return n; });
  }

  function toggleCategory(docs: Document[]) {
    const allOn = docs.every(d => selected.has(d.doc_id));
    setSelected(prev => {
      const n = new Set(prev);
      if (allOn) docs.forEach(d => n.delete(d.doc_id));
      else docs.forEach(d => n.add(d.doc_id));
      return n;
    });
  }

  function selectAll() {
    setSelected(new Set(eligibleDocs.map(d => d.doc_id)));
  }

  async function onGenerate() {
    setError(null);
    setGenerating(true);
    try {
      const r = await generateTestScripts([...selected]);
      if (r.status === 'processing' && r.job_id) {
        setJobId(r.job_id);
      } else if (r.status === 'done') {
        setResult({
          doc_id: r.doc_id!,
          source_name: r.source_name!,
          functional_count: r.functional_count ?? 0,
          integration_count: r.integration_count ?? 0,
          total_count: r.total_count ?? 0,
          test_type: r.test_type ?? 'functional',
          latency_ms: r.latency_ms ?? 0,
        });
        setGenerating(false);
      } else if (r.status === 'error') {
        setError(r.error || 'Generation failed');
        setGenerating(false);
      }
    } catch (err: any) {
      setError(err.message || String(err));
      setGenerating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl mx-4 flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Generate Test Scripts</h2>
            <p className="text-xs text-slate-400 mt-0.5">Select documents — functional and integration tests will be generated automatically</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors">✕</button>
        </div>

        {result ? (
          /* ── Success state ── */
          <div className="px-6 py-8 flex flex-col items-center gap-4 text-center">
            <div className="w-14 h-14 bg-teal-100 rounded-full flex items-center justify-center">
              <svg className="w-7 h-7 text-teal-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <p className="text-base font-semibold text-slate-900">Test scripts generated</p>
              <p className="text-xs text-slate-400 mt-1 max-w-xs">{result.source_name}</p>
            </div>
            <div className="flex gap-4 text-center">
              <div className="bg-slate-50 border border-slate-200 rounded-xl px-5 py-3">
                <div className="text-2xl font-bold text-slate-800">{result.functional_count}</div>
                <div className="text-xs text-slate-500 mt-0.5">Functional<br/>Scenario Tests</div>
              </div>
              {result.integration_count > 0 && (
                <div className="bg-teal-50 border border-teal-200 rounded-xl px-5 py-3">
                  <div className="text-2xl font-bold text-teal-700">{result.integration_count}</div>
                  <div className="text-xs text-teal-600 mt-0.5">Integration<br/>Tests</div>
                </div>
              )}
            </div>
            <p className="text-xs text-slate-400">Saved as draft — find it in Test Scripts and publish when ready.</p>
            <button
              onClick={onGenerated}
              className="px-5 py-2 text-sm font-medium text-white bg-teal-600 hover:bg-teal-700 rounded-lg transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            {/* ── Document picker ── */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
              {/* Select all shortcut */}
              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-500">{selected.size} of {eligibleDocs.length} documents selected</p>
                <button
                  onClick={selectAll}
                  className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                >
                  Select all
                </button>
              </div>

              {[...grouped.entries()].map(([cat, docs]) => {
                const allOn = docs.every(d => selected.has(d.doc_id));
                const someOn = docs.some(d => selected.has(d.doc_id));
                const hasIntDocs = docs.some(isIntegrationDoc);
                return (
                  <div key={cat} className="border border-slate-200 rounded-xl overflow-hidden">
                    {/* Category header */}
                    <button
                      onClick={() => toggleCategory(docs)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
                    >
                      <input
                        type="checkbox"
                        checked={allOn}
                        ref={el => { if (el) el.indeterminate = someOn && !allOn; }}
                        onChange={() => toggleCategory(docs)}
                        onClick={e => e.stopPropagation()}
                        className="w-3.5 h-3.5 rounded border-slate-300 accent-teal-600"
                      />
                      <span className="text-xs font-semibold text-slate-700 flex-1">{cat}</span>
                      {hasIntDocs && (
                        <span className="text-[10px] font-medium text-teal-700 bg-teal-100 border border-teal-200 px-1.5 py-0.5 rounded-full">
                          ⚡ Integration
                        </span>
                      )}
                      <span className="text-xs text-slate-400">{docs.length}</span>
                    </button>
                    {/* Doc rows */}
                    <div className="divide-y divide-slate-100">
                      {docs.map(doc => (
                        <label
                          key={doc.doc_id}
                          className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${selected.has(doc.doc_id) ? 'bg-teal-50' : 'hover:bg-slate-50'}`}
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(doc.doc_id)}
                            onChange={() => toggle(doc.doc_id)}
                            className="w-3.5 h-3.5 rounded border-slate-300 accent-teal-600 flex-shrink-0"
                          />
                          <span className="text-xs text-slate-700 flex-1 truncate">{doc.source_name}</span>
                          {isIntegrationDoc(doc) && (
                            <span className="text-[10px] text-teal-600 font-medium flex-shrink-0">⚡ Integration</span>
                          )}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}

              {eligibleDocs.length === 0 && (
                <div className="text-center py-8 text-sm text-slate-400">No documents available — upload documents first.</div>
              )}
            </div>

            {/* ── Generation summary + actions ── */}
            <div className="px-6 py-4 border-t border-slate-100 space-y-3 flex-shrink-0">
              {/* What will be generated */}
              {selectedDocs.length > 0 && (
                <div className="flex items-start gap-4 bg-slate-50 rounded-xl px-4 py-3">
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="w-2 h-2 rounded-full bg-indigo-500" />
                      <span className="text-slate-700 font-medium">Functional Scenario Tests</span>
                      <span className="text-slate-400">from {selectedDocs.length} doc{selectedDocs.length !== 1 ? 's' : ''}</span>
                    </div>
                    {hasIntegration && (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="w-2 h-2 rounded-full bg-teal-500" />
                        <span className="text-teal-700 font-medium">Integration Tests</span>
                        <span className="text-slate-400">from {integrationSel.length} integration doc{integrationSel.length !== 1 ? 's' : ''}</span>
                      </div>
                    )}
                    {!hasIntegration && (
                      <p className="text-xs text-slate-400 pl-4">Add Integration Design docs to also generate Integration Tests</p>
                    )}
                  </div>
                </div>
              )}

              {error && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
              )}

              <div className="flex justify-end gap-2">
                <button
                  onClick={onClose}
                  disabled={generating}
                  className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900 rounded-lg hover:bg-slate-100 disabled:opacity-40 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={onGenerate}
                  disabled={selected.size === 0 || generating}
                  className="px-4 py-2 text-sm font-medium text-white bg-teal-600 hover:bg-teal-700 rounded-lg disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {generating && <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                  {generating ? (jobId ? 'Generating… (this may take 60–90s)' : 'Starting…') : `Generate (${selected.size} doc${selected.size !== 1 ? 's' : ''})`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function FindingCard({ f }: { f: Finding }) {
  const [open, setOpen] = useState(false);
  const sevClass =
    f.severity === 'high' ? 'bg-red-100 text-red-700' :
    f.severity === 'medium' ? 'bg-amber-100 text-amber-700' :
    'bg-slate-100 text-slate-600';
  const catClass =
    f.category === 'risk' ? 'text-red-600' :
    f.category === 'anti-pattern' ? 'text-amber-600' :
    'text-teal-600';

  return (
    <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full text-left px-3 py-2.5 flex items-start gap-2 hover:bg-slate-50 transition-colors"
      >
        <span className={`mt-0.5 text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${sevClass}`}>
          {f.severity}
        </span>
        <span className="text-xs font-medium text-slate-800 flex-1 leading-snug">{f.title}</span>
        <span className={`text-xs flex-shrink-0 mt-0.5 ${catClass}`}>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 border-t border-slate-100">
          <p className="text-xs text-slate-600 pt-2 leading-relaxed">{f.detail}</p>
          {f.evidence && f.evidence.length > 0 && (
            <div className="bg-slate-50 border-l-2 border-slate-300 pl-2.5 py-1.5 rounded-r">
              {f.evidence.map((e, i) => (
                <p key={i} className="text-xs text-slate-500 font-mono whitespace-pre-wrap">{e}</p>
              ))}
            </div>
          )}
          <p className="text-xs text-slate-700">
            <span className="font-medium">Recommendation: </span>{f.recommendation}
          </p>
        </div>
      )}
    </div>
  );
}

function SowFindingCard({ f }: { f: SowFinding }) {
  const [open, setOpen] = useState(false);
  const tlDot: Record<string, string> = {
    green: 'bg-green-500',
    yellow: 'bg-amber-400',
    red: 'bg-red-500',
  };
  const tlLabel: Record<string, string> = {
    green: 'Evidenced',
    yellow: 'Partial',
    red: 'Gap',
  };
  const tlText: Record<string, string> = {
    green: 'text-green-700',
    yellow: 'text-amber-700',
    red: 'text-red-700',
  };

  return (
    <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full text-left px-3 py-2.5 flex items-start gap-2 hover:bg-slate-50 transition-colors"
      >
        <span className={`mt-1 w-2.5 h-2.5 rounded-full flex-shrink-0 ${tlDot[f.traffic_light] ?? 'bg-slate-400'}`} />
        <span className="text-xs font-medium text-slate-800 flex-1 leading-snug">{f.deliverable}</span>
        <span className={`text-xs flex-shrink-0 mt-0.5 font-medium ${tlText[f.traffic_light] ?? 'text-slate-500'}`}>
          {tlLabel[f.traffic_light]} {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 border-t border-slate-100">
          <p className="text-xs text-slate-600 pt-2 leading-relaxed">{f.detail}</p>
          {f.evidence && f.evidence.length > 0 && (
            <div className="bg-slate-50 border-l-2 border-slate-300 pl-2.5 py-1.5 rounded-r">
              {f.evidence.map((e, i) => (
                <p key={i} className="text-xs text-slate-500 font-mono whitespace-pre-wrap">{e}</p>
              ))}
            </div>
          )}
          <p className="text-xs text-slate-700">
            <span className="font-medium">Recommendation: </span>{f.recommendation}
          </p>
        </div>
      )}
    </div>
  );
}

function StatusReportPanel({ report }: { report: StatusReportResponse }) {
  const sc = {
    green:  { bg: 'bg-green-50',  border: 'border-green-200',  dot: 'bg-green-500',  text: 'text-green-700'  },
    yellow: { bg: 'bg-amber-50',  border: 'border-amber-200',  dot: 'bg-amber-400',  text: 'text-amber-700'  },
    red:    { bg: 'bg-red-50',    border: 'border-red-200',    dot: 'bg-red-500',    text: 'text-red-700'    },
  }[report.overall_status] ?? { bg: 'bg-amber-50', border: 'border-amber-200', dot: 'bg-amber-400', text: 'text-amber-700' };

  const statusLabel: Record<string, string> = { green: 'On Track', yellow: 'At Risk', red: 'Action Required' };

  return (
    <div className="space-y-5">
      {/* RAG Status + Exec Summary */}
      <div className={`rounded-xl border p-4 ${sc.bg} ${sc.border}`}>
        <div className="flex items-center gap-2 mb-3">
          <span className={`w-3 h-3 rounded-full flex-shrink-0 ${sc.dot}`} />
          <span className={`text-xs font-semibold uppercase tracking-wide ${sc.text}`}>
            {statusLabel[report.overall_status] ?? report.overall_status} — {report.overall_status_reason}
          </span>
        </div>
        <p className="text-sm text-slate-700 leading-relaxed">{report.exec_summary}</p>
      </div>

      {/* Highlights */}
      {report.highlights.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Highlights</p>
          <ul className="space-y-1.5">
            {report.highlights.map((h, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-violet-400 flex-shrink-0" />
                <span className="text-xs text-slate-700 leading-relaxed">{h}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Workstreams */}
      {report.workstreams.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
            Workstreams <span className="text-slate-400 normal-case font-normal">({report.workstreams.length})</span>
          </p>
          <div className="space-y-2">
            {report.workstreams.map((ws, i) => <WorkstreamCard key={i} ws={ws} />)}
          </div>
        </div>
      )}

      {/* Decisions Needed */}
      {report.decisions_needed.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Decisions Needed</p>
          <div className="space-y-2">
            {report.decisions_needed.map((d, i) => (
              <div key={i} className="border border-amber-200 bg-amber-50 rounded-lg px-3 py-2.5">
                <p className="text-xs font-medium text-slate-800 mb-1.5">{d.decision}</p>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                  <span>Owner: <span className="font-medium text-slate-700">{d.owner}</span></span>
                  <span>By: <span className="font-medium text-slate-700">{d.deadline}</span></span>
                </div>
                {d.impact_if_delayed && (
                  <p className="text-xs text-amber-700 mt-1.5">⚠ {d.impact_if_delayed}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Key Risks */}
      {report.key_risks.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Key Risks</p>
          <div className="space-y-2">
            {report.key_risks.map((r, i) => (
              <div key={i} className={`rounded-lg px-3 py-2.5 border ${r.severity === 'high' ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'}`}>
                <div className="flex items-start gap-2 mb-1">
                  <span className={`text-xs font-semibold px-1.5 py-0.5 rounded uppercase flex-shrink-0 ${r.severity === 'high' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                    {r.severity}
                  </span>
                  <span className="text-xs font-medium text-slate-800 leading-snug">{r.risk}</span>
                </div>
                <p className="text-xs text-slate-600 pl-0">Mitigation: {r.mitigation}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Upcoming Milestones */}
      {report.upcoming_milestones.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Upcoming Milestones</p>
          <div className="space-y-1.5">
            {report.upcoming_milestones.map((m, i) => {
              const icon = { on_track: '✓', at_risk: '⚠', delayed: '✗' }[m.status] ?? '→';
              const cls  = { on_track: 'text-green-600', at_risk: 'text-amber-600', delayed: 'text-red-600' }[m.status] ?? 'text-slate-500';
              return (
                <div key={i} className="flex items-center gap-2.5">
                  <span className={`text-sm font-bold flex-shrink-0 ${cls}`}>{icon}</span>
                  <span className="text-xs text-slate-700 flex-1">{m.milestone}</span>
                  <span className="text-xs text-slate-400 flex-shrink-0">{m.due}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Next Week Focus */}
      {report.next_week_focus.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Next Week Focus</p>
          <ul className="space-y-1.5">
            {report.next_week_focus.map((f, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="text-violet-400 text-xs mt-0.5 flex-shrink-0">→</span>
                <span className="text-xs text-slate-700">{f}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-slate-300 pt-2">Model: {report.model_id} · {report.latency_ms}ms</p>
    </div>
  );
}

function WorkstreamCard({ ws }: { ws: StatusWorkstream }) {
  const [open, setOpen] = useState(false);
  const dotColors: Record<string, string> = { green: 'bg-green-500', yellow: 'bg-amber-400', red: 'bg-red-500' };

  return (
    <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full text-left px-3 py-2.5 flex items-start gap-2 hover:bg-slate-50 transition-colors"
      >
        <span className={`mt-1 w-2.5 h-2.5 rounded-full flex-shrink-0 ${dotColors[ws.status] ?? 'bg-slate-400'}`} />
        <div className="flex-1 min-w-0">
          <span className="text-xs font-medium text-slate-800 leading-snug">{ws.name}</span>
          {!open && <p className="text-xs text-slate-400 mt-0.5 truncate">{ws.summary}</p>}
        </div>
        <span className="text-xs text-slate-400 flex-shrink-0 mt-0.5">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-slate-100 pt-2">
          <p className="text-xs text-slate-600 leading-relaxed">{ws.summary}</p>
          {ws.completed_this_week.length > 0 && (
            <div>
              <p className="text-xs font-medium text-slate-500 mb-1">Completed this week</p>
              <ul className="space-y-0.5">
                {ws.completed_this_week.map((item, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs text-slate-700">
                    <span className="text-green-500 mt-0.5 flex-shrink-0">✓</span>{item}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ws.in_progress.length > 0 && (
            <div>
              <p className="text-xs font-medium text-slate-500 mb-1">In progress</p>
              <ul className="space-y-0.5">
                {ws.in_progress.map((item, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs text-slate-700">
                    <span className="text-blue-400 mt-0.5 flex-shrink-0">→</span>{item}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ws.risks.length > 0 && (
            <div>
              <p className="text-xs font-medium text-slate-500 mb-1">Risks</p>
              <ul className="space-y-0.5">
                {ws.risks.map((risk, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs text-amber-700">
                    <span className="mt-0.5 flex-shrink-0">⚠</span>{risk}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ws.detail && (
            <p className="text-xs text-slate-500 leading-relaxed border-t border-slate-100 pt-2">{ws.detail}</p>
          )}
        </div>
      )}
    </div>
  );
}

