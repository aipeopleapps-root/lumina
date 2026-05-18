import { useState, useEffect, useRef } from 'react';
import { api, chat as chatApi, assessChange, type Citation, type ChangeImpactResponse } from '../lib/api';
import { PolicyAdvisor } from './PolicyAdvisor';

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
  impactResult?: ChangeImpactResponse;
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
  const [impactMode, setImpactMode] = useState(false);
  const [activeTab, setActiveTab] = useState<'coach' | 'policy'>('coach');
  const [confirmNewChat, setConfirmNewChat] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [waitingPhase, setWaitingPhase] = useState('');
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
    setWaitingPhase('Searching documents…');
    setTimeout(() => setWaitingPhase('Generating answer…'), 3000);

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
      setWaitingPhase('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  async function sendImpact(description: string) {
    if (!description.trim() || waiting) return;
    setError(null);
    setInput('');
    setImpactMode(false);
    setWaiting(true);
    setWaitingPhase('Analysing modules…');
    setTimeout(() => setWaitingPhase('Assessing risks…'), 3000);
    const userTurn: Turn = { role: 'user', content: description };
    const newHistory = [...history, userTurn];
    setHistory(newHistory);
    try {
      const result = await assessChange(description);
      setHistory([...newHistory, { role: 'assistant', content: result.summary, impactResult: result }]);
    } catch (err: any) {
      setError(err.message || String(err));
      setHistory(newHistory.slice(0, -1));
    } finally {
      setWaiting(false);
      setWaitingPhase('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  function clearScope() {
    setScopedDoc(null);
    setActiveTopic(null);
    setHistory([]);
    setError(null);
    setImpactMode(false);
    setConfirmNewChat(false);
    setShowSuggestions(false);
  }

  function requestNewChat() {
    if (history.length > 0) {
      setConfirmNewChat(true);
    } else {
      clearScope();
    }
  }

  const hasConversation = history.length > 0;

  const policyDocs = documents.filter(d => d.doc_type === 'hr_policy');

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-white">

      <div className="flex flex-1 min-h-0 overflow-hidden">

      {/* ── Left nav strip ── */}
      <nav className="w-14 flex-shrink-0 flex flex-col items-center border-r border-slate-100 bg-slate-50 py-3 gap-1">
        <button
          onClick={() => setActiveTab('coach')}
          title="AI Coach"
          className={`w-10 h-10 rounded-xl flex flex-col items-center justify-center gap-0.5 transition-colors ${activeTab === 'coach' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-700 hover:bg-slate-200'}`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <span className="text-[9px] font-medium leading-none">Coach</span>
        </button>
        <button
          onClick={() => setActiveTab('policy')}
          title="HR Policy Advisor — answers from your uploaded HR policies"
          className={`w-10 h-10 rounded-xl flex flex-col items-center justify-center gap-0.5 transition-colors ${activeTab === 'policy' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-700 hover:bg-slate-200'}`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <span className="text-[9px] font-medium leading-none">Policies</span>
        </button>
      </nav>

      {activeTab === 'policy' ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <PolicyAdvisor policyDocs={policyDocs} />
        </div>
      ) : (
      <div className="flex flex-1 min-h-0 overflow-hidden">

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
            <div className="px-4 py-6 text-center space-y-2">
              <div className="w-10 h-10 bg-slate-100 rounded-xl flex items-center justify-center mx-auto text-xl">📂</div>
              <p className="text-xs font-medium text-slate-600">No documents yet</p>
              <p className="text-xs text-slate-400 leading-relaxed">Your consultant will upload and publish documents here. Check back soon.</p>
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
                        <div className="min-w-0 flex-1">
                          <span className={`text-xs leading-snug break-words ${isScoped ? 'text-indigo-700 font-medium' : 'text-slate-700'}`}>{doc.source_name}</span>
                          {isScoped && <div className="mt-0.5 text-[10px] text-indigo-500 font-medium">In context ✓</div>}
                        </div>
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
                  <h1 className="text-2xl font-semibold text-slate-900 mb-2">Ask Lumina</h1>
                  <p className="text-sm text-slate-500">Ask about your configuration, or click a document to focus on it.</p>
                </div>
              )}

              {/* Starter prompt cards */}
              {!scopedDoc && !impactMode && (
                <div className="space-y-3 mb-8">
                  {/* Change Impact — featured card */}
                  <button
                    onClick={() => setImpactMode(true)}
                    className="w-full text-left p-4 rounded-xl border-2 border-indigo-200 bg-indigo-50 hover:border-indigo-400 hover:bg-indigo-100 transition-colors group"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white text-base">⚡</div>
                        <div>
                          <div className="text-sm font-semibold text-indigo-900">Assess a Change</div>
                          <div className="text-xs text-indigo-500 mt-0.5">Get a structured impact analysis across all Workday modules</div>
                        </div>
                      </div>
                      <span className="text-indigo-400 group-hover:text-indigo-600 text-lg transition-colors">→</span>
                    </div>
                  </button>
                  {/* Regular starters */}
                  <div className="grid grid-cols-2 gap-3">
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
                </div>
              )}

              {/* Change impact input form */}
              {impactMode && (
                <div className="mb-8 space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center text-white text-sm">⚡</div>
                    <span className="text-sm font-semibold text-slate-900">Assess a Change</span>
                    <button onClick={() => setImpactMode(false)} className="ml-auto text-xs text-slate-400 hover:text-slate-600">Cancel</button>
                  </div>
                  <textarea
                    autoFocus
                    rows={4}
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    placeholder={`Describe the change you're considering…\n\nExamples:\n• Move from semi-monthly to bi-weekly payroll\n• Add a new legal entity in Canada\n• Change the benefits eligibility waiting period from 90 to 30 days`}
                    className="w-full border border-slate-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 resize-none placeholder:text-slate-300"
                  />
                  <button
                    onClick={() => sendImpact(input)}
                    disabled={!input.trim() || waiting}
                    className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Analyse impact →
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* ── Conversation ── */
          <>
            {/* Chat toolbar */}
            <div className="px-5 py-2 border-b border-slate-100 bg-white flex items-center gap-2 shrink-0">
              {scopedDoc && (
                <span className="inline-flex items-center gap-1.5 text-xs bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-full px-2.5 py-1">
                  <span>📄</span>
                  <span className="max-w-[180px] truncate">{scopedDoc.source_name}</span>
                  <button onClick={() => setScopedDoc(null)} className="text-indigo-400 hover:text-indigo-700 ml-0.5">✕</button>
                </span>
              )}
              <div className="flex-1" />
              <button
                onClick={() => setShowSuggestions(s => !s)}
                className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${showSuggestions ? 'bg-amber-50 border-amber-200 text-amber-700' : 'border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50'}`}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
                Suggestions
              </button>
              <button
                onClick={requestNewChat}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
                New chat
              </button>
            </div>

            {/* Suggestions panel */}
            {showSuggestions && (
              <div className="px-5 py-3 bg-amber-50 border-b border-amber-100 shrink-0">
                <p className="text-xs font-semibold text-amber-700 mb-2">Suggested questions</p>
                <div className="grid grid-cols-2 gap-2">
                  {STARTERS.map(s => (
                    <button
                      key={s.label}
                      onClick={() => { sendMessage(s.prompt); setShowSuggestions(false); }}
                      className="text-left text-xs px-3 py-2 rounded-lg bg-white border border-amber-200 text-slate-600 hover:border-amber-400 hover:text-slate-800 transition-colors leading-snug"
                    >
                      <span className="mr-1">{s.emoji}</span>{s.label}
                    </button>
                  ))}
                  <button
                    onClick={() => { setImpactMode(true); setShowSuggestions(false); }}
                    className="text-left text-xs px-3 py-2 rounded-lg bg-indigo-50 border border-indigo-200 text-indigo-700 hover:border-indigo-400 transition-colors leading-snug col-span-2"
                  >
                    ⚡ Assess a Change — structured impact analysis across all modules
                  </button>
                </div>
              </div>
            )}

            {/* Confirm new chat banner */}
            {confirmNewChat && (
              <div className="px-5 py-3 bg-slate-900 shrink-0 flex items-center gap-3">
                <p className="text-xs text-white flex-1">Start a new conversation? Your current chat will be cleared.</p>
                <button
                  onClick={clearScope}
                  className="text-xs font-medium px-3 py-1.5 bg-white text-slate-900 rounded-lg hover:bg-slate-100 transition-colors"
                >
                  Start fresh
                </button>
                <button
                  onClick={() => setConfirmNewChat(false)}
                  className="text-xs text-slate-400 hover:text-white transition-colors"
                >
                  Keep going
                </button>
              </div>
            )}

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
                    ) : turn.impactResult ? (
                      <ImpactCard result={turn.impactResult} />
                    ) : (
                      <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
                        <p className="text-xs font-semibold text-slate-400 mb-1.5">Lumina</p>
                        <p className="text-sm text-slate-800 whitespace-pre-wrap leading-relaxed">{turn.content}</p>
                        {turn.citations && turn.citations.length > 0 && (
                          <div className="mt-3 pt-2 border-t border-slate-100 space-y-1.5">
                            <p className="text-xs text-slate-400 mb-1">Sources</p>
                            {turn.citations.map((c, j) => (
                              <div key={j} className="flex items-start gap-2">
                                <span className="inline-flex items-center justify-center w-4 h-4 rounded bg-slate-100 text-slate-500 text-[10px] font-bold flex-shrink-0 mt-0.5">{j + 1}</span>
                                <div className="min-w-0">
                                  <span className="text-xs font-medium text-slate-700">{c.source_name}</span>
                                  {c.excerpt && <p className="text-[11px] text-slate-400 mt-0.5 leading-snug line-clamp-2">"{c.excerpt}"</p>}
                                </div>
                              </div>
                            ))}
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
                    <p className="text-xs font-semibold text-slate-400 mb-1.5">Lumina</p>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:0ms]" />
                        <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:150ms]" />
                        <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:300ms]" />
                      </div>
                      {waitingPhase && <span className="text-xs text-slate-400 animate-pulse">{waitingPhase}</span>}
                    </div>
                  </div>
                </div>
              )}

              <div ref={bottomRef} />
            </div>
          </>
        )}

        {/* ── Input area ── */}
        <div className="border-t border-slate-200 bg-white px-5 py-4">

          {/* Scope chip — landing state only (conversation state has its own toolbar) */}
          {!hasConversation && scopedDoc && (
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center gap-1.5 text-xs bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-full px-2.5 py-1">
                <span>📄</span>
                <span className="max-w-[180px] truncate">{scopedDoc.source_name}</span>
                <button onClick={() => setScopedDoc(null)} className="text-indigo-400 hover:text-indigo-700 ml-0.5">✕</button>
              </span>
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
      )}
      </div>
    </div>
  );
}

function ImpactCard({ result }: { result: ChangeImpactResponse }) {
  const sevColour: Record<string, string> = {
    high:   'bg-red-100 text-red-700 border-red-200',
    medium: 'bg-amber-100 text-amber-700 border-amber-200',
    low:    'bg-slate-100 text-slate-600 border-slate-200',
  };
  const sevDot: Record<string, string> = {
    high: 'bg-red-500', medium: 'bg-amber-400', low: 'bg-slate-400',
  };

  return (
    <div className="w-full max-w-[92%] space-y-3">
      {/* Header */}
      <div className="bg-indigo-600 rounded-2xl rounded-tl-sm px-4 py-3 text-white">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm">⚡</span>
          <span className="text-xs font-semibold uppercase tracking-wide opacity-80">Change Impact Assessment</span>
        </div>
        <p className="text-sm leading-relaxed">{result.summary}</p>
      </div>

      {/* Module impacts */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
        <div className="px-4 py-2.5 border-b border-slate-100 bg-slate-50">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Impact by Module</span>
        </div>
        <div className="divide-y divide-slate-100">
          {result.impacts.map((m, i) => (
            <div key={i} className="px-4 py-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${sevDot[m.severity] ?? 'bg-slate-400'}`} />
                <span className="text-xs font-semibold text-slate-800">{m.module}</span>
                <span className={`ml-auto text-xs px-2 py-0.5 rounded-full border font-medium ${sevColour[m.severity] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                  {m.severity}
                </span>
              </div>
              <p className="text-xs text-slate-600 leading-relaxed mb-2">{m.impact}</p>
              {m.actions.length > 0 && (
                <ul className="space-y-1">
                  {m.actions.map((a, j) => (
                    <li key={j} className="flex items-start gap-1.5 text-xs text-slate-500">
                      <span className="mt-1 w-1 h-1 rounded-full bg-indigo-400 flex-shrink-0" />
                      {a}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Risks */}
      {result.risks.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-2xl px-4 py-3">
          <p className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-2">Key Risks</p>
          <ul className="space-y-1.5">
            {result.risks.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-red-700">
                <span className="mt-1 w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" />
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Recommendation */}
      {result.recommendation && (
        <div className="bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Recommendation</p>
          <p className="text-xs text-slate-700 leading-relaxed">{result.recommendation}</p>
        </div>
      )}
    </div>
  );
}
