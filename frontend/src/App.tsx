import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMsal } from '@azure/msal-react';
import { loginRequest, claimsFromAccount } from './lib/msal';
import ConsultantPanel, { type NavSection } from './components/ConsultantPanel';
import { AdminPanel, type Tab as AdminTab } from './components/AdminPanel';
import { LuminaLogo } from './components/LuminaLogo';
import { OnboardingChecklist, shouldShowOnboarding } from './components/OnboardingChecklist';
import PlatformHome, { type AppId, APP_SCOPE } from './components/PlatformHome';
import RfpReimagine from './components/RfpReimagine';
import ProcessIntelligence from './components/ProcessIntelligence';
import TestAutomationSuite from './components/TestAutomationSuite';
import BpWorkbookGeneration from './components/BpWorkbookGeneration';
import AskStuey, { type StueyContext } from './components/AskStuey';
import { getMyClients, setActiveClientTenant, listTenants, getAppVisibility, type AssignedClient } from './lib/api';

// Process Intelligence is its own top-level destination, same as RFP
// Reimagine — it doesn't live inside the ConsultantPanel Documents shell at
// all (one page: current process map + generated agentic workflow, nothing
// else — see ProcessIntelligence.tsx).
type ConsultantView = 'home' | 'client-picker' | 'workspace' | 'rfp' | 'process-intelligence' | 'test-automation' | 'bp-workbook-generation';

const STUEY_CONTEXT: Record<ConsultantView, StueyContext> = {
  'home': 'platform-home',
  'client-picker': 'client-picker',
  'workspace': 'workspace',
  'rfp': 'rfp-reimagine',
  'process-intelligence': 'workspace',
  'test-automation': 'workspace',
  'bp-workbook-generation': 'workspace',
};

// App tiles that land inside the ConsultantPanel Documents workspace, and
// which pane each one should open to there. Process Intelligence isn't
// here — it routes to its own top-level ConsultantView instead (see
// launchApp below).
const WORKSPACE_NAV: Partial<Record<AppId, NavSection>> = {
  'go-live-check': 'go-live-check',
  'weekly-report': 'weekly-report',
  'workday-coach': 'workday-coach',
};
const WORKSPACE_NAV_VALUES = new Set(Object.values(WORKSPACE_NAV));

type Me = {
  email: string;
  tenantId: string;
  role: string;
  firstName: string;
  lastName: string;
} | null;

const ADMIN_ROLES = new Set(['super_admin', 'project_admin']);

// ── URL → state derivation ──────────────────────────────────────────────────
// No <Routes>/<Route> matching — every "which view" decision is derived directly from
// location.pathname via these pure helpers, and every navigation is a plain navigate() call.
// Given how much of this render tree is already gated by role/preview-mode (not just "which
// path"), this stays truer to the app's existing conditional structure than converting to
// route-element matching would, while still making the URL the single source of truth: refresh,
// back/forward, and bookmarking all fall out of this for free, since render is now a pure
// function of location.pathname instead of component-local state.

function getConsultantClientId(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'consultant') return null;
  const seg = parts[1];
  if (!seg || seg === 'client-picker' || seg === 'rfp-reimagine') return null;
  return decodeURIComponent(seg);
}

function getConsultantView(pathname: string): ConsultantView {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'consultant') return 'home';
  if (!parts[1]) return 'home';
  if (parts[1] === 'client-picker') return 'client-picker';
  if (parts[1] === 'rfp-reimagine') return 'rfp';
  if (parts[2] === 'process-intelligence') return 'process-intelligence';
  if (parts[2] === 'test-automation') return 'test-automation';
  if (parts[2] === 'bp-workbook-generation') return 'bp-workbook-generation';
  return 'workspace';
}

function getWorkspaceNavSection(pathname: string): NavSection {
  const parts = pathname.split('/').filter(Boolean);
  const seg = parts[2];
  return (seg && WORKSPACE_NAV_VALUES.has(seg as NavSection)) ? (seg as NavSection) : 'documents';
}

