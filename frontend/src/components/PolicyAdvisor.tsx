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
  'How many days of annual leave am I entitled to?',
  'What are the rules for working from home?',
  'What health insurance benefits does Deloitte offer?',
  'What is the gift and hospitality policy?',
  'What parental leave is available?',
  'How does the annual performance bonus work?',
];

const NOT_FOUND_PHRASE = 'not available in the provided policies';

function parseAnswer(text: string): ParsedAnswer {
  const notFound = text.toLowerCase().includes(NOT_FOUND_PHRASE);
  const answerMatch = text.match(/\*\*Answer:\*\*\s*([\s\S]*?)(?=\*\*Source:|$)/i);
  const sourceMatch = text.match(/\*\*Source:\*\*\s*([\s\S]*?)(?=\*\*Quote:|$)/i);
  const quoteMatch = text.match(/\*\*Quote:\*\*\s*([\s\S]*?)(?=\*\*Confidence:|$)/i);
  const confMatch = text.match(/\*\*Confidence:\*\*\s*([\s\S]*?)(?=$)/i);

  if (!answerMatch && !notFound) {
    return { raw: text, notFound: false };
  }

  return {
    answer: answerMatch?.[1]?.trim(),
    source: sourceMatch?.[1]?.trim(),
    quote: quoteMatch?.[1]?.trim(),
    confidence: confMatch?.[1]?.trim(),
    raw: text,
    notFound,
  };
}

function ConfidenceBadge({ level }: { level: string }) {
  const upper = level.toUpperCase().split(' ')[0];
  const colors: Record<string, string> = {
    HIGH: 'bg-green-100 text-green-800 border-green-200',
    MEDIUM: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    LOW: 'bg-red-100 text-red-800 border-red-200',
  };
  const cls = colors[upper] ?? 'bg-gray-100 text-gray-700 border-gray-200';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${cls}`}>
      {level}
    </span>
  );
}

function AnswerCard({ parsed }: { parsed: ParsedAnswer }) {
  if (parsed.notFound) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <div className="flex items-start gap-2">
          <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{parsed.raw}</span>
        </div>
      </div>
    );
  }

  if (!parsed.answer) {
    return <div className="text-sm text-gray-700 whitespace-pre-wrap">{parsed.raw}</div>;
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-4">
        <p className="text-xs font-semibold text-indigo-500 uppercase tracking-wide mb-1">Answer</p>
        <p className="text-sm text-gray-800">{parsed.answer}</p>
      </div>

      {parsed.quote && (
        <blockquote className="border-l-4 border-gray-300 pl-3 pr-2 py-1 bg-gray-50 rounded-r-lg">
          <p className="text-xs italic text-gray-600">"{parsed.quote}"</p>
        </blockquote>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        {parsed.source && (
          <div className="flex items-center gap-1 text-xs text-gray-500">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span>{parsed.source}</span>
          </div>
        )}
        {parsed.confidence && <ConfidenceBadge level={parsed.confidence} />}
      </div>
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function sendMessage(text: string) {
    if (!text.trim() || loading) return;
    const userMsg: Message = { role: 'user', content: text };
    const history = messages.map(m => ({ role: m.role, content: m.content }));
    setMessages(prev => [...prev, userMsg]);
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
    }
  }

  const hasMessages = messages.length > 0;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar */}
      {policyDocs.length > 0 && (
        <aside className="w-56 shrink-0 border-r border-gray-100 bg-gray-50 flex flex-col overflow-hidden">
          <div className="px-3 py-3 border-b border-gray-100">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Policy Library</p>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {policyDocs.map(doc => (
              <div key={doc.doc_id} className="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-white text-xs text-gray-600 cursor-default">
                <svg className="w-3.5 h-3.5 mt-0.5 text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span className="leading-snug">{doc.source_name}</span>
              </div>
            ))}
          </div>
        </aside>
      )}

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3 border-b border-gray-100 bg-white flex items-center gap-3 shrink-0">
          <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">PolicyBot</p>
            <p className="text-xs text-gray-400">
              {clientName ? `${clientName} — HR policy documents` : 'Answers sourced from your uploaded policy documents'}
            </p>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {!hasMessages && (
            <div className="flex flex-col items-center justify-center h-full gap-6 pb-8">
              <div className="text-center">
                <p className="text-sm font-medium text-gray-700 mb-1">Ask a policy question</p>
                <p className="text-xs text-gray-400">Answers are drawn directly from your organisation's uploaded HR policies.</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-lg">
                {STARTERS.map(s => (
                  <button
                    key={s}
                    onClick={() => sendMessage(s)}
                    className="text-left text-xs px-3 py-2.5 rounded-lg border border-gray-200 hover:border-indigo-300 hover:bg-indigo-50 text-gray-600 hover:text-indigo-700 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {msg.role === 'user' ? (
                <div className="max-w-sm bg-indigo-600 text-white text-sm rounded-2xl rounded-tr-sm px-4 py-2.5">
                  {msg.content}
                </div>
              ) : (
                <div className="max-w-xl w-full">
                  <AnswerCard parsed={parseAnswer(msg.content)} />
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="flex items-center gap-1.5 px-4 py-2.5 rounded-2xl rounded-tl-sm bg-gray-100">
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce [animation-delay:-0.3s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce [animation-delay:-0.15s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" />
              </div>
            </div>
          )}

          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="px-5 py-3 border-t border-gray-100 bg-white shrink-0">
          <form
            onSubmit={e => { e.preventDefault(); sendMessage(input); }}
            className="flex items-center gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Ask about leave, benefits, remote work, conduct…"
              disabled={loading}
              className="flex-1 text-sm border border-gray-200 rounded-full px-4 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-300 disabled:bg-gray-50"
            />
            <button
              type="submit"
              disabled={!input.trim() || loading}
              className="w-9 h-9 rounded-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 flex items-center justify-center transition-colors"
            >
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
