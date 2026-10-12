import { useState } from 'react';

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';

// Shared across every Process Intelligence screen (the As-Is/Agentic workspace,
// Planning Assistant) — not just the workspace tab bar — so navigating into
// Generate Plan (or, eventually, an agent's design doc) never "loses" the
// overall flow the way a plain back-link does. `activeScreen` is whichever of
// the three destinations the stepper itself can navigate between is currently
// showing; Upload is always shown as done since this only renders once a
// graph already exists.
//
// Generate/Regenerate Demo used to be its own milestone node here, but the
// Agentic Redesign screen's own rail now has an "Agents" / "Review & Demo"
// tab pair covering exactly that — a separate top-level node duplicated a
// destination reachable one click after Agentic Redesign, so it's gone; that
// screen's own tabs are the only place demo generation lives now.
export type PipelineScreen = 'asis' | 'agentic' | 'plan';

export function PipelineStepper({
  activeScreen, agenticUnlocked, stepCount, confPct, agentCount,
  onNavigate, onOpenPlan,
}: {
  activeScreen: PipelineScreen;
  agenticUnlocked: boolean;
  stepCount: number; confPct: number; agentCount: number;
  onNavigate: (screen: 'asis' | 'agentic') => void;
  // Omitted (rather than passed as a no-op) when already on the Plan screen —
  // that step reads as "you are here" instead of a dead click.
  onOpenPlan?: () => void;
}) {
  const asisState: 'current' | 'done' = activeScreen === 'asis' ? 'current' : 'done';
  const agenticState: 'current' | 'done' | 'locked' = !agenticUnlocked ? 'locked' : activeScreen === 'agentic' ? 'current' : 'done';
  const planState: 'current' | 'locked' = !agenticUnlocked ? 'locked' : 'current';
  const lockTip = 'Run AI Recommendations on As-Is Analysis first';

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', rowGap: 14 }}>
      <StepNode index={1} state="done" label="Upload" />
      <Connector filled />
      <StepNode index={2} state={asisState} label="As-Is Analysis" active={activeScreen === 'asis'}
        meta={`${stepCount} step${stepCount !== 1 ? 's' : ''} · ${confPct}%`}
        onClick={() => onNavigate('asis')} />
      <Connector filled={asisState === 'done'} />
      <StepNode index={3} state={agenticState} label="Agentic Redesign" active={activeScreen === 'agentic'}
        meta={agenticUnlocked ? `${agentCount} agent${agentCount !== 1 ? 's' : ''} proposed` : undefined}
        lockTip={lockTip}
        onClick={() => agenticUnlocked && onNavigate('agentic')} />
      <Connector filled={agenticUnlocked} />
      <StepNode index={4} state={planState} label="Generate Plan" active={activeScreen === 'plan'}
        lockTip={lockTip}
        onClick={agenticUnlocked ? onOpenPlan : undefined} />
    </div>
  );
}

// A consistent way back to the platform's landing page, meant to replace
// each screen inventing its own bespoke "back to X" link. Those ad-hoc links
// either duplicated navigation the stepper above already provides (e.g.
// Planning Assistant's old "← Agentic Workflow" button — the stepper's own
// Agentic Redesign node does the same thing) or quietly varied in
// destination/wording screen to screen. This one always does the same
// thing: leave Process Intelligence entirely.
export function HomeButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick}
      style={{ padding: '7px 14px', borderRadius: 999, fontSize: 13, fontWeight: 500, border: '1px solid #E5E5EA',
        cursor: 'pointer', background: '#fff', color: '#6E6E73', display: 'flex', alignItems: 'center', gap: 6, fontFamily: FONT, flexShrink: 0 }}>
      <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor">
        <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h3a1 1 0 001-1v-3h2v3a1 1 0 001 1h3a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
      </svg>
      Home
    </button>
  );
}

function Connector({ filled }: { filled: boolean }) {
  return <div style={{ width: 36, height: 2, background: filled ? '#0F6FEC' : '#E5E5EA', margin: '11px 8px 0', flexShrink: 0 }} />;
}

function StepNode({ index, state, label, meta, lockTip, active, onClick }: {
  index: number; state: 'done' | 'current' | 'locked'; label: string; meta?: string;
  lockTip?: string;
  // "Which screen you're currently viewing" — deliberately separate from
  // `state`, which tracks completion (done/actionable/locked). Circle fill
  // already carries the done/actionable/locked meaning; overloading it to
  // also mean "you are here" made "current" ambiguous between "unfinished"
  // and "the tab you're on". The underline below is the only "you are here"
  // signal, kept subtle and independent of completion color.
  active?: boolean;
  onClick?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const colors = state === 'done'
    ? { bg: '#0F6FEC', border: '#0F6FEC', fg: '#fff' }
    : state === 'current'
    ? { bg: '#0C0D0D', border: '#0C0D0D', fg: '#fff' }
    : { bg: '#FAFAFA', border: '#E5E5EA', fg: '#C7C7CC' };
  const clickable = state !== 'locked' && !!onClick;

  return (
    <button onClick={onClick} disabled={!clickable}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ background: 'none', border: 'none', padding: 0, fontFamily: FONT, textAlign: 'left',
        cursor: clickable ? 'pointer' : 'default', position: 'relative', flexShrink: 0 }}>
      <div style={{ width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, fontWeight: 700, border: `2px solid ${colors.border}`, background: colors.bg, color: colors.fg }}>
        {state === 'done' ? '✓' : index}
      </div>
      <div style={{ marginTop: 7, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap',
        color: state === 'locked' ? '#C7C7CC' : '#1D1D1F',
        paddingBottom: 3, borderBottom: `2px solid ${active ? '#0F6FEC' : 'transparent'}` }}>
        {label}
      </div>
      {meta && (
        <div style={{ marginTop: 1, fontSize: 10.5, color: '#8E8E93', whiteSpace: 'nowrap',
          fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}>
          {meta}
        </div>
      )}
      {state === 'locked' && lockTip && hover && (
        <div style={{ position: 'absolute', top: -30, left: '50%', transform: 'translateX(-50%)',
          background: '#1D1D1F', color: '#fff', fontSize: 10.5, padding: '5px 9px', borderRadius: 6,
          whiteSpace: 'nowrap', zIndex: 5 }}>
          {lockTip}
        </div>
      )}
    </button>
  );
}
