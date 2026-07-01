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
  scopedDocs?: string[];
  impactResult?: ChangeImpactResponse;
}

function topFolder(folderPath: string) {
  const parts = (folderPath || '/').split('/').filter(Boolean);
  return parts[0] || 'Uncategorised';
}

function dedupeByName(docs: Document[]): Document[] {
  const seen = new Map<string, Document>();
  for (const doc of docs) {
    const existing = seen.get(doc.source_name);
    if (!existing || doc.uploaded_at > existing.uploaded_at) seen.set(doc.source_name, doc);
  }
  return [...seen.values()].sort(
    (a, b) => topFolder(a.folder_path).localeCompare(topFolder(b.folder_path)) || a.source_name.localeCompare(b.source_name)
  );
}

function getStarters(docs: Document[]) {
  const hasCtx = docs.length > 0;
  const ctx = docs.length === 1 ? `"${docs[0].source_name}"` : `the ${docs.length} selected documents`;
  return [
    {
      emoji: '⚠️',
      label: 'Find risks',
      prompt: hasCtx
        ? `What risks and issues do you see in ${ctx}?`
        : 'What are the key risk areas and potential issues across my Workday setup?',
    },
    {
      emoji: '📋',
      label: 'Review setup',
      prompt: hasCtx
        ? `Summarise the key configurations and setup decisions in ${ctx}.`
        : 'Give me an executive summary of how my Workday is configured across all modules.',
    },
    {
      emoji: '✅',
      label: 'Best practices',
      prompt: hasCtx
        ? `What best practice gaps exist in ${ctx}? What should be improved?`
        : 'Compare my configuration to Workday best practices and tell me what I should improve.',
    },
    {
      emoji: '🔄',
      label: 'Processes',
      prompt: hasCtx
        ? `Walk me through the key processes and workflows described in ${ctx}.`
        : 'Walk me through how my key business processes are configured in Workday.',
    },
  ];
}

// ── Markdown renderer ────────────────────────────────────────────────────────

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|\[\d+\])/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**'))
          return <strong key={i} className="font-semibold text-slate-900">{part.slice(2, -2)}</strong>;
        if (part.startsWith('*') && part.endsWith('*') && part.length > 2)
          return <em key={i}>{part.slice(1, -1)}</em>;
        if (/^\[\d+\]$/.test(part))
          return <sup key={i} className="text-[11px] text-indigo-500 font-semibold ml-0.5">{part}</sup>;
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

function MarkdownMessage({ text }: { text: string }) {
  const lines = text.split('\n');
  const result: React.ReactNode[] = [];
  let listBuf: string[] = [];

  function flushList() {
    if (!listBuf.length) return;
    result.push(
      <ul key={result.length} className="my-2 space-y-1.5">
        {listBuf.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-slate-700 leading-relaxed">
            <span className="mt-2 w-1.5 h-1.5 rounded-full bg-indigo-400 flex-shrink-0" />
            <span>{renderInline(item)}</span>
          </li>
        ))}
      </ul>
    );
    listBuf = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,3} /.test(line)) {
      flushList();
      const txt = line.replace(/^#{1,3} /, '');
      result.push(<p key={i} className="mt-3 mb-0.5 text-sm font-semibold text-slate-900">{renderInline(txt)}</p>);
    } else if (/^[-•*] /.test(line)) {
      listBuf.push(line.replace(/^[-•*] /, ''));
    } else if (line === '') {
      flushList();
    } else {
      flushList();
      result.push(<p key={i} className="text-sm text-slate-800 leading-relaxed">{renderInline(line)}</p>);
    }
  }
  flushList();
  return <div className="space-y-0.5">{result}</div>;
}

// ── Component ────────────────────────────────────────────────────────────────

