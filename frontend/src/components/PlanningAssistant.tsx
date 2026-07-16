import { useEffect, useRef, useState } from 'react';
import { getPlan, updatePlanWithInstruction, savePlanTasks, type PiPlan, type PiPlanTask, type PiChatMessage } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';

const WELCOME: PiChatMessage = {
  role: 'assistant',
  ts: '',
  content:
    "Welcome to the Transformation Planner!\n\nI'm here to help you create a detailed implementation plan grounded " +
    "in the AI agents already defined for this process.\n\n**To get started**, tell me about your rollout:\n" +
    '- What timeline or resource constraints do you have?\n' +
    '- Which agent should be built first?\n' +
    '- Any phases you want called out explicitly?\n\n' +
    "Or just say \"build the plan\" and I'll draft one from the proposed agents.",
};

function fmtShort(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function newTaskId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

interface Props {
  processId: string;
  onBack: () => void;
}

export function PlanningAssistant({ processId, onBack }: Props) {
  const [plan, setPlan] = useState<PiPlan | null>(null);
  const [tasks, setTasks] = useState<PiPlanTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [granularity, setGranularity] = useState<'day' | 'week' | 'month'>('week');

  const [chatInput, setChatInput] = useState('');
  const [nlInput, setNlInput] = useState('');
  const [sending, setSending] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const p = await getPlan(processId);
        if (cancelled) return;
        setPlan(p);
        setTasks(p.tasks);
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Failed to load plan');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [processId]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [plan?.chat_history.length]);

  async function sendInstruction(instruction: string) {
    if (!instruction.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      const updated = await updatePlanWithInstruction(processId, instruction.trim());
      setPlan(updated);
      setTasks(updated.tasks);
      setDirty(false);
    } catch (err: any) {
      setError(err.message || 'Update failed');
    } finally {
      setSending(false);
    }
  }

  function handleChatSend() {
    const msg = chatInput;
    setChatInput('');
    sendInstruction(msg);
  }

  function handleNlUpdate() {
    const msg = nlInput;
    setNlInput('');
    sendInstruction(msg);
  }

  function updateTaskField(taskId: string, field: 'name' | 'start_date' | 'end_date', value: string) {
    setTasks(prev => prev.map(t => (t.task_id === taskId ? { ...t, [field]: value } : t)));
    setDirty(true);
  }

  function addTask() {
    const lastPhase = [...tasks].reverse().find(t => t.is_phase_header)?.phase ?? 'Unphased';
    const today = todayIso();
    setTasks(prev => [...prev, {
      task_id: newTaskId(), phase: lastPhase, name: 'New Task',
      start_date: today, end_date: today, dependencies: [], is_milestone: false, is_phase_header: false,
    }]);
    setDirty(true);
  }

  function deleteSelected() {
    if (!selectedTaskId) return;
    setTasks(prev => prev.filter(t => t.task_id !== selectedTaskId));
    setSelectedTaskId(null);
    setDirty(true);
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      const updated = await savePlanTasks(processId, tasks);
      setPlan(updated);
      setTasks(updated.tasks);
      setDirty(false);
    } catch (err: any) {
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  // ── Timeline range ──────────────────────────────────────────────────────
  const allDates = tasks.flatMap(t => [t.start_date, t.end_date]).filter(Boolean);
  const rangeStart = allDates.length ? new Date(allDates.reduce((a, b) => (a < b ? a : b)) + 'T00:00:00') : new Date();
  const rangeEndRaw = allDates.length ? new Date(allDates.reduce((a, b) => (a > b ? a : b)) + 'T00:00:00') : new Date();
  const totalDays = Math.max(1, Math.round((rangeEndRaw.getTime() - rangeStart.getTime()) / 86400000)) + 1;

  function pct(iso: string): number {
    const d = new Date(iso + 'T00:00:00');
    return Math.max(0, Math.min(100, ((d.getTime() - rangeStart.getTime()) / 86400000 / totalDays) * 100));
  }
  function widthPct(startIso: string, endIso: string): number {
    const s = new Date(startIso + 'T00:00:00');
    const e = new Date(endIso + 'T00:00:00');
    const days = Math.max(1, Math.round((e.getTime() - s.getTime()) / 86400000) + 1);
    return Math.max(1.5, (days / totalDays) * 100);
  }

  const stepDays = granularity === 'day' ? 2 : granularity === 'week' ? 7 : 30;
  const ticks: string[] = [];
  for (let d = 0; d <= totalDays; d += stepDays) {
    const dt = new Date(rangeStart.getTime() + d * 86400000);
    ticks.push(dt.toISOString().slice(0, 10));
  }

  const PHASE_COLORS = ['#0071E3', '#34C759', '#FF9F0A', '#AF52DE', '#FF2D55', '#5AC8FA'];
  const phaseColor = (phase: string) => {
    const phaseNames = [...new Set(tasks.filter(t => t.is_phase_header).map(t => t.phase))];
    const idx = phaseNames.indexOf(phase);
    return PHASE_COLORS[idx >= 0 ? idx % PHASE_COLORS.length : 0];
  };

  if (loading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F5F5F7', fontFamily: FONT }}>
        <div style={{ width: 32, height: 32, border: '3px solid #E5E5EA', borderTopColor: '#0071E3', borderRadius: '50%',
          animation: 'plan-spin 0.9s linear infinite' }} />
        <style>{`@keyframes plan-spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    );
  }

  const chatMessages = plan?.chat_history.length ? plan.chat_history : [];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#F5F5F7', fontFamily: FONT, overflow: 'hidden' }}>
      {/* Top bar */}
      <div style={{ background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(12px)', borderBottom: '1px solid #E5E5EA',
        padding: '12px 24px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <button onClick={onBack}
          style={{ padding: '7px 14px', borderRadius: 980, fontSize: 13, fontWeight: 500, border: '1px solid #E5E5EA',
            cursor: 'pointer', background: '#fff', color: '#6E6E73', display: 'flex', alignItems: 'center', gap: 5, fontFamily: FONT }}>
          <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
          Agentic Workflow
        </button>
        <span style={{ fontSize: 15, fontWeight: 700, color: '#1D1D1F' }}>AI Planning Assistant</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* Left: chat */}
        <div style={{ width: 340, flexShrink: 0, borderRight: '1px solid #E5E5EA', background: '#fff',
          display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <ChatBubble msg={WELCOME} />
            {chatMessages.map((m, i) => <ChatBubble key={i} msg={m} />)}
            {sending && (
              <div style={{ alignSelf: 'flex-start', background: '#F5F5F7', borderRadius: 12, padding: '8px 12px', fontSize: 12, color: '#8E8E93' }}>
                Thinking…
              </div>
            )}
            <div ref={chatBottomRef} />
          </div>
          <div style={{ borderTop: '1px solid #E5E5EA', padding: 12 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={chatInput} onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleChatSend(); }}
                placeholder="Describe your transformation initiative…"
                style={{ flex: 1, border: '1.5px solid #E5E5EA', borderRadius: 980, padding: '9px 14px',
                  fontSize: 13, fontFamily: FONT, outline: 'none', color: '#1D1D1F' }} />
              <button onClick={handleChatSend} disabled={sending || !chatInput.trim()}
                style={{ width: 34, height: 34, borderRadius: '50%', border: 'none', flexShrink: 0,
                  background: chatInput.trim() ? '#0071E3' : '#E5E5EA', color: '#fff', cursor: chatInput.trim() ? 'pointer' : 'not-allowed' }}>
                ↑
              </button>
            </div>
          </div>
        </div>

        {/* Right: plan */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {/* Toolbar */}
          <div style={{ padding: '12px 20px', borderBottom: '1px solid #E5E5EA', background: '#fff',
            display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <ToolbarButton onClick={addTask}>+ Add Task</ToolbarButton>
            <ToolbarButton onClick={deleteSelected} disabled={!selectedTaskId}>Delete</ToolbarButton>
            <div style={{ display: 'flex', background: '#F5F5F7', borderRadius: 8, padding: 2, marginLeft: 4 }}>
              {(['day', 'week', 'month'] as const).map(g => (
                <button key={g} onClick={() => setGranularity(g)}
                  style={{ padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, border: 'none',
                    cursor: 'pointer', textTransform: 'capitalize', fontFamily: FONT,
                    background: granularity === g ? '#fff' : 'transparent',
                    color: granularity === g ? '#1D1D1F' : '#8E8E93',
                    boxShadow: granularity === g ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>
                  {g}
                </button>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: '#8E8E93', fontWeight: 600 }}>{tasks.filter(t => !t.is_phase_header).length} TASKS</span>
            <button onClick={handleSave} disabled={!dirty || saving}
              style={{ padding: '7px 16px', borderRadius: 980, fontSize: 13, fontWeight: 600, border: 'none',
                cursor: dirty && !saving ? 'pointer' : 'not-allowed',
                background: dirty && !saving ? '#1D1D1F' : '#E5E5EA',
                color: dirty && !saving ? '#fff' : '#C7C7CC', fontFamily: FONT }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>

          {/* NL update input */}
          <div style={{ padding: '10px 20px', borderBottom: '1px solid #E5E5EA', background: '#fff', display: 'flex', gap: 8, flexShrink: 0 }}>
            <input value={nlInput} onChange={e => setNlInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleNlUpdate(); }}
              placeholder="Update plan with natural language (e.g., 'Add a testing phase after development')"
              style={{ flex: 1, border: '1.5px solid #E5E5EA', borderRadius: 10, padding: '9px 12px',
                fontSize: 13, fontFamily: FONT, outline: 'none', color: '#1D1D1F', background: '#F5F5F7' }} />
            <button onClick={handleNlUpdate} disabled={sending || !nlInput.trim()}
              style={{ padding: '9px 18px', borderRadius: 10, fontSize: 13, fontWeight: 600, border: 'none',
                cursor: nlInput.trim() ? 'pointer' : 'not-allowed',
                background: nlInput.trim() ? '#0071E3' : '#E5E5EA', color: nlInput.trim() ? '#fff' : '#C7C7CC', fontFamily: FONT }}>
              Update
            </button>
          </div>

          {error && (
            <div style={{ background: '#FFF0F0', borderBottom: '1px solid #FFD5D5', padding: '8px 20px', flexShrink: 0 }}>
              <span style={{ color: '#FF3B30', fontSize: 12 }}>{error}</span>
            </div>
          )}

          {/* Table + timeline */}
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: '#fff' }}>
            {tasks.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#8E8E93', fontSize: 13 }}>
                No plan yet — describe your initiative in the chat to generate one.
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #E5E5EA', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
                    <th style={thStyle}>Name</th>
                    <th style={thStyle}>Start</th>
                    <th style={thStyle}>End</th>
                    <th style={thStyle}>Dependencies</th>
                    <th style={{ ...thStyle, position: 'relative' }}>
                      {ticks.map((t, i) => (
                        <span key={i} style={{ position: 'absolute', left: `${pct(t)}%`, fontSize: 10, color: '#C7C7CC', fontWeight: 400 }}>
                          {fmtShort(t)}
                        </span>
                      ))}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map(t => (
                    <tr key={t.task_id}
                      onClick={() => !t.is_phase_header && setSelectedTaskId(t.task_id)}
                      style={{
                        borderBottom: '1px solid #F5F5F7',
                        background: selectedTaskId === t.task_id ? '#F0F8FF' : t.is_phase_header ? '#FAFAFA' : '#fff',
                        cursor: t.is_phase_header ? 'default' : 'pointer',
                      }}>
                      <td style={{ ...tdStyle, fontWeight: t.is_phase_header ? 700 : 400, fontStyle: t.is_milestone ? 'italic' : 'normal',
                        paddingLeft: t.is_phase_header ? 10 : 24, textTransform: t.is_phase_header ? 'uppercase' : 'none', fontSize: t.is_phase_header ? 11.5 : 12.5 }}>
                        {t.is_phase_header ? (
                          t.name
                        ) : (
                          <input value={t.name} onChange={e => updateTaskField(t.task_id, 'name', e.target.value)}
                            style={{ border: 'none', background: 'transparent', font: 'inherit', color: 'inherit', width: '100%', outline: 'none' }} />
                        )}
                      </td>
                      <td style={tdStyle}>
                        {t.is_phase_header ? fmtShort(t.start_date) : (
                          <input type="date" value={t.start_date} onChange={e => updateTaskField(t.task_id, 'start_date', e.target.value)}
                            style={{ border: 'none', background: 'transparent', font: 'inherit', color: 'inherit', outline: 'none' }} />
                        )}
                      </td>
                      <td style={tdStyle}>
                        {t.is_phase_header ? fmtShort(t.end_date) : (
                          <input type="date" value={t.end_date} onChange={e => updateTaskField(t.task_id, 'end_date', e.target.value)}
                            style={{ border: 'none', background: 'transparent', font: 'inherit', color: 'inherit', outline: 'none' }} />
                        )}
                      </td>
                      <td style={{ ...tdStyle, color: '#8E8E93', fontSize: 11.5 }}>
                        {t.dependencies.length ? t.dependencies.join(', ') : '–'}
                      </td>
                      <td style={{ ...tdStyle, position: 'relative', height: 30 }}>
                        {t.is_milestone ? (
                          <div style={{ position: 'absolute', left: `${pct(t.start_date)}%`, top: '50%', width: 9, height: 9,
                            background: '#FF9F0A', transform: 'translate(-50%, -50%) rotate(45deg)', borderRadius: 2 }} />
                        ) : (
                          <div style={{ position: 'absolute', left: `${pct(t.start_date)}%`, width: `${widthPct(t.start_date, t.end_date)}%`,
                            top: t.is_phase_header ? '35%' : '30%', height: t.is_phase_header ? 8 : 12, borderRadius: 4,
                            background: phaseColor(t.phase), opacity: t.is_phase_header ? 0.9 : 0.55 }} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 11, fontWeight: 700, color: '#8E8E93', textTransform: 'uppercase', letterSpacing: 0.4 };
const tdStyle: React.CSSProperties = { padding: '6px 10px', color: '#1D1D1F', verticalAlign: 'middle' };

function ToolbarButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ padding: '7px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, border: '1px solid #E5E5EA',
        cursor: disabled ? 'not-allowed' : 'pointer', background: '#fff', color: disabled ? '#C7C7CC' : '#1D1D1F', fontFamily: FONT }}>
      {children}
    </button>
  );
}

function ChatBubble({ msg }: { msg: PiChatMessage }) {
  const isUser = msg.role === 'user';
  return (
    <div style={{ alignSelf: isUser ? 'flex-end' : 'flex-start', maxWidth: '90%' }}>
      <div style={{
        borderRadius: 12, padding: '10px 13px', fontSize: 12.5, lineHeight: 1.55,
        background: isUser ? '#1D1D1F' : '#F5F5F7', color: isUser ? '#fff' : '#1D1D1F',
        borderTopRightRadius: isUser ? 3 : 12, borderTopLeftRadius: isUser ? 12 : 3,
      }}>
        {isUser ? msg.content : renderMarkdown(msg.content)}
      </div>
    </div>
  );
}
