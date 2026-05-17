import { useState, useMemo } from 'react';
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

export type BulkAction = 'publish' | 'unpublish' | 'delete' | 'download' | 'analyse' | 'generateTests';

interface Props {
  template: FolderTemplate;
  documents: Document[];
  onDownload: (doc: Document) => void;
  onDelete?: (doc: Document) => void;
  onAnalyse?: (doc: Document) => void;
  onValidateSow?: (doc: Document) => void;
  onPublish?: (doc: Document, published: boolean) => void;
  onGenerateTests?: (doc: Document) => void;
  onBulkAction?: (action: BulkAction, docs: Document[]) => void;
}

type StatusFilter = 'all' | 'draft' | 'published';

// Doc types that get their own fixed sections regardless of folder_path
const VIRTUAL_SECTIONS = [
  { id: 'sow',           label: 'Statement of Work', docType: 'sow'           },
  { id: 'test-script',   label: 'Test Scripts',       docType: 'test-script'   },
  { id: 'status-report', label: 'Status Reports',     docType: 'status-report' },
] as const;

const VIRTUAL_TYPES = new Set(VIRTUAL_SECTIONS.map(s => s.docType));

// ── Section icons (SVG, keyed to folder name keywords) ────────────────────────

function SectionIcon({ name }: { name: string }) {
  const n = name.toLowerCase();
  const cls = 'w-3.5 h-3.5 flex-shrink-0';
  const s = { strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, strokeWidth: 1.5, fill: 'none', stroke: 'currentColor' };

  // Statement of Work / contract
  if (n.includes('statement') || n.includes('sow'))
    return <svg className={cls} viewBox="0 0 24 24" {...s}><path d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>;

  // Configuration / workbook — sliders
  if (n.includes('configuration') || n.includes('workbook'))
    return <svg className={cls} viewBox="0 0 24 24" {...s}><path d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" /></svg>;

  // Business process / workflow — arrows
  if (n.includes('business') || n.includes('process') || n.includes('bpd'))
    return <svg className={cls} viewBox="0 0 24 24" {...s}><path d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6" /></svg>;

  // Integration / interface — arrows crossing
  if (n.includes('integration') || n.includes('interface'))
    return <svg className={cls} viewBox="0 0 24 24" {...s}><path d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" /></svg>;

  // Test scripts — circle check
  if (n.includes('test'))
    return <svg className={cls} viewBox="0 0 24 24" {...s}><path d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;

  // Status reports — bar chart
  if (n.includes('status') || n.includes('report'))
    return <svg className={cls} viewBox="0 0 24 24" {...s}><path d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" /></svg>;

  // Training — academic cap
  if (n.includes('training'))
    return <svg className={cls} viewBox="0 0 24 24" {...s}><path d="M4.26 10.147a60.436 60.436 0 00-.491 6.347A48.627 48.627 0 0112 20.904a48.627 48.627 0 018.232-4.41 60.46 60.46 0 00-.491-6.347m-15.482 0a50.57 50.57 0 00-2.658-.813A59.905 59.905 0 0112 3.493a59.902 59.902 0 0110.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.697 50.697 0 0112 13.489a50.702 50.702 0 017.74-3.342M6.75 15a.75.75 0 100-1.5.75.75 0 000 1.5zm0 0v-3.675A55.378 55.378 0 0112 8.443m-7.007 11.55A5.981 5.981 0 006.75 15.75v-1.5" /></svg>;

  // Data migration — database / cylinder
  if (n.includes('data') || n.includes('migration'))
    return <svg className={cls} viewBox="0 0 24 24" {...s}><path d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" /></svg>;

  // Project management — briefcase
  if (n.includes('project'))
    return <svg className={cls} viewBox="0 0 24 24" {...s}><path d="M20.25 14.15v4.25c0 1.094-.787 2.036-1.872 2.18-2.087.277-4.216.42-6.378.42s-4.291-.143-6.378-.42c-1.085-.144-1.872-1.086-1.872-2.18v-4.25m16.5 0a2.18 2.18 0 00.75-1.661V8.706c0-1.081-.768-2.015-1.837-2.175a48.114 48.114 0 00-3.413-.387m4.5 8.006c-.194.165-.42.295-.673.38A23.978 23.978 0 0112 15.75c-2.648 0-5.195-.429-7.577-1.22a2.016 2.016 0 01-.673-.38m0 0A2.18 2.18 0 013 12.489V8.706c0-1.081.768-2.015 1.837-2.175a48.111 48.111 0 013.413-.387m7.5 0V5.25A2.25 2.25 0 0013.5 3h-3a2.25 2.25 0 00-2.25 2.25v.894m7.5 0a48.667 48.667 0 00-7.5 0M12 12.75h.008v.008H12v-.008z" /></svg>;

  // Generic document — fallback
  return <svg className={cls} viewBox="0 0 24 24" {...s}><path d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function folderLabel(path: string) {
  if (!path || path === '/') return '';
  return path.replace(/^\//, '').replace(/\//g, ' › ');
}

function formatDate(iso: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
    ...(!sameYear ? { year: 'numeric' } : {}),
  });
}

