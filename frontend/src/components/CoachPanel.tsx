import { useState } from 'react';
import { chat, type ChatResponse, type Citation } from '../lib/api';

type Turn = {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
};

export default function CoachPanel() {
  const [history, setHistory] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSend() {
    if (!input.trim() || waiting) return;
    const userMsg = input.trim();
    setInput('');
    setError(null);
    setWaiting(true);

    const newHistory: Turn[] = [...history, { role: 'user', content: userMsg }];
    setHistory(newHistory);

    try {
      const resp = await chat(
        userMsg,
        newHistory.slice(0, -1).map((t) => ({ role: t.role, content: t.content }))
      );
      setHistory([
        ...newHistory,
        {
          role: 'assistant',
          content: resp.answer,
          citations: resp.citations,
        },
      ]);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setWaiting(false);
    }
  }

  return (
    <div className="flex flex-col h-full max-h-[calc(100vh-200px)]">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto space-y-3 mb-4">
        {history.length === 0 && (
          <div className="text-sm text-slate-400 text-center py-8">
            Ask about this tenant's Workday configuration. The coach answers
            are grounded in ingested artifacts and curated best practices.
          </div>
        )}
        {history.map((t, i) => (
          <MessageBubble key={i} turn={t} />
        ))}
        {waiting && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <div className="w-2 h-2 bg-slate-400 rounded-full animate-pulse" />
            Thinking…
          </div>
        )}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded">
            {error}
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-slate-200 pt-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSend()}
            placeholder="Ask a question…"
            disabled={waiting}
            className="flex-1 border border-slate-300 rounded px-3 py-2 text-sm"
          />
          <button
            onClick={onSend}
            disabled={!input.trim() || waiting}
            className="px-4 py-2 bg-slate-900 text-white rounded text-sm hover:bg-slate-800 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ turn }: { turn: Turn }) {
  const isUser = turn.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-2 text-sm ${
          isUser
            ? 'bg-slate-900 text-white'
            : 'bg-slate-100 text-slate-900 border border-slate-200'
        }`}
      >
        <p className="whitespace-pre-wrap">{turn.content}</p>
        {turn.citations && turn.citations.length > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-300 space-y-1.5">
            <div className="text-xs text-slate-600 font-medium">Sources</div>
            {turn.citations.map((c, i) => (
              <CitationPill key={i} citation={c} index={i + 1} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CitationPill({ citation, index }: { citation: Citation; index: number }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-baseline gap-1.5 text-left hover:bg-slate-200 rounded px-2 py-1 transition"
      >
        <span className="font-mono font-semibold text-slate-700">[{index}]</span>
        <span className="text-slate-600">{citation.source_name}</span>
        {citation.module && (
          <span className="text-slate-500">· {citation.module}</span>
        )}
      </button>
      {expanded && (
        <div className="ml-6 mt-1 bg-white border border-slate-300 rounded p-2 text-slate-700">
          <div className="text-[11px] text-slate-500 mb-1">
            Type: {citation.doc_type} · Chunk: {citation.chunk_index} · Score:{' '}
            {citation.score.toFixed(3)}
          </div>
          <p className="italic">{citation.excerpt}</p>
        </div>
      )}
    </div>
  );
}
