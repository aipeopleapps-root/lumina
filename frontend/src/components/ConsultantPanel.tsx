import { useState, useEffect, useCallback, useRef } from 'react';
import { ingestDoc, analyzeDoc, deleteDoc, publishDoc, validateSow, generateTestScripts, generateStatusReport, api, type Finding, type AnalyzeResponse, type SowFinding, type SowValidateResponse, type StatusReportResponse, type StatusWorkstream } from '../lib/api';
import { FolderPicker } from './FolderPicker';
import { FileExplorer } from './FileExplorer';
import { PublishReviewModal } from './PublishReviewModal';
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
}

type Props = { role: string; tenantId: string };

function moduleFromPath(path: string): string {
  if (!path || path === '/') return 'unknown';
  return path.split('/').filter(Boolean)[0] || 'unknown';
}

function docTypeFromFile(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'xlsx' || ext === 'xlsm') return 'config-workbook';
  return 'document';
}

export default function ConsultantPanel({ role, tenantId }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [folderPath, setFolderPath] = useState('/');
  const [folderTemplate, setFolderTemplate] = useState<FolderTemplate | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [statusStep, setStatusStep] = useState<'idle' | 'uploading' | 'indexing' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [resultDocName, setResultDocName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [showUpload, setShowUpload] = useState(true);
  const [showResults, setShowResults] = useState(false);
  const [isSowUpload, setIsSowUpload] = useState(false);
  const [sowResult, setSowResult] = useState<SowValidateResponse | null>(null);
  const [validatingSow, setValidatingSow] = useState(false);
  const [pendingPublishDoc, setPendingPublishDoc] = useState<Document | null>(null);
  const [generateTestsDoc, setGenerateTestsDoc] = useState<Document | null>(null);
  const [statusReport, setStatusReport] = useState<StatusReportResponse | null>(null);
  const [generatingReport, setGeneratingReport] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    setFile(null);
    setFolderPath('/');

    Promise.all([
      api.get('/tenant/folder-structure'),
      api.get('/documents/list'),
    ]).then(([structData, docsData]) => {
      setFolderTemplate(structData.template ?? null);
      setDocuments(docsData.documents || []);
    }).catch(console.error).finally(() => setDocsLoading(false));
  }, [tenantId]);

  function handleFileDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) setFile(dropped);
  }

  async function onRun() {
    if (!file) return;
    setError(null);
    setResult(null);
    setResultDocName(null);

    try {
      setUploading(true);
      setStatusStep('uploading');
      const uploadUrl = await getPresignedUrl(file.name, tenantId);
      const putResp = await fetch(uploadUrl.url, {
        method: 'PUT',
        headers: { 'Content-Type': uploadUrl.content_type },
        body: file,
      });
      if (!putResp.ok) throw new Error(`S3 upload failed: ${putResp.status}`);

      setUploading(false);
      setStatusStep('indexing');
      const docId = crypto.randomUUID();
      await ingestDoc({
        s3_key: uploadUrl.key,
        doc_id: docId,
        doc_type: isSowUpload ? 'sow' : docTypeFromFile(file.name),
        source_name: file.name,
        module: moduleFromPath(folderPath),
        folder_path: folderPath,
      });

      setStatusStep('done');
      setFile(null);
      setIsSowUpload(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      loadDocuments();
    } catch (err: any) {
      setError(err.message || String(err));
      setStatusStep('error');
    } finally {
      setUploading(false);
    }
  }

  async function onAnalyse(doc: Document) {
    setError(null);
    setResult(null);
    setSowResult(null);
    setResultDocName(doc.source_name);
    setAnalyzing(true);
    setShowUpload(false);
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
    setShowUpload(false);
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
    setShowUpload(false);
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

  if (!canIngest) {
    return (
      <div className="text-sm text-slate-500 bg-slate-100 p-4 rounded border border-slate-200">
        Your role ({role}) does not have access to consultant insights.
      </div>
    );
  }

  const hasResults = analyzing || !!result;

  return (
    <>
    <div className="flex h-full min-h-0 overflow-hidden">

      {/* ── Panel 1: Upload (collapsible) ── */}
      {showUpload ? (
        <div className="w-[360px] flex-shrink-0 flex flex-col border-r border-slate-200 bg-white overflow-y-auto transition-all">
          {/* Header with collapse button */}
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Upload Document</h2>
              <p className="text-xs text-slate-400 mt-0.5">.xlsx · .xlsm · .pdf · .docx</p>
            </div>
            <button
              onClick={() => setShowUpload(false)}
              title="Hide upload panel"
              className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors text-sm"
            >
              ←
            </button>
          </div>

          <div className="p-5 space-y-4 flex-1">
            {/* Drop zone */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleFileDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`
                border-2 border-dashed rounded-xl px-5 py-7 text-center cursor-pointer transition-all
                ${dragging ? 'border-slate-400 bg-slate-50' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'}
                ${file ? 'border-green-300 bg-green-50' : ''}
              `}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xlsm,.pdf,.docx"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file ? (
                <div className="flex flex-col items-center gap-2">
                  <div className="w-9 h-9 bg-green-100 rounded-lg flex items-center justify-center">📄</div>
                  <div className="text-sm font-medium text-slate-800 break-all">{file.name}</div>
                  <div className="text-xs text-slate-400">{(file.size / 1024).toFixed(0)} KB</div>
                  <button
                    onClick={(e) => { e.stopPropagation(); setFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                    className="text-xs text-slate-400 hover:text-red-500"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <div className="w-9 h-9 bg-slate-100 rounded-lg flex items-center justify-center text-lg">📁</div>
                  <div className="text-sm text-slate-600">
                    <span className="font-medium text-slate-800">Drop a file</span> or click to browse
                  </div>
                </div>
              )}
            </div>

            {/* SOW toggle */}
            <label className="flex items-center gap-2.5 cursor-pointer select-none group">
              <div
                onClick={() => setIsSowUpload(v => !v)}
                className={`w-9 h-5 rounded-full transition-colors flex-shrink-0 ${isSowUpload ? 'bg-indigo-600' : 'bg-slate-200'}`}
              >
                <div className={`w-4 h-4 bg-white rounded-full shadow-sm mt-0.5 transition-transform ${isSowUpload ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
              </div>
              <div>
                <div className="text-xs font-medium text-slate-700">Statement of Work</div>
                <div className="text-xs text-slate-400">Enables SOW validation against project docs</div>
              </div>
            </label>

            {/* Upload button */}
            <button
              onClick={onRun}
              disabled={!file || uploading}
              className="w-full py-2.5 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {uploading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="inline-block w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  {statusStep === 'uploading' ? 'Uploading…' : 'Indexing…'}
                </span>
              ) : 'Upload'}
            </button>

            {uploading && (
              <div className="flex gap-1.5">
                {(['uploading', 'indexing'] as const).map((step, i) => {
                  const cur = statusStep === 'uploading' ? 0 : 1;
                  return (
                    <div key={step} className="flex items-center gap-1.5 flex-1">
                      <div className={`flex-1 h-1 rounded-full ${i < cur ? 'bg-slate-900' : i === cur ? 'bg-slate-400' : 'bg-slate-200'}`} />
                      {i < 1 && <span className="text-xs text-slate-300">›</span>}
                    </div>
                  );
                })}
              </div>
            )}

            {error && !analyzing && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                <p className="text-xs text-red-700">{error}</p>
              </div>
            )}

            {/* Folder picker — secondary, below the action */}
            {folderTemplate && (
              <div className="pt-2 border-t border-slate-100">
                <label className="block text-xs font-medium text-slate-500 mb-1.5">
                  Destination folder
                  {folderPath !== '/' && <span className="ml-2 font-normal text-slate-400">{folderPath}</span>}
                </label>
                <FolderPicker template={folderTemplate} selected={folderPath} onChange={setFolderPath} />
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Collapsed upload — thin strip with expand button */
        <div className="w-10 flex-shrink-0 flex flex-col items-center border-r border-slate-200 bg-white py-4 gap-3">
          <button
            onClick={() => setShowUpload(true)}
            title="Show upload panel"
            className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors text-sm"
          >
            →
          </button>
          <span className="text-xs text-slate-300 [writing-mode:vertical-rl] rotate-180 select-none tracking-wide mt-1">Upload</span>
        </div>
      )}

      {/* ── Panel 2: Document Library (always visible, fills space) ── */}
      <div className="flex-1 flex flex-col min-w-0 bg-slate-50 overflow-y-auto">
        <div className="px-5 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            {!showUpload && (
              <button
                onClick={() => setShowUpload(true)}
                className="text-xs text-slate-500 hover:text-slate-800 px-2.5 py-1 rounded-lg hover:bg-slate-100 border border-slate-200 transition-colors"
              >
                ＋ Upload
              </button>
            )}
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Document Library</h2>
              <p className="text-xs text-slate-400 mt-0.5">{documents.length} document{documents.length !== 1 ? 's' : ''}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onGenerateReport}
              disabled={generatingReport}
              className="flex items-center gap-1.5 text-xs font-medium text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-40 px-3 py-1.5 rounded-lg transition-colors"
            >
              {generatingReport
                ? <><span className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />Generating…</>
                : <>📊 Weekly Report</>}
            </button>
            <button
              onClick={loadDocuments}
              disabled={docsLoading}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800 disabled:opacity-40 px-2.5 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
            >
              <span className={docsLoading ? 'animate-spin inline-block' : ''}>↻</span>
              Refresh
            </button>
          </div>
        </div>

        <div className="p-5">
          {/* SOW documents banner */}
          {documents.filter(d => d.doc_type === 'sow').length > 0 && (
            <div className="mb-4 bg-indigo-50 border border-indigo-200 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-indigo-600 text-sm">📋</span>
                <span className="text-xs font-semibold text-indigo-800 uppercase tracking-wide">Statement of Work</span>
              </div>
              <div className="space-y-2">
                {documents.filter(d => d.doc_type === 'sow').map(doc => (
                  <div key={doc.doc_id} className="flex items-center justify-between gap-3 bg-white rounded-lg border border-indigo-100 px-3 py-2">
                    <span className="text-xs text-slate-700 font-medium truncate flex-1">{doc.source_name}</span>
                    <button
                      onClick={() => onValidateSow(doc)}
                      className="flex-shrink-0 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg px-3 py-1.5 transition-colors"
                    >
                      Validate SOW
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {documents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-12 h-12 bg-slate-100 rounded-2xl flex items-center justify-center text-2xl mb-3">📂</div>
              <p className="text-sm font-medium text-slate-600">No documents yet</p>
              <p className="text-xs text-slate-400 mt-1">Uploaded files will appear here</p>
            </div>
          ) : folderTemplate ? (
            <FileExplorer
              template={folderTemplate}
              documents={documents}
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
              onGenerateTests={(doc) => setGenerateTestsDoc(doc)}
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

      {/* ── Panel 3: Results (analysis or SOW validation) ── */}
      {(hasResults || showResults || validatingSow || sowResult || generatingReport || statusReport) && (
        <div className={`w-[480px] flex-shrink-0 flex flex-col border-l border-slate-200 bg-white overflow-y-auto transition-all ${showResults ? '' : 'hidden'}`}>
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                {statusReport || generatingReport ? 'Weekly Status Report'
                  : sowResult || validatingSow ? 'SOW Validation'
                  : 'AI Analysis'}
              </h2>
              {statusReport && <p className="text-xs text-violet-500 mt-0.5">Week ending {statusReport.week_ending}</p>}
              {resultDocName && !statusReport && <p className="text-xs text-indigo-500 mt-0.5 truncate max-w-[280px]">{resultDocName}</p>}
            </div>
            <button
              onClick={() => { setShowResults(false); setSowResult(null); setStatusReport(null); }}
              title="Hide results"
              className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors text-base leading-none"
            >
              ✕
            </button>
          </div>

          <div className="p-5 space-y-4">
            {(analyzing || validatingSow || generatingReport) ? (
              <div className="flex flex-col items-center justify-center py-16 gap-4">
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
      )}

      {/* Show results button when panel is hidden but results exist */}
      {!showResults && hasResults && !analyzing && (
        <div className="w-10 flex-shrink-0 flex flex-col items-center border-l border-slate-200 bg-white py-4 gap-3">
          <button
            onClick={() => setShowResults(true)}
            title="Show analysis results"
            className="w-7 h-7 flex items-center justify-center rounded-lg text-indigo-400 hover:text-indigo-700 hover:bg-indigo-50 transition-colors text-sm"
          >
            ←
          </button>
          <span className="text-xs text-slate-300 [writing-mode:vertical-rl] rotate-180 select-none tracking-wide mt-1">Analysis</span>
        </div>
      )}

    </div>

      {generateTestsDoc && (
        <GenerateTestsModal
          doc={generateTestsDoc}
          onClose={() => setGenerateTestsDoc(null)}
          onGenerated={() => { setGenerateTestsDoc(null); loadDocuments(); }}
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

function GenerateTestsModal({
  doc,
  onClose,
  onGenerated,
}: {
  doc: { doc_id: string; source_name: string };
  onClose: () => void;
  onGenerated: () => void;
}) {
  const [testType, setTestType] = useState<'sit' | 'uat' | 'both'>('both');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ name: string; count: number } | null>(null);

  async function onGenerate() {
    setError(null);
    setGenerating(true);
    try {
      const result = await generateTestScripts(doc.doc_id, testType);
      setSuccess({ name: result.source_name, count: result.test_count });
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-100">
          <h2 className="text-base font-semibold text-slate-900">Generate Test Scripts</h2>
          <p className="text-xs text-slate-500 mt-1 truncate">{doc.source_name}</p>
        </div>

        <div className="px-6 py-5 space-y-5">
          {!success ? (
            <>
              <div>
                <p className="text-xs font-medium text-slate-600 mb-3">Script type to generate</p>
                <div className="space-y-2">
                  {([
                    { value: 'both', label: 'SIT & UAT', desc: 'Full coverage — system integration and user acceptance tests' },
                    { value: 'sit',  label: 'SIT only',  desc: 'System integration tests — technical data flows and integrations' },
                    { value: 'uat',  label: 'UAT only',  desc: 'User acceptance tests — business process and user journey scenarios' },
                  ] as const).map(opt => (
                    <label key={opt.value} className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${testType === opt.value ? 'border-teal-500 bg-teal-50' : 'border-slate-200 hover:border-slate-300'}`}>
                      <input
                        type="radio"
                        name="testType"
                        value={opt.value}
                        checked={testType === opt.value}
                        onChange={() => setTestType(opt.value)}
                        className="mt-0.5 accent-teal-600"
                      />
                      <div>
                        <div className="text-sm font-medium text-slate-800">{opt.label}</div>
                        <div className="text-xs text-slate-400 mt-0.5">{opt.desc}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              <div className="bg-slate-50 rounded-xl px-4 py-3 text-xs text-slate-500 space-y-1">
                <p className="font-medium text-slate-700">What happens next</p>
                <p>• AI generates 8–15 test cases from your document</p>
                <p>• Test script is saved to the document library as a <span className="font-medium text-amber-600">Draft</span></p>
                <p>• Review it, then publish to make it client-visible</p>
              </div>

              {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
            </>
          ) : (
            <div className="text-center py-4 space-y-3">
              <div className="w-12 h-12 bg-teal-100 rounded-full flex items-center justify-center mx-auto text-2xl">✓</div>
              <div>
                <p className="text-sm font-semibold text-slate-900">{success.count} test cases generated</p>
                <p className="text-xs text-slate-500 mt-1">Saved as draft — find it in the document library</p>
              </div>
              <p className="text-xs text-slate-400 break-all">{success.name}</p>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2">
          <button
            onClick={success ? onGenerated : onClose}
            className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition-colors"
          >
            {success ? 'Close' : 'Cancel'}
          </button>
          {!success && (
            <button
              onClick={onGenerate}
              disabled={generating}
              className="px-4 py-2 text-sm font-medium text-white bg-teal-600 hover:bg-teal-700 rounded-lg disabled:opacity-50 transition-colors flex items-center gap-2"
            >
              {generating && <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
              {generating ? 'Generating…' : 'Generate'}
            </button>
          )}
        </div>
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

async function getPresignedUrl(
  filename: string,
  _tenantId: string
): Promise<{ url: string; key: string; content_type: string }> {
  return api.post('/upload-url', { filename });
}
