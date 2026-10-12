import { useState } from 'react';
import HowLuminaFits from './HowLuminaFits';

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';

export type AppId = 'process-intelligence' | 'rfp-reimagine' | 'test-automation' | 'bp-workbook-generation' | 'blueprint-match' | 'integration-studio' | 'config-guard' | 'ask-stuey' | 'go-live-check' | 'weekly-report' | 'workday-coach';

// 'client' apps operate within a single assigned client engagement (they need
// a client picked before they mean anything — e.g. Process Intelligence maps
// one client's process); 'firm' apps are generic and work the same regardless
// of which client, if any, the consultant currently has active — e.g. Ask
// Stuey, or RFP Reimagine (drafts a response to a prospect, not scoped to an
// existing assigned client). App.tsx's launchApp() reads this to decide
// whether to route through the client picker before opening the app.
export type AppScope = 'client' | 'firm';

type Props = {
  firstName?: string;
  onLaunch: (appId: AppId) => void;
  activeClientName?: string;
  wipApps?: Record<string, string>; // appId -> admin-written reason it's grayed out right now
};

type AppDef = {
  id: AppId;
  name: string;
  tagline: string;
  description: string;
  accent: string;
  accentSoft: string;
  icon: React.ReactNode;
  status: 'live' | 'soon' | 'always-on';
  scope: AppScope;
};

export const APP_SCOPE: Record<AppId, AppScope> = {
  'process-intelligence': 'client',
  'rfp-reimagine': 'firm',
  'test-automation': 'client',
  'bp-workbook-generation': 'client',
  'blueprint-match': 'client',
  'integration-studio': 'client',
  'config-guard': 'client',
  'ask-stuey': 'firm',
  'go-live-check': 'client',
  'weekly-report': 'client',
  'workday-coach': 'client',
};

// Every known app, for admin visibility-toggle UI and any other place that
// needs the full catalogue rather than just what's currently visible.
export const ALL_APP_IDS: AppId[] = [
  'process-intelligence', 'rfp-reimagine', 'test-automation', 'bp-workbook-generation', 'blueprint-match',
  'integration-studio', 'config-guard', 'ask-stuey', 'go-live-check', 'weekly-report', 'workday-coach',
];

// Shared with HowLuminaFits.tsx's stage comparison strip, so a feature named
// there always matches its own tile's colour below rather than inventing a
// second, uncoordinated palette.
export const APP_ACCENTS: Partial<Record<AppId, { accent: string; accentSoft: string }>> = {
  'process-intelligence': { accent: '#0C8599', accentSoft: '#E6F7F8' },
  'test-automation': { accent: '#7C3AED', accentSoft: '#F3EEFE' },
  'bp-workbook-generation': { accent: '#2563EB', accentSoft: '#EAF1FE' },
  'integration-studio': { accent: '#4F46E5', accentSoft: '#EEEEFD' },
  'config-guard': { accent: '#DC2626', accentSoft: '#FDECEC' },
  'ask-stuey': { accent: '#16A34A', accentSoft: '#EAFBF1' },
};

