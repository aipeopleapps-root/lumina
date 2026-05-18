import { useState, useMemo, useEffect } from 'react';
import type { FolderTemplate } from './FolderTemplateSelector';
import { SectionIcon } from './SectionIcon';

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

export type BulkAction = 'publish' | 'unpublish' | 'delete' | 'download' | 'analyse';

interface Props {
  template: FolderTemplate;
  documents: Document[];
  onDownload: (doc: Document) => void;
  onDelete?: (doc: Document) => void;
  onAnalyse?: (doc: Document) => void;
  onValidateSow?: (doc: Document) => void;
  onPublish?: (doc: Document, published: boolean) => void;
  onBulkAction?: (action: BulkAction, docs: Document[]) => void;
  onSelectionChange?: (docs: Document[]) => void;
  selectionReset?: number;
}

type StatusFilter = 'all' | 'draft' | 'published';

// Doc types that get their own fixed sections regardless of folder_path
const VIRTUAL_SECTIONS = [
  { id: 'sow',           label: 'Statement of Work',      docType: 'sow'           },
  { id: 'hr_policy',     label: 'HR Policies & Knowledge', docType: 'hr_policy'    },
  { id: 'test-script',   label: 'Test Scripts',            docType: 'test-script'  },
  { id: 'status-report', label: 'Status Reports',          docType: 'status-report'},
] as const;

const VIRTUAL_TYPES = new Set(VIRTUAL_SECTIONS.map(s => s.docType));

// ── Helpers ───────────────────────────────────────────────────────────────────

