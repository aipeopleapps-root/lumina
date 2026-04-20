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

  useEffect(() => {
    loadDocuments();
  }, []);

  const loadDocuments = async () => {
    setLoading(true);
    try {
      // This endpoint needs to be created
      const data = await api.get('/documents/list');
      setDocuments(data.documents);
    } catch (error) {
      console.error('Failed to load documents:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async (doc: Document) => {
    try {
      // Get presigned download URL
      const result = await api.post('/documents/download-url', {
        s3_key: doc.s3_key
      });
      
      // Open in new tab to trigger download
      window.open(result.url, '_blank');
    } catch (error) {
      alert('Failed to download document');
    }
  };

  if (loading) {
    return <div className="p-6">Loading documents...</div>;
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
                    <span className="flex items-center gap-1">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                      </svg>
                      {doc.doc_type}
                    </span>
                    <span className="flex items-center gap-1">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                      </svg>
                      {doc.module}
                    </span>
                    <span className="flex items-center gap-1">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      {new Date(doc.uploaded_at).toLocaleDateString()}
                    </span>
                    <span>{doc.chunk_count} chunks</span>
                  </div>
                </div>
                <button
                  onClick={() => handleDownload(doc)}
                  className="ml-4 px-4 py-2 bg-slate-900 text-white text-sm rounded hover:bg-slate-800 flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
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