// Process Intelligence — three swimlanes with a routed connector threading
// through them, plus a magnifying glass to read as "map AND analyze," not
// just "flowchart."
function IcFlow() {
  return (
    <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 2.5h14M1 8h14M1 13.5h14" opacity="0.35"/>
      <circle cx="3.2" cy="2.5" r="1.3" fill="currentColor" stroke="none"/>
      <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none"/>
      <circle cx="12.5" cy="13.5" r="1.3" fill="currentColor" stroke="none"/>
      <path d="M4.3 3.3L7 7.3M9 8.7l2.6 4"/>
    </svg>
  );
}
// RFP Reimagine — a document mid-draft, with a sparkle marking the AI-
// generated content rather than a plain static file icon.
function IcDoc() {
  return (
    <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 1.5h5.5l3 3v9.5a1 1 0 01-1 1h-7.5a1 1 0 01-1-1v-11.5a1 1 0 011-1z"/>
      <path d="M9 1.5V4.5h3"/>
      <path d="M4.8 9h3.6M4.8 11.3h2.4"/>
      <path d="M12.3 8.3l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5.5-1.4z" fill="currentColor" stroke="none"/>
    </svg>
  );
}
// Test Automation Suite — a browser window (what Playwright actually
// drives) with a run/play affordance, not a generic media-player glyph.
function IcPlay() {
  return (
    <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.8"/>
      <path d="M1.5 5.3h13" strokeWidth="1.1"/>
      <circle cx="3.4" cy="3.9" r="0.45" fill="currentColor" stroke="none"/>
      <circle cx="4.8" cy="3.9" r="0.45" fill="currentColor" stroke="none"/>
      <path d="M6.7 7.5v4l3.6-2-3.6-2z" fill="currentColor" stroke="none"/>
    </svg>
  );
}
// BP Workbook Generation — a document with a small grid inside, reading as
// "structured workbook" rather than RFP Reimagine's free-text IcDoc.
function IcWorkbook() {
  return (
    <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 1.5h5.5l3 3v9.5a1 1 0 01-1 1h-7.5a1 1 0 01-1-1v-11.5a1 1 0 011-1z"/>
      <path d="M9 1.5V4.5h3"/>
      <path d="M4.3 8h7.4M4.3 10.3h7.4M4.3 12.6h7.4M7.3 8v4.6" strokeWidth="1"/>
    </svg>
  );
}
// Blueprint Match — a ruled architectural blueprint sheet (the "playbook")
// with a match/check pin, distinct from the generic stacked-layers glyph.
function IcLayers() {
  return (
    <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="1.5" width="10.5" height="10.5" rx="1"/>
      <path d="M4 1.5v10.5M1.5 4h10.5M1.5 8.5h6.5M8 4v4.5" opacity="0.45"/>
      <circle cx="12" cy="12" r="3" fill="#FAFAFA"/>
      <path d="M10.6 12l1 1 1.8-2" strokeWidth="1.3"/>
    </svg>
  );
}
// Integration Studio — three connected systems; already the right metaphor.
function IcLink() {
  return (
    <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="3" cy="8" r="2"/><circle cx="13" cy="3" r="2"/><circle cx="13" cy="13" r="2"/>
      <path d="M4.7 7.2l6.6-3.4M4.7 8.8l6.6 3.4"/>
    </svg>
  );
}
// ConfigGuard — shield with a check; already the right metaphor.
function IcShield() {
  return (
    <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5l5.5 2v4c0 4-2.5 6.2-5.5 7-3-.8-5.5-3-5.5-7v-4l5.5-2z"/>
      <path d="M5.7 8l1.7 1.7 3-3.4"/>
    </svg>
  );
}
function IcSpark() {
  return (
    <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5l1.1 3.4L12.5 6l-3.4 1.1L8 10.5l-1.1-3.4L3.5 6l3.4-1.1L8 1.5z"/>
      <path d="M13 10.5l.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6.6-1.8z"/>
    </svg>
  );
}
// Go-Live Check — a rocket for "launch readiness," distinct from
// ConfigGuard's shield-check so the two don't read as the same idea.
function IcCheck() {
  return (
    <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5c2 1.4 3 3.6 3 6.2 0 1.6-.4 3-1 4.1L8 13.5l-2-1.7c-.6-1.1-1-2.5-1-4.1 0-2.6 1-4.8 3-6.2z"/>
      <circle cx="8" cy="6.8" r="1.3"/>
      <path d="M5.3 10.2L3.3 12M10.7 10.2l2 1.8M6.3 13.2L8 14.8l1.7-1.6" opacity="0.6"/>
    </svg>
  );
}
// Weekly Report — a bar chart with a trend line, reading as "status over
// time" rather than a static report page.
function IcReport() {
  return (
    <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 14.5v-12M1.5 14.5h13"/>
      <rect x="3.3" y="9.5" width="2.1" height="5" rx="0.4" fill="currentColor" stroke="none" opacity="0.35"/>
      <rect x="6.9" y="6.5" width="2.1" height="8" rx="0.4" fill="currentColor" stroke="none" opacity="0.35"/>
      <rect x="10.5" y="3.5" width="2.1" height="11" rx="0.4" fill="currentColor" stroke="none" opacity="0.35"/>
      <path d="M3.3 9.7l3.6-2.3 3.6 1.1 3.4-4.8"/>
    </svg>
  );
}
// Workday Coach — a chat bubble with a guiding "?", reading as coaching
// Q&A rather than a generic messaging icon.
function IcCoach() {
  return (
    <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H2a1 1 0 00-1 1v7a1 1 0 001 1h3.5l2.5 3 2.5-3H14a1 1 0 001-1V3a1 1 0 00-1-1z"/>
      <path d="M6.4 6.1c0-.9.7-1.5 1.6-1.5s1.6.5 1.6 1.3c0 1-1.6 1-1.6 2.1" strokeWidth="1.2"/>
      <circle cx="8" cy="10.1" r="0.15" fill="currentColor" stroke="currentColor" strokeWidth="0.9"/>
    </svg>
  );
}

