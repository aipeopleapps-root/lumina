import { useEffect, useState } from 'react';
import {
  signIn,
  signOut,
  getCurrentUser,
  fetchUserAttributes,
} from 'aws-amplify/auth';
import ConsultantPanel from './components/ConsultantPanel';
import CoachPanel from './components/CoachPanel';
import { AdminPanel } from './components/AdminPanel';
import { DocumentsPanel } from './components/DocumentsPanel';

type Me = {
  email: string;
  tenantId: string;
  role: string;
} | null;

export default function App() {
  const [me, setMe] = useState<Me>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function refreshMe() {
    try {
      await getCurrentUser();
      const attrs = await fetchUserAttributes();
      setMe({
        email: attrs.email ?? '',
        tenantId: attrs['custom:tenant_id'] ?? '(none)',
        role: attrs['custom:role'] ?? 'client',
      });
    } catch {
      setMe(null);
    }
  }

  useEffect(() => {
    refreshMe();
  }, []);

  async function onSignIn(e: React.FormEvent) {
    e.preventDefault();
    setSigningIn(true);
    setError(null);
    try {
      await signIn({ username: email, password });
      await refreshMe();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSigningIn(false);
    }
  }

  async function onSignOut() {
    await signOut();
    setMe(null);
  }

  if (!me) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <form
          onSubmit={onSignIn}
          className="bg-white p-8 rounded-lg shadow-sm border border-slate-200 w-96"
        >
          <h1 className="text-xl font-semibold mb-1">Workday AI Platform</h1>
          <p className="text-sm text-slate-500 mb-6">Sign in to the demo</p>
          <label className="block text-sm mb-2">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full border border-slate-300 rounded px-3 py-2 mb-4"
            required
          />
          <label className="block text-sm mb-2">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full border border-slate-300 rounded px-3 py-2 mb-4"
            required
          />
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
          <button
            type="submit"
            disabled={signingIn}
            className="w-full bg-slate-900 text-white py-2 rounded hover:bg-slate-800 disabled:opacity-60"
          >
            {signingIn ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="text-xs text-slate-400 mt-4">
            Demo users are provisioned by the seed script. Pick a consultant or
            client user depending on which panel you want to exercise.
          </p>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header — shows tenant + role, critical for the isolation story */}
      <header className="border-b border-slate-200 bg-white px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-slate-900 rounded-md flex items-center justify-center text-white text-xs font-semibold">
            WD
          </div>
          <div>
            <div className="text-sm font-medium">Workday AI Platform</div>
            <div className="text-xs text-slate-500">Demo environment</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-xs text-slate-500">Tenant</div>
            <div className="text-sm font-semibold tracking-wide uppercase">
              {me.tenantId}
            </div>
          </div>
          <div className="h-8 w-px bg-slate-200" />
          <div className="text-right">
            <div className="text-xs text-slate-500">Signed in as</div>
            <div className="text-sm">
              {me.email} <span className="text-slate-400">· {me.role}</span>
            </div>
          </div>
          <button
            onClick={onSignOut}
            className="text-sm text-slate-600 hover:text-slate-900 ml-2"
          >
            Sign out
          </button>
        </div>
      </header>

{/* Role-based main content */}
<main className="flex-1 bg-slate-50 overflow-y-auto">
        {/* Admin: Full-screen tenant/user management */}
        {me.role === 'admin' && <AdminPanel />}
        
        {/* Consultant: Full-screen upload & analyze */}
        {me.role === 'consultant' && (
          <div className="p-6 max-w-5xl mx-auto">
            <div className="mb-6">
              <h2 className="text-2xl font-semibold mb-2">Consultant Portal</h2>
              <p className="text-slate-600">
                Upload Workday configuration workbooks to analyze for risks, anti-patterns, and best-practice gaps.
              </p>
            </div>
            <ConsultantPanel role={me.role} tenantId={me.tenantId} />
          </div>
        )}
        
        {/* Client: Split view - Chat + Documents */}
        {me.role === 'client' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 divide-x divide-slate-200 h-full">
            <section className="p-6 overflow-y-auto bg-white">
              <div className="mb-4">
                <h2 className="text-xl font-semibold mb-1">AI Coach</h2>
                <p className="text-sm text-slate-500">
                  Ask questions about your Workday configuration. Answers are grounded in your uploaded documents.
                </p>
              </div>
              <CoachPanel />
            </section>
            <section className="overflow-y-auto">
              <DocumentsPanel />
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
