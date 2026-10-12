import React, { useEffect, useRef, useState } from 'react';
import { askStueyChat, askStueyFeedback, type AskStueySource, type AskStueyConfidence, type AskStueyMode } from '../lib/api';

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';
const ACCENT = '#16A34A';
const CRANKY_ACCENT = '#B45309';

const MODE_COPY: Record<AskStueyMode, { greeting: string; cleared: string; error: string }> = {
  regular: {
    greeting: "G'day, Stuey here 👋 Tell me what you're after — pricing, SKU guides, benchmarking, proposal content — and I'll dig up the right one. I've probably seen every version of it already.",
    cleared: 'Clean slate — what are you after?',
    error: 'Something went wrong on my end — mind trying that again?',
  },
  cranky: {
    greeting: "Right. What do you need. I'll find it — I always do — but let's not pretend either of us is thrilled about it.",
    cleared: "Fine. Clean slate. What is it this time?",
    error: "Something broke on my end. Not my doing. Try again.",
  },
};

export type StueyContext = 'platform-home' | 'client-picker' | 'rfp-reimagine' | 'workspace';

type Props = {
  context: StueyContext;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Fills the whole viewport instead of floating bottom-right, and drops the
  // FAB/nudge/hide/maximize chrome entirely — window management is the OS's
  // job once this is opened as its own app (see StueyStandalone.tsx), not
  // something the chat itself needs to offer.
  standalone?: boolean;
};

type Message = {
  role: 'stuey' | 'user';
  text: string;
  sources?: AskStueySource[];
  confidence?: AskStueyConfidence;
  feedbackable?: boolean; // only real Q&A replies from send() get a thumbs up/down, not greetings
  feedback?: 'up' | 'down';
};

const CONFIDENCE_STYLE: Record<Exclude<AskStueyConfidence, 'none'>, { label: string; color: string; dot: string }> = {
  high: { label: 'High confidence', color: '#0C7A3D', dot: ACCENT },
  medium: { label: 'Moderate confidence', color: '#B45309', dot: '#F59E0B' },
  low: { label: 'Low confidence', color: '#B91C1C', dot: '#EF4444' },
};

// Page-context nudge bubble only — a light, non-AI hint shown before the person has
// asked anything. Once they actually type a question, `send()` below calls the real
// backend (ask_stuey_chat, grounded in the firm-knowledge document store) instead.
const NUDGES: Record<StueyContext, string> = {
  'platform-home': "New here? Process Intelligence and RFP Reimagine are ready to try — the rest are on the way.",
  'client-picker': 'Pick any client here to open Process Intelligence for their engagement.',
  'rfp-reimagine': 'Filling in Business Drivers and Current Systems in Additional Context sharpens the draft a lot.',
  'workspace': 'Upload a process diagram or Workday workbook from Documents to get started with Process Intelligence.',
};

const AVATAR_SRC = '/stuey-avatar.jpg';

// ── Draggable FAB positioning — the icon used to be pinned to a fixed
// bottom-right corner, which meant it permanently covered whatever happened
// to live there on some screens. Position is tracked in top-left pixel
// coordinates (simpler to clamp/reason about than bottom/right offsets) and
// persisted so a dragged position survives a reload.
const FAB_SIZE = 56;
const FAB_MARGIN = 16;
const FAB_POS_KEY = 'stuey-fab-pos';

function clampFabPos(x: number, y: number): { x: number; y: number } {
  if (typeof window === 'undefined') return { x, y };
  const maxX = Math.max(FAB_MARGIN, window.innerWidth - FAB_SIZE - FAB_MARGIN);
  const maxY = Math.max(FAB_MARGIN, window.innerHeight - FAB_SIZE - FAB_MARGIN);
  return { x: Math.min(Math.max(FAB_MARGIN, x), maxX), y: Math.min(Math.max(FAB_MARGIN, y), maxY) };
}

function defaultFabPos(): { x: number; y: number } {
  if (typeof window === 'undefined') return { x: 24, y: 24 };
  return clampFabPos(window.innerWidth - FAB_SIZE - 24, window.innerHeight - FAB_SIZE - 24);
}

