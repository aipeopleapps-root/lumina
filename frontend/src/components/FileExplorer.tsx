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
  template?: FolderTemplate;
  documents: Document[];
  onDownload: (doc: Document) => void;
  onDelete?: (doc: Document) => void;
  onAnalyse?: (doc: Document) => void;
  onPublish?: (doc: Document, published: boolean) => void;
  onGenerateTests?: (doc: Document) => void;
  onBulkAction?: (action: BulkAction, docs: Document[]) => void;
}

type StatusFilter = 'all' | 'draft' | 'published';

// ── Category config (order matters) ──────────────────────────────────────────

const CATEGORIES = [
  { id: 'sow',             label: 'Statement of Work', icon: '📋' },
  { id: 'config-workbook', label: 'Configuration',     icon: '📊' },
  { id: 'document',        label: 'Documents',         icon: '📄' },
  { id: 'test-script',     label: 'Test Scripts',      icon: '🧪' },
  { id: 'status-report',   label: 'Status Reports',    icon: '📈' },
] as const;

const KNOWN_TYPES = new Set(CATEGORIES.map(c => c.id));

function categoryFor(docType: string) {
  return KNOWN_TYPES.has(docType as any) ? docType : 'document';
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
  onDownload, onDelete, onAnalyse, onPublish, onGenerateTests,
}: {
  doc: Document;
  versionCount: number;
  isSelected: boolean;
  anySelected: boolean;
  onToggle: () => void;
  onDownload: (d: Document) => void;
  onDelete?: (d: Document) => void;
  onAnalyse?: (d: Document) => void;
  onPublish?: (d: Document, published: boolean) => void;
  onGenerateTests?: (d: Document) => void;
}) {
  const isSow    = doc.doc_type === 'sow';
  const folder   = folderLabel(doc.folder_path);

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
          {onGenerateTests && !isSow && (
            <button onClick={() => onGenerateTests(doc)} className="px-2 py-1 text-xs bg-teal-600 text-white rounded hover:bg-teal-700 transition-colors">
              Tests
            </button>
          )}
          {onAnalyse && (
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
  icon, label, rows, selectedIds, anySelected, onToggle,
  onDownload, onDelete, onAnalyse, onPublish, onGenerateTests,
}: {
  icon: string;
  label: string;
  rows: { doc: Document; versionCount: number }[];
  selectedIds: Set<string>;
  anySelected: boolean;
  onToggle: (id: string) => void;
  onDownload: (d: Document) => void;
  onDelete?: (d: Document) => void;
  onAnalyse?: (d: Document) => void;
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
        <span className="text-base leading-none">{icon}</span>
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

export function FileExplorer({ documents, onDownload, onDelete, onAnalyse, onPublish, onGenerateTests, onBulkAction }: Props) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const allRows = useMemo(() => latestVersions(documents), [documents]);

  // Apply status filter
  const filtered = useMemo(() => {
    if (statusFilter === 'draft')     return allRows.filter(r => !r.doc.published);
    if (statusFilter === 'published') return allRows.filter(r => r.doc.published);
    return allRows;
  }, [allRows, statusFilter]);

  // Group by category
  const grouped = useMemo(() => {
    const map = new Map<string, { doc: Document; versionCount: number }[]>();
    for (const row of filtered) {
      const cat = categoryFor(row.doc.doc_type);
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(row);
    }
    // Sort within each group: newest first
    for (const rows of map.values()) {
      rows.sort((a, b) => b.doc.uploaded_at.localeCompare(a.doc.uploaded_at));
    }
    return map;
  }, [filtered]);

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
          {CATEGORIES.map(cat => {
            const rows = grouped.get(cat.id);
            if (!rows || rows.length === 0) return null;
            return (
              <CategorySection
                key={cat.id}
                icon={cat.icon}
                label={cat.label}
                rows={rows}
                selectedIds={selectedIds}
                anySelected={anySelected}
                onToggle={toggleSelect}
                onDownload={onDownload}
                onDelete={onDelete}
                onAnalyse={onAnalyse}
                onPublish={onPublish}
                onGenerateTests={onGenerateTests}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
