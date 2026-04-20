import { useState, useEffect } from 'react';
import { api } from '../lib/api';

interface Document {
  doc_id: string;
  source_name: string;
  doc_type: string;
  module: string;
  chunk_count: number;
  uploaded_at: string;
  s3_key: string;
}

export function DocumentsPanel() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDocuments();
  }, []);

  const loadDocuments = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get('/documents/list');
      setDocuments(data.documents || []);
    } catch (err: any) {
      console.error('Failed to load documents:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async (doc: Document) => {
    try {
      const result = await api.post('/documents/download-url', {
        s3_key: doc.s3_key
      });
      window.open(result.url, '_blank');
    } catch (error) {
      alert('Failed to download document');
    }
  };

  if (loading) {
    return <div className="p-6">Loading documents...</div>;
  }

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
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-lg font-semibold mb-1">Your Documents</h2>
        <p className="text-sm text-slate-500">
          View and download all uploaded Workday configuration files
        </p>
      </div>

      {documents.length === 0 ? (
        <div className="text-center py-12 text-slate-500">
          <p>No documents uploaded yet.</p>
          <p className="text-sm mt-2">Your consultant will upload configuration files here.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {documents.map((doc) => (
            <div
              key={doc.doc_id}
              className="bg-white border border-slate-200 rounded-lg p-4 hover:shadow-sm transition-shadow"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="font-medium text-slate-900 mb-1">
                    {doc.source_name}
                  </div>
                  <div className="flex items-center gap-4 text-sm text-slate-500">
                    <span>{doc.doc_type}</span>
                    <span>{doc.module}</span>
                    <span>{new Date(doc.uploaded_at).toLocaleDateString()}</span>
                    <span>{doc.chunk_count} chunks</span>
                  </div>
                </div>
                <button
                  onClick={() => handleDownload(doc)}
                  className="ml-4 px-4 py-2 bg-deloitte-green text-white text-sm rounded hover:bg-deloitte-dark-green"
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
