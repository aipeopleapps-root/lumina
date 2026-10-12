import { useState, useRef, useEffect } from 'react';
import { chat as chatApi } from '../lib/api';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

const STARTERS = [
  'What are the config steps for setting up a new Pay Group in Workday Payroll?',
  'How should we sequence HCM and Payroll go-live for a phased rollout?',
  'What are the key risks in a mid-year Workday Payroll cutover?',
  'How do Compensation Grade Profiles interact with Merit process?',
  "What's the best approach for migrating employee data from the legacy system?",
  'How do we configure role-based security for a shared services model?',
];

const TOPIC_CHIPS = [
  { label: 'Config', icon: '⚙️' },
  { label: 'Integrations', icon: '🔗' },
  { label: 'Data Migration', icon: '📦' },
  { label: 'Security', icon: '🔒' },
  { label: 'Best Practices', icon: '✅' },
  { label: 'Risks', icon: '⚠️' },
];

function MarkdownMessage({ content }: { content: string }) {
  const lines = content.split('\n');
  const elements: JSX.Element[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('## ')) {
      elements.push(<h2 key={i} className="text-xs font-semibold text-slate-700 uppercase tracking-wide mt-3 mb-1 first:mt-0">{line.slice(3)}</h2>);
    } else if (line.startsWith('**') && line.endsWith('**') && line.length > 4) {
      const text = line.slice(2, -2);
      elements.push(<p key={i} className="text-xs font-semibold text-slate-800 mt-2 mb-0.5">{text}</p>);
    } else if (/^\*\*[^*]+:\*\*/.test(line)) {
      const parts = line.split(/(\*\*[^*]+:\*\*)/);
      elements.push(
        <p key={i} className="text-xs text-slate-700 leading-relaxed">
          {parts.map((p, j) =>
            /^\*\*[^*]+:\*\*$/.test(p)
              ? <strong key={j} className="font-semibold text-slate-800">{p.replace(/\*\*/g, '')}</strong>
              : p
          )}
        </p>
      );
    } else if (line.startsWith('- ') || line.startsWith('• ')) {
      elements.push(
        <li key={i} className="flex items-start gap-1.5 text-xs text-slate-700">
          <span className="text-slate-400 mt-0.5 flex-shrink-0">·</span>
          <span>{line.slice(2)}</span>
        </li>
      );
    } else if (/^\d+\.\s/.test(line)) {
      const num = line.match(/^(\d+)\.\s/)?.[1];
      elements.push(
        <li key={i} className="flex items-start gap-1.5 text-xs text-slate-700">
          <span className="text-slate-400 mt-0.5 flex-shrink-0 w-3">{num}.</span>
          <span>{line.replace(/^\d+\.\s/, '')}</span>
        </li>
      );
    } else if (line.startsWith('---')) {
      elements.push(<hr key={i} className="border-slate-200 my-2" />);
    } else if (line.trim() === '') {
      if (elements.length > 0) elements.push(<div key={i} className="h-1" />);
    } else {
      const inlined = line.replace(/`([^`]+)`/g, '<code class="bg-slate-100 text-slate-700 px-1 py-0.5 rounded text-[11px] font-mono">$1</code>');
      elements.push(
        <p key={i} className="text-xs text-slate-700 leading-relaxed"
          dangerouslySetInnerHTML={{ __html: inlined }} />
      );
    }
    i++;
  }

  return <div className="space-y-0.5">{elements}</div>;
}

export function ConsultantChat({ clientName }: { clientName?: string }) {
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
      const res = await chatApi(text, history, { mode: 'consultant_advisor' });
      setMessages(prev => [...prev, { role: 'assistant', content: res.answer }]);
    } catch (err: any) {
      setError(err.message || 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  function sendTopicChip(label: string) {
    sendMessage(`Give me guidance on ${label} in the context of this Workday implementation.`);
  }

  const hasMessages = messages.length > 0;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-white">
      {/* Header */}
      <div className="px-5 py-3 border-b border-gray-100 bg-white flex items-center gap-3 shrink-0">
        <div className="w-8 h-8 rounded-full bg-slate-900 flex items-center justify-center">
          <svg className="w-4 h-4 text-[#86BC25]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-gray-900">Consultant Coach</p>
          <p className="text-xs text-gray-400">
            {clientName ? `${clientName} — solutioning & delivery guidance` : 'Workday solutioning & delivery guidance'}
          </p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {!hasMessages && (
          <div className="flex flex-col items-center justify-center h-full gap-6 pb-8">
            <div className="text-center">
              <p className="text-sm font-medium text-gray-700 mb-1">Ask a delivery question</p>
              <p className="text-xs text-gray-400 max-w-xs mx-auto">Get technical Workday guidance, config steps, risk flags, and delivery notes grounded in your client's documents.</p>
            </div>
            {/* Topic chips */}
            <div className="flex flex-wrap gap-2 justify-center max-w-sm">
              {TOPIC_CHIPS.map(chip => (
                <button
                  key={chip.label}
                  onClick={() => sendTopicChip(chip.label)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-slate-200 hover:border-slate-900 hover:bg-slate-900 hover:text-white text-xs text-slate-600 transition-all"
                >
                  <span>{chip.icon}</span>
                  {chip.label}
                </button>
              ))}
            </div>
            {/* Starter questions */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-lg">
              {STARTERS.map(s => (
                <button
                  key={s}
                  onClick={() => sendMessage(s)}
                  className="text-left text-xs px-3 py-2.5 rounded-full border border-gray-200 hover:border-slate-900 hover:bg-slate-50 text-gray-600 hover:text-slate-900 transition-colors"
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
              <div className="max-w-sm bg-slate-900 text-white text-sm rounded-2xl rounded-tr-sm px-4 py-2.5">
                {msg.content}
              </div>
            ) : (
              <div className="max-w-2xl w-full bg-slate-50 border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-3">
                <MarkdownMessage content={msg.content} />
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="flex items-center gap-1.5 px-4 py-2.5 rounded-2xl rounded-tl-sm bg-slate-100">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:-0.3s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:-0.15s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" />
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
            placeholder="Ask about config, integrations, data migration, risks…"
            disabled={loading}
            className="flex-1 text-sm border border-gray-200 rounded-full px-4 py-2 focus:outline-none focus:ring-2 focus:ring-slate-300 disabled:bg-gray-50"
          />
          <button
            type="submit"
            disabled={!input.trim() || loading}
            className="w-9 h-9 rounded-full bg-slate-900 hover:bg-slate-700 disabled:opacity-40 flex items-center justify-center transition-colors"
          >
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}
