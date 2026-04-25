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
}

interface Props {
  template: FolderTemplate;
  documents: Document[];
  onDownload: (doc: Document) => void;
  onDelete?: (doc: Document) => void;
  onAnalyse?: (doc: Document) => void;
}

// Groups docs by folder_path, then within each folder groups versions by source_name
function buildDocMap(documents: Document[]): Map<string, Document[]> {
  const map = new Map<string, Document[]>();
  for (const doc of documents) {
    const key = doc.folder_path || '/';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(doc);
  }
  return map;
}

// Returns docs grouped by source_name (sorted newest-first within each group)
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
  onDownload,
  onDelete,
  onAnalyse,
}: {
  versions: Document[];
  onDownload: (d: Document) => void;
  onDelete?: (d: Document) => void;
  onAnalyse?: (d: Document) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const current = versions[0];
  const hasVersions = versions.length > 1;

  return (
    <div className="py-1.5 px-3 hover:bg-slate-50 rounded group">
      {/* Current (newest) version row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-slate-400 text-xs">📄</span>
          <div className="min-w-0">
            <div className="text-sm text-slate-800 truncate">{current.source_name}</div>
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
        <div className="flex items-center gap-1.5 ml-3 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
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
  onDownload,
  onDelete,
  onAnalyse,
}: {
  docs: Document[];
  onDownload: (d: Document) => void;
  onDelete?: (d: Document) => void;
  onAnalyse?: (d: Document) => void;
}) {
  const groups = groupByName(docs);
  return (
    <div className="px-1 py-1">
      {[...groups.values()].map((versions) => (
        <DocGroup
          key={versions[0].doc_id}
          versions={versions}
          onDownload={onDownload}
          onDelete={onDelete}
          onAnalyse={onAnalyse}
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

export function FileExplorer({ template, documents, onDownload, onDelete, onAnalyse }: Props) {
  const docMap = buildDocMap(documents);

  const initialExpanded = new Set<string>();
  for (const folder of template.folders) {
    initialExpanded.add(folder.id);
    for (const sub of folder.subfolders) {
      const subPath = `/${folder.name}/${sub.name}`;
      if (docMap.has(subPath)) {
        initialExpanded.add(`${folder.id}__${sub.id}`);
      }
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

  const rootDocs = docMap.get('/') || [];

  function countUnder(folderName: string, subfolders: { name: string }[]) {
    const direct = (docMap.get(`/${folderName}`) || []).length;
    const sub = subfolders.reduce(
      (acc, s) => acc + (docMap.get(`/${folderName}/${s.name}`) || []).length,
      0
    );
    return direct + sub;
  }

  return (
    <div className="space-y-1">
      {rootDocs.length > 0 && (
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 bg-slate-50">
            <span className="text-base">📁</span>
            <span className="font-medium text-slate-800 text-sm">Uncategorized</span>
            <CountBadge count={rootDocs.length} />
          </div>
          <DocList docs={rootDocs} onDownload={onDownload} onDelete={onDelete} onAnalyse={onAnalyse} />
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
                  <DocList docs={directDocs} onDownload={onDownload} onDelete={onDelete} onAnalyse={onAnalyse} />
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
                            <DocList docs={subDocs} onDownload={onDownload} onDelete={onDelete} onAnalyse={onAnalyse} />
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
