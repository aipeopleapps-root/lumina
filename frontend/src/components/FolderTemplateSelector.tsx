import { useState } from 'react';

interface Subfolder {
  id: string;
  name: string;
}

interface Folder {
  id: string;
  name: string;
  icon: string;
  subfolders: Subfolder[];
}

export interface FolderTemplate {
  id: string;
  name: string;
  description: string;
  folders: Folder[];
}

interface Props {
  templates: FolderTemplate[];
  selected: string;
  onChange: (templateId: string) => void;
}

export function FolderTemplateSelector({ templates, selected, onChange }: Props) {
  const [previewing, setPreviewing] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      {templates.map((t) => {
        const isSelected = selected === t.id;
        const isExpanded = previewing === t.id;

        return (
          <div
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`border rounded-lg cursor-pointer transition-all ${
              isSelected
                ? 'border-slate-900 bg-slate-50'
                : 'border-slate-200 hover:border-slate-400'
            }`}
          >
            <div className="flex items-center justify-between p-3">
              <div className="flex items-center gap-3">
                <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${
                  isSelected ? 'border-slate-900 bg-slate-900' : 'border-slate-300'
                }`} />
                <div>
                  <div className="text-sm font-medium text-slate-900">{t.name}</div>
                  <div className="text-xs text-slate-500">{t.description}</div>
                </div>
              </div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setPreviewing(isExpanded ? null : t.id); }}
                className="text-xs text-slate-500 hover:text-slate-700 ml-2 flex-shrink-0"
              >
                {isExpanded ? 'Hide' : 'Preview'}
              </button>
            </div>

            {isExpanded && (
              <div className="px-3 pb-3 border-t border-slate-100 pt-2">
                <div className="space-y-1">
                  {t.folders.map((folder) => (
                    <div key={folder.id}>
                      <div className="flex items-center gap-1 text-xs font-medium text-slate-700 py-0.5">
                        <span>📁</span>
                        <span>{folder.name}</span>
                      </div>
                      <div className="ml-5 flex flex-wrap gap-x-3 gap-y-0.5">
                        {folder.subfolders.map((sub) => (
                          <span key={sub.id} className="text-xs text-slate-500">
                            └ {sub.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
