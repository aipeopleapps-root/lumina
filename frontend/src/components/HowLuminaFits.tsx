import { useState } from 'react';
import { APP_ACCENTS, type AppId } from './PlatformHome';

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';
const STORAGE_KEY = 'lumina-how-fits-collapsed';

// The same six-stage delivery methodology already used elsewhere in this
// platform's own materials (Process Intelligence's onboarding content, the
// exec-facing Lumina Lifecycle Map) — kept identical here rather than
// inventing a second stage vocabulary for the landing page.
type Stage = {
  key: string;
  label: string;
  tag: string;
  oldWay: string;
  withLumina: string;
  impact: string;
  features: AppId[];
};

const STAGES: Stage[] = [
  {
    key: 'discovery', label: 'Discovery', tag: 'Align & prepare',
    impact: 'Weeks → minutes for a shared as-is map',
    oldWay: 'Current-state understanding comes from workshops, sticky notes, and someone’s memory of how a process used to work. The diagram lives in one person’s Visio file, half updated. Weeks pass before the team has a shared, accurate picture of what’s actually happening today.',
    withLumina: 'Upload the existing process diagram or workbook and Process Intelligence extracts the full as-is map — steps, swimlanes, systems touched — in minutes. Every step gets an AI-opportunity classification from day one, so design conversations start already knowing where automation fits.',
    features: ['process-intelligence'],
  },
  {
    key: 'design', label: 'Architect & Design', tag: 'Design the future state',
    impact: 'Blank page → a working first draft, same day',
    oldWay: 'Future-state design starts from a blank whiteboard. The business process workbook gets typed up by hand from workshop notes, and integration specs don’t take shape until requirements are already locked — so vendor conversations start from a blank page too, right when there’s the least time to spare.',
    withLumina: 'Process Intelligence proposes an agentic future-state redesign directly from the as-is map. BP Workbook Generation turns that same process map into a business process workbook automatically, and Integration Studio drafts integration design docs, sequence diagrams, and mapping sheets straight from requirements — every design conversation starts from a concrete draft, not a blank page.',
    features: ['process-intelligence', 'bp-workbook-generation', 'integration-studio'],
  },
  {
    key: 'prototype', label: 'Prototype', tag: 'Validate through experience',
    impact: 'One live walkthrough → an always-available demo',
    oldWay: 'Demonstrating the future state means a live, Deloitte-led walkthrough — scheduled around calendars, seen once by whoever made the meeting, and half-forgotten by the time design sign-off comes around.',
    withLumina: 'Process Intelligence generates an interactive, client-branded demo of the proposed agentic workflow that business stakeholders click through themselves — whenever they want, as many times as they want, before design sign-off.',
    features: ['process-intelligence'],
  },
  {
    key: 'testing', label: 'Testing', tag: 'Confirm solution readiness',
    impact: 'Hand-written scenarios → a reviewed workbook, same cycle',
    oldWay: 'Test scenarios and steps get written by hand from requirements docs, one at a time. Nobody’s fully sure the live tenant configuration actually matches the documented workbook until a defect surfaces mid-cycle and someone has to go prove it.',
    withLumina: 'Test Automation Suite turns requirements, user stories, or config workbooks directly into reviewed test scenarios and steps, exported as a ready-to-run workbook. ConfigGuard checks the live tenant against the configuration workbook automatically, catching drift before it becomes a defect.',
    features: ['test-automation', 'config-guard'],
  },
  {
    key: 'deploy', label: 'Deploy', tag: 'Transition with confidence',
    impact: 'Drift caught at go-live → drift caught before cutover',
    oldWay: 'Cutover verification testing gets rewritten from scratch under time pressure. Configuration drift is caught for the first time during production verification — if it’s caught at all before go-live.',
    withLumina: 'The same automated scenario library from Testing re-runs as production verification testing. ConfigGuard runs a final config-vs-workbook pass right before cutover, so drift is caught before it reaches production, not after.',
    features: ['test-automation', 'config-guard'],
  },
  {
    key: 'support', label: 'Support', tag: 'Sustain & optimise',
    impact: 'An audit surprise → continuous, always-on verification',
    oldWay: 'Once the project team disbands, nobody’s watching for undocumented configuration changes — until an audit finding surfaces months later and someone has to reconstruct what changed and when.',
    withLumina: 'ConfigGuard keeps running as a continuous check against the documented baseline — a living source of truth long after go-live, not a one-time verification that stops the day the project team moves on.',
    features: ['config-guard'],
  },
];

const _FEATURE_NAMES: Partial<Record<AppId, string>> = {
  'process-intelligence': 'Process Intelligence',
  'test-automation': 'Test Automation',
  'bp-workbook-generation': 'BP Workbook Generation',
  'integration-studio': 'Integration Studio',
  'config-guard': 'ConfigGuard',
  'ask-stuey': 'Ask Stuey',
};