function getTestAutomationRunId(pathname: string): string | undefined {
  const parts = pathname.split('/').filter(Boolean);
  return parts[2] === 'test-automation' && parts[3] && parts[3] !== 'reports' && parts[3] !== 'execute'
    ? decodeURIComponent(parts[3]) : undefined;
}

type TestAutomationView = 'build' | 'execute' | 'reports';
function getTestAutomationView(pathname: string): TestAutomationView {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[2] !== 'test-automation') return 'build';
  if (parts[3] === 'reports') return 'reports';
  if (parts[3] === 'execute') return 'execute';
  return 'build';
}

function getTestAutomationReportRunId(pathname: string): string | undefined {
  const parts = pathname.split('/').filter(Boolean);
  return parts[2] === 'test-automation' && parts[3] === 'reports' && parts[4]
    ? decodeURIComponent(parts[4]) : undefined;
}

function getAdminTab(pathname: string): AdminTab {
  const parts = pathname.split('/').filter(Boolean);
  return (parts[1] as AdminTab) || 'clients';
}

type PreviewNav = 'home' | 'workspace' | 'process-intelligence';
function getPreviewNav(pathname: string): PreviewNav {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'preview') return 'home';
  if (parts[1] === 'process-intelligence') return 'process-intelligence';
  if (parts[1] === 'workspace') return 'workspace';
  return 'home';
}
function getPreviewWorkspaceNav(pathname: string): NavSection {
  const parts = pathname.split('/').filter(Boolean);
  const seg = parts[2];
  return (seg && WORKSPACE_NAV_VALUES.has(seg as NavSection)) ? (seg as NavSection) : 'documents';
}

