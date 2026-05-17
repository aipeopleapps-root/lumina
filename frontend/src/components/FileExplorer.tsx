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

type FilterTab = 'all' | 'draft' | 'published' | 'test-scripts' | 'sow';
type SortField = 'date' | 'name' | 'status';
type SortDir = 'asc' | 'desc';

// ── Helpers ──────────────────────────────────────────────────────────────────

function typeIcon(docType: string) {
  switch (docType) {
    case 'sow':            return '📋';
    case 'config-workbook':return '📊';
    case 'test-script':    return '🧪';
    case 'status-report':  return '📈';
    default:               return '📄';
  }
}

function typeLabel(docType: string) {
  switch (docType) {
    case 'sow':            return 'SOW';
    case 'config-workbook':return 'Config';
    case 'test-script':    return 'Test Script';
    case 'status-report':  return 'Report';
    default:               return 'Document';
  }
}

function folderLabel(path: string) {
  if (!path || path === '/') return 'Uncategorized';
  return path.replace(/^\//, '').replace(/\//g, ' › ');
}

function formatDate(iso: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
    ...(!sameYear ? { year: 'numeric' } : {}),
  });
}

// Deduplicate to latest version per source_name
function latestVersions(docs: Document[]): { doc: Document; versionCount: number }[] {
  const map = new Map<string, Document[]>();
  for (const d of docs) {
    const k = d.source_name;
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(d);
  }
  const result: { doc: Document; versionCount: number }[] = [];
  for (const versions of map.values()) {
    versions.sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
    result.push({ doc: versions[0], versionCount: versions.length });
  }
  return result;
}

// ── Selection bar ─────────────────────────────────────────────────────────────