// Deduplicate to latest version per source_name
function latestVersions(docs: Document[]): { doc: Document; versionCount: number }[] {
  const map = new Map<string, Document[]>();
  for (const d of docs) {
    if (!map.has(d.source_name)) map.set(d.source_name, []);
    map.get(d.source_name)!.push(d);
  }
  return [...map.values()].map(versions => {
    versions.sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
    return { doc: versions[0], versionCount: versions.length };
  });
}

// ── Selection toolbar ─────────────────────────────────────────────────────────

function SelectionBar({
  selectedDocs, totalVisible, onSelectAll, onClear, onAction, canPublish, canGenerateTests,
}: {
  selectedDocs: Document[];
  totalVisible: number;
  onSelectAll: () => void;
  onClear: () => void;
  onAction: (a: BulkAction) => void;
  canPublish: boolean;
  canGenerateTests: boolean;
}) {
  const count            = selectedDocs.length;
  const hasPublishable   = selectedDocs.some(d => !d.published);
  const hasUnpublishable = selectedDocs.some(d => d.published === true);
  const eligibleForTests = selectedDocs.every(d => d.doc_type !== 'sow');
  const mixedWithSow     = !eligibleForTests && selectedDocs.some(d => d.doc_type !== 'sow');

  return (
    <div className="mb-4 bg-indigo-600 text-white rounded-xl px-4 py-2.5 flex items-center gap-3 flex-wrap shadow-md">
      <span className="text-sm font-semibold flex-shrink-0">
        {count} selected
        {count < totalVisible && (
          <button onClick={onSelectAll} className="ml-2 text-xs text-indigo-200 hover:text-white underline font-normal">
            Select all {totalVisible}
          </button>
        )}
        <button onClick={onClear} className="ml-2 text-xs text-indigo-200 hover:text-white underline font-normal">
          Clear
        </button>
      </span>
      <div className="flex items-center gap-1.5 flex-wrap">
        {canPublish && hasPublishable && (
          <button onClick={() => onAction('publish')} className="px-2.5 py-1 text-xs font-medium bg-green-600 hover:bg-green-700 rounded-lg transition-colors">✓ Publish</button>
        )}
        {canPublish && hasUnpublishable && (
          <button onClick={() => onAction('unpublish')} className="px-2.5 py-1 text-xs font-medium bg-amber-500 hover:bg-amber-600 rounded-lg transition-colors">↩ Unpublish</button>
        )}
        {canGenerateTests && eligibleForTests && (
          <button onClick={() => onAction('generateTests')} className="px-2.5 py-1 text-xs font-medium bg-teal-500 hover:bg-teal-600 rounded-lg transition-colors">⚙ Generate Tests</button>
        )}
        <button onClick={() => onAction('analyse')} className="px-2.5 py-1 text-xs font-medium bg-white/20 hover:bg-white/30 rounded-lg transition-colors">🔍 Analyse</button>
        <button onClick={() => onAction('download')} className="px-2.5 py-1 text-xs font-medium bg-white/20 hover:bg-white/30 rounded-lg transition-colors">↓ Download</button>
        <button onClick={() => onAction('delete')} className="px-2.5 py-1 text-xs font-medium bg-red-500 hover:bg-red-600 rounded-lg transition-colors">✕ Delete</button>
      </div>
      {mixedWithSow && (
        <span className="text-xs text-indigo-200 italic">Generate Tests unavailable — deselect SOW docs first</span>
      )}
    </div>
  );
}

