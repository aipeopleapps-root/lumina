import { useState } from 'react';
import type { FolderTemplate } from './FolderTemplateSelector';

interface Props {
  template: FolderTemplate;
  selected: string;
  onChange: (path: string) => void;
}

export function FolderPicker({ template, selected, onChange }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([template.folders[0]?.id]));

  function toggleFolder(folderId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(folderId) ? next.delete(folderId) : next.add(folderId);
      return next;
    });
  }

  function pathFor(folderName: string, subName?: string) {
    return subName ? `/${folderName}/${subName}` : `/${folderName}`;
  }

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden text-sm">
      {/* Root option */}
      <button
        type="button"
        onClick={() => onChange('/')}
        className={`w-full text-left px-3 py-2 flex items-center gap-2 border-b border-slate-100 ${
          selected === '/' ? 'bg-slate-900 text-white' : 'hover:bg-slate-50 text-slate-600'
        }`}
      >
        <span>📁</span>
        <span className="text-xs">/ (root — no folder)</span>
      </button>

      {template.folders.map((folder) => {
        const isOpen = expanded.has(folder.id);
        const folderPath = pathFor(folder.name);
        const folderSelected = selected === folderPath;

        return (
          <div key={folder.id} className="border-b border-slate-100 last:border-0">
            {/* Parent folder row */}
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => toggleFolder(folder.id)}
                className="px-2 py-2 text-slate-400 hover:text-slate-600"
              >
                {isOpen ? '▾' : '▸'}
              </button>
              <button
                type="button"
                onClick={() => onChange(folderPath)}
                className={`flex-1 text-left px-1 py-2 flex items-center gap-2 ${
                  folderSelected ? 'bg-slate-900 text-white rounded' : 'hover:bg-slate-50 text-slate-700'
                }`}
              >
                <span>📁</span>
                <span className="font-medium">{folder.name}</span>
              </button>
            </div>

            {/* Subfolders */}
            {isOpen && (
              <div className="ml-6 border-l border-slate-100">
                {folder.subfolders.map((sub) => {
                  const subPath = pathFor(folder.name, sub.name);
                  const subSelected = selected === subPath;
                  return (
                    <button
                      key={sub.id}
                      type="button"
                      onClick={() => onChange(subPath)}
                      className={`w-full text-left px-3 py-1.5 flex items-center gap-2 ${
                        subSelected ? 'bg-slate-900 text-white' : 'hover:bg-slate-50 text-slate-600'
                      }`}
                    >
                      <span className="text-xs">📄</span>
                      <span>{sub.name}</span>
                    </button>
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
