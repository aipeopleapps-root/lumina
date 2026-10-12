import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { FileExplorer } from './FileExplorer';
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

export function DocumentsPanel() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [template, setTemplate] = useState<FolderTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get('/documents/list'),
      api.get('/tenant/folder-structure'),
    ])
      .then(([docsData, structData]) => {
        setDocuments(docsData.documents || []);
        setTemplate(structData.template ?? null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleDownload = async (doc: Document) => {
    try {
      const result = await api.post('/documents/download-url', { s3_key: doc.s3_key });
      window.open(result.url, '_blank');
    } catch {
      alert('Failed to download document');
    }
  };

  if (loading) return <div className="p-6 text-sm text-slate-500">Loading documents...</div>;

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          Failed to load documents. {error}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 overflow-y-auto">
      <div className="mb-4">
        <h2 className="text-lg font-semibold mb-1">Documents</h2>
        <p className="text-sm text-slate-500">
          Your Workday configuration files, organised by folder
        </p>
      </div>

      {documents.length === 0 ? (
        <div className="text-center py-12 text-slate-500">
          <p>No documents uploaded yet.</p>
          <p className="text-sm mt-2">Your consultant will upload configuration files here.</p>
        </div>
      ) : template ? (
        <FileExplorer
          template={template}
          documents={documents}
          onDownload={handleDownload}
        />
      ) : (
        // Fallback: flat list if template couldn't be loaded
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          {documents.map((doc, i) => (
            <div key={doc.doc_id} className={`p-4 ${i > 0 ? 'border-t border-slate-100' : ''}`}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-medium text-slate-900 mb-1">{doc.source_name}</div>
                  <div className="text-sm text-slate-500">
                    {doc.doc_type} · {doc.module} · {new Date(doc.uploaded_at).toLocaleDateString()}
                  </div>
                </div>
                <button
                  onClick={() => handleDownload(doc)}
                  className="ml-4 px-4 py-2 bg-slate-900 text-white text-sm rounded hover:bg-slate-800"
                >
                  Download
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