// ── Doc row ───────────────────────────────────────────────────────────────────

function DocRow({
  doc, versionCount, isSelected, anySelected, onToggle,
  onDownload, onDelete, onAnalyse, onValidateSow, onPublish, onGenerateTests,
}: {
  doc: Document;
  versionCount: number;
  isSelected: boolean;
  anySelected: boolean;
  onToggle: () => void;
  onDownload: (d: Document) => void;
  onDelete?: (d: Document) => void;
  onAnalyse?: (d: Document) => void;
  onValidateSow?: (d: Document) => void;
  onPublish?: (d: Document, published: boolean) => void;
  onGenerateTests?: (d: Document) => void;
}) {
  const isSow           = doc.doc_type === 'sow';
  const isGeneratedDoc  = doc.doc_type === 'test-script' || doc.doc_type === 'status-report';
  const folder          = folderLabel(doc.folder_path);

  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 group transition-colors ${isSelected ? 'bg-indigo-50' : 'hover:bg-slate-50/80'}`}>
      {/* Checkbox */}
      <div className={`flex-shrink-0 w-4 transition-opacity ${anySelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggle}
          onClick={e => e.stopPropagation()}
          className="w-3.5 h-3.5 rounded border-slate-300 accent-indigo-600 cursor-pointer"
        />
      </div>

      {/* Name */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-800 truncate">{doc.source_name}</p>
        {versionCount > 1 && (
          <p className="text-xs text-slate-400">{versionCount - 1} older version{versionCount > 2 ? 's' : ''}</p>
        )}
      </div>

      {/* Folder chip — only shown when there is a folder */}
      {folder && (
        <span className="hidden md:block flex-shrink-0 text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full max-w-[160px] truncate">
          {folder}
        </span>
      )}

      {/* Status */}
      {onPublish && (
        <div className="flex items-center gap-1.5 flex-shrink-0 w-[78px]">
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${doc.published ? 'bg-green-500' : 'bg-amber-400'}`} />
          <span className={`text-xs ${doc.published ? 'text-green-700' : 'text-amber-600'}`}>
            {doc.published ? 'Published' : 'Draft'}
          </span>
        </div>
      )}

      {/* Date */}
      <span className="hidden sm:block flex-shrink-0 text-xs text-slate-400 w-14 text-right">
        {formatDate(doc.uploaded_at)}
      </span>

      {/* Actions — hidden during bulk selection */}
      {!anySelected && (
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          {onPublish && (
            <button
              onClick={() => onPublish(doc, !doc.published)}
              className={`px-2 py-1 text-xs rounded font-medium transition-colors ${
                doc.published ? 'bg-amber-100 text-amber-700 hover:bg-amber-200' : 'bg-green-600 text-white hover:bg-green-700'
              }`}
            >
              {doc.published ? 'Unpublish' : 'Publish'}
            </button>
          )}
          {isSow && onValidateSow && (
            <button onClick={() => onValidateSow(doc)} className="px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 transition-colors">
              Validate SOW
            </button>
          )}
          {!isSow && !isGeneratedDoc && onGenerateTests && (
            <button onClick={() => onGenerateTests(doc)} className="px-2 py-1 text-xs bg-teal-600 text-white rounded hover:bg-teal-700 transition-colors">
              Tests
            </button>
          )}
          {!isSow && onAnalyse && (
            <button onClick={() => onAnalyse(doc)} className="px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 transition-colors">
              Analyse
            </button>
          )}
          <button onClick={() => onDownload(doc)} className="px-2 py-1 text-xs bg-slate-100 text-slate-600 rounded hover:bg-slate-200 transition-colors" title="Download">
            ↓
          </button>
          {onDelete && (
            <button onClick={() => onDelete(doc)} className="px-2 py-1 text-xs bg-red-50 text-red-500 rounded hover:bg-red-100 transition-colors" title="Delete">
              ✕
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Category section ──────────────────────────────────────────────────────────

function CategorySection({
  label, rows, selectedIds, anySelected, onToggle,
  onDownload, onDelete, onAnalyse, onValidateSow, onPublish, onGenerateTests,
}: {
  label: string;
  rows: { doc: Document; versionCount: number }[];
  selectedIds: Set<string>;
  anySelected: boolean;
  onToggle: (id: string) => void;
  onDownload: (d: Document) => void;
  onDelete?: (d: Document) => void;
  onAnalyse?: (d: Document) => void;
  onValidateSow?: (d: Document) => void;
  onPublish?: (d: Document, published: boolean) => void;
  onGenerateTests?: (d: Document) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
      {/* Section header */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2.5 px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
      >
        <span className="text-slate-500"><SectionIcon name={label} /></span>
        <span className="text-sm font-semibold text-slate-800 flex-1">{label}</span>
        <span className="text-xs text-slate-400 bg-white border border-slate-200 px-2 py-0.5 rounded-full">
          {rows.length}
        </span>
        <span className="text-slate-400 text-xs ml-1">{open ? '▾' : '▸'}</span>
      </button>

      {/* Rows */}
      {open && (
        <div className="divide-y divide-slate-100">
          {rows.map(({ doc, versionCount }) => (
            <DocRow
              key={doc.doc_id}
              doc={doc}
              versionCount={versionCount}
              isSelected={selectedIds.has(doc.doc_id)}
              anySelected={anySelected}
              onToggle={() => onToggle(doc.doc_id)}
              onDownload={onDownload}
              onDelete={onDelete}
              onAnalyse={onAnalyse}
              onValidateSow={onValidateSow}
              onPublish={onPublish}
              onGenerateTests={onGenerateTests}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function FileExplorer({ template, documents, onDownload, onDelete, onAnalyse, onValidateSow, onPublish, onGenerateTests, onBulkAction }: Props) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const allRows = useMemo(() => latestVersions(documents), [documents]);

  // Apply status filter
  const filtered = useMemo(() => {
    if (statusFilter === 'draft')     return allRows.filter(r => !r.doc.published);
    if (statusFilter === 'published') return allRows.filter(r => r.doc.published);
    return allRows;
  }, [allRows, statusFilter]);

  // Group into virtual sections (by doc_type) + template folder sections + catch-all
  const grouped = useMemo(() => {
    // Fixed sections for SOW, generated test scripts, and status reports
    const virtual = VIRTUAL_SECTIONS.map(vs => ({
      ...vs,
      rows: filtered
        .filter(r => r.doc.doc_type === vs.docType)
        .sort((a, b) => b.doc.uploaded_at.localeCompare(a.doc.uploaded_at)),
    }));

    // Template folder sections — exclude virtual doc types
    const remaining = filtered.filter(r => !VIRTUAL_TYPES.has(r.doc.doc_type as any));
    const sections = template.folders.map(folder => {
      const prefix = `/${folder.name}`;
      const rows = remaining
        .filter(r => {
          const fp = r.doc.folder_path || '/';
          return fp === prefix || fp.startsWith(`${prefix}/`);
        })
        .sort((a, b) => b.doc.uploaded_at.localeCompare(a.doc.uploaded_at));
      return { folder, rows };
    });

    const assignedIds = new Set([
      ...virtual.flatMap(vs => vs.rows.map(r => r.doc.doc_id)),
      ...sections.flatMap(s => s.rows.map(r => r.doc.doc_id)),
    ]);
    const uncategorized = filtered
      .filter(r => !assignedIds.has(r.doc.doc_id))
      .sort((a, b) => b.doc.uploaded_at.localeCompare(a.doc.uploaded_at));

    return { virtual, sections, uncategorized };
  }, [filtered, template]);

  // Tab counts
  const counts = {
    all:       allRows.length,
    draft:     allRows.filter(r => !r.doc.published).length,
    published: allRows.filter(r => r.doc.published).length,
  };

  function toggleSelect(docId: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(docId) ? next.delete(docId) : next.add(docId);
      return next;
    });
  }

  function selectAll() {
    setSelectedIds(new Set(filtered.map(r => r.doc.doc_id)));
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function handleBulkAction(action: BulkAction) {
    const docs = documents.filter(d => selectedIds.has(d.doc_id));
    if (!docs.length) return;
    onBulkAction?.(action, docs);
    if (action === 'delete') clearSelection();
  }

  const anySelected  = selectedIds.size > 0;
  const selectedDocs = documents.filter(d => selectedIds.has(d.doc_id));

  const STATUS_TABS: { id: StatusFilter; label: string }[] = [
    { id: 'all',       label: 'All' },
    { id: 'draft',     label: 'Draft' },
    { id: 'published', label: 'Published' },
  ];

  return (
    <div className="space-y-4">
      {/* Selection bar */}
      {anySelected && (
        <SelectionBar
          selectedDocs={selectedDocs}
          totalVisible={filtered.length}
          onSelectAll={selectAll}
          onClear={clearSelection}
          onAction={handleBulkAction}
          canPublish={!!onPublish}
          canGenerateTests={!!onGenerateTests}
        />
      )}

      {/* Status filter tabs */}
      <div className="flex items-center gap-1">
        {STATUS_TABS.map(tab => {
          const cnt    = counts[tab.id];
          const active = statusFilter === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => { setStatusFilter(tab.id); clearSelection(); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                active ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'
              }`}
            >
              {tab.label}
              <span className={`px-1.5 py-0.5 rounded-full text-xs ${
                active ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'
              }`}>
                {cnt}
              </span>
            </button>
          );
        })}
      </div>

      {/* Category sections */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center text-sm text-slate-400">
          No {statusFilter !== 'all' ? statusFilter : ''} documents
        </div>
      ) : (
        <div className="space-y-3">
          {/* Fixed sections: SOW first, then template folders, then Test Scripts & Status Reports */}
          {grouped.virtual.slice(0, 1).map(vs => vs.rows.length === 0 ? null : (
            <CategorySection
              key={vs.id}
              label={vs.label}
              rows={vs.rows}
              selectedIds={selectedIds}
              anySelected={anySelected}
              onToggle={toggleSelect}
              onDownload={onDownload}
              onDelete={onDelete}
              onAnalyse={onAnalyse}
              onValidateSow={onValidateSow}
              onPublish={onPublish}
              onGenerateTests={onGenerateTests}
            />
          ))}
          {grouped.sections.map(({ folder, rows }) => {
            if (rows.length === 0) return null;
            return (
              <CategorySection
                key={folder.id}
                label={folder.name}
                rows={rows}
                selectedIds={selectedIds}
                anySelected={anySelected}
                onToggle={toggleSelect}
                onDownload={onDownload}
                onDelete={onDelete}
                onAnalyse={onAnalyse}
                onValidateSow={onValidateSow}
                onPublish={onPublish}
                onGenerateTests={onGenerateTests}
              />
            );
          })}
          {grouped.virtual.slice(1).map(vs => vs.rows.length === 0 ? null : (
            <CategorySection
              key={vs.id}
              label={vs.label}
              rows={vs.rows}
              selectedIds={selectedIds}
              anySelected={anySelected}
              onToggle={toggleSelect}
              onDownload={onDownload}
              onDelete={onDelete}
              onAnalyse={onAnalyse}
              onValidateSow={onValidateSow}
              onPublish={onPublish}
              onGenerateTests={onGenerateTests}
            />
          ))}
          {grouped.uncategorized.length > 0 && (
            <CategorySection
              label="Other Documents"
              rows={grouped.uncategorized}
              selectedIds={selectedIds}
              anySelected={anySelected}
              onToggle={toggleSelect}
              onDownload={onDownload}
              onDelete={onDelete}
              onAnalyse={onAnalyse}
              onValidateSow={onValidateSow}
              onPublish={onPublish}
              onGenerateTests={onGenerateTests}
            />
          )}
        </div>
      )}
    </div>
  );
}