const APPS: AppDef[] = [
  {
    id: 'process-intelligence', name: 'Process Intelligence', status: 'live', scope: APP_SCOPE['process-intelligence'],
    tagline: 'Map. Analyze. Modernize.',
    description: 'Turn process diagrams and workbooks into to-be process maps, agentic AI opportunities, and implementation plans.',
    accent: APP_ACCENTS['process-intelligence']!.accent, accentSoft: APP_ACCENTS['process-intelligence']!.accentSoft, icon: <IcFlow />,
  },
  {
    id: 'rfp-reimagine', name: 'RFP Reimagine', status: 'live', scope: APP_SCOPE['rfp-reimagine'],
    tagline: 'From questionnaire to proposal.',
    description: 'Generate a first-draft RFP response, cover letter, project plan, and resource plan — grounded in firm knowledge.',
    accent: '#0C0D0D', accentSoft: '#ECF4EE', icon: <IcDoc />,
  },
  {
    id: 'test-automation', name: 'Test Automation Suite', status: 'live', scope: APP_SCOPE['test-automation'],
    tagline: 'From requirements to a test pack.',
    description: 'Turn requirements, user stories, config workbooks, or BPW docs into reviewed test scenarios and steps, exported as a formatted Excel workbook.',
    accent: APP_ACCENTS['test-automation']!.accent, accentSoft: APP_ACCENTS['test-automation']!.accentSoft, icon: <IcPlay />,
  },
  {
    id: 'bp-workbook-generation', name: 'BP Workbook Generation', status: 'live', scope: APP_SCOPE['bp-workbook-generation'],
    tagline: 'From Econ Map to workbook.',
    description: 'Upload a Visio Econ Map and generate the full 20-section Business Process Workbook — AI-enriched, with optional security/notification inputs and custom-instruction overrides.',
    accent: APP_ACCENTS['bp-workbook-generation']!.accent, accentSoft: APP_ACCENTS['bp-workbook-generation']!.accentSoft, icon: <IcWorkbook />,
  },
  {
    id: 'blueprint-match', name: 'Blueprint Match', status: 'soon', scope: APP_SCOPE['blueprint-match'],
    tagline: "Deloitte's industry playbook, on demand.",
    description: "Match a client's context against Deloitte's industry blueprint repository of proven process designs.",
    accent: '#F97316', accentSoft: '#FFF1E6', icon: <IcLayers />,
  },
  {
    id: 'integration-studio', name: 'Integration Studio', status: 'soon', scope: APP_SCOPE['integration-studio'],
    tagline: 'Design docs, drawn from requirements.',
    description: 'Generate integration design docs, sequence diagrams, network diagrams, and mapping sheets from high-level requirements.',
    accent: APP_ACCENTS['integration-studio']!.accent, accentSoft: APP_ACCENTS['integration-studio']!.accentSoft, icon: <IcLink />,
  },
  {
    id: 'config-guard', name: 'ConfigGuard', status: 'soon', scope: APP_SCOPE['config-guard'],
    tagline: 'Catch drift before go-live.',
    description: "Validate a Workday tenant's live configuration against the configuration workbook and flag discrepancies.",
    accent: APP_ACCENTS['config-guard']!.accent, accentSoft: APP_ACCENTS['config-guard']!.accentSoft, icon: <IcShield />,
  },
  {
    id: 'ask-stuey', name: 'Ask Stuey', status: 'always-on', scope: APP_SCOPE['ask-stuey'],
    tagline: 'The one everyone still asks.',
    description: "Named for the guy who always had the answer. Stuey's always a click away in the corner of your screen — nudges you toward the right tool and answers quick questions about the platform.",
    accent: APP_ACCENTS['ask-stuey']!.accent, accentSoft: APP_ACCENTS['ask-stuey']!.accentSoft, icon: <IcSpark />,
  },
  {
    id: 'go-live-check', name: 'Go-Live Check', status: 'live', scope: APP_SCOPE['go-live-check'],
    tagline: 'SOW readiness, one check away.',
    description: "Validate a client's uploaded SOW against their delivered documents and flag red/amber/green readiness gaps before go-live.",
    accent: '#059669', accentSoft: '#E7F8F2', icon: <IcCheck />,
  },
  {
    id: 'weekly-report', name: 'Weekly Report', status: 'live', scope: APP_SCOPE['weekly-report'],
    tagline: 'Status reports, generated for you.',
    description: "Generate a weekly status report for a client engagement — workstream health, key risks, and next steps — from their uploaded documents.",
    accent: '#B45309', accentSoft: '#FDF3E7', icon: <IcReport />,
  },
  {
    id: 'workday-coach', name: 'Workday Coach', status: 'live', scope: APP_SCOPE['workday-coach'],
    tagline: 'Ask anything about this client.',
    description: "Chat grounded in a specific client's uploaded documents and HR policies — implementation guidance and policy Q&A in one place.",
    accent: '#9333EA', accentSoft: '#F5EBFE', icon: <IcCoach />,
  },
];

