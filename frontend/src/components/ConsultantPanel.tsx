import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { ingestDoc, analyzeDoc, deleteDoc, api, type Finding, type AnalyzeResponse } from '../lib/api';
import { FolderPicker } from './FolderPicker';
import { FileExplorer } from './FileExplorer';
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canIngest = role === 'consultant' || role === 'admin';

  const loadDocuments = useCallback(() => {
    setDocsLoading(true);
    api.get('/documents/list')
      .then((data) => setDocuments(data.documents || []))
      .catch((err) => console.error('Failed to load documents:', err))
      .finally(() => setDocsLoading(false));
  }, []);

  useEffect(() => {
    Promise.all([
      api.get('/tenant/folder-structure'),
      api.get('/documents/list'),
    ]).then(([structData, docsData]) => {
      setFolderTemplate(structData.template ?? null);
      setDocuments(docsData.documents || []);
    }).catch(console.error).finally(() => setDocsLoading(false));
  }, [loadDocuments]);

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
        doc_type: docTypeFromFile(file.name),
        source_name: file.name,
        module: moduleFromPath(folderPath),
        folder_path: folderPath,
      });

      setStatusStep('done');
      setFile(null);
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

  if (!canIngest) {
    return (
      <div className="text-sm text-slate-500 bg-slate-100 p-4 rounded border border-slate-200">
        Your role ({role}) does not have access to consultant insights.
      </div>
    );
  }

  const hasResults = analyzing || !!result;

  return (
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

            {/* Folder picker */}
            {folderTemplate && (
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">
                  Destination folder
                  {folderPath !== '/' && <span className="ml-2 font-normal text-slate-400">{folderPath}</span>}
                </label>
                <FolderPicker template={folderTemplate} selected={folderPath} onChange={setFolderPath} />
              </div>
            )}

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
          <button
            onClick={loadDocuments}
            disabled={docsLoading}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800 disabled:opacity-40 px-2.5 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <span className={docsLoading ? 'animate-spin inline-block' : ''}>↻</span>
            Refresh
          </button>
        </div>

        <div className="p-5">
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
            />
          ) : (
            <p className="text-xs text-slate-400">Loading folder structure…</p>
          )}
        </div>
      </div>

      {/* ── Panel 3: Analysis Results (slides in from right) ── */}
      {(hasResults || showResults) && (
        <div className={`w-[400px] flex-shrink-0 flex flex-col border-l border-slate-200 bg-white overflow-y-auto transition-all ${showResults ? '' : 'hidden'}`}>
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">AI Analysis</h2>
              {resultDocName && <p className="text-xs text-indigo-500 mt-0.5 truncate max-w-[280px]">{resultDocName}</p>}
            </div>
            <button
              onClick={() => setShowResults(false)}
              title="Hide results"
              className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors text-base leading-none"
            >
              ✕
            </button>
          </div>

          <div className="p-5 space-y-4">
            {analyzing ? (
              <div className="flex flex-col items-center justify-center py-16 gap-4">
                <span className="w-8 h-8 border-2 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
                <div className="text-center">
                  <p className="text-sm font-medium text-slate-700">Analysing document…</p>
                  <p className="text-xs text-slate-400 mt-1">This may take 30–60 seconds</p>
                </div>
              </div>
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

async function getPresignedUrl(
  filename: string,
  _tenantId: string
): Promise<{ url: string; key: string; content_type: string }> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  const apiEndpoint = import.meta.env.VITE_API_ENDPOINT;
  const r = await fetch(`${apiEndpoint}/upload-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ filename }),
  });
  if (!r.ok) throw new Error(`Upload URL request failed: ${r.status}`);
  return r.json();
}