function folderLabel(path: string) {
  if (!path || path === '/') return '';
  return path.replace(/^\//, '').replace(/\//g, ' › ');
}

function formatDate(iso: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
    ...(!sameYear ? { year: 'numeric' } : {}),
  });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} · ${time}`;
}

// Group by source_name, sort newest-first, expose all versions
function latestVersions(docs: Document[]): { doc: Document; allVersions: Document[] }[] {
  const map = new Map<string, Document[]>();
  for (const d of docs) {
    if (!map.has(d.source_name)) map.set(d.source_name, []);
    map.get(d.source_name)!.push(d);
  }
  return [...map.values()].map(versions => {
    versions.sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
    return { doc: versions[0], allVersions: versions };
  });
}

// ── Selection toolbar ─────────────────────────────────────────────────────────

function SelectionBar({
  selectedDocs, totalVisible, onSelectAll, onClear, onAction, canPublish,
}: {
  selectedDocs: Document[];
  totalVisible: number;
  onSelectAll: () => void;
  onClear: () => void;
  onAction: (a: BulkAction) => void;
  canPublish: boolean;
}) {
  const count            = selectedDocs.length;
  const hasPublishable   = selectedDocs.some(d => !d.published);
  const hasUnpublishable = selectedDocs.some(d => d.published === true);

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
        <button onClick={() => onAction('analyse')} className="px-2.5 py-1 text-xs font-medium bg-white/20 hover:bg-white/30 rounded-lg transition-colors">🔍 Analyse</button>
        <button onClick={() => onAction('download')} className="px-2.5 py-1 text-xs font-medium bg-white/20 hover:bg-white/30 rounded-lg transition-colors">↓ Download</button>
        <button onClick={() => onAction('delete')} className="px-2.5 py-1 text-xs font-medium bg-red-500 hover:bg-red-600 rounded-lg transition-colors">✕ Delete</button>
      </div>
    </div>
  );
}

// ── Doc row ───────────────────────────────────────────────────────────────────

function DocRow({
  doc, allVersions, isSelected, anySelected, onToggle,
  onDownload, onDelete, onAnalyse, onValidateSow, onPublish,
}: {
  doc: Document;
  allVersions: Document[];
  isSelected: boolean;
  anySelected: boolean;
  onToggle: () => void;
  onDownload: (d: Document) => void;
  onDelete?: (d: Document) => void;
  onAnalyse?: (d: Document) => void;
  onValidateSow?: (d: Document) => void;
  onPublish?: (d: Document, published: boolean) => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const isSow        = doc.doc_type === 'sow';
  const folder       = folderLabel(doc.folder_path);
  const totalVer     = allVersions.length;

  return (
    <div>
      {/* ── Current version row ── */}
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

        {/* Name + version toggle */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <p className="text-sm text-slate-800 truncate">{doc.source_name}</p>
            <span className="flex-shrink-0 text-[10px] font-semibold bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded">
              v{totalVer}
            </span>
          </div>
          {totalVer > 1 && (
            <button
              onClick={() => setHistoryOpen(v => !v)}
              className="flex items-center gap-0.5 text-xs text-slate-400 hover:text-indigo-600 mt-0.5 transition-colors"
            >
              <span>{historyOpen ? '▾' : '▸'}</span>
              <span>{totalVer - 1} older version{totalVer > 2 ? 's' : ''}</span>
            </button>
          )}
        </div>

        {/* Folder chip */}
        {folder && (
          <span className="hidden md:block flex-shrink-0 text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full max-w-[140px] truncate">
            {folder}
          </span>
        )}

        {/* Publish status */}
        {onPublish && (
          <div className="flex items-center gap-1.5 flex-shrink-0 w-[78px]">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${doc.published ? 'bg-green-500' : 'bg-amber-400'}`} />
            <span className={`text-xs ${doc.published ? 'text-green-700' : 'text-amber-600'}`}>
              {doc.published ? 'Published' : 'Draft'}
            </span>
          </div>
        )}

        {/* Upload date + time */}
        <span className="hidden sm:block flex-shrink-0 text-xs text-slate-400 w-28 text-right">
          {formatDate(doc.uploaded_at)}
        </span>

        {/* Hover actions */}
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
            {!isSow && onAnalyse && (
              <button onClick={() => onAnalyse(doc)} className="px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 transition-colors">
                Analyse
              </button>
            )}
            <button onClick={() => onDownload(doc)} className="px-2 py-1 text-xs bg-slate-100 text-slate-600 rounded hover:bg-slate-200 transition-colors" title="Download">↓</button>
            {onDelete && (
              <button onClick={() => onDelete(doc)} className="px-2 py-1 text-xs bg-red-50 text-red-500 rounded hover:bg-red-100 transition-colors" title="Delete">✕</button>
            )}
          </div>
        )}
      </div>

      {/* ── Version history (expandable) ── */}
      {historyOpen && totalVer > 1 && (
        <div className="bg-slate-50 border-t border-slate-100">
          {allVersions.slice(1).map((old, idx) => (
            <div
              key={old.doc_id}
              className="flex items-center gap-3 px-4 py-2 pl-10 border-b border-slate-100 last:border-0 group/old hover:bg-slate-100/60 transition-colors"
            >
              <span className="flex-shrink-0 text-[10px] font-semibold bg-slate-200 text-slate-500 px-1.5 py-0.5 rounded w-7 text-center">
                v{totalVer - 1 - idx}
              </span>
              <p className="text-xs text-slate-500 truncate flex-1">{old.source_name}</p>
              <span className="flex-shrink-0 text-xs text-slate-400 w-28 text-right">
                {formatDate(old.uploaded_at)}
              </span>
              <div className="flex items-center gap-1 opacity-0 group-hover/old:opacity-100 transition-opacity flex-shrink-0">
                <button onClick={() => onDownload(old)} className="px-2 py-0.5 text-xs bg-slate-200 text-slate-600 rounded hover:bg-slate-300 transition-colors" title="Download">↓</button>
                {onDelete && (
                  <button onClick={() => onDelete(old)} className="px-2 py-0.5 text-xs bg-red-50 text-red-400 rounded hover:bg-red-100 transition-colors" title="Delete">✕</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Category section ──────────────────────────────────────────────────────────

function CategorySection({
  label, rows, selectedIds, anySelected, onToggle,
  onDownload, onDelete, onAnalyse, onValidateSow, onPublish,
}: {
  label: string;
  rows: { doc: Document; allVersions: Document[] }[];
  selectedIds: Set<string>;
  anySelected: boolean;
  onToggle: (id: string) => void;
  onDownload: (d: Document) => void;
  onDelete?: (d: Document) => void;
  onAnalyse?: (d: Document) => void;
  onValidateSow?: (d: Document) => void;
  onPublish?: (d: Document, published: boolean) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
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

      {open && (
        <div className="divide-y divide-slate-100">
          {rows.map(({ doc, allVersions }) => (
            <DocRow
              key={doc.doc_id}
              doc={doc}
              allVersions={allVersions}
              isSelected={selectedIds.has(doc.doc_id)}
              anySelected={anySelected}
              onToggle={() => onToggle(doc.doc_id)}
              onDownload={onDownload}
              onDelete={onDelete}
              onAnalyse={onAnalyse}
              onValidateSow={onValidateSow}
              onPublish={onPublish}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function FileExplorer({ template, documents, onDownload, onDelete, onAnalyse, onValidateSow, onPublish, onBulkAction, onSelectionChange, selectionReset }: Props) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  useEffect(() => {
    setSelectedIds(new Set());
  }, [selectionReset]);

  useEffect(() => {
    onSelectionChange?.(documents.filter(d => selectedIds.has(d.doc_id)));
  }, [selectedIds, documents]);

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
          {/* SOW + HR Policies first, then template folders, then Test Scripts & Status Reports */}
          {grouped.virtual.slice(0, 2).map(vs => vs.rows.length === 0 ? null : (
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
              />
            );
          })}
          {grouped.virtual.slice(2).map(vs => vs.rows.length === 0 ? null : (
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
            />
          )}
        </div>
      )}
    </div>
  );
}
