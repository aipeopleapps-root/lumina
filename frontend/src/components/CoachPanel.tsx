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
    <div className="flex flex-col flex-1 min-h-0">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto space-y-3 mb-4">
        {history.length === 0 && (
          <div className="text-sm text-slate-400 text-center py-8">
            Ask about this client's Workday configuration. Answers are grounded in uploaded documents.
          </div>
        )}
        {history.map((turn, i) => (
          <div
            key={i}
            className={
              turn.role === 'user'
                ? 'bg-slate-100 rounded-lg p-3 text-sm'
                : 'bg-white border border-slate-200 rounded-lg p-3 text-sm'
            }
          >
            <div className="font-medium text-xs text-slate-500 mb-1">
              {turn.role === 'user' ? 'You' : 'Ask Workday Expert'}
            </div>
            <div className="whitespace-pre-wrap">{turn.content}</div>
            {turn.citations && turn.citations.length > 0 && (
              <div className="mt-2 pt-2 border-t border-slate-200">
                <div className="text-xs text-slate-500 mb-1">Sources:</div>
                <ul className="text-xs space-y-1">
                  {turn.citations.map((c, j) => (
                    <li key={j} className="text-slate-600">
                      • {c.source_name} ({c.doc_type}, {c.module})
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Input area */}
      <div className="border-t border-slate-200 pt-4">
        {error && (
          <p className="text-sm text-red-600 mb-2">{error}</p>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSend()}
            placeholder="Ask a question..."
            disabled={waiting}
            className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm disabled:opacity-50"
          />
          <button
            onClick={onSend}
            disabled={!input.trim() || waiting}
            className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm hover:bg-slate-800 disabled:opacity-50"
          >
            {waiting ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
