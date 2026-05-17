import { useState, useRef } from 'react';
import { ingestDoc, api } from '../lib/api';
import type { FolderTemplate } from './FolderTemplateSelector';

// Keyword hints per folder type — only strong/distinctive patterns
const FOLDER_HINTS: [string, string[]][] = [
  ['Configuration Workbooks', ['config', 'workbook', 'wb_', '_wb.', 'hcm_wb', 'payroll_wb', 'benefit_wb']],
  ['Business Process Documents', ['bpd', '_bpd', 'business_process', 'process_flow', 'workflow_']],
  ['Integration Design', ['integration', 'interface_', 'api_', '_api.', 'connector_', 'middleware', 'idoc_', 'sftp_']],
  ['Test Scripts', ['_test_', 'test_case', 'testcase', 'uat_', 'sit_', '_uat.', '_sit.']],
  ['Statement of Work', ['sow_', '_sow.', 'statement_of_work', 'contract_', 'agreement_']],
  ['Training', ['training_', '_training', 'job_aid', 'jobaid', 'user_guide', 'quick_ref']],
  ['Data Migration', ['migration_', '_migration', 'cutover_', 'data_conv', 'legacy_data']],
  ['Project Management', ['status_report', 'project_plan', 'charter_', 'weekly_status']],
];

function detectMismatch(filename: string, selectedFolderName: string): string | null {
  const lower = filename.toLowerCase().replace(/[\s-]/g, '_');
  for (const [folderName, hints] of FOLDER_HINTS) {
    if (folderName === selectedFolderName) continue;
    if (hints.some(h => lower.includes(h))) return folderName;
  }
  return null;
}

function docTypeFromFolderName(folderName: string): string {
  const n = folderName.toLowerCase();
  if (n.includes('statement') || n.includes('sow')) return 'sow';
  if (n.includes('configuration') || n.includes('workbook')) return 'config-workbook';
  if (n.includes('test')) return 'test-script';
  return 'document';
}

interface Props {
  template: FolderTemplate;
  onClose: () => void;
  onUploaded: () => void;
}

