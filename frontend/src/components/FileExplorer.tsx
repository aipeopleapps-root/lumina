import { useState } from 'react';
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
  onPublish?: (doc: Document, published: boolean) => void;
  onGenerateTests?: (doc: Document) => void;
  onBulkAction?: (action: BulkAction, docs: Document[]) => void;
}

function buildDocMap(documents: Document[]): Map<string, Document[]> {
  const map = new Map<string, Document[]>();
  for (const doc of documents) {
    const key = doc.folder_path || '/';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(doc);
  }
  return map;
}

function groupByName(docs: Document[]): Map<string, Document[]> {
  const map = new Map<string, Document[]>();
  for (const doc of docs) {
    const key = doc.source_name;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(doc);
  }
  for (const [, versions] of map) {
    versions.sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
  }
  return map;
}

function formatDate(iso: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function DocGroup({
  versions,
  selectedIds,
  onToggleSelect,
  onDownload,
  onDelete,
  onAnalyse,
  onPublish,
  onGenerateTests,
  anySelected,
}: {
  versions: Document[];
  selectedIds: Set<string>;
  onToggleSelect: (docId: string) => void;
  onDownload: (d: Document) => void;
  onDelete?: (d: Document) => void;
  onAnalyse?: (d: Document) => void;
  onPublish?: (d: Document, published: boolean) => void;
  onGenerateTests?: (d: Document) => void;
  anySelected: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const current = versions[0];
  const hasVersions = versions.length > 1;
  const isPublished = current.published === true;
  const isSelected = selectedIds.has(current.doc_id);
  const isSow = current.doc_type === 'sow';

  return (
    <div className={`py-1.5 px-3 rounded group ${isSelected ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}>
      <div className="flex items-center justify-between">
        {/* Checkbox + file info */}
        <div className="flex items-center gap-2 min-w-0">
          {/* Checkbox: always visible when anything selected, on hover otherwise */}
          <div className={`flex-shrink-0 transition-opacity ${anySelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => onToggleSelect(current.doc_id)}
              onClick={(e) => e.stopPropagation()}
              className="w-3.5 h-3.5 rounded border-slate-300 accent-indigo-600 cursor-pointer"
            />
          </div>
          <span className="text-slate-400 text-xs">📄</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="text-sm text-slate-800 truncate">{current.source_name}</div>
              {onPublish && (
                <span className={`flex-shrink-0 text-xs px-1.5 py-0.5 rounded-full font-medium ${
                  isPublished ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
                }`}>
                  {isPublished ? 'Published' : 'Draft'}
                </span>
              )}
            </div>
            <div className="text-xs text-slate-400 flex items-center gap-1.5">
              <span>{formatDate(current.uploaded_at)}</span>
              {hasVersions && (
                <button
                  onClick={() => setExpanded(v => !v)}
                  className="text-slate-500 hover:text-slate-700 underline"
                >
                  {expanded ? 'hide' : `+${versions.length - 1} older`}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Per-row hover actions (hidden when selection active) */}
        {!anySelected && (
          <div className="flex items-center gap-1.5 ml-3 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
            {onPublish && (
              <button
                onClick={() => onPublish(current, !isPublished)}
                className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
                  isPublished
                    ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                    : 'bg-green-600 text-white hover:bg-green-700'
                }`}
              >
                {isPublished ? 'Unpublish' : 'Publish'}
              </button>
            )}
            {onGenerateTests && !isSow && (
              <button
                onClick={() => onGenerateTests(current)}
                className="px-2.5 py-1 text-xs bg-teal-600 text-white rounded hover:bg-teal-700"
              >
                Generate Tests
              </button>
            )}
            {onAnalyse && (
              <button
                onClick={() => onAnalyse(current)}
                className="px-2.5 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
              >
                Analyse
              </button>
            )}
            <button
              onClick={() => onDownload(current)}
              className="px-2.5 py-1 text-xs bg-slate-900 text-white rounded hover:bg-slate-700"
            >
              Download
            </button>
            {onDelete && (
              <button
                onClick={() => onDelete(current)}
                className="px-2.5 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      {/* Older versions */}
      {expanded && versions.slice(1).map((doc, i) => (
        <div key={doc.doc_id} className="flex items-center justify-between mt-1 pl-6 py-1 border-l-2 border-slate-200 group/ver">
          <div className="text-xs text-slate-500 min-w-0">
            <span className="text-slate-400">v{versions.length - 1 - i}</span>
            <span className="ml-2">{formatDate(doc.uploaded_at)}</span>
          </div>
          <div className="flex items-center gap-1.5 ml-3 opacity-0 group-hover/ver:opacity-100 transition-opacity flex-shrink-0">
            <button
              onClick={() => onDownload(doc)}
              className="px-2 py-0.5 text-xs bg-slate-200 text-slate-700 rounded hover:bg-slate-300"
            >
              Download
            </button>
            {onDelete && (
              <button
                onClick={() => onDelete(doc)}
                className="px-2 py-0.5 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200"
              >
                Delete
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function DocList({
  docs,
  selectedIds,
  onToggleSelect,
  onDownload,
  onDelete,
  onAnalyse,
  onPublish,
  onGenerateTests,
  anySelected,
}: {
  docs: Document[];
  selectedIds: Set<string>;
  onToggleSelect: (docId: string) => void;
  onDownload: (d: Document) => void;
  onDelete?: (d: Document) => void;
  onAnalyse?: (d: Document) => void;
  onPublish?: (d: Document, published: boolean) => void;
  onGenerateTests?: (d: Document) => void;
  anySelected: boolean;
}) {
  const groups = groupByName(docs);
  return (
    <div className="px-1 py-1">
      {[...groups.values()].map((versions) => (
        <DocGroup
          key={versions[0].doc_id}
          versions={versions}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          onDownload={onDownload}
          onDelete={onDelete}
          onAnalyse={onAnalyse}
          onPublish={onPublish}
          onGenerateTests={onGenerateTests}
          anySelected={anySelected}
        />
      ))}
    </div>
  );
}

function CountBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-2 text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded-full">
      {count}
    </span>
  );
}

// Selection action bar — shown when at least 1 doc is selected
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
  onAction: (action: BulkAction) => void;
  canPublish: boolean;
  canGenerateTests: boolean;
}) {
  const count = selectedDocs.length;
  const hasPublishable = selectedDocs.some(d => !d.published);
  const hasUnpublishable = selectedDocs.some(d => d.published === true);
  // Generate Tests only available if no SOW docs selected
  const eligibleForTests = selectedDocs.every(d => d.doc_type !== 'sow');

  return (
    <div className="sticky top-0 z-10 mb-3 bg-indigo-600 text-white rounded-xl px-4 py-2.5 flex items-center gap-3 shadow-lg flex-wrap">
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="text-sm font-semibold">{count} selected</span>
        <span className="text-indigo-300 text-xs">·</span>
        {count < totalDocs ? (
          <button onClick={onSelectAll} className="text-xs text-indigo-200 hover:text-white underline">
            Select all {totalDocs}
          </button>
        ) : (
          <button onClick={onClear} className="text-xs text-indigo-200 hover:text-white underline">
            Clear
          </button>
        )}
        <button onClick={onClear} className="text-xs text-indigo-200 hover:text-white underline">
          {count < totalDocs ? '· Clear' : ''}
        </button>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {canPublish && hasPublishable && (
          <button
            onClick={() => onAction('publish')}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-green-600 hover:bg-green-700 rounded-lg transition-colors"
          >
            ✓ Publish
          </button>
        )}
        {canPublish && hasUnpublishable && (
          <button
            onClick={() => onAction('unpublish')}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-amber-500 hover:bg-amber-600 rounded-lg transition-colors"
          >
            ↩ Unpublish
          </button>
        )}
        {canGenerateTests && eligibleForTests && (
          <button
            onClick={() => onAction('generateTests')}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-teal-500 hover:bg-teal-600 rounded-lg transition-colors"
          >
            ⚙ Generate Tests
          </button>
        )}
        <button
          onClick={() => onAction('analyse')}
          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-white/20 hover:bg-white/30 rounded-lg transition-colors"
        >
          🔍 Analyse
        </button>
        <button
          onClick={() => onAction('download')}
          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-white/20 hover:bg-white/30 rounded-lg transition-colors"
        >
          ↓ Download
        </button>
        <button
          onClick={() => onAction('delete')}
          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-red-500 hover:bg-red-600 rounded-lg transition-colors"
        >
          ✕ Delete
        </button>
      </div>

      {/* Non-SOW notice when SOW docs are in selection */}
      {canGenerateTests && !eligibleForTests && selectedDocs.some(d => d.doc_type !== 'sow') && (
        <span className="text-xs text-indigo-200 italic">
          Generate Tests unavailable — deselect SOW documents first
        </span>
      )}
    </div>
  );
}

export function FileExplorer({ template, documents, onDownload, onDelete, onAnalyse, onPublish, onGenerateTests, onBulkAction }: Props) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const docMap = buildDocMap(documents);

  const initialExpanded = new Set<string>();
  for (const folder of template.folders) {
    initialExpanded.add(folder.id);
    for (const sub of folder.subfolders) {
      const subPath = `/${folder.name}/${sub.name}`;
      if (docMap.has(subPath)) initialExpanded.add(`${folder.id}__${sub.id}`);
    }
  }
  const [expanded, setExpanded] = useState<Set<string>>(initialExpanded);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleSelect(docId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(docId) ? next.delete(docId) : next.add(docId);
      return next;
    });
  }

  function selectAll() {
    // Select only the current (newest) version of each doc name
    const topDocIds = new Set<string>();
    for (const [, folderDocs] of docMap) {
      for (const [, versions] of groupByName(folderDocs)) {
        topDocIds.add(versions[0].doc_id);
      }
    }
    setSelectedIds(topDocIds);
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function handleBulkAction(action: BulkAction) {
    const selectedDocs = documents.filter(d => selectedIds.has(d.doc_id));
    if (selectedDocs.length === 0) return;
    onBulkAction?.(action, selectedDocs);
    if (action === 'delete') clearSelection();
  }

  const anySelected = selectedIds.size > 0;
  const selectedDocs = documents.filter(d => selectedIds.has(d.doc_id));

  // Count only top-level (newest) docs for select-all
  const topDocIds = new Set<string>();
  for (const [, folderDocs] of docMap) {
    for (const [, versions] of groupByName(folderDocs)) {
      topDocIds.add(versions[0].doc_id);
    }
  }

  const rootDocs = docMap.get('/') || [];

  function countUnder(folderName: string, subfolders: { name: string }[]) {
    const direct = (docMap.get(`/${folderName}`) || []).length;
    const sub = subfolders.reduce((acc, s) => acc + (docMap.get(`/${folderName}/${s.name}`) || []).length, 0);
    return direct + sub;
  }

  const sharedDocListProps = {
    selectedIds,
    onToggleSelect: toggleSelect,
    onDownload,
    onDelete,
    onAnalyse,
    onPublish,
    onGenerateTests,
    anySelected,
  };

  return (
    <div className="space-y-1">
      {/* Bulk selection bar */}
      {anySelected && (
        <SelectionBar
          selectedDocs={selectedDocs}
          totalDocs={topDocIds.size}
          onSelectAll={selectAll}
          onClear={clearSelection}
          onAction={handleBulkAction}
          canPublish={!!onPublish}
          canGenerateTests={!!onGenerateTests}
        />
      )}

      {rootDocs.length > 0 && (
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 bg-slate-50">
            <span className="text-base">📁</span>
            <span className="font-medium text-slate-800 text-sm">Uncategorized</span>
            <CountBadge count={rootDocs.length} />
          </div>
          <DocList docs={rootDocs} {...sharedDocListProps} />
        </div>
      )}

      {template.folders.map((folder) => {
        const isOpen = expanded.has(folder.id);
        const total = countUnder(folder.name, folder.subfolders);
        const directDocs = docMap.get(`/${folder.name}`) || [];

        return (
          <div key={folder.id} className="border border-slate-200 rounded-lg overflow-hidden">
            <button
              onClick={() => toggle(folder.id)}
              className="w-full flex items-center gap-2 px-4 py-3 bg-slate-50 hover:bg-slate-100 text-left"
            >
              <span className="text-slate-500 text-xs w-3">{isOpen ? '▾' : '▸'}</span>
              <span className="text-base">📁</span>
              <span className="font-medium text-slate-800 text-sm">{folder.name}</span>
              <CountBadge count={total} />
            </button>

            {isOpen && (
              <div className="divide-y divide-slate-100">
                {directDocs.length > 0 && (
                  <DocList docs={directDocs} {...sharedDocListProps} />
                )}

                {folder.subfolders.map((sub) => {
                  const subPath = `/${folder.name}/${sub.name}`;
                  const subDocs = docMap.get(subPath) || [];
                  const subKey = `${folder.id}__${sub.id}`;
                  const subOpen = expanded.has(subKey);

                  return (
                    <div key={sub.id}>
                      <button
                        onClick={() => toggle(subKey)}
                        className="w-full flex items-center gap-2 px-6 py-2 hover:bg-slate-50 text-left"
                      >
                        <span className="text-slate-400 text-xs w-3">{subOpen ? '▾' : '▸'}</span>
                        <span className="text-sm">📁</span>
                        <span className="text-sm text-slate-700">{sub.name}</span>
                        <CountBadge count={subDocs.length} />
                      </button>

                      {subOpen && (
                        <div className="px-4 pb-1">
                          {subDocs.length === 0 ? (
                            <p className="text-xs text-slate-400 px-3 py-2">No documents</p>
                          ) : (
                            <DocList docs={subDocs} {...sharedDocListProps} />
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
      })}
    </div>
  );
}
