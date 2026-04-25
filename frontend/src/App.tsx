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
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <form
          onSubmit={onSignIn}
          className="bg-white p-8 rounded-xl shadow-sm border border-slate-200 w-96"
        >
          <h1 className="text-xl font-semibold mb-1">The Mitre</h1>
          <p className="text-sm text-slate-500 mb-6">Workday Advisory Platform</p>
          <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 mb-4 text-sm"
            required
          />
          <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 mb-4 text-sm"
            required
          />
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
          <button
            type="submit"
            disabled={signingIn}
            className="w-full bg-slate-900 text-white py-2 rounded-lg hover:bg-slate-800 disabled:opacity-60 text-sm font-medium"
          >
            {signingIn ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
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
          <div className="w-8 h-8 bg-slate-900 rounded-md flex items-center justify-center text-white text-xs font-semibold tracking-tight">
            TM
          </div>
          <div>
            <div className="text-sm font-medium">The Mitre</div>
            <div className="text-xs text-slate-500">Workday Advisory Platform</div>
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