export function UploadModal({ template, onClose, onUploaded }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [selectedSubfolder, setSelectedSubfolder] = useState('');
  const [mismatchWarning, setMismatchWarning] = useState<string | null>(null);
  const [confirmedMismatch, setConfirmedMismatch] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [statusStep, setStatusStep] = useState<'uploading' | 'indexing'>('uploading');
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedFolderObj = template.folders.find(f => f.name === selectedFolder);

  function handleFile(f: File) {
    setFile(f);
    setMismatchWarning(null);
    setConfirmedMismatch(false);
    if (selectedFolder) {
      const mismatch = detectMismatch(f.name, selectedFolder);
      if (mismatch) setMismatchWarning(mismatch);
    }
  }

  function handleFolderSelect(folderName: string) {
    setSelectedFolder(folderName);
    setSelectedSubfolder('');
    setMismatchWarning(null);
    setConfirmedMismatch(false);
    if (file) {
      const mismatch = detectMismatch(file.name, folderName);
      if (mismatch) setMismatchWarning(mismatch);
    }
  }

  async function handleUpload() {
    if (!file || !selectedFolder) return;
    setError(null);
    const folderPath = selectedSubfolder
      ? `/${selectedFolder}/${selectedSubfolder}`
      : `/${selectedFolder}`;

    try {
      setUploading(true);
      setStatusStep('uploading');
      const uploadUrl: { url: string; key: string; content_type: string } =
        await api.post('/upload-url', { filename: file.name });
      const putResp = await fetch(uploadUrl.url, {
        method: 'PUT',
        headers: { 'Content-Type': uploadUrl.content_type },
        body: file,
      });
      if (!putResp.ok) throw new Error(`Upload failed: ${putResp.status}`);

      setStatusStep('indexing');
      await ingestDoc({
        s3_key: uploadUrl.key,
        doc_id: crypto.randomUUID(),
        doc_type: docTypeFromFolderName(selectedFolder),
        source_name: file.name,
        module: selectedFolder,
        folder_path: folderPath,
      });
      onUploaded();
      onClose();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setUploading(false);
    }
  }

  const canUpload = !!file && !!selectedFolder && !uploading && (!mismatchWarning || confirmedMismatch);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Upload Document</h2>
            <p className="text-xs text-slate-400 mt-0.5">Tag your document to the right category</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Scrollable body */}
        <div className="px-6 py-5 space-y-6 overflow-y-auto flex-1">

          {/* Step 1: File */}
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2.5">
              1 — Select file
            </p>
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files[0];
                if (f) handleFile(f);
              }}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl px-5 py-5 cursor-pointer transition-all
                ${dragging ? 'border-indigo-400 bg-indigo-50'
                : file ? 'border-green-300 bg-green-50'
                : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'}`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xlsm,.pdf,.docx"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              />
              {file ? (
                <div className="flex items-center gap-3">
                  <span className="text-2xl flex-shrink-0">📄</span>
                  <div className="flex-1 min-w-0 text-left">
                    <p className="text-sm font-medium text-slate-800 truncate">{file.name}</p>
                    <p className="text-xs text-slate-400">{(file.size / 1024).toFixed(0)} KB</p>
                  </div>
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      setFile(null);
                      setMismatchWarning(null);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }}
                    className="text-xs text-slate-400 hover:text-red-500 flex-shrink-0 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-1.5 text-center">
                  <span className="text-3xl">📁</span>
                  <p className="text-sm text-slate-600">
                    <span className="font-medium text-slate-800">Drop a file</span> or click to browse
                  </p>
                  <p className="text-xs text-slate-400">.xlsx · .xlsm · .pdf · .docx</p>
                </div>
              )}
            </div>
          </div>

          {/* Step 2: Category */}
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2.5">
              2 — Tag to category
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {template.folders.map(folder => (
                <button
                  key={folder.id}
                  onClick={() => handleFolderSelect(folder.name)}
                  className={`flex items-start gap-2.5 px-3 py-3 rounded-xl border text-left transition-all ${
                    selectedFolder === folder.name
                      ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500'
                      : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  <span className="text-lg leading-none mt-0.5 flex-shrink-0">{folder.icon}</span>
                  <span className="text-xs font-medium text-slate-700 leading-snug">{folder.name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Step 3: Sub-folder */}
          {selectedFolderObj && selectedFolderObj.subfolders.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2.5">
                3 — Sub-folder{' '}
                <span className="text-slate-400 font-normal normal-case">(optional)</span>
              </p>
              <select
                value={selectedSubfolder}
                onChange={e => setSelectedSubfolder(e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">/{selectedFolder} (root)</option>
                {selectedFolderObj.subfolders.map(sf => (
                  <option key={sf.id} value={sf.name}>
                    /{selectedFolder}/{sf.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Mismatch warning */}
          {mismatchWarning && !confirmedMismatch && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3.5">
              <div className="flex items-start gap-2.5">
                <span className="text-amber-500 text-base flex-shrink-0 mt-0.5">⚠</span>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-amber-800 mb-1">Possible category mismatch</p>
                  <p className="text-xs text-amber-700 leading-relaxed">
                    The filename suggests this might be a{' '}
                    <span className="font-semibold">{mismatchWarning}</span> document, but
                    you've selected <span className="font-semibold">{selectedFolder}</span>.
                  </p>
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => { setMismatchWarning(null); handleFolderSelect(mismatchWarning); }}
                      className="px-3 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
                    >
                      Switch to {mismatchWarning}
                    </button>
                    <button
                      onClick={() => setConfirmedMismatch(true)}
                      className="px-3 py-1.5 text-xs font-medium bg-white border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 transition-colors"
                    >
                      Keep {selectedFolder}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Upload progress */}
          {uploading && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span className="w-3.5 h-3.5 border-2 border-indigo-200 border-t-indigo-600 rounded-full animate-spin flex-shrink-0" />
                {statusStep === 'uploading' ? 'Uploading to storage…' : 'Indexing document…'}
              </div>
              <div className="h-1 bg-slate-200 rounded-full overflow-hidden">
                <div
                  className={`h-full bg-indigo-500 rounded-full transition-all duration-700 ${
                    statusStep === 'uploading' ? 'w-1/3' : 'w-full'
                  }`}
                />
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3">
              <p className="text-xs text-red-700">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between flex-shrink-0">
          <p className="text-xs text-slate-400">
            {selectedFolder ? (
              <>
                Saving to{' '}
                <span className="font-medium text-slate-600">
                  {selectedSubfolder
                    ? `/${selectedFolder}/${selectedSubfolder}`
                    : `/${selectedFolder}`}
                </span>
              </>
            ) : (
              'Select a category above'
            )}
          </p>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={uploading}
              className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900 rounded-lg hover:bg-slate-100 disabled:opacity-40 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleUpload}
              disabled={!canUpload}
              className="px-5 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50 transition-colors flex items-center gap-2"
            >
              {uploading && (
                <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              )}
              {uploading
                ? statusStep === 'uploading' ? 'Uploading…' : 'Indexing…'
                : 'Upload'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