function featureName(id: AppId): string {
  return _FEATURE_NAMES[id] ?? id;
}

// Small monochrome glyphs matching each feature's real tile icon in the app
// grid below (same metaphor, scaled down) — currentColor so each chip tints
// with its own accent automatically.
const _FEATURE_ICONS: Partial<Record<AppId, React.ReactNode>> = {
  'process-intelligence': (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 2.5h14M1 8h14M1 13.5h14" opacity="0.35" />
      <circle cx="3.2" cy="2.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="13.5" r="1.3" fill="currentColor" stroke="none" />
      <path d="M4.3 3.3L7 7.3M9 8.7l2.6 4" />
    </svg>
  ),
  'test-automation': (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.8" />
      <path d="M6.7 7.5v4l3.6-2-3.6-2z" fill="currentColor" stroke="none" />
    </svg>
  ),
  'bp-workbook-generation': (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 1.5h5.5l3 3v9.5a1 1 0 01-1 1h-7.5a1 1 0 01-1-1v-11.5a1 1 0 011-1z" />
      <path d="M4.3 8h7.4M4.3 10.3h7.4M4.3 12.6h7.4M7.3 8v4.6" strokeWidth="1" />
    </svg>
  ),
  'integration-studio': (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="3" cy="8" r="2" /><circle cx="13" cy="3" r="2" /><circle cx="13" cy="13" r="2" />
      <path d="M4.7 7.2l6.6-3.4M4.7 8.8l6.6 3.4" />
    </svg>
  ),
  'config-guard': (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5l5.5 2v4c0 4-2.5 6.2-5.5 7-3-.8-5.5-3-5.5-7v-4l5.5-2z" />
      <path d="M5.7 8l1.7 1.7 3-3.4" />
    </svg>
  ),
};

function IcClock() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.3" />
      <path d="M8 4.7V8l2.6 1.6" />
    </svg>
  );
}