export default function App() {
  const { instance, accounts } = useMsal();
  const navigate = useNavigate();
  const location = useLocation();
  const [me, setMe] = useState<Me>(null);
  const [authReady, setAuthReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Data caches — NOT navigation state. Which client/view is active is derived from the URL
  // below, never stored separately, so it can never go stale relative to what's on screen.
  const [myClients, setMyClients] = useState<AssignedClient[]>([]);
  const [askStueyOpen, setAskStueyOpen] = useState(false);

  // Admin demo previewer
  const [allClients, setAllClients] = useState<AssignedClient[]>([]);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [wipApps, setWipApps] = useState<Record<string, string>>({});
  // Gates Platform Home's first render — without this, the tile grid paints
  // fully "on" first, then visibly grays out the WIP-flagged ones a moment
  // later once getAppVisibility() resolves. Starts true for anyone who'll
  // never trigger that fetch (see the effect below) so it never blocks them.
  const [wipReady, setWipReady] = useState(false);

  const isConsultant = me?.role === 'consultant';
  const isAdmin = ADMIN_ROLES.has(me?.role ?? '');

  const consultantView = getConsultantView(location.pathname);
  const activeClient = useMemo(
    () => myClients.find(c => c.tenant_id === getConsultantClientId(location.pathname)) ?? null,
    [myClients, location.pathname]
  );
  const activeClientName = activeClient?.name;

  const isPreviewRoute = location.pathname.startsWith('/preview');
  const previewNav = getPreviewNav(location.pathname);
  const previewTenant = allClients[0]; // only one demo tenant is ever offered — see switchPreview

  function refreshMe() {
    // TEMPORARY local-only test shim — see msal.ts's getAccessToken for context. Bypasses the
    // MSAL account gate entirely so the RFP Reimagine local-backend test can reach the app
    // shell without a live interactive sign-in. Must be reverted before commit.
    const devToken = import.meta.env.VITE_LOCAL_DEV_TOKEN as string | undefined;
    if (devToken && !instance.getActiveAccount() && !accounts[0]) {
      const payload = JSON.parse(atob(devToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      const first = (v: unknown) => Array.isArray(v) ? v[0] : v;
      setMe({
        email: payload.email ?? '',
        tenantId: first(payload['extn.tenant_id']) ?? '(none)',
        role: first(payload['extn.role']) ?? 'consultant',
        firstName: '', lastName: '',
      });
      if (first(payload['extn.role']) === 'consultant') loadMyClients();
      setAuthReady(true);
      return;
    }
    // MFA/Conditional Access is enforced entirely by Entra on its own hosted
    // sign-in pages before a token is ever issued — unlike Cognito, there is
    // no post-login "is MFA set up yet" check to do here.
    const account = instance.getActiveAccount() ?? accounts[0] ?? null;
    if (!account) {
      setMe(null);
      setAuthReady(true);
      return;
    }
    const claims = claimsFromAccount(account);
    setMe(claims);
    if (shouldShowOnboarding()) setShowOnboarding(true);
    if (claims.role === 'consultant') {
      loadMyClients();
    }
    setAuthReady(true);
  }

  async function loadMyClients() {
    try {
      const clients = await getMyClients();
      setMyClients(clients);
      // Auto-select when there's exactly one client and the user landed on bare Platform
      // Home — never overrides a direct deep link to a specific client/view.
      if (clients.length === 1 && location.pathname === '/consultant') {
        navigate(`/consultant/${clients[0].tenant_id}`, { replace: true });
      }
    } catch {
      setMyClients([]);
    }
  }

  // Keep the API client's active-tenant header in sync with whatever the URL currently
  // resolves to — covers in-app navigation AND a direct deep-link/refresh alike, since both
  // just change what activeClient derives to.
  useEffect(() => {
    setActiveClientTenant(activeClient?.tenant_id ?? null);
  }, [activeClient?.tenant_id]);

  // Safety net for the bare "/" root and any role-mismatched path (e.g. a consultant
  // wandering to /admin/*, or a non-super_admin on /preview/*) — bounce to the right home.
  // Never fires for someone already on a valid path for their role.
  useEffect(() => {
    if (!me) return;
    const p = location.pathname;
    if (p.startsWith('/preview') && me.role !== 'super_admin') {
      navigate('/admin/clients', { replace: true });
    } else if (isAdmin && !p.startsWith('/admin') && !p.startsWith('/preview')) {
      navigate('/admin/clients', { replace: true });
    } else if (isConsultant && !p.startsWith('/consultant')) {
      navigate('/consultant', { replace: true });
    }
  }, [me, isAdmin, isConsultant, location.pathname, navigate]);

  function switchClient(client: AssignedClient) {
    const nav = consultantView === 'workspace' ? getWorkspaceNavSection(location.pathname) : 'documents';
    navigate(`/consultant/${client.tenant_id}/${nav}`);
  }

  function launchApp(appId: AppId) {
    if (appId === 'rfp-reimagine') {
      navigate('/consultant/rfp-reimagine');
    } else if (appId === 'ask-stuey') {
      setAskStueyOpen(true);
    } else if (appId === 'process-intelligence') {
      // Its own top-level view, not the ConsultantPanel workspace — still
      // needs an active client engagement first (client-scoped, see
      // APP_SCOPE in PlatformHome.tsx).
      navigate(activeClient
        ? `/consultant/${activeClient.tenant_id}/process-intelligence`
        : '/consultant/client-picker?next=process-intelligence');
    } else if (appId === 'test-automation') {
      // Also its own top-level view (same reasoning as Process Intelligence
      // above) — client-scoped, needs an active client engagement first.
      navigate(activeClient
        ? `/consultant/${activeClient.tenant_id}/test-automation`
        : '/consultant/client-picker?next=test-automation');
    } else if (appId === 'bp-workbook-generation') {
      // Also its own top-level view (same reasoning as Process Intelligence
      // above) — client-scoped, needs an active client engagement first.
      navigate(activeClient
        ? `/consultant/${activeClient.tenant_id}/bp-workbook-generation`
        : '/consultant/client-picker?next=bp-workbook-generation');
    } else if (WORKSPACE_NAV[appId]) {
      // Client-scoped apps that land inside the ConsultantPanel workspace
      // (see APP_SCOPE in PlatformHome.tsx) — need an active client
      // engagement before they mean anything, so route through the picker
      // first if none is set.
      const nav = WORKSPACE_NAV[appId]!;
      if (APP_SCOPE[appId] === 'client' && !activeClient) {
        navigate(`/consultant/client-picker?next=${nav}`);
      } else if (activeClient) {
        navigate(`/consultant/${activeClient.tenant_id}/${nav}`);
      }
    }
    // Other app IDs are "coming soon" tiles — PlatformHome handles those inline, never calls onLaunch for them.
  }

  useEffect(() => { refreshMe(); }, [accounts.length]);

  useEffect(() => {
    if (me?.role === 'super_admin') {
      listTenants()
        .then(ts => setAllClients(ts
          .filter((t: any) => t.status !== 'archived')
          .map((t: any) => ({ tenant_id: t.tenant_id, name: t.name || t.tenant_id, industry: t.industry || '' }))
        ))
        .catch(() => {});
    }
  }, [me?.role]);

  useEffect(() => {
    if (!me) return; // role not known yet — this same effect re-fires once refreshMe() sets it
    if (me.role === 'consultant') {
      getAppVisibility().then(r => setWipApps(r.wip_apps)).catch(() => setWipApps({})).finally(() => setWipReady(true));
    } else {
      // Non-consultant roles (admin's own view) never read wipApps, so don't
      // block anything on a fetch that's never going to happen.
      setWipReady(true);
    }
  }, [me?.role]);

  function switchPreview(value: string) {
    if (value === 'admin') {
      setActiveClientTenant(null);
      navigate('/admin/clients');
    } else {
      navigate('/preview');
    }
  }

  function launchPreviewApp(appId: AppId) {
    if (appId === 'process-intelligence') {
      navigate('/preview/process-intelligence');
    } else if (WORKSPACE_NAV[appId]) {
      navigate(`/preview/workspace/${WORKSPACE_NAV[appId]}`);
    }
    // Firm-wide apps (RFP Reimagine, Ask Stuey) aren't previewable here yet —
    // Platform Home just won't call onLaunch for anything else since those
    // tiles aren't wired to a preview destination.
  }

  async function onSignInClick() {
    setSigningIn(true);
    setError(null);
    try {
      await instance.loginRedirect(loginRequest);
      // Navigates away to Entra's hosted sign-in (password + any MFA
      // Conditional Access policy requires); execution does not continue
      // past this point in the current page load.
    } catch (err: any) {
      setError(err.message || String(err));
      setSigningIn(false);
    }
  }

  async function onSignOut() {
    setActiveClientTenant(null);
    setMe(null);
    setMyClients([]);
    setAllClients([]);
    setWipApps({});
    setWipReady(false);
    setError(null);
    await instance.logoutRedirect();
  }

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <svg width="40" height="40" viewBox="0 0 36 36" fill="none">
            <path d="M18 2 C17.4 11.6 12.6 16.6 2 18 C12.6 19.4 17.4 24.4 18 34 C18.6 24.4 23.4 19.4 34 18 C23.4 16.6 18.6 11.6 18 2Z" fill="white" opacity="0.9"/>
            <circle cx="27" cy="9" r="2.4" fill="white" opacity="0.45" />
          </svg>
          <div className="w-5 h-5 border-2 border-white/20 border-t-white/70 rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="min-h-screen flex">
        {/* Left branding panel */}
        <div className="hidden lg:flex lg:w-[58%] bg-slate-900 relative overflow-hidden flex-col justify-between p-14">

          {/* Radiant light burst — decorative */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            {/* Central glow origin */}
            <div className="absolute top-[38%] left-[44%] w-72 h-72 rounded-full bg-indigo-500 opacity-[0.07] blur-3xl" />
            {/* Ray lines fanning out from center-right */}
            {[
              'top-[37%] left-[46%] w-[420px] h-px rotate-[0deg]',
              'top-[37%] left-[46%] w-[380px] h-px rotate-[18deg]',
              'top-[37%] left-[46%] w-[320px] h-px rotate-[36deg]',
              'top-[37%] left-[46%] w-[260px] h-px rotate-[54deg]',
              'top-[37%] left-[46%] w-[200px] h-px rotate-[72deg]',
              'top-[37%] left-[46%] w-[380px] h-px rotate-[-18deg]',
              'top-[37%] left-[46%] w-[300px] h-px rotate-[-36deg]',
              'top-[37%] left-[46%] w-[220px] h-px rotate-[-54deg]',
            ].map((cls, i) => (
              <div key={i} className={`absolute ${cls} bg-white opacity-[0.04] origin-left`} />
            ))}
            {/* Corner accent circles */}
            <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full bg-slate-800" />
            <div className="absolute -bottom-16 -left-16 w-64 h-64 rounded-full bg-slate-800 opacity-70" />
          </div>

          {/* Top: Logo */}
          <div className="relative flex items-center gap-3">
            <div className="w-9 h-9 bg-slate-800 rounded-lg flex items-center justify-center shadow-lg">
              <LuminaLogo size={26} />
            </div>
            <span className="text-white text-base font-semibold tracking-tight">Lumina</span>
          </div>

          {/* Middle: Headline + two-persona breakdown */}
          <div className="relative space-y-10">
            <div>
              <div className="inline-flex items-center gap-2 bg-white/5 border border-white/10 rounded-full px-3 py-1 mb-6">
                <LuminaLogo size={13} />
                <span className="text-white/60 text-xs font-medium tracking-wide">Illuminate Your Enterprise</span>
              </div>
              <h1 className="text-4xl font-bold text-white leading-tight tracking-tight">
                AI intelligence,<br />built for consultants.
              </h1>
              <p className="text-slate-400 text-sm leading-relaxed mt-4 max-w-xs">
                One platform for the consultants who deliver — upload & analyze client
                documents, generate deliverables, and ship faster.
              </p>
            </div>

            {/* Consultant capabilities */}
            <div className="bg-white/5 border border-white/10 rounded-2xl p-5 space-y-3 max-w-xs">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-md bg-indigo-500/20 flex items-center justify-center">
                  <svg className="w-3.5 h-3.5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <span className="text-white text-xs font-semibold tracking-wide uppercase">Consultant</span>
              </div>
              <ul className="space-y-2">
                {[
                  'Upload & index project docs',
                  'AI risk & gap analysis',
                  'SOW deliverable validation',
                  'Process intelligence & test generation',
                ].map(item => (
                  <li key={item} className="flex items-start gap-2">
                    <span className="mt-1 w-1 h-1 rounded-full bg-indigo-400 flex-shrink-0" />
                    <span className="text-slate-400 text-xs leading-relaxed">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Bottom: footer */}
          <div className="relative text-slate-600 text-xs">
            © 2025 Lumina · Illuminate Your Enterprise
          </div>
        </div>

        {/* Right login panel — Entra handles password/MFA entirely on its own
            hosted pages (Conditional Access policy, if any, applies there);
            this is just the entry point into that redirect. */}
        <div className="flex-1 flex items-center justify-center bg-white px-8 py-12">
          <div className="w-full max-w-[360px]">
            {/* Mobile logo */}
            <div className="flex items-center gap-2 mb-10 lg:hidden">
              <div className="w-8 h-8 bg-slate-900 rounded-md flex items-center justify-center">
                <LuminaLogo size={22} />
              </div>
              <span className="font-semibold text-slate-900">Lumina</span>
            </div>

            <div className="mb-8">
              <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Welcome back</h2>
              <p className="text-slate-500 text-sm mt-1">Sign in to your workspace with your organization account</p>
            </div>

            {error && <div className="mb-4"><MfaError message={error} /></div>}

            <button
              type="button"
              onClick={onSignInClick}
              disabled={signingIn}
              className="w-full flex items-center justify-center gap-2.5 bg-slate-900 text-white py-2.5 rounded-lg hover:bg-slate-700 disabled:opacity-50 text-sm font-medium transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true">
                <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
              </svg>
              {signingIn ? 'Redirecting…' : 'Sign in with Microsoft'}
            </button>

            <p className="text-xs text-slate-400 mt-8 text-center">
              Need access? Contact your project administrator.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const roleBadge: Record<string, string> = {
    consultant:    'bg-[#86BC25]/20 text-[#86BC25] border border-[#86BC25]/30',
    project_admin: 'bg-amber-500/20  text-amber-300  border border-amber-500/30',
    super_admin:   'bg-white/10      text-white       border border-white/20',
  };
  const roleLabel: Record<string, string> = {
    consultant: 'Consultant',
    project_admin: 'Project Admin',
    super_admin: 'Super Admin',
  };

  function goHome() {
    if (isAdmin) navigate('/admin/clients');
    else if (isConsultant) navigate('/consultant');
  }

  const previewValue = !isPreviewRoute ? 'admin' : `consultant:${previewTenant?.tenant_id ?? ''}`;
  const isPreviewing = me.role === 'super_admin' && isPreviewRoute;

  return (
    <div className="h-screen flex flex-col">
      {/* Preview banner */}
      {isPreviewing && (
        <div className="bg-[#86BC25] text-black text-xs font-medium px-4 py-1.5 flex items-center justify-between flex-shrink-0">
          <span>
            Demo preview — viewing as{' '}
            <span className="font-bold capitalize">consultant</span>
            {previewTenant && (
              <> · <span className="font-bold">{previewTenant.name}</span></>
            )}
          </span>
          <span className="flex items-center gap-4">
            {previewNav !== 'home' && (
              <button
                onClick={() => navigate('/preview')}
                className="underline hover:no-underline font-bold"
              >
                Platform Home
              </button>
            )}
            <button
              onClick={() => switchPreview('admin')}
              className="underline hover:no-underline font-bold"
            >
              Back to Admin Panel
            </button>
          </span>
        </div>
      )}

      <header className="border-b border-[#222] bg-black px-6 py-0 flex items-center justify-between flex-shrink-0 h-14">
        {/* Logo — click goes home */}
        <button
          onClick={goHome}
          className="flex items-center gap-3 group focus:outline-none"
        >
          <div className="w-8 h-8 flex items-center justify-center">
            <LuminaLogo size={24} />
          </div>
          <div className="text-left">
            <div className="text-sm font-bold text-white tracking-wide leading-none">Lumina.</div>
            <div className="text-[10px] text-[#86BC25] mt-0.5 leading-none tracking-wider uppercase">Illuminate Your Enterprise</div>
          </div>
        </button>

        <div className="flex items-center gap-3">
          {/* Consultant client switcher */}
          {isConsultant && consultantView === 'workspace' && myClients.length > 0 && (
            <>
              <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5">
                <span className="text-xs text-white/40">Client:</span>
                <div className="flex gap-1">
                  {myClients.map(c => (
                    <button
                      key={c.tenant_id}
                      onClick={() => switchClient(c)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                        activeClient?.tenant_id === c.tenant_id
                          ? 'bg-[#86BC25] text-black'
                          : 'text-white/60 hover:text-white hover:bg-white/10'
                      }`}
                    >
                      {c.name || c.tenant_id}
                    </button>
                  ))}
                </div>
              </div>
              <div className="h-6 w-px bg-white/10" />
            </>
          )}

          {/* Admin demo previewer — pill switcher */}
          {me.role === 'super_admin' && allClients.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 bg-white/5 border border-white/10 rounded-lg p-0.5">
                {[
                  { value: 'admin', label: 'Admin' },
                  { value: `consultant:${allClients[0].tenant_id}`, label: 'Consultant' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => switchPreview(opt.value)}
                    title={opt.value.startsWith('consultant') ? `${opt.label} — ${allClients[0].name}` : opt.label}
                    className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors ${
                      previewValue === opt.value
                        ? 'bg-[#86BC25] text-black'
                        : 'text-white/50 hover:text-white hover:bg-white/10'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <div className="h-6 w-px bg-white/10" />
            </>
          )}

          {/* Role badge */}
          <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${roleBadge[me.role] || 'bg-white/10 text-white/60'}`}>
            {roleLabel[me.role] || me.role}
          </span>

          <div className="h-6 w-px bg-white/10" />

          <div className="text-right">
            {me.firstName ? (
              <>
                <div className="text-xs font-medium text-white">{me.firstName} {me.lastName}</div>
                <div className="text-[11px] text-white/40">{me.email}</div>
              </>
            ) : (
              <div className="text-xs text-white/60">{me.email}</div>
            )}
          </div>

          <button
            onClick={onSignOut}
            className="text-xs text-white/40 hover:text-[#86BC25] transition-colors ml-1"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="flex-1 bg-[#f8f9fa] overflow-hidden" style={{ borderTop: '1px solid #1a1a1a' }}>
        {isAdmin && !isPreviewRoute && (
          <AdminPanel role={me.role} email={me.email} tab={getAdminTab(location.pathname)} onTabChange={(t) => navigate(`/admin/${t}`)} />
        )}

        {isAdmin && isPreviewRoute && (
          previewNav === 'home' ? (
            <PlatformHome firstName={me.firstName} onLaunch={launchPreviewApp} activeClientName={previewTenant?.name} wipApps={wipApps} />
          ) : previewNav === 'process-intelligence' ? (
            <ProcessIntelligence tenantId={previewTenant?.tenant_id ?? ''} clientName={previewTenant?.name} onBack={() => navigate('/preview')} />
          ) : (
            <ConsultantPanel role="consultant" tenantId={previewTenant?.tenant_id ?? ''} clientName={previewTenant?.name}
              activeNav={getPreviewWorkspaceNav(location.pathname)} onNavChange={(n) => navigate(`/preview/workspace/${n}`)} />
          )
        )}

        {isConsultant && (
          consultantView === 'home' ? (
            wipReady ? (
              <PlatformHome firstName={me.firstName} onLaunch={launchApp} activeClientName={activeClientName} wipApps={wipApps} />
            ) : (
              <div className="h-full flex items-center justify-center">
                <div className="w-8 h-8 border-2 border-[#E5E5EA] border-t-[#0C0D0D] rounded-full animate-spin" />
              </div>
            )
          ) : consultantView === 'client-picker' ? (
            <ClientPicker
              clients={myClients}
              onSelect={c => {
                const next = new URLSearchParams(location.search).get('next') || 'documents';
                navigate(`/consultant/${c.tenant_id}/${next}`);
              }}
              onBack={() => navigate('/consultant')}
            />
          ) : consultantView === 'rfp' ? (
            <div className="h-full overflow-hidden">
              <RfpReimagine onBack={() => navigate('/consultant')} />
            </div>
          ) : consultantView === 'process-intelligence' && activeClient ? (
            <div className="h-full overflow-hidden">
              <ProcessIntelligence tenantId={activeClient.tenant_id} clientName={activeClient.name} onBack={() => navigate('/consultant')} />
            </div>
          ) : consultantView === 'test-automation' && activeClient ? (
            <div className="h-full overflow-hidden">
              <TestAutomationSuite
                tenantId={activeClient.tenant_id} clientName={activeClient.name} onBack={() => navigate('/consultant')}
                runId={getTestAutomationRunId(location.pathname)}
                onRunIdChange={(runId) => navigate(`/consultant/${activeClient.tenant_id}/test-automation/${runId}`, { replace: true })}
                view={getTestAutomationView(location.pathname)}
                onViewChange={(v) => navigate(`/consultant/${activeClient.tenant_id}/test-automation${v === 'build' ? '' : `/${v}`}`)}
                reportRunId={getTestAutomationReportRunId(location.pathname)}
                onReportRunIdChange={(runId) => navigate(
                  runId
                    ? `/consultant/${activeClient.tenant_id}/test-automation/reports/${runId}`
                    : `/consultant/${activeClient.tenant_id}/test-automation/reports`,
                  { replace: true },
                )}
              />
            </div>
          ) : consultantView === 'bp-workbook-generation' && activeClient ? (
            <div className="h-full overflow-hidden">
              <BpWorkbookGeneration tenantId={activeClient.tenant_id} clientName={activeClient.name} onBack={() => navigate('/consultant')} />
            </div>
          ) : activeClient ? (
            <div className="h-full flex flex-col overflow-hidden">
              <ConsultantPanel role={me.role} tenantId={activeClient.tenant_id} clientName={activeClient.name}
                activeNav={getWorkspaceNavSection(location.pathname)}
                onNavChange={(n) => navigate(`/consultant/${activeClient.tenant_id}/${n}`)} />
            </div>
          ) : wipReady ? (
            <PlatformHome firstName={me.firstName} onLaunch={launchApp} activeClientName={activeClientName} wipApps={wipApps} />
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="w-8 h-8 border-2 border-[#E5E5EA] border-t-[#0C0D0D] rounded-full animate-spin" />
            </div>
          )
        )}

        {isConsultant && (
          <AskStuey context={STUEY_CONTEXT[consultantView]} open={askStueyOpen} onOpenChange={setAskStueyOpen} />
        )}
      </main>

      {showOnboarding && me && (
        <OnboardingChecklist onDismiss={() => setShowOnboarding(false)} />
      )}
    </div>
  );
}

function ClientPicker({
  clients,
  onSelect,
  onBack,
}: {
  clients: AssignedClient[];
  onSelect: (c: AssignedClient) => void;
  onBack: () => void;
}) {
  const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';
  return (
    <div style={{ height: '100%', overflow: 'auto', fontFamily: FONT, background: '#F5F5F7' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '48px 24px 60px' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: '#6E6E73', fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 20 }}>
          ← Back to Platform
        </button>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: '#1D1D1F', margin: '0 0 6px', letterSpacing: '-0.01em' }}>
          Choose a client
        </h1>
        <p style={{ fontSize: 14, color: '#6E6E73', margin: '0 0 28px' }}>
          Process Intelligence works within a client engagement — pick which one.
        </p>

        {clients.length === 0 ? (
          <div style={{ background: '#FFFFFF', borderRadius: 14, border: '1px solid #E5E5EA', padding: 40, textAlign: 'center' }}>
            <p style={{ fontSize: 14, fontWeight: 600, color: '#1D1D1F', margin: 0 }}>No clients assigned yet</p>
            <p style={{ fontSize: 13, color: '#8E8E93', marginTop: 6 }}>Ask a Project Admin to assign you to a client engagement.</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
            {clients.map(c => (
              <button key={c.tenant_id} onClick={() => onSelect(c)} style={{
                background: '#FFFFFF', border: '1px solid #E5E5EA', borderRadius: 14, padding: 20, textAlign: 'left',
                cursor: 'pointer', fontFamily: FONT, transition: 'box-shadow 0.15s ease',
              }}
                onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 8px 20px rgba(0,0,0,0.06)'; }}
                onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none'; }}
              >
                <div style={{ width: 36, height: 36, borderRadius: 10, background: '#F5F5F7', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#3A3A3C', marginBottom: 12 }}>
                  {c.name.charAt(0).toUpperCase()}
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#1D1D1F' }}>{c.name}</div>
                {c.industry && <div style={{ fontSize: 12.5, color: '#8E8E93', marginTop: 2 }}>{c.industry}</div>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MfaError({ message }: { message: string }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg px-3.5 py-2.5 text-sm text-red-700 flex items-start gap-2">
      <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      {message}
    </div>
  );
}