function SelectionBar({
  selectedDocs,
  totalDocs,
  onSelectAll,
  onClear,
  onAction,
  canPublish,
  canGenerateTests,
}: {
  selectedDocs: Document[];
  totalDocs: number;
  onSelectAll: () => void;
  onClear: () => void;
  onAction: (a: BulkAction) => void;
  canPublish: boolean;
  canGenerateTests: boolean;
}) {
  const count = selectedDocs.length;
  const hasPublishable   = selectedDocs.some(d => !d.published);
  const hasUnpublishable = selectedDocs.some(d => d.published === true);
  const eligibleForTests = selectedDocs.every(d => d.doc_type !== 'sow');
  const hasSowInMixed    = !eligibleForTests && selectedDocs.some(d => d.doc_type !== 'sow');

  return (
    <div className="mb-3 bg-indigo-600 text-white rounded-xl px-4 py-2.5 flex items-center gap-3 flex-wrap shadow-md">
      <div className="flex items-center gap-2 flex-shrink-0 text-sm font-semibold">
        {count} selected
        <span className="text-indigo-300 font-normal text-xs">
          {count < totalDocs
            ? <button onClick={onSelectAll} className="hover:text-white underline ml-1">Select all {totalDocs}</button>
            : null}
          <button onClick={onClear} className="hover:text-white underline ml-1">Clear</button>
        </span>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {canPublish && hasPublishable && (
          <button onClick={() => onAction('publish')} className="px-2.5 py-1 text-xs font-medium bg-green-600 hover:bg-green-700 rounded-lg transition-colors">
            ✓ Publish
          </button>
        )}
        {canPublish && hasUnpublishable && (
          <button onClick={() => onAction('unpublish')} className="px-2.5 py-1 text-xs font-medium bg-amber-500 hover:bg-amber-600 rounded-lg transition-colors">
            ↩ Unpublish
          </button>
        )}
        {canGenerateTests && eligibleForTests && (
          <button onClick={() => onAction('generateTests')} className="px-2.5 py-1 text-xs font-medium bg-teal-500 hover:bg-teal-600 rounded-lg transition-colors">
            ⚙ Generate Tests
          </button>
        )}
        <button onClick={() => onAction('analyse')} className="px-2.5 py-1 text-xs font-medium bg-white/20 hover:bg-white/30 rounded-lg transition-colors">
          🔍 Analyse
        </button>
        <button onClick={() => onAction('download')} className="px-2.5 py-1 text-xs font-medium bg-white/20 hover:bg-white/30 rounded-lg transition-colors">
          ↓ Download
        </button>
        <button onClick={() => onAction('delete')} className="px-2.5 py-1 text-xs font-medium bg-red-500 hover:bg-red-600 rounded-lg transition-colors">
          ✕ Delete
        </button>
      </div>

      {hasSowInMixed && (
        <span className="text-xs text-indigo-200 italic">Generate Tests unavailable — deselect SOW docs first</span>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function FileExplorer({ documents, onDownload, onDelete, onAnalyse, onPublish, onGenerateTests, onBulkAction }: Props) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab]     = useState<FilterTab>('all');
  const [sortField, setSortField]     = useState<SortField>('date');
  const [sortDir, setSortDir]         = useState<SortDir>('desc');

  // All deduplicated docs
  const allRows = useMemo(() => latestVersions(documents), [documents]);

  // Tab counts
  const counts = useMemo(() => ({
    all:          allRows.length,
    draft:        allRows.filter(r => !r.doc.published).length,
    published:    allRows.filter(r => r.doc.published).length,
    'test-scripts': allRows.filter(r => r.doc.doc_type === 'test-script').length,
    sow:          allRows.filter(r => r.doc.doc_type === 'sow').length,
  }), [allRows]);

  // Filtered rows
  const filtered = useMemo(() => {
    let rows = allRows;
    if (activeTab === 'draft')        rows = rows.filter(r => !r.doc.published);
    if (activeTab === 'published')    rows = rows.filter(r => r.doc.published);
    if (activeTab === 'test-scripts') rows = rows.filter(r => r.doc.doc_type === 'test-script');
    if (activeTab === 'sow')          rows = rows.filter(r => r.doc.doc_type === 'sow');
    return rows;
  }, [allRows, activeTab]);

  // Sorted rows
  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'name')   cmp = a.doc.source_name.localeCompare(b.doc.source_name);
      if (sortField === 'date')   cmp = a.doc.uploaded_at.localeCompare(b.doc.uploaded_at);
      if (sortField === 'status') cmp = (a.doc.published ? 1 : 0) - (b.doc.published ? 1 : 0);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortField, sortDir]);

  function toggleSort(field: SortField) {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('desc'); }
  }

  function toggleSelect(docId: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(docId) ? next.delete(docId) : next.add(docId);
      return next;
    });
  }

  function selectAll() {
    setSelectedIds(new Set(sorted.map(r => r.doc.doc_id)));
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

  const anySelected   = selectedIds.size > 0;
  const selectedDocs  = documents.filter(d => selectedIds.has(d.doc_id));

  const tabs: { id: FilterTab; label: string; show?: boolean }[] = [
    { id: 'all',          label: 'All' },
    { id: 'draft',        label: 'Draft' },
    { id: 'published',    label: 'Published' },
    { id: 'test-scripts', label: 'Test Scripts', show: counts['test-scripts'] > 0 },
    { id: 'sow',          label: 'SOW',          show: counts.sow > 0 },
  ];

  const SortChevron = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <span className="text-slate-300 text-xs">↕</span>;
    return <span className="text-indigo-500 text-xs">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  return (
    <div>
      {/* Selection bar */}
      {anySelected && (
        <SelectionBar
          selectedDocs={selectedDocs}
          totalDocs={sorted.length}
          onSelectAll={selectAll}
          onClear={clearSelection}
          onAction={handleBulkAction}
          canPublish={!!onPublish}
          canGenerateTests={!!onGenerateTests}
        />
      )}

      {/* Filter tabs + sort */}
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          {tabs.filter(t => t.show !== false).map(tab => {
            const cnt = counts[tab.id];
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  active
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'
                }`}
              >
                {tab.label}
                <span className={`text-xs px-1 py-0.5 rounded-full ${
                  active ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'
                }`}>
                  {cnt}
                </span>
              </button>
            );
          })}
        </div>

        {/* Sort controls */}
        <div className="flex items-center gap-0.5 text-xs text-slate-400">
          <span className="mr-1">Sort:</span>
          {(['name', 'date', 'status'] as SortField[]).map(f => (
            <button
              key={f}
              onClick={() => toggleSort(f)}
              className={`flex items-center gap-0.5 px-2 py-1 rounded transition-colors hover:bg-slate-100 ${
                sortField === f ? 'text-slate-700 font-medium' : 'text-slate-400'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)} <SortChevron field={f} />
            </button>
          ))}
        </div>
      </div>

      {/* Document rows */}
      {sorted.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <p className="text-sm text-slate-400">No documents in this view</p>
        </div>
      ) : (
        <div className="border border-slate-200 rounded-xl overflow-hidden bg-white divide-y divide-slate-100">
          {sorted.map(({ doc, versionCount }) => {
            const isSelected = selectedIds.has(doc.doc_id);
            const isSow = doc.doc_type === 'sow';
            const hasVersions = versionCount > 1;

            return (
              <div
                key={doc.doc_id}
                className={`flex items-center gap-3 px-3 py-2.5 group transition-colors ${
                  isSelected ? 'bg-indigo-50' : 'hover:bg-slate-50'
                }`}
              >
                {/* Checkbox */}
                <div className={`flex-shrink-0 transition-opacity ${anySelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(doc.doc_id)}
                    onClick={e => e.stopPropagation()}
                    className="w-3.5 h-3.5 rounded border-slate-300 accent-indigo-600 cursor-pointer"
                  />
                </div>

                {/* Type icon */}
                <span className="text-base flex-shrink-0 leading-none">{typeIcon(doc.doc_type)}</span>

                {/* Name + version hint */}
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-slate-800 truncate block">{doc.source_name}</span>
                  {hasVersions && (
                    <span className="text-xs text-slate-400">+{versionCount - 1} older version{versionCount > 2 ? 's' : ''}</span>
                  )}
                </div>

                {/* Folder chip */}
                <span className="hidden md:block flex-shrink-0 text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full max-w-[140px] truncate">
                  {folderLabel(doc.folder_path)}
                </span>

                {/* Type label */}
                <span className="hidden lg:block flex-shrink-0 text-xs text-slate-400 w-20 text-right">
                  {typeLabel(doc.doc_type)}
                </span>

                {/* Status */}
                {onPublish && (
                  <div className="flex items-center gap-1.5 flex-shrink-0 w-20">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${doc.published ? 'bg-green-500' : 'bg-amber-400'}`} />
                    <span className={`text-xs ${doc.published ? 'text-green-700' : 'text-amber-600'}`}>
                      {doc.published ? 'Published' : 'Draft'}
                    </span>
                  </div>
                )}

                {/* Date */}
                <span className="hidden sm:block flex-shrink-0 text-xs text-slate-400 w-16 text-right">
                  {formatDate(doc.uploaded_at)}
                </span>

                {/* Per-row actions (hidden during bulk selection) */}
                {!anySelected && (
                  <div className="flex items-center gap-1 ml-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    {onPublish && (
                      <button
                        onClick={() => onPublish(doc, !doc.published)}
                        className={`px-2 py-1 text-xs rounded font-medium transition-colors ${
                          doc.published
                            ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                            : 'bg-green-600 text-white hover:bg-green-700'
                        }`}
                      >
                        {doc.published ? 'Unpublish' : 'Publish'}
                      </button>
                    )}
                    {onGenerateTests && !isSow && (
                      <button
                        onClick={() => onGenerateTests(doc)}
                        className="px-2 py-1 text-xs bg-teal-600 text-white rounded hover:bg-teal-700 transition-colors"
                      >
                        Tests
                      </button>
                    )}
                    {onAnalyse && (
                      <button
                        onClick={() => onAnalyse(doc)}
                        className="px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 transition-colors"
                      >
                        Analyse
                      </button>
                    )}
                    <button
                      onClick={() => onDownload(doc)}
                      className="px-2 py-1 text-xs bg-slate-200 text-slate-700 rounded hover:bg-slate-300 transition-colors"
                    >
                      ↓
                    </button>
                    {onDelete && (
                      <button
                        onClick={() => onDelete(doc)}
                        className="px-2 py-1 text-xs bg-red-100 text-red-600 rounded hover:bg-red-200 transition-colors"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
