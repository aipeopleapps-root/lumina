import { useState, useEffect, useRef } from 'react';
import { api, chat as chatApi, type Citation } from '../lib/api';

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

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  scopedDoc?: string;
  focusLabel?: string;
}

const TOPICS = [
  { id: 'risks',       label: 'Risks & Issues',  prefix: 'Focus on identifying risks, issues, and potential problems: ' },
  { id: 'config',      label: 'Configuration',    prefix: 'Focus on configuration details and settings: ' },
  { id: 'practices',   label: 'Best Practices',   prefix: 'Evaluate against Workday best practices and flag any gaps: ' },
  { id: 'process',     label: 'Process Flows',    prefix: 'Focus on business process flows and workflow configuration: ' },
  { id: 'integration', label: 'Integrations',     prefix: 'Focus on integrations and external data connections: ' },
];

const STARTERS = [
  { emoji: '⚠️', label: 'Find risks',         prompt: 'What are the key risk areas and potential issues in my Workday configuration?' },
  { emoji: '📋', label: 'Summarise setup',     prompt: 'Give me a high-level summary of how my Workday is configured across all modules.' },
  { emoji: '✅', label: 'Best practices gap',  prompt: 'How does my configuration compare to Workday best practices? What should I improve?' },
  { emoji: '🔄', label: 'Process walkthrough', prompt: 'Walk me through how the key business processes are configured in my setup.' },
];

function topFolder(folderPath: string) {
  const parts = (folderPath || '/').split('/').filter(Boolean);
  return parts[0] || 'Uncategorised';
}

function dedupeByName(docs: Document[]): Document[] {
  const seen = new Map<string, Document>();
  for (const doc of docs) {
    const existing = seen.get(doc.source_name);
    if (!existing || doc.uploaded_at > existing.uploaded_at) {
      seen.set(doc.source_name, doc);
    }
  }
  return [...seen.values()].sort((a, b) => topFolder(a.folder_path).localeCompare(topFolder(b.folder_path)) || a.source_name.localeCompare(b.source_name));
}

