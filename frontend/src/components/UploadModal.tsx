import { useState, useRef, useEffect } from 'react';
import { ingestDoc, api } from '../lib/api';
import { SectionIcon } from './SectionIcon';
import type { FolderTemplate } from './FolderTemplateSelector';

// ── Client name PII detection ─────────────────────────────────────────────────
// Add or remove company names here to control what triggers the upload warning.
const CLIENT_NAMES = [
  'Acme Corporation', 'Acme Corp',
  'GlobalBank', 'Global Bank',
  'Meridian Health',
  'United Tech Solutions', 'UTS',
];

async function extractFileText(file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  // Plain text: read directly
  if (ext === 'txt' || ext === 'md') {
    return new Promise(resolve => {
      const r = new FileReader();
      r.onload = e => resolve((e.target?.result as string) ?? '');
      r.onerror = () => resolve('');
      r.readAsText(file);
    });
  }
  // All other formats (PDF, DOCX, XLSX, VSDX…): binary ASCII scan.
  // PDFs store text as readable runs; DOCX/XLSX metadata is also scannable.
  // Limit to first 8 MB to keep the UI responsive.
  return new Promise(resolve => {
    const r = new FileReader();
    r.onload = e => {
      const buf = e.target?.result as ArrayBuffer;
      if (!buf) { resolve(''); return; }
      const bytes = new Uint8Array(buf, 0, Math.min(buf.byteLength, 8_000_000));
      const parts: string[] = [];
      let run = '';
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b >= 0x20 && b < 0x7F) {
          run += String.fromCharCode(b);
        } else {
          if (run.length >= 4) parts.push(run);
          run = '';
        }
      }
      if (run.length >= 4) parts.push(run);
      resolve(parts.join(' '));
    };
    r.onerror = () => resolve('');
    r.readAsArrayBuffer(file);
  });
}

