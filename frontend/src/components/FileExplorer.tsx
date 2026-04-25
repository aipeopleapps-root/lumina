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

function DocRow({ doc, onDownload }: { doc: Document; onDownload: (d: Document) => void }) {
  return (
    <div className="flex items-center justify-between py-2 px-3 hover:bg-slate-50 rounded group">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-slate-400 text-xs">📄</span>
        <div className="min-w-0">
          <div className="text-sm text-slate-800 truncate">{doc.source_name}</div>
          <div className="text-xs text-slate-400">
            {new Date(doc.uploaded_at).toLocaleDateString()} · {doc.chunk_count} chunks
          </div>
        </div>
      </div>
      <button
        onClick={() => onDownload(doc)}
        className="ml-3 px-3 py-1 text-xs bg-slate-900 text-white rounded hover:bg-slate-700 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
      >
        Download
      </button>
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

export function FileExplorer({ template, documents, onDownload }: Props) {
  const docMap = buildDocMap(documents);
  const [expanded, setExpanded] = useState<Set<string>>(
    new Set(template.folders.map((f) => f.id))
  );

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // Docs that didn't match any folder (folder_path = "/" or unrecognised)
  const rootDocs = docMap.get('/') || [];

  // Count docs under a parent folder (direct + all subfolders)
  function countUnder(folderName: string, subfolders: { name: string }[]) {
    const directPath = `/${folderName}`;
    const direct = (docMap.get(directPath) || []).length;
    const sub = subfolders.reduce((acc, s) => {
      return acc + (docMap.get(`/${folderName}/${s.name}`) || []).length;
    }, 0);
    return direct + sub;
  }

  return (
    <div className="space-y-1">
      {template.folders.map((folder) => {
        const isOpen = expanded.has(folder.id);
        const total = countUnder(folder.name, folder.subfolders);
        const directDocs = docMap.get(`/${folder.name}`) || [];

        return (
          <div key={folder.id} className="border border-slate-200 rounded-lg overflow-hidden">
            {/* Parent folder header */}
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
                {/* Docs placed directly in this parent folder */}
                {directDocs.length > 0 && (
                  <div className="px-2 py-1">
                    {directDocs.map((doc) => (
                      <DocRow key={doc.doc_id} doc={doc} onDownload={onDownload} />
                    ))}
                  </div>
                )}

                {/* Subfolders */}
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
                            subDocs.map((doc) => (
                              <DocRow key={doc.doc_id} doc={doc} onDownload={onDownload} />
                            ))
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

      {/* Root / uncategorized docs */}
      {rootDocs.length > 0 && (
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 bg-slate-50">
            <span className="text-base">📁</span>
            <span className="font-medium text-slate-800 text-sm">Uncategorized</span>
            <CountBadge count={rootDocs.length} />
          </div>
          <div className="px-2 py-1">
            {rootDocs.map((doc) => (
              <DocRow key={doc.doc_id} doc={doc} onDownload={onDownload} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