export function ClientView() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [scopedDocs, setScopedDocs] = useState<Document[]>([]);
  const [history, setHistory] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impactMode, setImpactMode] = useState(false);
  const [activeTab, setActiveTab] = useState<'coach' | 'policy'>('coach');
  const [confirmNewChat, setConfirmNewChat] = useState(false);
  const [waitingPhase, setWaitingPhase] = useState('');
  const [showSuggest, setShowSuggest] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const impactRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.get('/documents/list')
      .then(d => setDocuments(d.documents || []))
      .catch((err: any) => setDocsError(err.message || 'Failed to load'))
      .finally(() => setDocsLoading(false));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, waiting]);

  const dedupedDocs = dedupeByName(documents);
  const docsByFolder = new Map<string, Document[]>();
  for (const doc of dedupedDocs) {
    const key = topFolder(doc.folder_path);
    if (!docsByFolder.has(key)) docsByFolder.set(key, []);
    docsByFolder.get(key)!.push(doc);
  }

  function toggleDoc(doc: Document) {
    setScopedDocs(prev =>
      prev.find(d => d.doc_id === doc.doc_id) ? prev.filter(d => d.doc_id !== doc.doc_id) : [...prev, doc]
    );
  }

  const starters = getStarters(scopedDocs);

  async function sendMessage(messageText: string) {
    if (!messageText.trim() || waiting) return;
    setError(null);
    setInput('');
    setShowSuggest(false);
    setWaiting(true);
    setWaitingPhase('Searching documents…');
    const t = setTimeout(() => setWaitingPhase('Generating response…'), 3000);

    const userTurn: Turn = {
      role: 'user',
      content: messageText,
      scopedDocs: scopedDocs.length > 0 ? scopedDocs.map(d => d.source_name) : undefined,
    };
    const newHistory = [...history, userTurn];
    setHistory(newHistory);

    try {
      const opts: Record<string, any> = {};
      if (scopedDocs.length === 1) opts.doc_id = scopedDocs[0].doc_id;
      else if (scopedDocs.length > 1) opts.doc_ids = scopedDocs.map(d => d.doc_id);

      const resp = await chatApi(
        messageText,
        newHistory.slice(0, -1).map(t => ({ role: t.role, content: t.content })),
        opts
      );
      setHistory([...newHistory, { role: 'assistant', content: resp.answer, citations: resp.citations }]);
    } catch (err: any) {
      setError(err.message || String(err));
      setHistory(newHistory.slice(0, -1));
    } finally {
      clearTimeout(t);
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
    setWaitingPhase('Analysing impact…');
    const t = setTimeout(() => setWaitingPhase('Assessing risks…'), 3000);

    const userTurn: Turn = { role: 'user', content: `⚡ Assess a Change: ${description}` };
    const newHistory = [...history, userTurn];
    setHistory(newHistory);
    try {
      const result = await assessChange(description);
      setHistory([...newHistory, { role: 'assistant', content: result.summary, impactResult: result }]);
    } catch (err: any) {
      setError(err.message || String(err));
      setHistory(newHistory.slice(0, -1));
    } finally {
      clearTimeout(t);
      setWaiting(false);
      setWaitingPhase('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  function clearScope() {
    setScopedDocs([]);
    setHistory([]);
    setError(null);
    setImpactMode(false);
    setConfirmNewChat(false);
    setInput('');
    setShowSuggest(false);
  }

  const hasConversation = history.length > 0;
  const policyDocs = documents.filter(d => d.doc_type === 'hr_policy');

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-white">

      {/* Tab bar — underline style */}
      <div className="flex border-b border-slate-200 bg-white shrink-0 px-4">
        {(['coach', 'policy'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-3 text-xs font-semibold border-b-2 transition-colors -mb-px ${
              activeTab === tab ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            {tab === 'coach' ? 'AI Coach' : 'HR Advisor'}
          </button>
        ))}
      </div>

      {activeTab === 'policy' ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <PolicyAdvisor policyDocs={policyDocs} />
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 overflow-hidden">

          {/* ── Sidebar ────────────────────────────────────────────── */}
          {sidebarOpen ? (
            <div className="w-64 flex-shrink-0 flex flex-col border-r border-slate-200 bg-slate-50 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between bg-white shrink-0">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Documents</span>
                <div className="flex items-center gap-2">
                  {scopedDocs.length > 0 && (
                    <button onClick={() => setScopedDocs([])} className="text-xs text-indigo-600 hover:text-indigo-800 font-medium">
                      Clear ({scopedDocs.length})
                    </button>
                  )}
                  <button onClick={() => setSidebarOpen(false)} className="text-slate-300 hover:text-slate-500 text-sm leading-none">✕</button>
                </div>
              </div>

              {docsLoading ? (
                <div className="flex items-center gap-2 px-4 py-4">
                  <div className="w-3 h-3 border border-slate-300 border-t-slate-600 rounded-full animate-spin" />
                  <p className="text-xs text-slate-400">Loading…</p>
                </div>
              ) : docsError ? (
                <div className="px-4 py-4">
                  <p className="text-xs text-red-600 mb-2">Could not load documents</p>
                  <button onClick={() => { setDocsLoading(true); setDocsError(null); api.get('/documents/list').then(d => setDocuments(d.documents || [])).catch((e: any) => setDocsError(e.message)).finally(() => setDocsLoading(false)); }} className="text-xs text-indigo-600 underline">Retry</button>
                </div>
              ) : dedupedDocs.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <div className="w-10 h-10 bg-slate-100 rounded-xl flex items-center justify-center mx-auto mb-3 text-xl">📂</div>
                  <p className="text-xs font-medium text-slate-600 mb-1">No documents yet</p>
                  <p className="text-xs text-slate-400">Your consultant will publish documents here.</p>
                </div>
              ) : (
                <>
                  {scopedDocs.length > 0 && (
                    <div className="px-3 py-2 bg-indigo-50 border-b border-indigo-100 shrink-0">
                      <p className="text-[10px] font-bold text-indigo-500 uppercase tracking-widest mb-1.5">In context — {scopedDocs.length} doc{scopedDocs.length > 1 ? 's' : ''}</p>
                      {scopedDocs.map(d => (
                        <div key={d.doc_id} className="flex items-center gap-1.5 py-0.5">
                          <span className="text-[11px] text-indigo-700 truncate flex-1">📄 {d.source_name}</span>
                          <button onClick={() => toggleDoc(d)} className="text-indigo-300 hover:text-indigo-600 text-xs leading-none">✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="py-1 overflow-y-auto flex-1">
                    {[...docsByFolder.entries()].map(([folder, docs]) => (
                      <div key={folder} className="mb-0.5">
                        <div className="px-4 py-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-widest">{folder}</div>
                        {docs.map(doc => {
                          const checked = scopedDocs.some(d => d.doc_id === doc.doc_id);
                          return (
                            <button
                              key={doc.doc_id}
                              onClick={() => toggleDoc(doc)}
                              className={`w-full text-left px-3 py-2 flex items-start gap-2.5 transition-colors group ${checked ? 'bg-indigo-50/80' : 'hover:bg-slate-100'}`}
                            >
                              <div className={`mt-0.5 w-4 h-4 rounded border-2 flex-shrink-0 flex items-center justify-center transition-all ${checked ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300 bg-white group-hover:border-slate-400'}`}>
                                {checked && <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                              </div>
                              <span className={`text-xs leading-snug break-words ${checked ? 'text-indigo-700 font-medium' : 'text-slate-600 group-hover:text-slate-900'}`}>{doc.source_name}</span>
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="w-9 flex-shrink-0 flex flex-col items-center border-r border-slate-200 bg-slate-50 py-3 gap-2">
              <button onClick={() => setSidebarOpen(true)} title="Show documents" className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" /></svg>
              </button>
              {scopedDocs.length > 0 && (
                <span className="text-[10px] font-bold text-white bg-indigo-500 rounded-full w-5 h-5 flex items-center justify-center">{scopedDocs.length}</span>
              )}
            </div>
          )}

          {/* ── Main area ──────────────────────────────────────────── */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

            {!hasConversation ? (
              /* ── Landing ── */
              <div className="flex-1 flex flex-col items-center justify-center px-8 py-10 overflow-y-auto">
                {!sidebarOpen && (
                  <button onClick={() => setSidebarOpen(true)} className="self-start mb-6 flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-700">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" /></svg>
                    Documents
                  </button>
                )}

                <div className="w-full max-w-2xl">
                  {/* Hero */}
                  <div className="text-center mb-8">
                    <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-indigo-600 mb-4 shadow-lg shadow-indigo-200">
                      <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" /></svg>
                    </div>
                    <h1 className="text-2xl font-bold text-slate-900 mb-1.5">How can I help?</h1>
                    <p className="text-sm text-slate-500">
                      {scopedDocs.length > 0
                        ? `${scopedDocs.length} document${scopedDocs.length > 1 ? 's' : ''} in context · ${scopedDocs.slice(0, 2).map(d => d.source_name).join(', ')}${scopedDocs.length > 2 ? ` +${scopedDocs.length - 2} more` : ''}`
                        : 'Select documents to focus my answers, or ask anything about your Workday setup.'}
                    </p>
                  </div>

                  {!impactMode ? (
                    <>
                      {/* 2×2 starter cards */}
                      <div className="grid grid-cols-2 gap-3 mb-3">
                        {starters.map(s => (
                          <button
                            key={s.label}
                            onClick={() => sendMessage(s.prompt)}
                            className="group text-left p-4 rounded-2xl border border-slate-200 hover:border-indigo-200 hover:bg-indigo-50/40 transition-all"
                          >
                            <div className="text-2xl mb-2">{s.emoji}</div>
                            <div className="text-sm font-semibold text-slate-800 mb-1 group-hover:text-indigo-800">{s.label}</div>
                            <div className="text-xs text-slate-400 leading-snug line-clamp-2">{s.prompt}</div>
                          </button>
                        ))}
                      </div>

                      {/* Assess a Change — full-width featured card */}
                      <button
                        onClick={() => { setImpactMode(true); setTimeout(() => impactRef.current?.focus(), 50); }}
                        className="w-full text-left p-4 rounded-2xl bg-gradient-to-r from-indigo-50 to-violet-50 border-2 border-indigo-100 hover:border-indigo-300 transition-all group"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white text-xl flex-shrink-0 shadow-sm shadow-indigo-200">⚡</div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-semibold text-indigo-900 mb-0.5">Assess a Change</div>
                            <div className="text-xs text-indigo-500">Get a structured impact analysis across all Workday modules before you make a change</div>
                          </div>
                          <span className="text-indigo-300 group-hover:text-indigo-500 text-xl transition-colors flex-shrink-0">→</span>
                        </div>
                      </button>
                    </>
                  ) : (
                    /* Impact form on landing */
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 px-1">
                        <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center text-white text-sm">⚡</div>
                        <span className="text-sm font-semibold text-slate-900">Assess a Change</span>
                        <button onClick={() => { setImpactMode(false); setInput(''); }} className="ml-auto text-xs text-slate-400 hover:text-slate-700">Cancel</button>
                      </div>
                      <textarea
                        ref={impactRef}
                        rows={5}
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        placeholder={`Describe the change you're considering…\n\nExamples:\n• Move from semi-monthly to bi-weekly payroll\n• Add a new legal entity in Canada\n• Change benefits eligibility from 90 to 30 days`}
                        className="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 resize-none placeholder:text-slate-300 bg-slate-50"
                      />
                      <button
                        onClick={() => sendImpact(input)}
                        disabled={!input.trim() || waiting}
                        className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl text-sm font-semibold disabled:opacity-40 transition-colors"
                      >
                        Analyse impact →
                      </button>
                    </div>
                  )}

                  {/* Free-form input at bottom of landing */}
                  {!impactMode && (
                    <div className="mt-5 flex gap-2">
                      <input
                        ref={inputRef}
                        type="text"
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage(input)}
                        placeholder="Or ask anything…"
                        disabled={waiting}
                        className="flex-1 border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-slate-50 disabled:opacity-50"
                      />
                      <button
                        onClick={() => sendMessage(input)}
                        disabled={!input.trim() || waiting}
                        className="px-4 py-3 bg-slate-900 text-white rounded-xl font-medium hover:bg-slate-700 disabled:opacity-30 transition-colors"
                      >
                        {waiting ? <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : '↑'}
                      </button>
                    </div>
                  )}
                </div>
              </div>

            ) : (
              /* ── Conversation ── */
              <>
                {/* Toolbar */}
                <div className="px-4 py-2 border-b border-slate-100 bg-white flex items-center gap-2 shrink-0 min-h-[48px]">
                  <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto">
                    {scopedDocs.length === 0
                      ? <span className="text-xs text-slate-400 italic flex-shrink-0">All documents in scope</span>
                      : scopedDocs.map(doc => (
                          <span key={doc.doc_id} className="inline-flex items-center gap-1.5 text-xs bg-indigo-50 text-indigo-700 border border-indigo-100 rounded-full px-2.5 py-1 flex-shrink-0">
                            <span>📄</span>
                            <span className="max-w-[110px] truncate">{doc.source_name}</span>
                            <button onClick={() => toggleDoc(doc)} className="text-indigo-300 hover:text-indigo-600 leading-none">✕</button>
                          </span>
                        ))
                    }
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => { setShowSuggest(s => !s); if (impactMode) setImpactMode(false); }}
                      title="Suggested questions"
                      className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${showSuggest ? 'bg-amber-50 border-amber-200 text-amber-700' : 'border-slate-200 text-slate-400 hover:text-slate-700 hover:bg-slate-50'}`}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
                      Suggest
                    </button>
                    <button
                      onClick={() => { setImpactMode(v => !v); setInput(''); setShowSuggest(false); if (!impactMode) setTimeout(() => impactRef.current?.focus(), 50); }}
                      title="Assess a Change"
                      className={`flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${impactMode ? 'bg-indigo-50 border-indigo-200 text-indigo-700 font-medium' : 'border-slate-200 text-slate-400 hover:text-slate-700 hover:bg-slate-50'}`}
                    >
                      ⚡
                    </button>
                    <button
                      onClick={() => history.length > 0 ? setConfirmNewChat(true) : clearScope()}
                      title="New conversation"
                      className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-400 hover:text-slate-700 hover:bg-slate-50 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
                    </button>
                  </div>
                </div>

                {/* Suggest strip */}
                {showSuggest && (
                  <div className="px-4 py-2.5 bg-amber-50/60 border-b border-amber-100 shrink-0 flex flex-wrap gap-2">
                    {starters.map(s => (
                      <button
                        key={s.label}
                        onClick={() => { sendMessage(s.prompt); setShowSuggest(false); }}
                        className="text-xs px-3 py-1.5 rounded-full bg-white border border-amber-200 text-slate-700 hover:border-amber-400 hover:text-slate-900 transition-colors"
                      >
                        {s.emoji} {s.label}
                      </button>
                    ))}
                  </div>
                )}

                {/* Confirm new chat */}
                {confirmNewChat && (
                  <div className="px-4 py-3 bg-slate-900 shrink-0 flex items-center gap-3">
                    <p className="text-xs text-slate-300 flex-1">Start a new conversation? This chat will be cleared.</p>
                    <button onClick={clearScope} className="text-xs font-semibold px-3 py-1.5 bg-white text-slate-900 rounded-lg">Start fresh</button>
                    <button onClick={() => setConfirmNewChat(false)} className="text-xs text-slate-500 hover:text-white">Keep going</button>
                  </div>
                )}

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
                  {history.map((turn, i) => (
                    <div key={i} className={`flex gap-3 ${turn.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      {turn.role === 'assistant' && !turn.impactResult && (
                        <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0 mt-1 shadow-sm">L</div>
                      )}
                      <div className="max-w-[78%]">
                        {turn.role === 'user' ? (
                          <div className="bg-slate-900 text-white rounded-2xl rounded-tr-sm px-4 py-3">
                            <p className="text-sm whitespace-pre-wrap leading-relaxed">{turn.content}</p>
                            {turn.scopedDocs && turn.scopedDocs.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-white/10">
                                {turn.scopedDocs.map((name, j) => (
                                  <span key={j} className="text-[11px] text-slate-300 bg-white/10 rounded-full px-2 py-0.5 leading-relaxed">📄 {name}</span>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : turn.impactResult ? (
                          <ImpactCard result={turn.impactResult} />
                        ) : (
                          <div className="bg-white border border-slate-100 rounded-2xl rounded-tl-sm px-5 py-4 shadow-sm">
                            <MarkdownMessage text={turn.content} />
                            {turn.citations && turn.citations.length > 0 && (
                              <div className="mt-4 pt-3 border-t border-slate-100">
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Sources</p>
                                <div className="space-y-2">
                                  {turn.citations.map((c, j) => (
                                    <div key={j} className="flex items-start gap-2">
                                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-slate-100 text-slate-500 text-[10px] font-bold flex-shrink-0 mt-0.5">{j + 1}</span>
                                      <div>
                                        <p className="text-xs font-medium text-slate-700">{c.source_name}</p>
                                        {c.excerpt && <p className="text-[11px] text-slate-400 mt-0.5 leading-snug line-clamp-2">"{c.excerpt}"</p>}
                                      </div>
                                    </div>
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
                    <div className="flex gap-3 justify-start">
                      <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0 mt-1 shadow-sm">L</div>
                      <div className="bg-white border border-slate-100 rounded-2xl rounded-tl-sm px-5 py-4 shadow-sm">
                        <div className="flex items-center gap-2">
                          <div className="flex gap-1">
                            {[0, 150, 300].map(d => (
                              <span key={d} style={{ animationDelay: `${d}ms` }} className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" />
                            ))}
                          </div>
                          {waitingPhase && <span className="text-xs text-slate-400 animate-pulse">{waitingPhase}</span>}
                        </div>
                      </div>
                    </div>
                  )}

                  <div ref={bottomRef} />
                </div>

                {/* Input area */}
                <div className="border-t border-slate-200 bg-white px-5 py-4 shrink-0">
                  {impactMode ? (
                    <div className="p-3.5 bg-indigo-50 border border-indigo-200 rounded-2xl space-y-2.5">
                      <div className="flex items-center gap-2">
                        <span>⚡</span>
                        <span className="text-xs font-semibold text-indigo-800">Assess a Change</span>
                        <button onClick={() => { setImpactMode(false); setInput(''); }} className="ml-auto text-xs text-indigo-400 hover:text-indigo-700">Cancel</button>
                      </div>
                      <textarea
                        ref={impactRef}
                        rows={3}
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendImpact(input); }}
                        placeholder="Describe the change… (⌘↵ to submit)"
                        className="w-full border border-indigo-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 resize-none bg-white placeholder:text-slate-300"
                      />
                      <button
                        onClick={() => sendImpact(input)}
                        disabled={!input.trim() || waiting}
                        className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold disabled:opacity-40 transition-colors"
                      >
                        Analyse impact →
                      </button>
                    </div>
                  ) : (
                    <>
                      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
                      <div className="flex gap-2">
                        <input
                          ref={inputRef}
                          type="text"
                          value={input}
                          onChange={e => setInput(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage(input)}
                          placeholder={
                            scopedDocs.length > 1 ? `Ask about ${scopedDocs.length} selected documents…`
                            : scopedDocs.length === 1 ? `Ask about ${scopedDocs[0].source_name}…`
                            : 'Ask a follow-up question…'
                          }
                          disabled={waiting}
                          className="flex-1 border border-slate-200 rounded-xl px-4 py-3 text-sm bg-slate-50 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                        />
                        <button
                          onClick={() => sendMessage(input)}
                          disabled={!input.trim() || waiting}
                          className="px-4 py-3 bg-slate-900 text-white rounded-xl font-medium hover:bg-slate-700 disabled:opacity-30 transition-colors"
                        >
                          {waiting ? <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : '↑'}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Impact Card ──────────────────────────────────────────────────────────────

function ImpactCard({ result }: { result: ChangeImpactResponse }) {
  const sevColour: Record<string, string> = {
    high:   'bg-red-100 text-red-700 border-red-200',
    medium: 'bg-amber-100 text-amber-700 border-amber-200',
    low:    'bg-slate-100 text-slate-600 border-slate-200',
  };
  const sevDot: Record<string, string> = { high: 'bg-red-500', medium: 'bg-amber-400', low: 'bg-slate-400' };

  return (
    <div className="w-full max-w-[92%] space-y-3">
      <div className="bg-indigo-600 rounded-2xl rounded-tl-sm px-5 py-4 text-white">
        <div className="flex items-center gap-2 mb-2">
          <span>⚡</span>
          <span className="text-xs font-bold uppercase tracking-widest opacity-80">Change Impact Assessment</span>
        </div>
        <p className="text-sm leading-relaxed">{result.summary}</p>
      </div>

      <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden shadow-sm">
        <div className="px-4 py-2.5 border-b border-slate-100 bg-slate-50">
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Impact by Module</span>
        </div>
        <div className="divide-y divide-slate-100">
          {result.impacts.map((m, i) => (
            <div key={i} className="px-4 py-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${sevDot[m.severity] ?? 'bg-slate-400'}`} />
                <span className="text-xs font-semibold text-slate-800">{m.module}</span>
                <span className={`ml-auto text-xs px-2 py-0.5 rounded-full border font-medium ${sevColour[m.severity] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}>{m.severity}</span>
              </div>
              <p className="text-xs text-slate-600 leading-relaxed mb-1.5">{m.impact}</p>
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

      {result.risks.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-2xl px-4 py-3">
          <p className="text-[10px] font-bold text-red-700 uppercase tracking-widest mb-2">Key Risks</p>
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

      {result.recommendation && (
        <div className="bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Recommendation</p>
          <p className="text-xs text-slate-700 leading-relaxed">{result.recommendation}</p>
        </div>
      )}
    </div>
  );
}