function loadFabPos(): { x: number; y: number } {
  if (typeof window === 'undefined') return { x: 24, y: 24 };
  try {
    const saved = window.localStorage.getItem(FAB_POS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') return clampFabPos(parsed.x, parsed.y);
    }
  } catch { /* malformed/missing — fall through to the default corner */ }
  return defaultFabPos();
}

// Opens upward, right-aligned to the FAB (matching the original bottom-right
// placement) by default, but flips to whichever side actually has room so a
// FAB dragged near an edge never opens something off-screen.
function anchorNear(fab: { x: number; y: number }, boxW: number, boxH: number, gap: number): { left: number; top: number } {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  let top = fab.y - boxH - gap;
  if (top < FAB_MARGIN) top = Math.min(fab.y + FAB_SIZE + gap, vh - boxH - FAB_MARGIN);
  top = Math.max(FAB_MARGIN, Math.min(top, vh - boxH - FAB_MARGIN));
  let left = fab.x + FAB_SIZE - boxW;
  left = Math.max(FAB_MARGIN, Math.min(left, vw - boxW - FAB_MARGIN));
  return { left, top };
}

function IcExpand() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" />
    </svg>
  );
}

function IcCompress() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 6h4V2M14 6h-4V2M2 10h4v4M14 10h-4v4" />
    </svg>
  );
}

// Thumb-down is thumb-up rotated 180° — same path, no need to hand-author a second one.
function IcThumbUp({ filled = false, flipped = false }: { filled?: boolean; flipped?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={flipped ? { transform: 'rotate(180deg)' } : undefined}>
      <path d="M7 10v11" />
      <path d="M7 10l3.5-7a1.5 1.5 0 0 1 2.7 0l.3.6a2 2 0 0 1 .1 1.5L12.4 9H18a2 2 0 0 1 2 2.3l-1.3 8A2 2 0 0 1 16.7 21H7" />
    </svg>
  );
}

// There's only one photo of Stuey — no separate cranky-expression asset exists, and
// nothing here can redraw his face. So "cranky" is conveyed two ways instead: a
// desaturated, harder-contrast tint on the same photo (the same trick a moody photo
// filter uses — warm and bright reads friendly, flat and cool reads irritable), plus
// an unambiguous mood badge overlaid on the avatar itself, not just the chrome around
// it — the ring/pulse color alone was easy to miss at a glance.
function StueyAvatar({ size, ring = true, pulse = false, accent = ACCENT, cranky = false }: {
  size: number; ring?: boolean; pulse?: boolean; accent?: string; cranky?: boolean;
}) {
  const shadows = [ring ? `0 0 0 2px #FFFFFF, 0 0 0 3.5px ${accent}` : '', pulse ? `0 0 0 8px ${accent}22` : '']
    .filter(Boolean).join(', ');
  const badgeSize = Math.max(14, Math.round(size * 0.42));
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0, display: 'inline-block' }}>
      <img src={AVATAR_SRC} alt="Stuey" draggable={false} style={{
        width: size, height: size, borderRadius: '50%', objectFit: 'cover', display: 'block',
        boxShadow: shadows || undefined, transition: 'box-shadow 0.3s ease, filter 0.3s ease',
        filter: cranky ? 'saturate(0.5) contrast(1.15) brightness(0.92) sepia(0.15)' : undefined,
      }} />
      {cranky && size >= 24 && (
        <span aria-hidden style={{
          position: 'absolute', bottom: -2, right: -2, width: badgeSize, height: badgeSize,
          borderRadius: '50%', background: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: Math.max(9, Math.round(badgeSize * 0.62)), lineHeight: 1,
          boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
        }}>😤</span>
      )}
    </div>
  );
}

