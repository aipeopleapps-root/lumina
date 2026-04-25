import { useState, useEffect } from 'react';
import {
  listTenants, listUsers, createTenant, createUser,
  resetPassword, getAuditLog, assignConsultant,
  type AdminUser, type AuditEntry,
} from '../lib/api';
import { FolderTemplateSelector, type FolderTemplate } from './FolderTemplateSelector';
import { api } from '../lib/api';

interface Client {
  tenant_id: string;
  name: string;
  industry: string;
  region: string;
  status: string;
  user_count: number;
  document_count: number;
  created_at: string;
}

interface Props {
  role: string;
}

type Tab = 'clients' | 'assignments' | 'users' | 'audit';

const ROLE_LABELS: Record<string, string> = {
  client: 'Client',
  consultant: 'Consultant',
  project_admin: 'Project Admin',
  security_admin: 'Security Admin',
  admin: 'Admin',
};

const ROLE_BADGE: Record<string, string> = {
  client: 'bg-blue-100 text-blue-700',
  consultant: 'bg-indigo-100 text-indigo-700',
  project_admin: 'bg-amber-100 text-amber-700',
  security_admin: 'bg-red-100 text-red-700',
  admin: 'bg-slate-900 text-white',
};

export function AdminPanel({ role }: Props) {
  const isProjectAdmin = role === 'project_admin' || role === 'admin';
  const isSecurityAdmin = role === 'security_admin' || role === 'admin';

  const defaultTab: Tab = isProjectAdmin ? 'clients' : 'users';
  const [tab, setTab] = useState<Tab>(defaultTab);

  return (
    <div className="h-full flex flex-col bg-slate-50">
      {/* Tab bar */}
      <div className="bg-white border-b border-slate-200 px-6 flex gap-1 pt-3">
        {isProjectAdmin && (
          <>
            <TabBtn id="clients" label="Clients" active={tab} setTab={setTab} />
            <TabBtn id="assignments" label="Consultant Assignments" active={tab} setTab={setTab} />
          </>
        )}
        {isSecurityAdmin && (
          <>
            <TabBtn id="users" label="Users" active={tab} setTab={setTab} />
            <TabBtn id="audit" label="Audit Log" active={tab} setTab={setTab} />
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'clients' && isProjectAdmin && <ClientsTab />}
        {tab === 'assignments' && isProjectAdmin && <AssignmentsTab />}
        {tab === 'users' && isSecurityAdmin && <UsersTab />}
        {tab === 'audit' && isSecurityAdmin && <AuditTab />}
      </div>
    </div>
  );
}

function TabBtn({ id, label, active, setTab }: {
  id: Tab; label: string; active: Tab; setTab: (t: Tab) => void;
}) {
  return (
    <button
      onClick={() => setTab(id)}
      className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
        active === id
          ? 'border-slate-900 text-slate-900'
          : 'border-transparent text-slate-500 hover:text-slate-700'
      }`}
    >
      {label}
    </button>
  );
}

// ─── Clients Tab ──────────────────────────────────────────────────────────────

function ClientsTab() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [templates, setTemplates] = useState<FolderTemplate[]>([]);
  const [form, setForm] = useState({
    tenant_id: '', name: '', industry: '', region: '',
    folder_structure_template: 'standard_workday',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    load();
    api.get('/admin/get-templates')
      .then(d => setTemplates(d.templates || []))
      .catch(() => {});
  }, []);

  async function load() {
    setLoading(true);
    try { setClients(await listTenants()); }
    finally { setLoading(false); }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await createTenant(form);
      setShowCreate(false);
      setForm({ tenant_id: '', name: '', industry: '', region: '', folder_structure_template: 'standard_workday' });
      load();
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally { setSaving(false); }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Clients</h2>
          <p className="text-xs text-slate-500 mt-0.5">All client tenants on the platform</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-3 py-2 bg-slate-900 text-white text-sm rounded-lg hover:bg-slate-700 transition-colors"
        >
          + New Client
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-2 border-slate-200 border-t-slate-700 rounded-full animate-spin" />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="text-left px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Client</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Industry</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Region</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Users</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Docs</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {clients.map(c => (
                <tr key={c.tenant_id} className="hover:bg-slate-50">
                  <td className="px-5 py-3">
                    <div className="font-medium text-slate-900">{c.name}</div>
                    <div className="text-xs text-slate-400 font-mono">{c.tenant_id}</div>
                  </td>
                  <td className="px-5 py-3 text-slate-600">{c.industry || '—'}</td>
                  <td className="px-5 py-3 text-slate-600">{c.region || '—'}</td>
                  <td className="px-5 py-3 text-slate-700">{c.user_count}</td>
                  <td className="px-5 py-3 text-slate-700">{c.document_count}</td>
                  <td className="px-5 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      c.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'
                    }`}>{c.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {clients.length === 0 && (
            <div className="text-center py-12 text-slate-400 text-sm">No clients yet</div>
          )}
        </div>
      )}

      {showCreate && (
        <Modal title="New Client" onClose={() => setShowCreate(false)}>
          <form onSubmit={handleCreate} className="space-y-4">
            <Field label="Client ID *" hint="Lowercase, alphanumeric, dashes ok">
              <input required placeholder="acme-corp" value={form.tenant_id}
                onChange={e => setForm({ ...form, tenant_id: e.target.value.toLowerCase() })}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400" />
            </Field>
            <Field label="Organisation Name *">
              <input required placeholder="Acme Corporation" value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Industry">
                <input placeholder="Manufacturing" value={form.industry}
                  onChange={e => setForm({ ...form, industry: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400" />
              </Field>
              <Field label="Region">
                <input placeholder="North America" value={form.region}
                  onChange={e => setForm({ ...form, region: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400" />
              </Field>
            </div>
            {templates.length > 0 && (
              <Field label="Folder Template">
                <FolderTemplateSelector templates={templates}
                  selected={form.folder_structure_template}
                  onChange={id => setForm({ ...form, folder_structure_template: id })} />
              </Field>
            )}
            <ModalActions onCancel={() => setShowCreate(false)} saving={saving} label="Create Client" />
          </form>
        </Modal>
      )}
    </div>
  );
}

// ─── Assignments Tab ──────────────────────────────────────────────────────────

function AssignmentsTab() {
  const [clients, setClients] = useState<Client[]>([]);
  const [consultants, setConsultants] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  // assignments[consultantSub][tenantId] = true
  const [assignments, setAssignments] = useState<Record<string, Record<string, boolean>>>({});

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [c, u] = await Promise.all([listTenants(), listUsers()]);
      setClients(c);
      setConsultants(u.filter((x: AdminUser) => x.role === 'consultant'));
      // Assignments start unchecked; state is authoritative as the admin toggles.
      setAssignments({});
    } finally { setLoading(false); }
  }

  async function toggle(consultant: AdminUser, tenantId: string) {
    const key = `${consultant.sub}-${tenantId}`;
    setSaving(key);
    const current = assignments[consultant.sub]?.[tenantId] ?? false;
    const action = current ? 'unassign' : 'assign';
    try {
      await assignConsultant(consultant.sub, consultant.email, tenantId, action);
      setAssignments(prev => ({
        ...prev,
        [consultant.sub]: {
          ...(prev[consultant.sub] || {}),
          [tenantId]: !current,
        },
      }));
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally { setSaving(null); }
  }

  if (loading) {
    return <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-slate-200 border-t-slate-700 rounded-full animate-spin" /></div>;
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Consultant Assignments</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Toggle to assign or remove a consultant's access to a client. Changes take effect immediately.
        </p>
      </div>

      {consultants.length === 0 && (
        <div className="text-center py-12 text-slate-400 text-sm">No consultants found. Create consultant users first.</div>
      )}

      {consultants.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
          <table className="text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="text-left px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide w-56">Consultant</th>
                {clients.map(c => (
                  <th key={c.tenant_id} className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide text-center min-w-[120px]">
                    <div>{c.name}</div>
                    <div className="font-mono text-slate-400 normal-case font-normal">{c.tenant_id}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {consultants.map(u => (
                <tr key={u.sub} className="hover:bg-slate-50">
                  <td className="px-5 py-3">
                    <div className="font-medium text-slate-800">{u.email}</div>
                    <div className="text-xs text-slate-400 font-mono">{u.sub.slice(0, 8)}…</div>
                  </td>
                  {clients.map(c => {
                    const key = `${u.sub}-${c.tenant_id}`;
                    const isOn = assignments[u.sub]?.[c.tenant_id] ?? false;
                    const isLoading = saving === key;
                    return (
                      <td key={c.tenant_id} className="px-4 py-3 text-center">
                        <button
                          onClick={() => toggle(u, c.tenant_id)}
                          disabled={isLoading}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none disabled:opacity-50 ${
                            isOn ? 'bg-green-500' : 'bg-slate-200'
                          }`}
                        >
                          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                            isOn ? 'translate-x-6' : 'translate-x-1'
                          }`} />
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Users Tab ────────────────────────────────────────────────────────────────

function UsersTab() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showReset, setShowReset] = useState<AdminUser | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [form, setForm] = useState({ email: '', tenant_id: '', role: 'consultant', temporary_password: 'TempPass123!' });
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    load();
    listTenants().then(setClients).catch(() => {});
  }, []);

  async function load() {
    setLoading(true);
    try { setUsers(await listUsers()); }
    finally { setLoading(false); }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const r = await createUser(form);
      alert(`User created!\n\nEmail: ${r.email}\nTemp password: ${r.temporary_password}\n\nUser must change password on first login.`);
      setShowCreate(false);
      setForm({ email: '', tenant_id: '', role: 'consultant', temporary_password: 'TempPass123!' });
      load();
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally { setSaving(false); }
  }

  const filtered = users.filter(u =>
    !search || u.email.includes(search) || u.tenant_id.includes(search) || u.role.includes(search)
  );

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Users</h2>
          <p className="text-xs text-slate-500 mt-0.5">All platform users. Reset passwords or create new accounts.</p>
        </div>
        <div className="flex gap-2">
          <input
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="input w-48"
          />
          <button onClick={() => setShowCreate(true)}
            className="px-3 py-2 bg-slate-900 text-white text-sm rounded-lg hover:bg-slate-700 transition-colors">
            + New User
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-slate-200 border-t-slate-700 rounded-full animate-spin" /></div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="text-left px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">User</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Tenant</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Role</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map(u => (
                <tr key={u.sub} className="hover:bg-slate-50">
                  <td className="px-5 py-3">
                    <div className="font-medium text-slate-900">{u.email}</div>
                    <div className="text-xs text-slate-400 font-mono">{u.sub.slice(0, 12)}…</div>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-slate-600">{u.tenant_id || '—'}</td>
                  <td className="px-5 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${ROLE_BADGE[u.role] || 'bg-slate-100 text-slate-600'}`}>
                      {ROLE_LABELS[u.role] || u.role}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      u.enabled ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                    }`}>
                      {u.enabled ? u.status || 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <button
                      onClick={() => setShowReset(u)}
                      className="text-xs text-slate-600 hover:text-slate-900 border border-slate-200 rounded px-2 py-1 hover:border-slate-400 transition-colors"
                    >
                      Reset Password
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="text-center py-12 text-slate-400 text-sm">No users found</div>
          )}
        </div>
      )}

      {showCreate && (
        <Modal title="New User" onClose={() => setShowCreate(false)}>
          <form onSubmit={handleCreate} className="space-y-4">
            <Field label="Email *">
              <input required type="email" placeholder="user@example.com" value={form.email}
                onChange={e => setForm({ ...form, email: e.target.value.toLowerCase() })}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400" />
            </Field>
            <Field label="Client">
              <select value={form.tenant_id} onChange={e => setForm({ ...form, tenant_id: e.target.value })} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400">
                <option value="">Platform-level (no tenant)</option>
                {clients.map(c => <option key={c.tenant_id} value={c.tenant_id}>{c.name} ({c.tenant_id})</option>)}
              </select>
            </Field>
            <Field label="Role *">
              <select required value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400">
                <option value="client">Client</option>
                <option value="consultant">Consultant</option>
                <option value="project_admin">Project Admin</option>
                <option value="security_admin">Security Admin</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
            <Field label="Temporary Password" hint="User must change on first login">
              <input value={form.temporary_password}
                onChange={e => setForm({ ...form, temporary_password: e.target.value })}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400" />
            </Field>
            <ModalActions onCancel={() => setShowCreate(false)} saving={saving} label="Create User" />
          </form>
        </Modal>
      )}

      {showReset && (
        <ResetPasswordModal user={showReset} onClose={() => setShowReset(null)} />
      )}
    </div>
  );
}

function ResetPasswordModal({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const [password, setPassword] = useState('TempPass123!');
  const [saving, setSaving] = useState(false);

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await resetPassword(user.email, password);
      alert(`Password reset for ${user.email}.\nNew temp password: ${password}`);
      onClose();
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally { setSaving(false); }
  }

  return (
    <Modal title={`Reset Password — ${user.email}`} onClose={onClose}>
      <form onSubmit={handleReset} className="space-y-4">
        <Field label="New Temporary Password" hint="User must change on next login">
          <input required value={password} onChange={e => setPassword(e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400" />
        </Field>
        <ModalActions onCancel={onClose} saving={saving} label="Reset Password" destructive />
      </form>
    </Modal>
  );
}

// ─── Audit Log Tab ────────────────────────────────────────────────────────────

function AuditTab() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterTenant, setFilterTenant] = useState('');
  const [filterKind, setFilterKind] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      setEntries(await getAuditLog({
        limit: 100,
        ...(filterTenant ? { tenant_id: filterTenant } : {}),
        ...(filterKind ? { kind: filterKind } : {}),
      }));
    } catch (err: any) {
      alert(`Failed to load audit log: ${err.message}`);
    } finally { setLoading(false); }
  }

  const KIND_BADGE: Record<string, string> = {
    chat: 'bg-blue-100 text-blue-700',
    analyze: 'bg-indigo-100 text-indigo-700',
    ingest: 'bg-green-100 text-green-700',
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Audit Log</h2>
          <p className="text-xs text-slate-500 mt-0.5">All AI interactions across tenants. Most recent first.</p>
        </div>
        <div className="flex gap-2 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500">Tenant</label>
            <input placeholder="acme" value={filterTenant} onChange={e => setFilterTenant(e.target.value)} className="input w-32" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500">Kind</label>
            <select value={filterKind} onChange={e => setFilterKind(e.target.value)} className="input w-32">
              <option value="">All</option>
              <option value="chat">Chat</option>
              <option value="analyze">Analyze</option>
              <option value="ingest">Ingest</option>
            </select>
          </div>
          <button onClick={load} className="px-3 py-2 bg-slate-900 text-white text-sm rounded-lg hover:bg-slate-700 transition-colors">
            Apply
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-slate-200 border-t-slate-700 rounded-full animate-spin" /></div>
      ) : (
        <div className="space-y-2">
          {entries.map((e, i) => (
            <div key={i} className="bg-white rounded-xl border border-slate-200 px-5 py-4 space-y-2">
              <div className="flex items-center gap-3 flex-wrap">
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${KIND_BADGE[e.kind] || 'bg-slate-100 text-slate-600'}`}>
                  {e.kind}
                </span>
                <span className="font-mono text-xs text-slate-500">{e.tenant_id}</span>
                <span className="text-xs text-slate-400">{e.user_id.slice(0, 8)}…</span>
                <span className="text-xs text-slate-400 ml-auto">{new Date(e.created_at).toLocaleString()}</span>
                <span className="text-xs text-slate-400">{e.latency_ms}ms</span>
              </div>
              {e.prompt_preview && (
                <p className="text-xs text-slate-600 bg-slate-50 rounded px-3 py-2 font-mono leading-relaxed truncate">
                  {e.prompt_preview}
                </p>
              )}
            </div>
          ))}
          {entries.length === 0 && (
            <div className="text-center py-12 text-slate-400 text-sm">No audit entries found</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-5 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-lg leading-none">✕</button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-slate-400 mt-1">{hint}</p>}
    </div>
  );
}

function ModalActions({ onCancel, saving, label, destructive }: {
  onCancel: () => void; saving: boolean; label: string; destructive?: boolean;
}) {
  return (
    <div className="flex gap-3 pt-2">
      <button type="button" onClick={onCancel}
        className="flex-1 px-4 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors">
        Cancel
      </button>
      <button type="submit" disabled={saving}
        className={`flex-1 px-4 py-2 text-sm rounded-lg font-medium text-white transition-colors disabled:opacity-50 ${
          destructive ? 'bg-red-600 hover:bg-red-700' : 'bg-slate-900 hover:bg-slate-700'
        }`}>
        {saving ? 'Saving…' : label}
      </button>
    </div>
  );
}