// Name + scope lookup for the admin visibility-toggle UI (AdminPanel's Apps
// tab), which needs the catalogue without importing the tile JSX/icons.
export const APP_LABELS: Record<AppId, { name: string; tagline: string; scope: AppScope }> =
  Object.fromEntries(APPS.map(a => [a.id, { name: a.name, tagline: a.tagline, scope: a.scope }])) as Record<AppId, { name: string; tagline: string; scope: AppScope }>;

function getTimeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

export default function PlatformHome({ firstName, onLaunch, activeClientName, wipApps }: Props) {
  const [expanded, setExpanded] = useState<AppId | null>(null);
  const wip = wipApps ?? {};

  const liveApps = APPS.filter(app => app.status !== 'soon' && !wip[app.id]);
  const notLiveApps = APPS.filter(app => app.status === 'soon' || wip[app.id]);

  function renderTile(app: AppDef) {
    const isExpanded = expanded === app.id;
    const wipReason = wip[app.id];
    const isWip = !!wipReason;
    const isClickable = app.status !== 'soon' && !isWip;
    return (
      <div key={app.id}
        onClick={() => isClickable ? onLaunch(app.id) : setExpanded(isExpanded ? null : app.id)}
        style={{
          background: '#FFFFFF', borderRadius: 18, padding: 28, cursor: 'pointer',
          border: '1px solid #E5E5EA', position: 'relative', overflow: 'hidden',
          transition: 'transform 0.15s ease, box-shadow 0.15s ease',
          opacity: (app.status === 'soon' || isWip) ? 0.88 : 1,
        }}
        onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = '0 12px 28px rgba(0,0,0,0.08)'; }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; }}
      >
        {isWip ? (
          <span style={{
            position: 'absolute', top: 20, right: 20, fontSize: 10, fontWeight: 700, color: '#B45309',
            background: '#FDF3E7', padding: '3px 8px', borderRadius: 999, letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>
            🔧 Work in Progress
          </span>
        ) : app.status === 'soon' && (
          <span style={{
            position: 'absolute', top: 20, right: 20, fontSize: 10, fontWeight: 700, color: '#8E8E93',
            background: '#F2F2F7', padding: '3px 8px', borderRadius: 999, letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>
            Coming Soon
          </span>
        )}
        {!isWip && app.status === 'always-on' && (
          <span style={{
            position: 'absolute', top: 20, right: 20, fontSize: 10, fontWeight: 700, color: app.accent,
            background: app.accentSoft, padding: '3px 8px', borderRadius: 999, letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>
            Always Available
          </span>
        )}
        <div style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
          color: app.scope === 'client' && activeClientName ? app.accent : '#8E8E93', marginBottom: 12,
        }}>
          {app.scope === 'firm' ? 'Firm-wide' : activeClientName ? `For ${activeClientName}` : 'Client-specific'}
        </div>
        <div style={{
          width: 52, height: 52, borderRadius: app.id === 'ask-stuey' ? '50%' : 14,
          background: isClickable ? app.accentSoft : '#F5F5F7', overflow: 'hidden',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: isClickable ? app.accent : '#AEAEB2', marginBottom: 18,
        }}>
          {app.id === 'ask-stuey'
            ? <img src="/stuey-avatar.jpg" alt="Stuey" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : app.icon}
        </div>
        <h3 style={{ fontSize: 19, fontWeight: 700, color: '#1D1D1F', margin: '0 0 4px', letterSpacing: '-0.01em' }}>
          {app.name}
        </h3>
        <p style={{ fontSize: 13, fontWeight: 600, color: isClickable ? app.accent : '#AEAEB2', margin: '0 0 10px' }}>
          {app.tagline}
        </p>
        <p style={{ fontSize: 13.5, color: '#6E6E73', lineHeight: 1.5, margin: 0 }}>
          {app.description}
        </p>
        {isWip ? (
          isExpanded ? (
            <p style={{ marginTop: 18, fontSize: 12.5, color: '#B45309', lineHeight: 1.5, borderTop: '1px solid #F0F0F0', paddingTop: 12 }}>
              {wipReason}
            </p>
          ) : (
            <div style={{ marginTop: 18, fontSize: 13, fontWeight: 600, color: '#AEAEB2' }}>
              Why? →
            </div>
          )
        ) : app.status === 'live' ? (
          <div style={{ marginTop: 18, fontSize: 13, fontWeight: 600, color: app.accent, display: 'flex', alignItems: 'center', gap: 4 }}>
            Open <span aria-hidden>→</span>
          </div>
        ) : app.status === 'always-on' ? (
          <div style={{ marginTop: 18, fontSize: 13, fontWeight: 600, color: app.accent, display: 'flex', alignItems: 'center', gap: 4 }}>
            Say hi <span aria-hidden>→</span>
          </div>
        ) : isExpanded ? (
          <p style={{ marginTop: 18, fontSize: 12.5, color: '#8E8E93', lineHeight: 1.5, borderTop: '1px solid #F0F0F0', paddingTop: 12 }}>
            Not built yet — this tile is a preview of what's coming to the platform.
          </p>
        ) : (
          <div style={{ marginTop: 18, fontSize: 13, fontWeight: 600, color: '#AEAEB2' }}>
            Learn more
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', fontFamily: FONT, background: '#F5F5F7' }}>
      {/* Hero */}
      <div style={{ padding: '72px 24px 48px', textAlign: 'center', background: 'linear-gradient(180deg, #FAFAFA 0%, #F5F5F7 100%)' }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: '#86BC25', textTransform: 'uppercase', letterSpacing: '0.12em', margin: '0 0 12px' }}>
          Lumina Platform
        </p>
        <h1 style={{ fontSize: 44, fontWeight: 700, color: '#1D1D1F', margin: '0 0 14px', letterSpacing: '-0.02em', lineHeight: 1.1 }}>
          {firstName ? `Good ${getTimeOfDay()}, ${firstName}.` : 'Good ' + getTimeOfDay() + '.'}
        </h1>
        <p style={{ fontSize: 19, color: '#6E6E73', maxWidth: 620, margin: '0 auto', lineHeight: 1.4 }}>
          Every AI tool for your engagement, in one place. Pick where you're starting.
        </p>
      </div>

      <div style={{ paddingTop: 8 }}>
        <HowLuminaFits />
      </div>

      {/* App grid — live/usable tiles grouped together first, everything grayed
          out (admin-marked WIP or genuinely not-yet-built) grouped below, so
          the "what can I actually use right now" answer is visually obvious
          rather than scattered through one flat grid in catalogue order. */}
      <div style={{ maxWidth: 1120, margin: '0 auto', padding: '8px 24px 80px' }}>
        {liveApps.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 20 }}>
            {liveApps.map(app => renderTile(app))}
          </div>
        )}
        {notLiveApps.length > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: liveApps.length > 0 ? '40px 0 20px' : '0 0 20px' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#8E8E93', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Work in Progress
              </span>
              <div style={{ flex: 1, height: 1, background: '#E5E5EA' }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 20 }}>
              {notLiveApps.map(app => renderTile(app))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