export function ClientView() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [scopedDoc, setScopedDoc] = useState<Document | null>(null);
  const [activeTopic, setActiveTopic] = useState<string | null>(null);
  const [history, setHistory] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDocsLoading(true);
    setDocsError(null);
    api.get('/documents/list')
      .then(d => setDocuments(d.documents || []))
      .catch((err: any) => {
        console.error('Failed to load documents:', err);
        setDocsError(err.message || 'Failed to load documents');
      })
      .finally(() => setDocsLoading(false));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, waiting]);

  const dedupedDocs = dedupeByName(documents);

  // Group sidebar docs by top-level folder
  const docsByFolder = new Map<string, Document[]>();
  for (const doc of dedupedDocs) {
    const key = topFolder(doc.folder_path);
    if (!docsByFolder.has(key)) docsByFolder.set(key, []);
    docsByFolder.get(key)!.push(doc);
  }

  async function sendMessage(messageText: string) {
    if (!messageText.trim() || waiting) return;
    const topic = TOPICS.find(t => t.id === activeTopic);
    const apiMessage = topic ? topic.prefix + messageText : messageText;

    setError(null);
    setInput('');
    setWaiting(true);

    const userTurn: Turn = {
      role: 'user',
      content: messageText,
      scopedDoc: scopedDoc?.source_name,
      focusLabel: topic?.label,
    };
    const newHistory = [...history, userTurn];
    setHistory(newHistory);

    try {
      const resp = await chatApi(
        apiMessage,
        newHistory.slice(0, -1).map(t => ({ role: t.role, content: t.content })),
        {
          module: scopedDoc?.module || undefined,
          doc_id: scopedDoc?.doc_id || undefined,
        }
      );
      setHistory([...newHistory, { role: 'assistant', content: resp.answer, citations: resp.citations }]);
    } catch (err: any) {
      setError(err.message || String(err));
      setHistory(newHistory.slice(0, -1));
    } finally {
      setWaiting(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  function clearScope() {
    setScopedDoc(null);
    setActiveTopic(null);
    setHistory([]);
    setError(null);
  }

  const hasConversation = history.length > 0;

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-white">

      {/* ── Sidebar: Documents ── */}
      {sidebarOpen ? (
        <div className="w-60 flex-shrink-0 flex flex-col border-r border-slate-200 bg-slate-50 overflow-y-auto">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between bg-white">
            <span className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Documents</span>
            <button onClick={() => setSidebarOpen(false)} className="text-slate-400 hover:text-slate-600 text-xs px-1">✕</button>
          </div>

          {docsLoading ? (
            <div className="flex items-center gap-2 px-4 py-4">
              <div className="w-3 h-3 border border-slate-300 border-t-slate-600 rounded-full animate-spin flex-shrink-0" />
              <p className="text-xs text-slate-400">Loading…</p>
            </div>
          ) : docsError ? (
            <div className="px-4 py-4 space-y-1">
              <p className="text-xs font-medium text-red-600">Could not load documents</p>
              <p className="text-xs text-slate-400 leading-relaxed">{docsError}</p>
              <button
                onClick={() => {
                  setDocsLoading(true);
                  setDocsError(null);
                  api.get('/documents/list')
                    .then(d => setDocuments(d.documents || []))
                    .catch((err: any) => setDocsError(err.message || 'Failed to load documents'))
                    .finally(() => setDocsLoading(false));
                }}
                className="mt-2 text-xs text-slate-500 hover:text-slate-800 underline"
              >
                Retry
              </button>
            </div>
          ) : dedupedDocs.length === 0 ? (
            <div className="px-4 py-6 space-y-2">
              <p className="text-xs font-medium text-slate-500">No documents available yet.</p>
              <p className="text-xs text-slate-400 leading-relaxed">Your consultant needs to upload and publish documents to your workspace before they appear here.</p>
            </div>
          ) : (
            <div className="py-2">
              {[...docsByFolder.entries()].map(([folder, docs]) => (
                <div key={folder} className="mb-1">
                  <div className="px-4 py-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wide">{folder}</div>
                  {docs.map(doc => {
                    const isScoped = scopedDoc?.doc_id === doc.doc_id;
                    return (
                      <button
                        key={doc.doc_id}
                        onClick={() => {
                          if (isScoped) { setScopedDoc(null); } else { setScopedDoc(doc); setHistory([]); }
                        }}
                        className={`w-full text-left px-4 py-2 flex items-start gap-2 transition-colors ${isScoped ? 'bg-indigo-50 border-l-2 border-indigo-500' : 'hover:bg-slate-100 border-l-2 border-transparent'}`}
                      >
                        <span className="text-slate-400 text-xs mt-0.5 flex-shrink-0">📄</span>
                        <span className={`text-xs leading-snug break-words ${isScoped ? 'text-indigo-700 font-medium' : 'text-slate-700'}`}>{doc.source_name}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="w-9 flex-shrink-0 flex flex-col items-center border-r border-slate-200 bg-slate-50 py-3 gap-2">
          <button onClick={() => setSidebarOpen(true)} title="Show documents" className="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-slate-700 rounded transition-colors text-sm">→</button>
          <span className="text-xs text-slate-300 [writing-mode:vertical-rl] rotate-180 mt-1 select-none tracking-wide">Docs</span>
        </div>
      )}

      {/* ── Main chat area ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {!hasConversation ? (
          /* ── Landing state ── */
          <div className="flex-1 flex flex-col items-center justify-center px-8 py-12 overflow-y-auto">
            {!sidebarOpen && (
              <button onClick={() => setSidebarOpen(true)} className="self-start mb-6 text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1">
                <span>☰</span> Documents
              </button>
            )}

            <div className="w-full max-w-xl">
              {scopedDoc ? (
                <div className="mb-8 text-center">
                  <div className="inline-flex items-center gap-2 bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-2.5 mb-3">
                    <span className="text-base">📄</span>
                    <span className="text-sm font-medium text-indigo-800">{scopedDoc.source_name}</span>
                    <button onClick={() => setScopedDoc(null)} className="text-indigo-400 hover:text-indigo-700 ml-1 text-xs">✕</button>
                  </div>
                  <p className="text-sm text-slate-500">Ask anything about this document, or pick a focus below.</p>
                </div>
              ) : (
                <div className="text-center mb-8">
                  <h1 className="text-2xl font-semibold text-slate-900 mb-2">Ask Meridian</h1>
                  <p className="text-sm text-slate-500">Ask about your configuration, or click a document to focus on it.</p>
                </div>
              )}

              {/* Starter prompt cards */}
              {!scopedDoc && (
                <div className="grid grid-cols-2 gap-3 mb-8">
                  {STARTERS.map(s => (
                    <button
                      key={s.label}
                      onClick={() => sendMessage(s.prompt)}
                      className="text-left p-4 rounded-xl border border-slate-200 hover:border-slate-300 hover:bg-slate-50 transition-colors"
                    >
                      <div className="text-xl mb-1.5">{s.emoji}</div>
                      <div className="text-sm font-medium text-slate-800 mb-0.5">{s.label}</div>
                      <div className="text-xs text-slate-400 line-clamp-2">{s.prompt}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          /* ── Conversation ── */
          <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
            {history.map((turn, i) => (
              <div key={i} className={`flex ${turn.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] ${turn.role === 'user' ? 'order-2' : ''}`}>
                  {turn.role === 'user' ? (
                    <div className="bg-slate-900 text-white rounded-2xl rounded-tr-sm px-4 py-3">
                      <p className="text-sm whitespace-pre-wrap">{turn.content}</p>
                      {(turn.scopedDoc || turn.focusLabel) && (
                        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-white/10 flex-wrap">
                          {turn.scopedDoc && <span className="text-xs text-slate-300 bg-white/10 rounded-full px-2 py-0.5">📄 {turn.scopedDoc}</span>}
                          {turn.focusLabel && <span className="text-xs text-slate-300 bg-white/10 rounded-full px-2 py-0.5">{turn.focusLabel}</span>}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
                      <p className="text-xs font-semibold text-slate-400 mb-1.5">Workday Expert</p>
                      <p className="text-sm text-slate-800 whitespace-pre-wrap leading-relaxed">{turn.content}</p>
                      {turn.citations && turn.citations.length > 0 && (
                        <div className="mt-3 pt-2 border-t border-slate-100">
                          <p className="text-xs text-slate-400 mb-1">Sources</p>
                          <div className="flex flex-wrap gap-1.5">
                            {turn.citations.map((c, j) => (
                              <span key={j} className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">
                                {c.source_name}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {waiting && (
              <div className="flex justify-start">
                <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
                  <p className="text-xs font-semibold text-slate-400 mb-1.5">Workday Expert</p>
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:0ms]" />
                    <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:300ms]" />
                  </div>
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        )}

        {/* ── Input area ── */}
        <div className="border-t border-slate-200 bg-white px-5 py-4">

          {/* Context + scope chips */}
          {(scopedDoc || activeTopic || hasConversation) && (
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              {scopedDoc && (
                <span className="inline-flex items-center gap-1.5 text-xs bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-full px-2.5 py-1">
                  <span>📄</span>
                  <span className="max-w-[180px] truncate">{scopedDoc.source_name}</span>
                  <button onClick={() => setScopedDoc(null)} className="text-indigo-400 hover:text-indigo-700 ml-0.5">✕</button>
                </span>
              )}
              {hasConversation && (
                <button onClick={clearScope} className="text-xs text-slate-400 hover:text-slate-600 ml-auto">
                  New chat
                </button>
              )}
            </div>
          )}

          {/* Topic refinement chips */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="text-xs text-slate-400 flex-shrink-0">Focus:</span>
            {TOPICS.map(t => (
              <button
                key={t.id}
                onClick={() => setActiveTopic(prev => prev === t.id ? null : t.id)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  activeTopic === t.id
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'text-slate-600 border-slate-200 hover:border-slate-400 hover:text-slate-800'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Text input */}
          {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage(input)}
              placeholder={scopedDoc ? `Ask about ${scopedDoc.source_name}…` : 'Ask anything about your Workday configuration…'}
              disabled={waiting}
              className="flex-1 border border-slate-300 rounded-xl px-4 py-2.5 text-sm disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400"
            />
            <button
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || waiting}
              className="px-4 py-2.5 bg-slate-900 text-white rounded-xl text-sm font-medium hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {waiting ? (
                <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : '↑'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