// Chevron points where the click will take you: down when collapsed (more
// content will appear below), up when expanded (clicking folds it away).
function IcCollapse({ open }: { open: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .15s' }}>
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

export default function HowLuminaFits() {
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) !== '1'; } catch { return true; }
  });
  const stage = STAGES[active];

  function toggle() {
    setOpen(v => {
      const next = !v;
      try { localStorage.setItem(STORAGE_KEY, next ? '0' : '1'); } catch { /* ignore */ }
      return next;
    });
  }

  if (!open) {
    return (
      <div style={{ maxWidth: 1120, margin: '0 auto', padding: '0 24px 24px', fontFamily: FONT }}>
        <button onClick={toggle} style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontFamily: FONT,
          background: '#fff', border: '1px solid #E5E5EA', borderRadius: 999, padding: '12px 20px',
          boxShadow: '0 2px 10px rgba(0,0,0,0.04)',
        }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#86BC25' }}>●</span>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: '#1D1D1F', flex: 1, textAlign: 'left' }}>
            How Lumina fits your Workday engagement
          </span>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: '#8E8E93', display: 'flex', alignItems: 'center', gap: 5 }}>
            Show <IcCollapse open={false} />
          </span>
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1120, margin: '0 auto', padding: '0 24px 48px', fontFamily: FONT }}>
      <div style={{ background: '#fff', border: '1px solid #E5E5EA', borderRadius: 22, boxShadow: '0 4px 24px rgba(0,0,0,0.06)', overflow: 'hidden' }}>

        <div style={{ padding: '28px 32px 4px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#86BC25', margin: '0 0 8px' }}>
              Across the project timeline
            </p>
            <h2 style={{ fontSize: 24, fontWeight: 800, color: '#1D1D1F', margin: '0 0 8px', letterSpacing: '-0.01em' }}>
              How Lumina fits your Workday engagement
            </h2>
            <p style={{ fontSize: 14, color: '#6E6E73', margin: 0, maxWidth: 660, lineHeight: 1.55 }}>
              Pick a stage to see what changes — the way it gets done without Lumina, next to the way it gets done with it.
            </p>
          </div>
          <button onClick={toggle} title="Minimise"
            style={{
              flexShrink: 0, width: 30, height: 30, borderRadius: '50%', border: '1px solid #E5E5EA', background: '#FAFAFA',
              color: '#8E8E93', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT,
            }}>
            <IcCollapse open={true} />
          </button>
        </div>

        {/* Stage picker */}
        <div style={{ display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', rowGap: 14, padding: '22px 32px 24px', overflowX: 'auto' }}>
          {STAGES.map((s, i) => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'flex-start', flexShrink: 0 }}>
              {i > 0 && <div style={{ width: 34, height: 2, background: i <= active ? '#86BC25' : '#E5E5EA', marginTop: 15, marginRight: 4 }} />}
              <button onClick={() => setActive(i)}
                style={{
                  background: 'none', border: 'none', padding: '0 8px 0 0', cursor: 'pointer', fontFamily: FONT, textAlign: 'left',
                }}>
                <div style={{
                  width: 30, height: 30, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12.5, fontWeight: 700, transition: 'all .15s',
                  background: i === active ? '#0C0D0D' : i < active ? '#86BC25' : '#F5F5F7',
                  color: i <= active ? '#fff' : '#AEAEB2',
                  border: `2px solid ${i === active ? '#0C0D0D' : i < active ? '#86BC25' : '#E5E5EA'}`,
                }}>
                  {i < active ? '✓' : i + 1}
                </div>
                <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap', color: i === active ? '#1D1D1F' : '#8E8E93' }}>
                  {s.label}
                </div>
                <div style={{ marginTop: 1, fontSize: 10.5, color: '#ACACB2', whiteSpace: 'nowrap' }}>
                  {s.tag}
                </div>
              </button>
            </div>
          ))}
        </div>

        {/* Stage context bar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '12px 32px', borderTop: '1px solid #F0F0F0',
          borderBottom: '1px solid #F0F0F0', background: '#FAFAFA',
        }}>
          <span style={{
            fontSize: 10.5, fontWeight: 800, padding: '3px 10px', borderRadius: 999,
            background: '#0C0D0D', color: '#fff', letterSpacing: '0.02em', flexShrink: 0,
          }}>
            STAGE {active + 1} / {STAGES.length}
          </span>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: '#1D1D1F' }}>{stage.label}</span>
          <span style={{ fontSize: 12.5, color: '#8E8E93' }}>— {stage.tag}</span>
        </div>

        {/* Old way / With Lumina comparison */}
        <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
          <div style={{ padding: '26px 30px 28px', borderRight: '1px solid #F0F0F0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 14 }}>
              <span style={{ color: '#ACACB2' }}><IcClock /></span>
              <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#ACACB2', margin: 0 }}>
                The old way
              </p>
            </div>
            <p style={{ fontSize: 14.5, color: '#6E6E73', lineHeight: 1.65, margin: 0 }}>
              {stage.oldWay}
            </p>
          </div>
          <div style={{ padding: '26px 30px 28px', background: 'linear-gradient(180deg, #FAFDF5 0%, #FFFFFF 100%)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 14 }}>
              <span style={{ color: '#86BC25' }}>⚡</span>
              <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#86BC25', margin: 0 }}>
                With Lumina
              </p>
            </div>
            <div style={{
              display: 'inline-block', fontSize: 13, fontWeight: 700, color: '#3F6212', background: '#EEFAD4',
              borderRadius: 999, padding: '6px 14px', marginBottom: 16,
            }}>
              {stage.impact}
            </div>
            <p style={{ fontSize: 14.5, color: '#1D1D1F', lineHeight: 1.65, margin: '0 0 16px' }}>
              {stage.withLumina}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {stage.features.map(f => {
                const c = APP_ACCENTS[f];
                return (
                  <span key={f} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    fontSize: 11.5, fontWeight: 700, padding: '4px 12px 4px 9px', borderRadius: 999,
                    background: c?.accentSoft ?? '#F5F5F7', color: c?.accent ?? '#6E6E73',
                  }}>
                    {_FEATURE_ICONS[f]}
                    {featureName(f)}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Transformation marker, straddling the two columns */}
          <div style={{
            position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
            width: 34, height: 34, borderRadius: '50%', background: '#0C0D0D', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15,
            boxShadow: '0 0 0 5px #fff',
          }}>
            →
          </div>
        </div>

        {/* Ask Stuey — spans every stage, not tied to one */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '16px 32px',
          borderTop: '1px solid #F0F0F0', background: '#FAFAFA', flexWrap: 'wrap',
        }}>
          <div style={{
            width: 30, height: 30, borderRadius: '50%', overflow: 'hidden', flexShrink: 0,
            border: `2px solid ${APP_ACCENTS['ask-stuey']!.accent}`,
          }}>
            <img src="/stuey-avatar.jpg" alt="Stuey" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
          <p style={{ fontSize: 13, color: '#3A3A3C', margin: 0, lineHeight: 1.5 }}>
            <strong style={{ color: '#1D1D1F' }}>Ask Stuey is with you the whole way</strong> — in this project and across the
            practice. Old way: 10–30 minutes hunting through folders, Teams, and email, or interrupting a colleague. With
            Lumina: ask Stuey and get pointed straight to the right document or answer.
          </p>
        </div>
      </div>
    </div>
  );
}
