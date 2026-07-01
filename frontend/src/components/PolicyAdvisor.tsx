import { useState, useRef, useEffect } from 'react';
import { chat as chatApi } from '../lib/api';

interface PolicyDoc {
  doc_id: string;
  source_name: string;
  module?: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ParsedAnswer {
  answer?: string;
  source?: string;
  quote?: string;
  confidence?: string;
  raw: string;
  notFound: boolean;
}

const STARTERS = [
  { emoji: '🏖️', label: 'Annual leave', prompt: 'How many days of annual leave am I entitled to?' },
  { emoji: '🏠', label: 'Remote work', prompt: 'What are the rules for working from home?' },
  { emoji: '🏥', label: 'Health insurance', prompt: 'What health and medical benefits are available to employees?' },
  { emoji: '👶', label: 'Parental leave', prompt: 'What parental leave is available and what are the eligibility rules?' },
  { emoji: '🎁', label: 'Gifts & hospitality', prompt: 'What is the gift and hospitality policy?' },
  { emoji: '💰', label: 'Bonus', prompt: 'How does the annual performance bonus work?' },
];

const NOT_FOUND_PHRASE = 'not available in the provided policies';

function parseAnswer(text: string): ParsedAnswer {
  const notFound = text.toLowerCase().includes(NOT_FOUND_PHRASE);
  const answerMatch = text.match(/\*\*Answer:\*\*\s*([\s\S]*?)(?=\*\*Source:|$)/i);
  const sourceMatch = text.match(/\*\*Source:\*\*\s*([\s\S]*?)(?=\*\*Quote:|$)/i);
  const quoteMatch = text.match(/\*\*Quote:\*\*\s*([\s\S]*?)(?=\*\*Confidence:|$)/i);
  const confMatch  = text.match(/\*\*Confidence:\*\*\s*([\s\S]*?)(?=$)/i);

  if (!answerMatch && !notFound) return { raw: text, notFound: false };

  return {
    answer:     answerMatch?.[1]?.trim(),
    source:     sourceMatch?.[1]?.trim(),
    quote:      quoteMatch?.[1]?.trim(),
    confidence: confMatch?.[1]?.trim(),
    raw: text,
    notFound,
  };
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**'))
          return <strong key={i} className="font-semibold text-slate-900">{part.slice(2, -2)}</strong>;
        if (part.startsWith('*') && part.endsWith('*') && part.length > 2)
          return <em key={i}>{part.slice(1, -1)}</em>;
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
      result.push(<p key={i} className="mt-3 mb-0.5 text-sm font-semibold text-slate-900">{renderInline(line.replace(/^#{1,3} /, ''))}</p>);
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

function ConfidenceBadge({ level }: { level: string }) {
  const upper = level.toUpperCase().split(' ')[0];
  const cls: Record<string, string> = {
    HIGH:   'bg-green-100 text-green-700 border-green-200',
    MEDIUM: 'bg-amber-100 text-amber-700 border-amber-200',
    LOW:    'bg-red-100 text-red-700 border-red-200',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${cls[upper] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}>
      {level} confidence
    </span>
  );
}

function AnswerCard({ parsed }: { parsed: ParsedAnswer }) {
  if (parsed.notFound) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-2">
        <svg className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
        <p className="text-sm text-amber-800">{parsed.raw}</p>
      </div>
    );
  }

  if (!parsed.answer) {
    return (
      <div className="bg-white border border-slate-100 rounded-2xl rounded-tl-sm px-5 py-4 shadow-sm">
        <MarkdownMessage text={parsed.raw} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="bg-white border border-slate-100 rounded-2xl rounded-tl-sm px-5 py-4 shadow-sm">
        <MarkdownMessage text={parsed.answer} />
      </div>

      {(parsed.quote || parsed.source || parsed.confidence) && (
        <div className="bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 space-y-2">
          {parsed.quote && (
            <blockquote className="border-l-2 border-indigo-300 pl-3">
              <p className="text-xs italic text-slate-600 leading-relaxed">"{parsed.quote}"</p>
            </blockquote>
          )}
          <div className="flex items-center gap-3 flex-wrap">
            {parsed.source && (
              <div className="flex items-center gap-1.5 text-xs text-slate-500">
                <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                {parsed.source}
              </div>
            )}
            {parsed.confidence && <ConfidenceBadge level={parsed.confidence} />}
          </div>
        </div>
      )}
    </div>
  );
}

interface Props {
  policyDocs?: PolicyDoc[];
  clientName?: string;
}

export function PolicyAdvisor({ policyDocs = [], clientName }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function sendMessage(text: string) {
    if (!text.trim() || loading) return;
    const history = messages.map(m => ({ role: m.role, content: m.content }));
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setInput('');
    setError(null);
    setLoading(true);
    try {
      const res = await chatApi(text, history, { mode: 'hr_advisor' });
      setMessages(prev => [...prev, { role: 'assistant', content: res.answer }]);
    } catch (err: any) {
      setError(err.message || 'Request failed');
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  const hasMessages = messages.length > 0;

  return (
    <div className="flex h-full overflow-hidden">

      {/* Policy library sidebar */}
      {policyDocs.length > 0 && (
        <aside className="w-56 shrink-0 border-r border-slate-200 bg-slate-50 flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-white shrink-0">
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Policy Library</p>
          </div>
          <div className="flex-1 overflow-y-auto py-2">
            {policyDocs.map(doc => (
              <div key={doc.doc_id} className="flex items-start gap-2 px-3 py-2 text-xs text-slate-600">
                <svg className="w-3.5 h-3.5 mt-0.5 text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                <span className="leading-snug">{doc.source_name}</span>
              </div>
            ))}
          </div>
        </aside>
      )}

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Messages / landing */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {!hasMessages ? (
            <div className="flex flex-col items-center justify-center h-full max-w-lg mx-auto">
              <div className="text-center mb-8">
                <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-indigo-600 mb-4 shadow-lg shadow-indigo-200">
                  <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" /></svg>
                </div>
                <h2 className="text-xl font-bold text-slate-900 mb-1.5">HR Policy Advisor</h2>
                <p className="text-sm text-slate-500">
                  {clientName ? `${clientName} — ` : ''}Ask anything about your HR policies. Answers are cited directly from your uploaded policy documents.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2.5 w-full">
                {STARTERS.map(s => (
                  <button
                    key={s.label}
                    onClick={() => sendMessage(s.prompt)}
                    className="group text-left p-3.5 rounded-2xl border border-slate-200 hover:border-indigo-200 hover:bg-indigo-50/40 transition-all"
                  >
                    <div className="text-xl mb-1.5">{s.emoji}</div>
                    <div className="text-xs font-semibold text-slate-700 mb-0.5 group-hover:text-indigo-800">{s.label}</div>
                    <div className="text-xs text-slate-400 leading-snug line-clamp-2">{s.prompt}</div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-5 max-w-3xl mx-auto">
              {messages.map((msg, i) => (
                <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'assistant' && (
                    <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0 mt-1 shadow-sm">H</div>
                  )}
                  <div className="max-w-[78%]">
                    {msg.role === 'user' ? (
                      <div className="bg-slate-900 text-white rounded-2xl rounded-tr-sm px-4 py-3">
                        <p className="text-sm leading-relaxed">{msg.content}</p>
                      </div>
                    ) : (
                      <AnswerCard parsed={parseAnswer(msg.content)} />
                    )}
                  </div>
                </div>
              ))}

              {loading && (
                <div className="flex gap-3 justify-start">
                  <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0 mt-1 shadow-sm">H</div>
                  <div className="bg-white border border-slate-100 rounded-2xl rounded-tl-sm px-5 py-4 shadow-sm">
                    <div className="flex gap-1">
                      {[0, 150, 300].map(d => (
                        <span key={d} style={{ animationDelay: `${d}ms` }} className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" />
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {error && (
                <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{error}</div>
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="border-t border-slate-200 bg-white px-5 py-4 shrink-0">
          <div className="flex gap-2 max-w-3xl mx-auto">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendMessage(input)}
              placeholder="Ask about leave, benefits, conduct, remote work…"
              disabled={loading}
              className="flex-1 border border-slate-200 rounded-xl px-4 py-3 text-sm bg-slate-50 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
            />
            <button
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || loading}
              className="px-4 py-3 bg-slate-900 text-white rounded-xl font-medium hover:bg-slate-700 disabled:opacity-30 transition-colors"
            >
              {loading ? <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : '↑'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