export default function AskStuey({ context, open, onOpenChange, standalone = false }: Props) {
  const [nudge, setNudge] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [maximized, setMaximized] = useState(false);
  // Persisted across sessions — a one-time toggle pick shouldn't reset every time the
  // widget reopens. Falls back to 'regular' for anyone who's never set it.
  const [mode, setMode] = useState<AskStueyMode>(() => {
    const saved = localStorage.getItem('stuey-mode');
    return saved === 'cranky' ? 'cranky' : 'regular';
  });
  const accent = mode === 'cranky' ? CRANKY_ACCENT : ACCENT;
  const shownContexts = useRef<Set<StueyContext>>(new Set());
  const hasGreeted = useRef(false);
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [fabPos, setFabPos] = useState(() => loadFabPos());
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean; curX: number; curY: number } | null>(null);

  useEffect(() => { localStorage.setItem('stuey-mode', mode); }, [mode]);

  // Re-clamp on resize so a position saved on a wide screen doesn't strand
  // the icon off-screen after a resize/rotate.
  useEffect(() => {
    function onResize() { setFabPos(p => clampFabPos(p.x, p.y)); }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function handleFabPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: fabPos.x, origY: fabPos.y, moved: false, curX: fabPos.x, curY: fabPos.y };
  }
  function handleFabPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const ds = dragState.current;
    if (!ds) return;
    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) ds.moved = true;
    if (ds.moved) {
      const next = clampFabPos(ds.origX + dx, ds.origY + dy);
      ds.curX = next.x; ds.curY = next.y;
      setFabPos(next);
    }
  }
  function handleFabPointerUp() {
    const ds = dragState.current;
    dragState.current = null;
    if (!ds) return;
    if (ds.moved) {
      localStorage.setItem(FAB_POS_KEY, JSON.stringify({ x: ds.curX, y: ds.curY }));
    } else {
      onOpenChange(!open);
    }
  }

  function switchMode(next: AskStueyMode) {
    if (next === mode) return;
    setMode(next);
    // A conversation started in one voice reading as continuous in the other would be
    // jarring — same reasoning "Clear chat" already exists as an explicit action, just
    // triggered automatically here since changing persona IS starting over.
    setMessages([{ role: 'stuey', text: MODE_COPY[next].greeting }]);
    setInput('');
  }

  useEffect(() => {
    if (open || shownContexts.current.has(context)) return;
    nudgeTimer.current = setTimeout(() => {
      shownContexts.current.add(context);
      setNudge(NUDGES[context]);
    }, 5000);
    return () => { if (nudgeTimer.current) clearTimeout(nudgeTimer.current); };
  }, [context, open]);

  useEffect(() => {
    if (open) setNudge(null);
    else setMaximized(false); // always reopen minimized, never straight to fullscreen
    if (open && !hasGreeted.current) {
      hasGreeted.current = true;
      setMessages([{ role: 'stuey', text: MODE_COPY[mode].greeting }]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function clearChat() {
    setMessages([{ role: 'stuey', text: MODE_COPY[mode].cleared }]);
    setInput('');
  }

  const [downCommentIndex, setDownCommentIndex] = useState<number | null>(null);
  const [downComment, setDownComment] = useState('');

  function precedingUserText(index: number): string {
    for (let i = index - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].text;
    }
    return '';
  }

  async function rateUp(index: number) {
    const m = messages[index];
    setMessages(ms => ms.map((msg, i) => i === index ? { ...msg, feedback: 'up' } : msg));
    try {
      await askStueyFeedback({
        message: precedingUserText(index), reply: m.text,
        sources: (m.sources ?? []).map(s => s.source_name), rating: 'up',
      });
    } catch { /* best-effort — don't interrupt the chat over a feedback-logging failure */ }
  }

  function openDownComment(index: number) {
    setDownCommentIndex(index);
    setDownComment('');
  }

  async function submitDown(index: number) {
    const m = messages[index];
    const comment = downComment.trim();
    setMessages(ms => ms.map((msg, i) => i === index ? { ...msg, feedback: 'down' } : msg));
    setDownCommentIndex(null);
    try {
      await askStueyFeedback({
        message: precedingUserText(index), reply: m.text,
        sources: (m.sources ?? []).map(s => s.source_name), rating: 'down', comment,
      });
    } catch { /* best-effort — don't interrupt the chat over a feedback-logging failure */ }
  }

  async function send() {
    const text = input.trim();
    if (!text || thinking) return;
    setInput('');
    const history = messages.map(m => ({ role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.text }));
    setMessages(m => [...m, { role: 'user', text }]);
    setThinking(true);
    try {
      const { reply, sources, confidence } = await askStueyChat({ message: text, history, mode });
      setMessages(m => [...m, { role: 'stuey', text: reply, sources: sources.filter(s => s.url), confidence, feedbackable: true }]);
    } catch {
      setMessages(m => [...m, { role: 'stuey', text: MODE_COPY[mode].error }]);
    } finally {
      setThinking(false);
    }
  }

  const nudgeAnchor = anchorNear(fabPos, 260, 150, 12);
  const panelAnchor = anchorNear(fabPos, 400, 540, 12);

  return (
    <div style={standalone ? { position: 'fixed', inset: 0, zIndex: 200, fontFamily: FONT } : { fontFamily: FONT }}>
      {/* Nudge bubble — anchored near the FAB's current (draggable) position. */}
      {!standalone && nudge && !open && (
        <div style={{
          position: 'fixed', left: nudgeAnchor.left, top: nudgeAnchor.top, width: 260, background: '#FFFFFF',
          borderRadius: 14, border: '1px solid #E5E5EA', boxShadow: '0 10px 30px rgba(0,0,0,0.12)',
          padding: '14px 16px', animation: 'stuey-fade-in 0.25s ease', zIndex: 200,
        }}>
          <style>{'@keyframes stuey-fade-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }'}</style>
          <button onClick={() => setNudge(null)} aria-label="Dismiss"
            style={{ position: 'absolute', top: 8, right: 8, background: 'none', border: 'none', color: '#AEAEB2', fontSize: 14, cursor: 'pointer', padding: 2, lineHeight: 1 }}>
            ×
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <StueyAvatar size={18} ring={false} cranky={mode === 'cranky'} />
            <p style={{ fontSize: 11, fontWeight: 700, color: ACCENT, textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>Stuey</p>
          </div>
          <p style={{ fontSize: 13, color: '#3A3A3C', lineHeight: 1.45, margin: 0, paddingRight: 8 }}>{nudge}</p>
          <button onClick={() => onOpenChange(true)} style={{
            marginTop: 10, background: 'none', border: 'none', color: ACCENT, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: 0,
          }}>
            Ask a question →
          </button>
        </div>
      )}

      {/* Chat panel — anchored near the FAB's current position (flips side/edge
          to stay on-screen if the icon's been dragged near a corner), except
          maximized mode which stays a fixed near-fullscreen corner regardless. */}
      {open && (
        <div style={standalone ? {
          position: 'fixed', inset: 0,
          background: '#FFFFFF',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          zIndex: 200,
        } : {
          position: 'fixed',
          ...(maximized ? { bottom: 24, right: 24 } : { left: panelAnchor.left, top: panelAnchor.top }),
          width: maximized ? 'calc(100vw - 48px)' : 400,
          height: maximized ? 'calc(100vh - 48px)' : 540,
          background: '#FFFFFF',
          borderRadius: 16, border: '1px solid #E5E5EA', boxShadow: '0 16px 40px rgba(0,0,0,0.16)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          transition: 'width 0.25s ease, height 0.25s ease',
          zIndex: 200,
        }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid #F0F0F0', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                {/* The masthead avatar IS the mode switch — one icon for both
                    states, mood conveyed only by the emoji badge/tint baked
                    into StueyAvatar, never spelled out in text. */}
                <button onClick={() => switchMode(mode === 'cranky' ? 'regular' : 'cranky')}
                  aria-label={mode === 'cranky' ? 'Switch to regular mode' : 'Switch to cranky mode'}
                  title={mode === 'cranky' ? 'Switch to regular mode' : 'Switch to cranky mode'}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', lineHeight: 0 }}>
                  <StueyAvatar size={28} accent={accent} cranky={mode === 'cranky'} />
                </button>
                <span style={{ fontSize: 14, fontWeight: 700, color: '#1D1D1F' }}>Ask Stuey</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button onClick={clearChat} aria-label="Clear chat" title="Clear chat"
                  style={{ background: 'none', border: 'none', color: '#8E8E93', fontSize: 15, cursor: 'pointer', padding: 4, lineHeight: 1, borderRadius: 6 }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#F5F5F7'; e.currentTarget.style.color = '#1D1D1F'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#8E8E93'; }}>
                  ↺
                </button>
                {!standalone && (
                  <button onClick={() => setMaximized(m => !m)} aria-label={maximized ? 'Minimise' : 'Maximise'} title={maximized ? 'Minimise' : 'Maximise'}
                    style={{ background: 'none', border: 'none', color: '#8E8E93', cursor: 'pointer', padding: 5, lineHeight: 1, borderRadius: 6, display: 'flex' }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#F5F5F7'; e.currentTarget.style.color = '#1D1D1F'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#8E8E93'; }}>
                    {maximized ? <IcCompress /> : <IcExpand />}
                  </button>
                )}
                {!standalone && (
                  <button onClick={() => onOpenChange(false)} aria-label="Hide" title="Hide"
                    style={{ background: 'none', border: 'none', color: '#8E8E93', fontSize: 16, cursor: 'pointer', padding: 4, lineHeight: 1 }}>
                    ×
                  </button>
                )}
              </div>
            </div>
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
                <div style={{
                  padding: m.role === 'user' ? '8px 12px' : '2px 1px',
                  borderRadius: 12,
                  background: m.role === 'user' ? '#F5F5F7' : 'transparent',
                  color: '#1D1D1F',
                  fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap',
                }}>
                  {m.text}
                </div>
                {m.role === 'stuey' && m.confidence && m.confidence !== 'none' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 6, padding: '0 2px' }}
                    title="How closely the retrieved documents matched this question">
                    <span aria-hidden style={{
                      width: 6, height: 6, borderRadius: '50%', background: CONFIDENCE_STYLE[m.confidence].dot,
                    }} />
                    <span style={{ fontSize: 11, fontWeight: 600, color: CONFIDENCE_STYLE[m.confidence].color }}>
                      {CONFIDENCE_STYLE[m.confidence].label}
                    </span>
                  </div>
                )}
                {m.sources && m.sources.length > 0 && (
                  <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {m.sources.map((s, j) => (
                      <a key={j} href={s.url ?? undefined} target="_blank" rel="noopener noreferrer" style={{
                        display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderRadius: 9,
                        background: '#FAFAFA', border: '1px solid #E5E5EA', color: '#3A3A3C',
                        fontSize: 12, fontWeight: 500, textDecoration: 'none',
                        transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease',
                      }}
                        onMouseEnter={e => {
                          e.currentTarget.style.background = '#EAFBF1';
                          e.currentTarget.style.borderColor = '#CFF3DE';
                          e.currentTarget.style.color = ACCENT;
                        }}
                        onMouseLeave={e => {
                          e.currentTarget.style.background = '#FAFAFA';
                          e.currentTarget.style.borderColor = '#E5E5EA';
                          e.currentTarget.style.color = '#3A3A3C';
                        }}>
                        <span aria-hidden style={{ opacity: 0.7, flexShrink: 0 }}>📄</span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{s.source_name}</span>
                        {s.is_canonical && <span title="Master copy" aria-hidden style={{ flexShrink: 0 }}>⭐</span>}
                        {!s.is_current && (
                          <span style={{
                            flexShrink: 0, fontSize: 9.5, fontWeight: 700, color: '#B45309', background: '#FDF3E7',
                            padding: '2px 5px', borderRadius: 4, letterSpacing: '0.02em',
                          }}>
                            OLDER VERSION
                          </span>
                        )}
                      </a>
                    ))}
                  </div>
                )}
                {m.feedbackable && (
                  <div style={{ marginTop: 6 }}>
                    {m.feedback ? (
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5,
                        color: m.feedback === 'up' ? ACCENT : '#DC2626',
                      }}>
                        <IcThumbUp filled flipped={m.feedback === 'down'} />
                        <span>{m.feedback === 'up' ? 'Thanks for the feedback' : 'Thanks — noted'}</span>
                      </div>
                    ) : downCommentIndex === i ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, background: '#F5F5F7', borderRadius: 10, padding: 8 }}>
                        <span style={{ fontSize: 11.5, color: '#6E6E73' }}>What was wrong? (optional)</span>
                        <textarea value={downComment} onChange={e => setDownComment(e.target.value)}
                          placeholder="e.g. wrong document, wrong price, missed the point of my question…"
                          rows={2}
                          style={{ resize: 'vertical', border: '1px solid #D2D2D7', borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: FONT }} />
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button onClick={() => setDownCommentIndex(null)} style={{
                            background: 'none', border: 'none', color: '#8E8E93', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', padding: '4px 8px',
                          }}>
                            Cancel
                          </button>
                          <button onClick={() => submitDown(i)} style={{
                            background: '#1D1D1F', border: 'none', color: '#fff', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', padding: '4px 10px', borderRadius: 999,
                          }}>
                            Submit
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 2 }}>
                        <button onClick={() => rateUp(i)} aria-label="Good response" title="Good response"
                          style={{ background: 'none', border: 'none', color: '#AEAEB2', cursor: 'pointer', padding: 5, borderRadius: 6, lineHeight: 1, display: 'flex' }}
                          onMouseEnter={e => { e.currentTarget.style.background = '#F5F5F7'; e.currentTarget.style.color = ACCENT; }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#AEAEB2'; }}>
                          <IcThumbUp />
                        </button>
                        <button onClick={() => openDownComment(i)} aria-label="Bad response" title="Bad response"
                          style={{ background: 'none', border: 'none', color: '#AEAEB2', cursor: 'pointer', padding: 5, borderRadius: 6, lineHeight: 1, display: 'flex' }}
                          onMouseEnter={e => { e.currentTarget.style.background = '#F5F5F7'; e.currentTarget.style.color = '#DC2626'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#AEAEB2'; }}>
                          <IcThumbUp flipped />
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            {thinking && (
              <div style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 4, padding: '8px 1px' }}>
                <style>{'@keyframes stuey-typing-dot { 0%, 60%, 100% { opacity: 0.3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-2px); } }'}</style>
                {[0, 1, 2].map(dot => (
                  <span key={dot} aria-hidden style={{
                    width: 6, height: 6, borderRadius: '50%', background: '#AEAEB2',
                    animation: 'stuey-typing-dot 1.1s ease-in-out infinite', animationDelay: `${dot * 0.15}s`,
                  }} />
                ))}
                <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}>Stuey is thinking</span>
              </div>
            )}
          </div>

          <div style={{ padding: 12, borderTop: '1px solid #F0F0F0', display: 'flex', gap: 8, flexShrink: 0 }}>
            <input value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') send(); }}
              placeholder="Ask about an app or engagement…"
              disabled={thinking}
              style={{ flex: 1, border: '1px solid #D2D2D7', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: FONT }} />
            <button onClick={send} disabled={!input.trim() || thinking} style={{
              padding: '8px 14px', borderRadius: 999, border: 'none', background: (input.trim() && !thinking) ? accent : '#D2D2D7',
              color: '#fff', fontSize: 13, fontWeight: 600, cursor: (input.trim() && !thinking) ? 'pointer' : 'not-allowed', fontFamily: FONT,
            }}>
              →
            </button>
          </div>
        </div>
      )}

      {/* FAB — freely draggable so it can be moved off whatever it's covering;
          position persists across reloads. A drag vs. a click is told apart by
          movement distance (handlePointerUp), not by a separate drag handle. */}
      {!standalone && (
        <button
          onPointerDown={handleFabPointerDown}
          onPointerMove={handleFabPointerMove}
          onPointerUp={handleFabPointerUp}
          onDragStart={e => e.preventDefault()}
          aria-label="Ask Stuey" title="Drag to move"
          style={{
            position: 'fixed', left: fabPos.x, top: fabPos.y, zIndex: 200,
            width: FAB_SIZE, height: FAB_SIZE, borderRadius: '50%', border: 'none', padding: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent',
            filter: 'drop-shadow(0 8px 20px rgba(0,0,0,0.18))',
            cursor: 'grab', touchAction: 'none',
          }}>
          <StueyAvatar size={52} pulse={!!nudge && !open} cranky={mode === 'cranky'} />
        </button>
      )}
    </div>
  );
}
