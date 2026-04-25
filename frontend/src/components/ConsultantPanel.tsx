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
  const [statusStep, setStatusStep] = useState<'idle' | 'uploading' | 'indexing' | 'analyzing' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
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

      setStatusStep('analyzing');
      setAnalyzing(true);
      const out = await analyzeDoc(docId, 'all');
      setResult(out);
      setStatusStep('done');
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      loadDocuments();
    } catch (err: any) {
      setError(err.message || String(err));
      setStatusStep('error');
    } finally {
      setUploading(false);
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

  const busy = uploading || analyzing;

  return (
    <div className="flex h-full min-h-0">
      {/* ── Left panel: Upload + Analysis ── */}
      <div className="w-[420px] flex-shrink-0 flex flex-col border-r border-slate-200 bg-white overflow-y-auto">
        <div className="p-6 border-b border-slate-100">
          <h2 className="text-base font-semibold text-slate-900 mb-0.5">Upload Document</h2>
          <p className="text-xs text-slate-500">Supports .xlsx · .xlsm · .pdf · .docx</p>
        </div>

        <div className="p-6 space-y-5">
          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleFileDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`
              relative border-2 border-dashed rounded-xl px-6 py-8 text-center cursor-pointer transition-all
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
                <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center text-lg">📄</div>
                <div className="text-sm font-medium text-slate-800 break-all">{file.name}</div>
                <div className="text-xs text-slate-400">{(file.size / 1024).toFixed(0)} KB</div>
                <button
                  onClick={(e) => { e.stopPropagation(); setFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                  className="text-xs text-slate-400 hover:text-red-500 mt-1"
                >
                  Remove
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <div className="w-10 h-10 bg-slate-100 rounded-lg flex items-center justify-center text-xl">📁</div>
                <div className="text-sm text-slate-600">
                  <span className="font-medium text-slate-800">Drop a file here</span> or click to browse
                </div>
                <div className="text-xs text-slate-400">.xlsx · .xlsm · .pdf · .docx</div>
              </div>
            )}
          </div>

          {/* Folder picker */}
          {folderTemplate && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-2">
                Destination folder
                {folderPath !== '/' && (
                  <span className="ml-2 font-normal text-slate-400">{folderPath}</span>
                )}
              </label>
              <FolderPicker
                template={folderTemplate}
                selected={folderPath}
                onChange={setFolderPath}
              />
            </div>
          )}

          {/* Upload button + progress */}
          <div>
            <button
              onClick={onRun}
              disabled={!file || busy}
              className="w-full py-2.5 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="inline-block w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  {statusStep === 'uploading' ? 'Uploading…' : statusStep === 'indexing' ? 'Indexing…' : 'Analysing…'}
                </span>
              ) : 'Upload & Analyse'}
            </button>

            {busy && (
              <div className="mt-3 flex items-center gap-2">
                {(['uploading', 'indexing', 'analyzing'] as const).map((step, i) => {
                  const stepOrder = { uploading: 0, indexing: 1, analyzing: 2 };
                  const currentOrder = stepOrder[statusStep as keyof typeof stepOrder] ?? -1;
                  const done = i < currentOrder;
                  const active = i === currentOrder;
                  return (
                    <div key={step} className="flex items-center gap-2 flex-1">
                      <div className={`flex-1 h-1 rounded-full transition-colors ${done ? 'bg-slate-900' : active ? 'bg-slate-400' : 'bg-slate-200'}`} />
                      {i < 2 && <div className={`text-xs ${done ? 'text-slate-700' : 'text-slate-300'}`}>›</div>}
                    </div>
                  );
                })}
              </div>
            )}
            {busy && (
              <p className="text-xs text-slate-400 mt-1.5 text-center capitalize">{statusStep}…</p>
            )}

            {error && (
              <div className="mt-3 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                <p className="text-xs text-red-700">{error}</p>
              </div>
            )}
          </div>
        </div>

        {/* Analysis results */}
        {result && (
          <div className="border-t border-slate-100 px-6 py-5 space-y-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-slate-900">Analysis Complete</h3>
                <span className="text-xs text-slate-400">{result.findings.length} findings</span>
              </div>
              <p className="text-sm text-slate-600 leading-relaxed">{result.summary}</p>
            </div>

            <div className="space-y-2">
              {result.findings.map((f, i) => (
                <FindingCard key={i} f={f} />
              ))}
            </div>

            <p className="text-xs text-slate-300">Model: {result.model_id}</p>
          </div>
        )}
      </div>

      {/* ── Right panel: Document Library ── */}
      <div className="flex-1 flex flex-col min-w-0 bg-slate-50 overflow-y-auto">
        <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Document Library</h2>
            <p className="text-xs text-slate-500 mt-0.5">{documents.length} document{documents.length !== 1 ? 's' : ''} uploaded</p>
          </div>
          <button
            onClick={loadDocuments}
            disabled={docsLoading}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800 disabled:opacity-40 transition-colors px-3 py-1.5 rounded-lg hover:bg-slate-100"
          >
            <span className={docsLoading ? 'animate-spin inline-block' : ''}>↻</span>
            Refresh
          </button>
        </div>

        <div className="p-6">
          {documents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="w-14 h-14 bg-slate-100 rounded-2xl flex items-center justify-center text-2xl mb-3">📂</div>
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
            />
          ) : (
            <p className="text-xs text-slate-400">Loading folder structure…</p>
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