async function scanForClientNames(
  fileList: File[],
): Promise<{ file: string; names: string[] }[]> {
  const hits: { file: string; names: string[] }[] = [];
  for (const file of fileList) {
    const text = await extractFileText(file);
    const found = CLIENT_NAMES.filter(name =>
      new RegExp(
        `\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
        'i',
      ).test(text),
    );
    if (found.length > 0) hits.push({ file: file.name, names: found });
  }
  return hits;
}

// ── Keyword hints per category name — only strong/distinctive patterns
const FOLDER_HINTS: [string, string[]][] = [
  ['Process Diagrams', ['vsdx', 'visio', 'process_map', 'swimlane', 'flow_diagram']],
  ['Configuration Workbooks', ['config', 'workbook', 'wb_', '_wb.', 'hcm_wb', 'payroll_wb', 'benefit_wb']],
  ['Business Process Documents', ['bpd', '_bpd', 'business_process', 'process_flow', 'workflow_']],
  ['Integration Design', ['integration', 'interface_', 'api_', '_api.', 'connector_', 'middleware', 'idoc_', 'sftp_']],
  ['Test Scripts', ['_test_', 'test_case', 'testcase', 'uat_', 'sit_', '_uat.', '_sit.']],
  ['Statement of Work', ['sow_', '_sow.', 'statement_of_work', 'contract_', 'agreement_']],
  ['Training', ['training_', '_training', 'job_aid', 'jobaid', 'user_guide', 'quick_ref']],
  ['Data Migration', ['migration_', '_migration', 'cutover_', 'data_conv', 'legacy_data']],
  ['Project Management', ['status_report', 'project_plan', 'charter_', 'weekly_status']],
  ['Status Reports', ['status_report', 'weekly_status', 'weekly_report']],
];

function detectMismatch(filename: string, selectedName: string): string | null {
  const lower = filename.toLowerCase().replace(/[\s-]/g, '_');
  for (const [catName, hints] of FOLDER_HINTS) {
    if (catName === selectedName) continue;
    if (hints.some(h => lower.includes(h))) return catName;
  }
  return null;
}

// Virtual categories that always appear, with explicit doc_type
const VIRTUAL_CATEGORIES = [
  { id: 'sow',             name: 'Statement of Work',      docType: 'sow',             subfolders: [] as {id:string;name:string}[] },
  {
    id: 'process-diagram',
    name: 'Process Diagrams',
    docType: 'process-diagram',
    subfolders: [
      { id: 'hcm',          name: 'HCM & Core HR' },
      { id: 'payroll',      name: 'Payroll' },
      { id: 'talent',       name: 'Talent & Performance' },
      { id: 'recruiting',   name: 'Recruiting' },
      { id: 'integrations', name: 'Integrations' },
    ] as {id:string;name:string}[],
  },
  { id: 'test-script',     name: 'Test Scripts',           docType: 'test-script',     subfolders: [] as {id:string;name:string}[] },
  { id: 'status-report',   name: 'Status Reports',         docType: 'status-report',   subfolders: [] as {id:string;name:string}[] },
  {
    id: 'hr_policy',
    name: 'HR Policies & Knowledge',
    docType: 'hr_policy',
    subfolders: [
      { id: 'leave',       name: 'Leave & Time Off' },
      { id: 'remote',      name: 'Remote Work & Flexible Working' },
      { id: 'benefits',    name: 'Benefits & Compensation' },
      { id: 'conduct',     name: 'Code of Conduct & Ethics' },
      { id: 'learning',    name: 'Learning & Development' },
      { id: 'performance', name: 'Performance Management' },
      { id: 'general',     name: 'General HR' },
    ],
  },
];

const VIRTUAL_NAMES = new Set<string>(VIRTUAL_CATEGORIES.map(c => c.name));

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  'Statement of Work':       'Contracts and scoped deliverable agreements',
  'Process Diagrams':        'Visio files, process flows, and workflow images — used for Process Intelligence (.vsdx, .png, .jpg)',
  'Test Scripts':            'SIT / UAT test cases and scenario scripts',
  'Status Reports':          'Weekly or milestone project status updates',
  'HR Policies & Knowledge': 'Company policies, handbooks, and HR guidance',
  'Configuration Workbooks': 'Workday configuration workbooks (.xlsx / .xlsm)',
  'Business Process Documents': 'BPDs, process flows, and workflow designs',
  'Integration Design':      'Integration specs, API docs, and middleware designs',
  'Training':                'Job aids, user guides, and training materials',
  'Data Migration':          'Data conversion and cutover planning docs',
  'Project Management':      'Project plans, charters, and governance docs',
};

function docTypeFromFolderName(folderName: string): string {
  const n = folderName.toLowerCase();
  if (n.includes('configuration') || n.includes('workbook')) return 'config-workbook';
  if (n.includes('test')) return 'test-script';
  if (n.includes('status') || n.includes('report')) return 'status-report';
  return 'document';
}

interface Category {
  id: string;
  name: string;
  docType: string;
  subfolders: readonly { id: string; name: string }[] | { id: string; name: string }[];
}

interface Props {
  template: FolderTemplate;
  onClose: () => void;
  onUploaded: (message: string) => void;
}

export function UploadModal({ template, onClose, onUploaded }: Props) {
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<Category | null>(null);
  const [selectedSubfolder, setSelectedSubfolder] = useState('');
  const [mismatchWarning, setMismatchWarning] = useState<string | null>(null);
  const [confirmedMismatch, setConfirmedMismatch] = useState(false);
  const [clientNameHits, setClientNameHits] = useState<{ file: string; names: string[] }[]>([]);
  const [confirmedClientNames, setConfirmedClientNames] = useState(false);
  const [scanningNames, setScanningNames] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number; current: string; step: 'uploading' | 'indexing' } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Scan for client names whenever the file list changes
  useEffect(() => {
    if (files.length === 0) {
      setClientNameHits([]);
      setConfirmedClientNames(false);
      return;
    }
    setScanningNames(true);
    setConfirmedClientNames(false);
    scanForClientNames(files).then(hits => {
      setClientNameHits(hits);
      setScanningNames(false);
    });
  }, [files]);

  // Build unified category list: SOW + Process Diagrams first, then template folders, then the rest
  const allCategories: Category[] = [
    ...VIRTUAL_CATEGORIES.slice(0, 2).map(c => ({ ...c })),
    ...template.folders
      .filter(f => !VIRTUAL_NAMES.has(f.name))
      .map(f => ({
        id: f.id,
        name: f.name,
        docType: docTypeFromFolderName(f.name),
        subfolders: f.subfolders,
      })),
    ...VIRTUAL_CATEGORIES.slice(2).map(c => ({ ...c })),
  ];

  const DIAGRAM_EXTS = new Set(['.vsdx', '.png', '.jpg', '.jpeg']);
  const DOC_EXTS     = new Set(['.xlsx', '.xlsm', '.pdf', '.docx', '.txt', '.md']);

  function addFiles(incoming: File[]) {
    const isDiagramCat = selected?.docType === 'process-diagram';
    const allowed = incoming.filter(f => {
      const ext = '.' + f.name.split('.').pop()!.toLowerCase();
      return isDiagramCat ? DIAGRAM_EXTS.has(ext) : DOC_EXTS.has(ext);
    });
    const merged = [...files];
    for (const f of allowed) {
      if (!merged.find(x => x.name === f.name && x.size === f.size)) merged.push(f);
    }
    setFiles(merged);
    setMismatchWarning(null);
    setConfirmedMismatch(false);
    if (selected && merged.length === 1) {
      const mismatch = detectMismatch(merged[0].name, selected.name);
      if (mismatch) setMismatchWarning(mismatch);
    }
  }

  function removeFile(idx: number) {
    setFiles(prev => prev.filter((_, i) => i !== idx));
    setMismatchWarning(null);
    setConfirmedMismatch(false);
  }

  function handleCategorySelect(cat: Category) {
    setSelected(cat);
    setSelectedSubfolder('');
    setMismatchWarning(null);
    setConfirmedMismatch(false);
    if (files.length === 1) {
      const mismatch = detectMismatch(files[0].name, cat.name);
      if (mismatch) setMismatchWarning(mismatch);
    }
  }

  function switchToCategory(name: string) {
    const cat = allCategories.find(c => c.name === name);
    if (cat) handleCategorySelect(cat);
    setMismatchWarning(null);
  }

  async function handleUpload() {
    if (!files.length || !selected) return;
    setError(null);
    const folderPath = selectedSubfolder
      ? `/${selected.name}/${selectedSubfolder}`
      : `/${selected.name}`;

    try {
      setUploading(true);
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setUploadProgress({ done: i, total: files.length, current: file.name, step: 'uploading' });
        const uploadUrl: { url: string; key: string; content_type: string } =
          await api.post('/upload-url', { filename: file.name });
        const putResp = await fetch(uploadUrl.url, {
          method: 'PUT',
          headers: { 'Content-Type': uploadUrl.content_type },
          body: file,
        });
        if (!putResp.ok) throw new Error(`Upload failed for ${file.name}: ${putResp.status}`);

        setUploadProgress({ done: i, total: files.length, current: file.name, step: 'indexing' });
        await ingestDoc({
          s3_key: uploadUrl.key,
          doc_id: crypto.randomUUID(),
          doc_type: selected.docType,
          source_name: file.name,
          module: selected.name,
          folder_path: folderPath,
        });
      }
      setUploadProgress(null);
      const n = files.length;
      onUploaded(`${n} file${n > 1 ? 's' : ''} uploaded and indexed successfully`);
      onClose();
    } catch (err: any) {
      setError(err.message || String(err));
      setUploadProgress(null);
    } finally {
      setUploading(false);
    }
  }

  const canUpload =
    files.length > 0 &&
    !!selected &&
    !uploading &&
    !scanningNames &&
    (!mismatchWarning || confirmedMismatch) &&
    (clientNameHits.length === 0 || confirmedClientNames);

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
            <h2 className="text-base font-semibold text-slate-900">Upload Documents</h2>
            <p className="text-xs text-slate-400 mt-0.5">Drop multiple files and tag them to a category</p>
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
                addFiles(Array.from(e.dataTransfer.files));
              }}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl px-5 py-5 cursor-pointer transition-all
                ${dragging ? 'border-indigo-400 bg-indigo-50'
                : files.length ? 'border-slate-300 bg-slate-50'
                : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'}`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept={selected?.docType === 'process-diagram'
                  ? '.vsdx,.png,.jpg,.jpeg'
                  : '.xlsx,.xlsm,.pdf,.docx,.txt,.md'}
                multiple
                className="hidden"
                onChange={e => {
                  if (e.target.files?.length) addFiles(Array.from(e.target.files));
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
              />
              <div className="flex flex-col items-center gap-2 text-center">
                <div className="w-10 h-10 bg-slate-100 rounded-xl flex items-center justify-center">
                  <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                  </svg>
                </div>
                <p className="text-sm text-slate-600">
                  <span className="font-medium text-slate-800">Drop files</span> or click to browse
                </p>
                <p className="text-xs text-slate-400">
                  {selected?.docType === 'process-diagram'
                    ? '.vsdx · .png · .jpg · .jpeg'
                    : '.xlsx · .xlsm · .pdf · .docx · .txt · .md'}
                </p>
              </div>
            </div>

            {/* File list */}
            {files.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {files.map((f, i) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-2 bg-white border border-slate-200 rounded-lg">
                    <svg className="w-4 h-4 text-slate-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                    </svg>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-slate-800 truncate">{f.name}</p>
                      <p className="text-xs text-slate-400">{(f.size / 1024).toFixed(0)} KB</p>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); removeFile(i); }}
                      className="text-slate-300 hover:text-red-500 flex-shrink-0 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Step 2: Category */}
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2.5">
              2 — Tag to category
            </p>
            <div className="grid grid-cols-2 gap-2">
              {allCategories.map(cat => (
                <button
                  key={cat.id}
                  onClick={() => handleCategorySelect(cat)}
                  className={`flex items-start gap-2.5 px-3 py-3 rounded-xl border text-left transition-all ${
                    selected?.id === cat.id
                      ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500'
                      : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  <SectionIcon name={cat.name} className={`w-4 h-4 flex-shrink-0 mt-0.5 ${selected?.id === cat.id ? 'text-indigo-500' : 'text-slate-400'}`} />
                  <div className="min-w-0">
                    <div className={`text-xs font-semibold leading-snug ${selected?.id === cat.id ? 'text-indigo-700' : 'text-slate-700'}`}>
                      {cat.name}
                    </div>
                    {CATEGORY_DESCRIPTIONS[cat.name] && (
                      <div className={`text-[11px] leading-snug mt-0.5 ${selected?.id === cat.id ? 'text-indigo-400' : 'text-slate-400'}`}>
                        {CATEGORY_DESCRIPTIONS[cat.name]}
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Step 3: Sub-folder */}
          {selected && selected.subfolders.length > 0 && (
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
                <option value="">/{selected.name} (root)</option>
                {selected.subfolders.map(sf => (
                  <option key={sf.id} value={sf.name}>
                    /{selected.name}/{sf.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Scanning indicator */}
          {scanningNames && (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className="w-3 h-3 border-2 border-slate-200 border-t-slate-500 rounded-full animate-spin flex-shrink-0" />
              Checking for client names…
            </div>
          )}

          {/* Client name PII warning */}
          {!scanningNames && clientNameHits.length > 0 && (
            <div className="bg-orange-50 border border-orange-200 rounded-xl px-4 py-4">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-orange-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                </svg>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-orange-900 mb-1">
                    Client names detected
                  </p>
                  <p className="text-xs text-orange-700 leading-relaxed mb-3">
                    The following files appear to contain confidential client information.
                    Make sure you are authorised to upload them to this platform.
                  </p>
                  <ul className="space-y-1.5 mb-4">
                    {clientNameHits.map(hit => (
                      <li key={hit.file} className="text-xs">
                        <span className="font-medium text-orange-900 truncate block">{hit.file}</span>
                        <span className="text-orange-600">
                          Found: {hit.names.map(n => `"${n}"`).join(', ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <label className="flex items-start gap-2.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={confirmedClientNames}
                      onChange={e => setConfirmedClientNames(e.target.checked)}
                      className="mt-0.5 w-4 h-4 rounded border-orange-300 text-orange-600 focus:ring-orange-500 cursor-pointer flex-shrink-0"
                    />
                    <span className="text-xs text-orange-800 leading-relaxed">
                      I confirm this document may contain client information and I am authorised
                      to upload it to this platform.
                    </span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* Mismatch warning */}
          {mismatchWarning && !confirmedMismatch && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3.5">
              <div className="flex items-start gap-2.5">
                <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                </svg>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-amber-800 mb-1">Possible category mismatch</p>
                  <p className="text-xs text-amber-700 leading-relaxed">
                    The filename suggests this might be a{' '}
                    <span className="font-semibold">{mismatchWarning}</span> document, but
                    you've selected <span className="font-semibold">{selected?.name}</span>.
                  </p>
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => switchToCategory(mismatchWarning)}
                      className="px-3 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
                    >
                      Switch to {mismatchWarning}
                    </button>
                    <button
                      onClick={() => setConfirmedMismatch(true)}
                      className="px-3 py-1.5 text-xs font-medium bg-white border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 transition-colors"
                    >
                      Keep {selected?.name}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Upload progress */}
          {uploadProgress && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span className="w-3.5 h-3.5 border-2 border-indigo-200 border-t-indigo-600 rounded-full animate-spin flex-shrink-0" />
                <span className="truncate">
                  {uploadProgress.step === 'uploading' ? 'Uploading' : 'Indexing'}{' '}
                  <span className="font-medium text-slate-700">{uploadProgress.current}</span>
                  {uploadProgress.total > 1 && (
                    <span className="text-slate-400"> ({uploadProgress.done + 1}/{uploadProgress.total})</span>
                  )}
                </span>
              </div>
              <div className="h-1 bg-slate-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                  style={{ width: `${Math.round(((uploadProgress.done + (uploadProgress.step === 'indexing' ? 0.5 : 0)) / uploadProgress.total) * 100)}%` }}
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
            {selected ? (
              <>
                {files.length > 0 && <span className="font-medium text-slate-600">{files.length} file{files.length > 1 ? 's' : ''} → </span>}
                <span className="font-medium text-slate-600">
                  {selectedSubfolder
                    ? `/${selected.name}/${selectedSubfolder}`
                    : `/${selected.name}`}
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
                ? uploadProgress?.step === 'uploading' ? 'Uploading…' : 'Indexing…'
                : files.length > 1 ? `Upload ${files.length} files` : 'Upload'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
