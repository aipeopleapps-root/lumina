import { useEffect, useState } from 'react';
import {
  signIn,
  signOut,
  getCurrentUser,
  fetchUserAttributes,
} from 'aws-amplify/auth';
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
  const [signingIn, setSigningIn] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

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
    setActiveClientTenant(null);
    setMe(null);
    setMyClients([]);
    setActiveClient(null);
    setPreview({ view: 'admin' });
    setAllClients([]);
  }

  if (!me) {
    return (
      <div className="min-h-screen flex">
        {/* Left branding panel */}
        <div className="hidden lg:flex lg:w-[58%] bg-slate-900 relative overflow-hidden flex-col justify-between p-14">
          {/* Decorative background shapes */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <div className="absolute -top-32 -right-32 w-[480px] h-[480px] rounded-full bg-slate-800" />
            <div className="absolute bottom-[-80px] left-[-60px] w-80 h-80 rounded-full bg-slate-800 opacity-60" />
            <div className="absolute top-1/2 left-2/3 w-56 h-56 rounded-full bg-indigo-950 opacity-50" />
            <div className="absolute top-[30%] left-[10%] w-1 h-24 bg-indigo-500 opacity-20 rotate-12" />
            <div className="absolute top-[55%] left-[20%] w-1 h-16 bg-indigo-500 opacity-15 rotate-12" />
          </div>

          {/* Top: Logo */}
          <div className="relative flex items-center gap-3">
            <div className="w-9 h-9 bg-slate-800 rounded-lg flex items-center justify-center shadow-lg">
              <LuminaLogo size={26} dark />
            </div>
            <span className="text-white text-base font-semibold tracking-tight">Lumina</span>
          </div>

          {/* Middle: Headline + features */}
          <div className="relative space-y-10">
            <div>
              <div className="inline-flex items-center gap-2 bg-indigo-950 border border-indigo-800 rounded-full px-3 py-1 mb-5">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
                <span className="text-indigo-300 text-xs font-medium">Illuminate Your Enterprise</span>
              </div>
              <h1 className="text-4xl font-bold text-white leading-tight tracking-tight">
                AI-powered intelligence<br />for every engagement
              </h1>
              <p className="text-slate-400 text-base leading-relaxed mt-4 max-w-sm">
                From implementation to optimisation — give your consultants an AI co-pilot and your clients a premium experience.
              </p>
            </div>

            <div className="space-y-5">
              {[
                {
                  label: 'Document Intelligence',
                  desc: 'Surface insights from SOWs, config guides, and tenant documents instantly.',
                  colour: 'bg-indigo-500',
                },
                {
                  label: 'AI Advisory Chat',
                  desc: 'Answer complex Workday questions with citations from your knowledge base.',
                  colour: 'bg-violet-500',
                },
                {
                  label: 'Delivery Assurance',
                  desc: 'Proactively identify project risks and keep every engagement on track.',
                  colour: 'bg-blue-500',
                },
              ].map(f => (
                <div key={f.label} className="flex items-start gap-4">
                  <div className={`w-7 h-7 rounded-md ${f.colour} flex-shrink-0 flex items-center justify-center mt-0.5 opacity-90`}>
                    <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <div>
                    <div className="text-white text-sm font-semibold">{f.label}</div>
                    <div className="text-slate-400 text-sm mt-0.5 leading-relaxed">{f.desc}</div>
                  </div>
                </div>
              ))}
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
                <LuminaLogo size={22} dark />
              </div>
              <span className="font-semibold text-slate-900">Lumina</span>
            </div>

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

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3.5 py-2.5 text-sm text-red-700 flex items-start gap-2">
                  <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {error}
                </div>
              )}

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
            <LuminaLogo size={22} dark />
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
                  <optgroup label="── Consultant view ──">
                    {allClients.map(c => (
                      <option key={`consultant:${c.tenant_id}`} value={`consultant:${c.tenant_id}`}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="── Client view ──">
                    {allClients.map(c => (
                      <option key={`client:${c.tenant_id}`} value={`client:${c.tenant_id}`}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
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
            <div className="h-full flex items-center justify-center">
              <div className="text-center space-y-3">
                <div className="text-4xl">👤</div>
                <p className="text-base font-medium text-slate-700">
                  {myClients.length === 0 ? 'No clients assigned yet' : 'Select a client to get started'}
                </p>
                <p className="text-sm text-slate-400">
                  {myClients.length === 0
                    ? 'Ask a Project Admin to assign you to a client.'
                    : 'Use the client switcher in the header above.'}
                </p>
              </div>
            </div>
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
