import { useEffect, useState } from 'react';
import {
  signIn,
  signOut,
  getCurrentUser,
  fetchUserAttributes,
  confirmSignIn,
  setUpTOTP,
  verifyTOTPSetup,
  updateMFAPreference,
  fetchMFAPreference,
} from 'aws-amplify/auth';
import QRCode from 'qrcode';
import ConsultantPanel from './components/ConsultantPanel';
import { AdminPanel } from './components/AdminPanel';
import { ClientView } from './components/ClientView';
import { LuminaLogo } from './components/LuminaLogo';
import { getMyClients, setActiveClientTenant, listTenants, type AssignedClient } from './lib/api';

type Me = {
  email: string;
  tenantId: string;
  role: string;
} | null;

type PreviewMode =
  | { view: 'admin' }
  | { view: 'consultant'; tenant: AssignedClient }
  | { view: 'client'; tenant: AssignedClient };

const ADMIN_ROLES = new Set(['admin', 'project_admin', 'security_admin']);

export default function App() {
  const [me, setMe] = useState<Me>(null);
  const [authReady, setAuthReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  // MFA auth flow
  type AuthStep = 'signin' | 'mfa-totp' | 'mfa-setup';
  const [authStep, setAuthStep] = useState<AuthStep>('signin');
  const [totpCode, setTotpCode] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);
  const [setupIsConfirmSignIn, setSetupIsConfirmSignIn] = useState(false);

  // Consultant client-switcher
  const [myClients, setMyClients] = useState<AssignedClient[]>([]);
  const [activeClient, setActiveClient] = useState<AssignedClient | null>(null);

  // Admin demo previewer
  const [preview, setPreview] = useState<PreviewMode>({ view: 'admin' });
  const [allClients, setAllClients] = useState<AssignedClient[]>([]);

  async function refreshMe() {
    try {
      await getCurrentUser();
      const attrs = await fetchUserAttributes();
      const role = attrs['custom:role'] ?? 'client';
      setMe({
        email: attrs.email ?? '',
        tenantId: attrs['custom:tenant_id'] ?? '(none)',
        role,
      });
      if (role === 'consultant') {
        loadMyClients();
      }
    } catch {
      setMe(null);
    } finally {
      setAuthReady(true);
    }
  }

  async function loadMyClients() {
    try {
      const clients = await getMyClients();
      setMyClients(clients);
      if (clients.length === 1) {
        switchClient(clients[0]);
      }
    } catch {
      setMyClients([]);
    }
  }

  function switchClient(client: AssignedClient) {
    setActiveClient(client);
    setActiveClientTenant(client.tenant_id);
  }

  useEffect(() => { refreshMe(); }, []);

  useEffect(() => {
    if (me?.role === 'admin') {
      listTenants()
        .then(ts => setAllClients(ts
          .filter((t: any) => t.status !== 'archived')
          .map((t: any) => ({ tenant_id: t.tenant_id, name: t.name || t.tenant_id, industry: t.industry || '' }))
        ))
        .catch(() => {});
    }
  }, [me?.role]);

  function switchPreview(value: string) {
    if (value === 'admin') {
      setActiveClientTenant(null);
      setPreview({ view: 'admin' });
    } else {
      const [view, tenantId] = value.split(':') as ['consultant' | 'client', string];
      const tenant = allClients.find(c => c.tenant_id === tenantId);
      if (!tenant) return;
      setActiveClientTenant(tenantId);
      setPreview({ view, tenant });
    }
  }

  async function checkAndCompleteSignIn() {
    const attrs = await fetchUserAttributes();
    const role = attrs['custom:role'] ?? 'client';
    if (!ADMIN_ROLES.has(role)) {
      const mfaPref = await fetchMFAPreference();
      const hasTOTP = mfaPref.preferred === 'TOTP' || (mfaPref.enabled ?? []).includes('TOTP');
      if (!hasTOTP) {
        const details = await setUpTOTP();
        const uri = details.getSetupUri('Lumina', attrs.email ?? '');
        setTotpSecret(details.sharedSecret);
        setQrDataUrl(await QRCode.toDataURL(uri.toString(), { width: 200, margin: 2 }));
        setSetupIsConfirmSignIn(false);
        setTotpCode('');
        setError(null);
        setAuthStep('mfa-setup');
        return;
      }
    }
    await refreshMe();
  }

  async function onSignIn(e: React.FormEvent) {
    e.preventDefault();
    setSigningIn(true);
    setError(null);
    try {
      const { nextStep } = await signIn({ username: email, password });
      if (nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') {
        setTotpCode('');
        setError(null);
        setAuthStep('mfa-totp');
      } else if (nextStep.signInStep === 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP') {
        const uri = nextStep.totpSetupDetails.getSetupUri('Lumina', email);
        setTotpSecret(nextStep.totpSetupDetails.sharedSecret);
        setQrDataUrl(await QRCode.toDataURL(uri.toString(), { width: 200, margin: 2 }));
        setSetupIsConfirmSignIn(true);
        setTotpCode('');
        setError(null);
        setAuthStep('mfa-setup');
      } else {
        await checkAndCompleteSignIn();
      }
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSigningIn(false);
    }
  }

  async function onConfirmTotp(e: React.FormEvent) {
    e.preventDefault();
    setMfaBusy(true);
    setError(null);
    try {
      await confirmSignIn({ challengeResponse: totpCode });
      await refreshMe();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setMfaBusy(false);
    }
  }

  async function onVerifySetup(e: React.FormEvent) {
    e.preventDefault();
    setMfaBusy(true);
    setError(null);
    try {
      if (setupIsConfirmSignIn) {
        await confirmSignIn({ challengeResponse: totpCode });
      } else {
        await verifyTOTPSetup({ code: totpCode });
        await updateMFAPreference({ totp: 'PREFERRED' });
      }
      await refreshMe();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setMfaBusy(false);
    }
  }

  async function onCancelMfa() {
    try { await signOut(); } catch {}
    setAuthStep('signin');
    setTotpCode('');
    setError(null);
  }

  async function onSignOut() {
    await signOut();
    setActiveClientTenant(null);
    setMe(null);
    setMyClients([]);
    setActiveClient(null);
    setPreview({ view: 'admin' });
    setAllClients([]);
    setAuthStep('signin');
    setTotpCode('');
    setTotpSecret('');
    setQrDataUrl('');
    setError(null);
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
                AI intelligence,<br />built for enterprise.
              </h1>
              <p className="text-slate-400 text-sm leading-relaxed mt-4 max-w-xs">
                One platform. Two powerful experiences — for the consultants who deliver, and the clients they serve.
              </p>
            </div>

            {/* Persona cards */}
            <div className="grid grid-cols-2 gap-4">
              {/* Consultant */}
              <div className="bg-white/5 border border-white/10 rounded-2xl p-5 space-y-3">
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
                    'Publish docs to clients',
                  ].map(item => (
                    <li key={item} className="flex items-start gap-2">
                      <span className="mt-1 w-1 h-1 rounded-full bg-indigo-400 flex-shrink-0" />
                      <span className="text-slate-400 text-xs leading-relaxed">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Client */}
              <div className="bg-white/5 border border-white/10 rounded-2xl p-5 space-y-3">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md bg-teal-500/20 flex items-center justify-center">
                    <svg className="w-3.5 h-3.5 text-teal-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-3 3v-3z" />
                    </svg>
                  </div>
                  <span className="text-white text-xs font-semibold tracking-wide uppercase">Client</span>
                </div>
                <ul className="space-y-2">
                  {[
                    'Ask Lumina — AI chat advisor',
                    'Browse shared documents',
                    'Cite sources from knowledge base',
                    'Instant answers, anytime',
                  ].map(item => (
                    <li key={item} className="flex items-start gap-2">
                      <span className="mt-1 w-1 h-1 rounded-full bg-teal-400 flex-shrink-0" />
                      <span className="text-slate-400 text-xs leading-relaxed">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          {/* Bottom: footer */}
          <div className="relative text-slate-600 text-xs">
            © 2025 Lumina · Illuminate Your Enterprise
          </div>
        </div>

        {/* Right login panel */}
        <div className="flex-1 flex items-center justify-center bg-white px-8 py-12">
          <div className="w-full max-w-[360px]">
            {/* Mobile logo */}
            <div className="flex items-center gap-2 mb-10 lg:hidden">
              <div className="w-8 h-8 bg-slate-900 rounded-md flex items-center justify-center">
                <LuminaLogo size={22} />
              </div>
              <span className="font-semibold text-slate-900">Lumina</span>
            </div>

            {/* ── Step 1: Email + Password ── */}
            {authStep === 'signin' && (
              <>
                <div className="mb-8">
                  <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Welcome back</h2>
                  <p className="text-slate-500 text-sm mt-1">Sign in to your workspace</p>
                </div>
                <form onSubmit={onSignIn} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Email address</label>
                    <input
                      type="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder="you@company.com"
                      className="w-full border border-slate-300 rounded-lg px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent placeholder:text-slate-300 transition-shadow"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Password</label>
                    <input
                      type="password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent transition-shadow"
                      required
                    />
                  </div>
                  {error && <MfaError message={error} />}
                  <button
                    type="submit"
                    disabled={signingIn}
                    className="w-full bg-slate-900 text-white py-2.5 rounded-lg hover:bg-slate-700 disabled:opacity-50 text-sm font-medium transition-colors mt-1"
                  >
                    {signingIn ? 'Signing in…' : 'Sign in'}
                  </button>
                </form>
                <p className="text-xs text-slate-400 mt-8 text-center">
                  Need access? Contact your project administrator.
                </p>
              </>
            )}

            {/* ── Step 2: Enter TOTP code (already configured) ── */}
            {authStep === 'mfa-totp' && (
              <>
                <div className="flex flex-col items-center mb-8">
                  <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                    <svg className="w-6 h-6 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                    </svg>
                  </div>
                  <h2 className="text-xl font-bold text-slate-900 tracking-tight">Two-factor authentication</h2>
                  <p className="text-slate-500 text-sm mt-1 text-center">Enter the 6-digit code from your authenticator app.</p>
                </div>
                <form onSubmit={onConfirmTotp} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Authentication code</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={totpCode}
                      onChange={e => setTotpCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="000000"
                      autoFocus
                      className="w-full border border-slate-300 rounded-lg px-3.5 py-2.5 text-2xl font-mono tracking-[0.5em] text-center focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent placeholder:text-slate-200 transition-shadow"
                      required
                    />
                  </div>
                  {error && <MfaError message={error} />}
                  <button
                    type="submit"
                    disabled={mfaBusy || totpCode.length < 6}
                    className="w-full bg-slate-900 text-white py-2.5 rounded-lg hover:bg-slate-700 disabled:opacity-50 text-sm font-medium transition-colors"
                  >
                    {mfaBusy ? 'Verifying…' : 'Verify'}
                  </button>
                  <button
                    type="button"
                    onClick={onCancelMfa}
                    className="w-full text-sm text-slate-500 hover:text-slate-800 py-1.5 transition-colors"
                  >
                    ← Back to sign in
                  </button>
                </form>
              </>
            )}

            {/* ── Step 3: Forced TOTP setup ── */}
            {authStep === 'mfa-setup' && (
              <>
                <div className="mb-6">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-8 h-8 bg-amber-100 rounded-full flex items-center justify-center flex-shrink-0">
                      <svg className="w-4 h-4 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                      </svg>
                    </div>
                    <div>
                      <h2 className="text-lg font-bold text-slate-900 tracking-tight">Secure your account</h2>
                      <p className="text-slate-500 text-xs">MFA is required for your role</p>
                    </div>
                  </div>
                  <p className="text-slate-600 text-sm leading-relaxed">
                    Scan the QR code with your authenticator app (Google Authenticator, Authy, etc.), then enter the 6-digit code below.
                  </p>
                </div>

                {qrDataUrl && (
                  <div className="flex justify-center mb-4">
                    <div className="border border-slate-200 rounded-xl p-3 bg-white shadow-sm">
                      <img src={qrDataUrl} alt="TOTP QR code" width={180} height={180} />
                    </div>
                  </div>
                )}

                {totpSecret && (
                  <div className="mb-5">
                    <p className="text-xs text-slate-400 mb-1.5">Can't scan? Enter this key manually:</p>
                    <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono text-xs text-slate-700 tracking-widest break-all select-all">
                      {totpSecret.match(/.{1,4}/g)?.join(' ') ?? totpSecret}
                    </div>
                  </div>
                )}

                <form onSubmit={onVerifySetup} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Enter the 6-digit code to verify</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={totpCode}
                      onChange={e => setTotpCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="000000"
                      autoFocus
                      className="w-full border border-slate-300 rounded-lg px-3.5 py-2.5 text-2xl font-mono tracking-[0.5em] text-center focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent placeholder:text-slate-200 transition-shadow"
                      required
                    />
                  </div>
                  {error && <MfaError message={error} />}
                  <button
                    type="submit"
                    disabled={mfaBusy || totpCode.length < 6}
                    className="w-full bg-slate-900 text-white py-2.5 rounded-lg hover:bg-slate-700 disabled:opacity-50 text-sm font-medium transition-colors"
                  >
                    {mfaBusy ? 'Activating…' : 'Activate two-factor authentication'}
                  </button>
                  <button
                    type="button"
                    onClick={onCancelMfa}
                    className="w-full text-sm text-slate-500 hover:text-slate-800 py-1.5 transition-colors"
                  >
                    ← Back to sign in
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  const isConsultant = me.role === 'consultant';
  const isAdmin = ADMIN_ROLES.has(me.role);

  const roleBadge: Record<string, string> = {
    client: 'bg-blue-100 text-blue-700',
    consultant: 'bg-indigo-100 text-indigo-700',
    project_admin: 'bg-amber-100 text-amber-700',
    security_admin: 'bg-red-100 text-red-700',
    admin: 'bg-slate-900 text-white',
  };
  const roleLabel: Record<string, string> = {
    client: 'Client',
    consultant: 'Consultant',
    project_admin: 'Project Admin',
    security_admin: 'Security Admin',
    admin: 'Admin',
  };

  const previewValue = preview.view === 'admin'
    ? 'admin'
    : `${preview.view}:${(preview as any).tenant.tenant_id}`;

  const isPreviewing = me.role === 'admin' && preview.view !== 'admin';

  return (
    <div className="h-screen flex flex-col">
      {/* Preview banner */}
      {isPreviewing && (
        <div className="bg-amber-400 text-amber-900 text-xs font-medium px-4 py-1.5 flex items-center justify-between flex-shrink-0">
          <span>
            Demo preview — viewing as{' '}
            <span className="font-semibold capitalize">{preview.view}</span>
            {(preview.view === 'consultant' || preview.view === 'client') && (
              <> · <span className="font-semibold">{preview.tenant.name}</span></>
            )}
          </span>
          <button
            onClick={() => switchPreview('admin')}
            className="underline hover:no-underline ml-4"
          >
            Back to Admin Panel
          </button>
        </div>
      )}

      <header className="border-b border-slate-200 bg-white px-6 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-slate-900 rounded-md flex items-center justify-center">
            <LuminaLogo size={22} />
          </div>
          <div>
            <div className="text-sm font-medium">Lumina</div>
            <div className="text-xs text-slate-500">Illuminate Your Enterprise</div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Consultant client switcher */}
          {isConsultant && myClients.length > 0 && (
            <>
              <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5">
                <span className="text-xs text-slate-500">Client:</span>
                <div className="flex gap-1">
                  {myClients.map(c => (
                    <button
                      key={c.tenant_id}
                      onClick={() => switchClient(c)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                        activeClient?.tenant_id === c.tenant_id
                          ? 'bg-slate-900 text-white'
                          : 'text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {c.name || c.tenant_id}
                    </button>
                  ))}
                </div>
              </div>
              <div className="h-8 w-px bg-slate-200" />
            </>
          )}

          {/* Admin demo previewer */}
          {me.role === 'admin' && allClients.length > 0 && (
            <>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">Preview as</span>
                <select
                  value={previewValue}
                  onChange={e => switchPreview(e.target.value)}
                  className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400 text-slate-700 cursor-pointer"
                >
                  <option value="admin">Admin Panel</option>
                  <option value={`consultant:${allClients[0].tenant_id}`}>
                    Consultant — {allClients[0].name}
                  </option>
                  <option value={`client:${allClients[0].tenant_id}`}>
                    Client — {allClients[0].name}
                  </option>
                </select>
              </div>
              <div className="h-8 w-px bg-slate-200" />
            </>
          )}

          {/* Role badge */}
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${roleBadge[me.role] || 'bg-slate-100 text-slate-600'}`}>
            {roleLabel[me.role] || me.role}
          </span>

          <div className="h-8 w-px bg-slate-200" />

          <div className="text-right">
            <div className="text-xs text-slate-500">Signed in as</div>
            <div className="text-sm text-slate-800">{me.email}</div>
          </div>

          <button
            onClick={onSignOut}
            className="text-sm text-slate-500 hover:text-slate-900 ml-1"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="flex-1 bg-slate-50 overflow-hidden">
        {isAdmin && preview.view === 'admin' && <AdminPanel role={me.role} />}

        {isAdmin && preview.view === 'consultant' && (
          <ConsultantPanel role="consultant" tenantId={(preview as any).tenant.tenant_id} />
        )}

        {isAdmin && preview.view === 'client' && (
          <div className="h-full overflow-hidden">
            <ClientView />
          </div>
        )}

        {isConsultant && (
          activeClient ? (
            <div className="h-full flex flex-col overflow-hidden">
              <ConsultantPanel role={me.role} tenantId={activeClient.tenant_id} />
            </div>
          ) : (
            <ConsultantHome
              clients={myClients}
              userEmail={me.email}
              onSelectClient={switchClient}
            />
          )
        )}

        {me.role === 'client' && (
          <div className="h-full overflow-hidden">
            <ClientView />
          </div>
        )}
      </main>
    </div>
  );
}

function ConsultantHome({
  clients,
  userEmail,
  onSelectClient,
}: {
  clients: AssignedClient[];
  userEmail: string;
  onSelectClient: (c: AssignedClient) => void;
}) {
  const firstName = userEmail.split('@')[0].split('.')[0];
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  const quickActions = [
    {
      icon: '📄',
      title: 'Upload a document',
      desc: 'Ingest a config workbook, BPD, or SOW into a client workspace.',
    },
    {
      icon: '🔍',
      title: 'Analyse a document',
      desc: 'Surface risks, anti-patterns, and recommendations with AI.',
    },
    {
      icon: '📋',
      title: 'Validate a SOW',
      desc: 'Cross-reference deliverables against project documents.',
    },
    {
      icon: '💬',
      title: 'Client AI Advisor',
      desc: 'Preview how your client experiences the Lumina AI Advisor.',
    },
  ];

  return (
    <div className="h-full overflow-auto bg-slate-50">
      <div className="max-w-3xl mx-auto px-8 py-10 space-y-10">

        {/* Greeting */}
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            Good {getTimeOfDay()}, {cap(firstName)}
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Select a client workspace below to get started.
          </p>
        </div>

        {/* Client cards */}
        <div>
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3">
            Your clients
          </h2>
          {clients.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl px-6 py-10 text-center">
              <div className="text-3xl mb-3">🗂️</div>
              <p className="text-sm font-medium text-slate-600">No clients assigned yet</p>
              <p className="text-xs text-slate-400 mt-1">Ask a Project Admin to assign you to a client engagement.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {clients.map(c => (
                <button
                  key={c.tenant_id}
                  onClick={() => onSelectClient(c)}
                  className="group bg-white border border-slate-200 hover:border-slate-400 hover:shadow-md rounded-xl px-5 py-4 text-left transition-all duration-150"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="w-9 h-9 rounded-lg bg-slate-100 group-hover:bg-slate-900 flex items-center justify-center text-slate-600 group-hover:text-white text-sm font-semibold transition-colors flex-shrink-0">
                      {c.name.charAt(0).toUpperCase()}
                    </div>
                    <span className="text-slate-300 group-hover:text-slate-600 mt-1 transition-colors text-lg">→</span>
                  </div>
                  <div className="mt-3">
                    <div className="text-sm font-semibold text-slate-900">{c.name}</div>
                    {c.industry && (
                      <div className="text-xs text-slate-400 mt-0.5">{c.industry}</div>
                    )}
                  </div>
                  <div className="mt-3 pt-3 border-t border-slate-100 flex gap-3 text-xs text-slate-400">
                    <span>Documents</span>
                    <span>·</span>
                    <span>Analysis</span>
                    <span>·</span>
                    <span>SOW Validation</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* What you can do */}
        <div>
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3">
            What you can do in a workspace
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {quickActions.map(a => (
              <div key={a.title} className="bg-white border border-slate-200 rounded-xl px-4 py-4 flex gap-3">
                <span className="text-xl flex-shrink-0 mt-0.5">{a.icon}</span>
                <div>
                  <div className="text-sm font-medium text-slate-800">{a.title}</div>
                  <div className="text-xs text-slate-400 mt-0.5 leading-relaxed">{a.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

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

function getTimeOfDay(): string {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}
