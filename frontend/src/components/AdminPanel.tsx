import { useState, useEffect } from 'react';
import {
  listTenants, listUsers, listAssignments, createTenant, createUser,
  resetPassword, getAuditLog, assignConsultant, getCostSummary,
  archiveClient, manageUser,
  type AdminUser, type AuditEntry, type CostSummary,
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

type Tab = 'clients' | 'assignments' | 'users' | 'audit' | 'costs' | 'credentials';

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
            <TabBtn id="assignments" label="Assignments" active={tab} setTab={setTab} />
            <TabBtn id="costs" label="Platform Costs" active={tab} setTab={setTab} />
          </>
        )}
        {isSecurityAdmin && (
          <>
            <TabBtn id="users" label="Users" active={tab} setTab={setTab} />
            <TabBtn id="audit" label="Audit Log" active={tab} setTab={setTab} />
          </>
        )}
        {role === 'admin' && (
          <TabBtn id="credentials" label="Demo Credentials" active={tab} setTab={setTab} />
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'clients' && isProjectAdmin && <ClientsTab />}
        {tab === 'assignments' && isProjectAdmin && <AssignmentsTab />}
        {tab === 'users' && isSecurityAdmin && <UsersTab />}
        {tab === 'audit' && isSecurityAdmin && <AuditTab />}
        {tab === 'costs' && isProjectAdmin && <CostsTab />}
        {tab === 'credentials' && role === 'admin' && <CredentialsTab />}
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
  const [showArchived, setShowArchived] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<Client | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [templates, setTemplates] = useState<FolderTemplate[]>([]);
  const [form, setForm] = useState({
    tenant_id: '', name: '', industry: '', region: '',
    folder_structure_template: 'standard_workday',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    load();
    api.get('/admin/get-templates').then(d => setTemplates(d.templates || [])).catch(() => {});
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

  async function handleArchive(client: Client, action: 'archive' | 'restore') {
    setActing(client.tenant_id);
    setConfirmArchive(null);
    try {
      await archiveClient(client.tenant_id, action);
      setClients(prev => prev.map(c =>
        c.tenant_id === client.tenant_id ? { ...c, status: action === 'archive' ? 'archived' : 'active' } : c
      ));
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally { setActing(null); }
  }

  const visible = clients.filter(c => showArchived ? true : c.status !== 'archived');
  const archivedCount = clients.filter(c => c.status === 'archived').length;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Clients</h2>
          <p className="text-xs text-slate-500 mt-0.5">All client tenants on the platform</p>
        </div>
        <div className="flex items-center gap-3">
          {archivedCount > 0 && (
            <button
              onClick={() => setShowArchived(v => !v)}
              className="text-xs text-slate-500 hover:text-slate-800 underline"
            >
              {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
            </button>
          )}
          <button onClick={() => setShowCreate(true)}
            className="px-3 py-2 bg-slate-900 text-white text-sm rounded-lg hover:bg-slate-700 transition-colors">
            + New Client
          </button>
        </div>
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
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visible.map(c => {
                const isArchived = c.status === 'archived';
                const isActing = acting === c.tenant_id;
                return (
                  <tr key={c.tenant_id} className={isArchived ? 'opacity-50 bg-slate-50' : 'hover:bg-slate-50'}>
                    <td className="px-5 py-3">
                      <div className={`font-medium ${isArchived ? 'text-slate-500' : 'text-slate-900'}`}>{c.name}</div>
                      <div className="text-xs text-slate-400 font-mono">{c.tenant_id}</div>
                    </td>
                    <td className="px-5 py-3 text-slate-600">{c.industry || '—'}</td>
                    <td className="px-5 py-3 text-slate-600">{c.region || '—'}</td>
                    <td className="px-5 py-3 text-slate-700">{c.user_count}</td>
                    <td className="px-5 py-3 text-slate-700">{c.document_count}</td>
                    <td className="px-5 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        isArchived ? 'bg-slate-100 text-slate-500' : 'bg-green-100 text-green-700'
                      }`}>{isArchived ? 'Archived' : 'Active'}</span>
                    </td>
                    <td className="px-5 py-3 text-right">
                      {isActing ? (
                        <span className="inline-block w-4 h-4 border-2 border-slate-200 border-t-slate-600 rounded-full animate-spin" />
                      ) : isArchived ? (
                        <button
                          onClick={() => handleArchive(c, 'restore')}
                          className="text-xs text-indigo-600 hover:text-indigo-800 border border-indigo-200 rounded px-2 py-1 hover:border-indigo-400 transition-colors"
                        >
                          Restore
                        </button>
                      ) : (
                        <button
                          onClick={() => setConfirmArchive(c)}
                          className="text-xs text-slate-500 hover:text-amber-700 border border-slate-200 rounded px-2 py-1 hover:border-amber-300 transition-colors"
                        >
                          Archive
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visible.length === 0 && (
            <div className="text-center py-12 text-slate-400 text-sm">No clients yet</div>
          )}
        </div>
      )}

      {/* Archive confirmation */}
      {confirmArchive && (
        <Modal title="Archive Client" onClose={() => setConfirmArchive(null)}>
          <div className="space-y-4">
            <p className="text-sm text-slate-700">
              Archive <span className="font-semibold">{confirmArchive.name}</span>?
            </p>
            <p className="text-xs text-slate-500 leading-relaxed">
              The client's data and documents are preserved. Their users will no longer appear in assignments.
              You can restore the client at any time.
            </p>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setConfirmArchive(null)}
                className="flex-1 px-4 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50">
                Cancel
              </button>
              <button onClick={() => handleArchive(confirmArchive, 'archive')}
                className="flex-1 px-4 py-2 text-sm rounded-lg font-medium text-white bg-amber-600 hover:bg-amber-700">
                Archive Client
              </button>
            </div>
          </div>
        </Modal>
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
  // assignments[consultantSub] = Set of assigned client tenant_ids
  const [assignments, setAssignments] = useState<Record<string, Set<string>>>({});
  // which consultant's "add client" picker is open
  const [addingFor, setAddingFor] = useState<string | null>(null);

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [c, u, existing] = await Promise.all([listTenants(), listUsers(), listAssignments()]);
      setClients(c);
      setConsultants(u.filter((x: AdminUser) => x.role === 'consultant'));
      const map: Record<string, Set<string>> = {};
      for (const a of existing) {
        if (!map[a.consultant_sub]) map[a.consultant_sub] = new Set();
        map[a.consultant_sub].add(a.client_tenant_id);
      }
      setAssignments(map);
    } finally { setLoading(false); }
  }

  async function assign(consultant: AdminUser, tenantId: string) {
    const key = `${consultant.sub}+${tenantId}`;
    setSaving(key);
    setAddingFor(null);
    try {
      await assignConsultant(consultant.sub, consultant.email, tenantId, 'assign');
      setAssignments(prev => {
        const next = new Set(prev[consultant.sub] ?? []);
        next.add(tenantId);
        return { ...prev, [consultant.sub]: next };
      });
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally { setSaving(null); }
  }

  async function unassign(consultant: AdminUser, tenantId: string) {
    const key = `${consultant.sub}-${tenantId}`;
    setSaving(key);
    try {
      await assignConsultant(consultant.sub, consultant.email, tenantId, 'unassign');
      setAssignments(prev => {
        const next = new Set(prev[consultant.sub] ?? []);
        next.delete(tenantId);
        return { ...prev, [consultant.sub]: next };
      });
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally { setSaving(null); }
  }

  if (loading) {
    return <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-slate-200 border-t-slate-700 rounded-full animate-spin" /></div>;
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Consultant Assignments</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Control which clients each consultant can access. Changes take effect immediately.
        </p>
      </div>

      {consultants.length === 0 && (
        <div className="bg-white rounded-xl border border-slate-200 py-12 text-center text-slate-400 text-sm">
          No consultants found. Create a consultant user first.
        </div>
      )}

      <div className="space-y-3">
        {consultants.map(consultant => {
          const assigned = assignments[consultant.sub] ?? new Set<string>();
          const unassignedClients = clients.filter(c => !assigned.has(c.tenant_id));
          const isAddingHere = addingFor === consultant.sub;

          return (
            <div key={consultant.sub} className="bg-white rounded-xl border border-slate-200 px-5 py-4">
              <div className="flex items-start justify-between gap-4">

                {/* Consultant info */}
                <div className="min-w-0">
                  {(consultant.given_name || consultant.family_name) && (
                    <div className="text-sm font-medium text-slate-900 truncate">
                      {consultant.given_name} {consultant.family_name}
                    </div>
                  )}
                  <div className={`truncate ${(consultant.given_name || consultant.family_name) ? 'text-xs text-slate-500' : 'text-sm font-medium text-slate-900'}`}>
                    {consultant.email}
                  </div>
                </div>

                {/* Assigned clients + add button */}
                <div className="flex flex-wrap items-center gap-2 justify-end flex-1 min-w-0">
                  {assigned.size === 0 && (
                    <span className="text-xs text-slate-400 italic">No clients assigned</span>
                  )}
                  {[...assigned].map(tenantId => {
                    const client = clients.find(c => c.tenant_id === tenantId);
                    const isSaving = saving === `${consultant.sub}-${tenantId}`;
                    return (
                      <span
                        key={tenantId}
                        className="inline-flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 text-indigo-800 text-xs rounded-full px-3 py-1"
                      >
                        <span className="font-medium">{client?.name || tenantId}</span>
                        <button
                          onClick={() => unassign(consultant, tenantId)}
                          disabled={!!saving}
                          title={`Remove ${tenantId}`}
                          className="text-indigo-400 hover:text-red-600 disabled:opacity-40 transition-colors leading-none font-semibold"
                        >
                          {isSaving ? (
                            <span className="inline-block w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin" />
                          ) : '×'}
                        </button>
                      </span>
                    );
                  })}

                  {/* Add client picker */}
                  {unassignedClients.length > 0 && (
                    <div className="relative">
                      {isAddingHere ? (
                        <div className="absolute right-0 top-full mt-1 z-10 bg-white border border-slate-200 rounded-xl shadow-lg min-w-[180px] py-1">
                          <div className="px-3 py-1.5 text-xs font-medium text-slate-400 uppercase tracking-wide border-b border-slate-100 mb-1">
                            Add client
                          </div>
                          {unassignedClients.map(c => (
                            <button
                              key={c.tenant_id}
                              onClick={() => assign(consultant, c.tenant_id)}
                              disabled={!!saving}
                              className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-colors"
                            >
                              <div className="font-medium">{c.name}</div>
                              <div className="text-xs text-slate-400 font-mono">{c.tenant_id}</div>
                            </button>
                          ))}
                          <div className="border-t border-slate-100 mt-1 pt-1">
                            <button
                              onClick={() => setAddingFor(null)}
                              className="w-full text-left px-3 py-1.5 text-xs text-slate-400 hover:text-slate-600"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : null}
                      <button
                        onClick={() => setAddingFor(isAddingHere ? null : consultant.sub)}
                        disabled={!!saving}
                        className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 border border-dashed border-slate-300 hover:border-slate-500 rounded-full px-3 py-1 transition-colors disabled:opacity-40"
                      >
                        + Add client
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Click-outside to close picker */}
      {addingFor && (
        <div className="fixed inset-0 z-0" onClick={() => setAddingFor(null)} />
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
  const [confirmDelete, setConfirmDelete] = useState<AdminUser | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [form, setForm] = useState({ email: '', given_name: '', family_name: '', tenant_id: '', role: 'consultant', temporary_password: 'TempPass123!' });
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
      setForm({ email: '', given_name: '', family_name: '', tenant_id: '', role: 'consultant', temporary_password: 'TempPass123!' });
      load();
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally { setSaving(false); }
  }

  async function handleManageUser(user: AdminUser, action: 'disable' | 'enable' | 'delete') {
    setActing(user.sub);
    setConfirmDelete(null);
    try {
      await manageUser(user.email, action);
      if (action === 'delete') {
        setUsers(prev => prev.filter(u => u.sub !== user.sub));
      } else {
        setUsers(prev => prev.map(u =>
          u.sub === user.sub ? { ...u, enabled: action === 'enable' } : u
        ));
      }
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally { setActing(null); }
  }

  const filtered = users.filter(u =>
    !search || u.email.includes(search) || u.tenant_id.includes(search) || u.role.includes(search)
  );

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Users</h2>
          <p className="text-xs text-slate-500 mt-0.5">All platform users. Reset passwords, disable, or remove accounts.</p>
        </div>
        <div className="flex gap-2">
          <input
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 w-48"
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
              {filtered.map(u => {
                const isActing = acting === u.sub;
                const isDisabled = !u.enabled;
                return (
                  <tr key={u.sub} className={isDisabled ? 'opacity-60 bg-slate-50' : 'hover:bg-slate-50'}>
                    <td className="px-5 py-3">
                      {(u.given_name || u.family_name) && (
                        <div className={`font-medium ${isDisabled ? 'text-slate-500' : 'text-slate-900'}`}>
                          {u.given_name} {u.family_name}
                        </div>
                      )}
                      <div className={`text-sm ${(u.given_name || u.family_name) ? 'text-slate-500' : `font-medium ${isDisabled ? 'text-slate-500' : 'text-slate-900'}`}`}>{u.email}</div>
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
                      {isActing ? (
                        <span className="inline-block w-4 h-4 border-2 border-slate-200 border-t-slate-600 rounded-full animate-spin" />
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => setShowReset(u)}
                            className="text-xs text-slate-600 hover:text-slate-900 border border-slate-200 rounded px-2 py-1 hover:border-slate-400 transition-colors"
                          >
                            Reset
                          </button>
                          {u.enabled ? (
                            <button
                              onClick={() => handleManageUser(u, 'disable')}
                              className="text-xs text-amber-600 hover:text-amber-800 border border-amber-200 rounded px-2 py-1 hover:border-amber-400 transition-colors"
                            >
                              Disable
                            </button>
                          ) : (
                            <button
                              onClick={() => handleManageUser(u, 'enable')}
                              className="text-xs text-green-600 hover:text-green-800 border border-green-200 rounded px-2 py-1 hover:border-green-400 transition-colors"
                            >
                              Enable
                            </button>
                          )}
                          <button
                            onClick={() => setConfirmDelete(u)}
                            className="text-xs text-red-500 hover:text-red-700 border border-red-200 rounded px-2 py-1 hover:border-red-400 transition-colors"
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="text-center py-12 text-slate-400 text-sm">No users found</div>
          )}
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <Modal title="Delete User" onClose={() => setConfirmDelete(null)}>
          <div className="space-y-4">
            <p className="text-sm text-slate-700">
              Permanently delete <span className="font-semibold">{confirmDelete.email}</span>?
            </p>
            <p className="text-xs text-slate-500 leading-relaxed">
              This removes the user from Cognito. Their uploaded documents and audit history are preserved.
              This action cannot be undone.
            </p>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setConfirmDelete(null)}
                className="flex-1 px-4 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50">
                Cancel
              </button>
              <button onClick={() => handleManageUser(confirmDelete, 'delete')}
                className="flex-1 px-4 py-2 text-sm rounded-lg font-medium text-white bg-red-600 hover:bg-red-700">
                Delete User
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showCreate && (
        <Modal title="New User" onClose={() => setShowCreate(false)}>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="First Name *">
                <input required placeholder="Jane" value={form.given_name}
                  onChange={e => setForm({ ...form, given_name: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400" />
              </Field>
              <Field label="Last Name *">
                <input required placeholder="Smith" value={form.family_name}
                  onChange={e => setForm({ ...form, family_name: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400" />
              </Field>
            </div>
            <Field label="Email *">
              <input required type="email" placeholder="user@example.com" value={form.email}
                onChange={e => setForm({ ...form, email: e.target.value.toLowerCase() })}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400" />
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
            <Field label="Client">
              <select value={form.tenant_id} onChange={e => setForm({ ...form, tenant_id: e.target.value })} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400">
                <option value="">Platform-level (no tenant)</option>
                {clients.map(c => <option key={c.tenant_id} value={c.tenant_id}>{c.name} ({c.tenant_id})</option>)}
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

const ACTION_BADGE: Record<string, string> = {
  'document.upload':            'bg-green-100 text-green-700',
  'document.publish':           'bg-teal-100 text-teal-700',
  'document.unpublish':         'bg-yellow-100 text-yellow-700',
  'document.delete':            'bg-red-100 text-red-700',
  'ai.chat':                    'bg-blue-100 text-blue-700',
  'ai.analyze':                 'bg-indigo-100 text-indigo-700',
  'admin.user_create':          'bg-purple-100 text-purple-700',
  'admin.tenant_create':        'bg-purple-100 text-purple-700',
  'admin.password_reset':       'bg-orange-100 text-orange-700',
  'admin.consultant_assign':    'bg-slate-100 text-slate-700',
  'admin.consultant_unassign':  'bg-slate-100 text-slate-500',
};

const ACTION_GROUPS = [
  { label: 'All', value: '' },
  { label: 'Documents', value: 'document.' },
  { label: 'AI', value: 'ai.' },
  { label: 'Admin', value: 'admin.' },
];

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const ts = entry.created_at ? new Date(entry.created_at) : null;
  const badge = ACTION_BADGE[entry.action] ?? 'bg-slate-100 text-slate-600';
  const resource = entry.resource_name || entry.resource_id || '—';

  return (
    <>
      <tr
        className="hover:bg-slate-50 cursor-pointer select-none"
        onClick={() => setOpen(o => !o)}
      >
        <td className="px-4 py-3 whitespace-nowrap">
          <div className="text-xs text-slate-800 font-mono">
            {ts ? ts.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
          </div>
          <div className="text-xs text-slate-400 font-mono">
            {ts ? ts.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}
          </div>
        </td>
        <td className="px-4 py-3">
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${badge}`}>
            {entry.action}
          </span>
        </td>
        <td className="px-4 py-3">
          <div className="text-xs text-slate-800">{entry.user_email || entry.user_id.slice(0, 12) + '…'}</div>
          <div className="text-xs text-slate-400">{entry.role}</div>
        </td>
        <td className="px-4 py-3 font-mono text-xs text-slate-600">{entry.tenant_id}</td>
        <td className="px-4 py-3 text-xs text-slate-600 max-w-[180px] truncate" title={resource}>{resource}</td>
        <td className="px-4 py-3 font-mono text-xs text-slate-400">{entry.ip_address}</td>
        <td className="px-4 py-3 text-slate-400 text-xs text-center">{open ? '▲' : '▼'}</td>
      </tr>
      {open && (
        <tr className="bg-slate-50">
          <td colSpan={7} className="px-6 py-4">
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <div className="text-slate-400 mb-1 font-medium uppercase tracking-wide text-[10px]">Event</div>
                <div className="font-mono text-slate-700">{entry.event_id}</div>
                <div className="font-mono text-slate-500 mt-1">{entry.event_ts}</div>
              </div>
              <div>
                <div className="text-slate-400 mb-1 font-medium uppercase tracking-wide text-[10px]">Resource</div>
                <div className="text-slate-700">{entry.resource_type || '—'} / {entry.resource_id || '—'}</div>
                {entry.resource_name && <div className="text-slate-500 mt-0.5">{entry.resource_name}</div>}
              </div>
              {Object.keys(entry.details ?? {}).length > 0 && (
                <div className="col-span-2">
                  <div className="text-slate-400 mb-1 font-medium uppercase tracking-wide text-[10px]">Details</div>
                  <pre className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-700 font-mono whitespace-pre-wrap overflow-auto max-h-48">
                    {JSON.stringify(entry.details, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AuditTab() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterTenant, setFilterTenant] = useState('');
  const [filterAction, setFilterAction] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    setError('');
    try {
      setEntries(await getAuditLog({
        limit: 200,
        ...(filterTenant ? { tenant_id: filterTenant } : {}),
        ...(filterAction ? { action: filterAction } : {}),
      }));
    } catch (err: any) {
      setError(err.message || 'Failed to load audit log');
    } finally { setLoading(false); }
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Audit Log</h2>
          <p className="text-xs text-slate-500 mt-0.5">All platform activity across tenants. Click any row to expand details.</p>
        </div>
        <div className="flex gap-2 items-end flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500">Tenant</label>
            <input
              placeholder="acme"
              value={filterTenant}
              onChange={e => setFilterTenant(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && load()}
              className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 w-32"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500">Category</label>
            <select
              value={filterAction}
              onChange={e => setFilterAction(e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 w-36"
            >
              {ACTION_GROUPS.map(g => (
                <option key={g.value} value={g.value}>{g.label}</option>
              ))}
            </select>
          </div>
          <button
            onClick={load}
            className="px-3 py-2 bg-slate-900 text-white text-sm rounded-lg hover:bg-slate-700 transition-colors self-end"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-2 border-slate-200 border-t-slate-700 rounded-full animate-spin" />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Datetime</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Action</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">User</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Tenant</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Resource</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">IP Address</th>
                <th className="px-4 py-3 w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {entries.map(e => (
                <AuditRow key={e.event_id || e.event_ts} entry={e} />
              ))}
            </tbody>
          </table>
          {entries.length === 0 && (
            <div className="text-center py-12 text-slate-400 text-sm">No audit entries found</div>
          )}
          {entries.length > 0 && (
            <div className="px-4 py-2 border-t border-slate-100 text-xs text-slate-400 text-right">
              {entries.length} event{entries.length !== 1 ? 's' : ''}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Platform Costs Tab ───────────────────────────────────────────────────────

const SERVICE_COLOUR: Record<string, string> = {
  'Bedrock (AI)':        'bg-purple-500',
  'Lambda (Compute)':    'bg-orange-400',
  'DynamoDB (Database)': 'bg-blue-500',
  'S3 (Document Storage)': 'bg-green-500',
  'API Gateway':         'bg-teal-500',
  'Cognito (Auth)':      'bg-indigo-400',
  'CloudWatch (Logs)':   'bg-slate-400',
  'VPC / NAT Gateway':   'bg-yellow-500',
};

function fmt(usd: number) {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return '$' + usd.toFixed(2);
}

function CostsTab() {
  const [data, setData] = useState<CostSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [days, setDays] = useState(30);

  useEffect(() => { load(days); }, [days]);

  async function load(d: number) {
    setLoading(true);
    setError('');
    try {
      setData(await getCostSummary(d));
    } catch (e: any) {
      setError(e.message || 'Failed to load cost data');
    } finally {
      setLoading(false);
    }
  }

  const PERIODS = [
    { label: '7 days',  value: 7 },
    { label: '30 days', value: 30 },
    { label: '90 days', value: 90 },
  ];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Platform Costs</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Real AWS spend via Cost Explorer. Use this to size project budgets accurately.
          </p>
        </div>
        <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
          {PERIODS.map(p => (
            <button
              key={p.value}
              onClick={() => setDays(p.value)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                days === p.value
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-2 border-slate-200 border-t-slate-700 rounded-full animate-spin" />
        </div>
      ) : data && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-4">
            <SummaryCard
              label="Total AWS Spend"
              value={fmt(data.total_usd)}
              sub={`Last ${data.period.days} days`}
              colour="text-slate-900"
            />
            <SummaryCard
              label="AI Cost (Bedrock)"
              value={fmt(data.bedrock_usd)}
              sub={data.total_usd > 0 ? `${Math.round(data.bedrock_usd / data.total_usd * 100)}% of total` : '—'}
              colour="text-purple-700"
            />
            <SummaryCard
              label="AI Calls"
              value={String(data.ai_usage.total_calls)}
              sub={data.ai_usage.total_calls > 0 && data.bedrock_usd > 0
                ? `≈ ${fmt(data.bedrock_usd / data.ai_usage.total_calls)} per call`
                : 'from audit log'}
              colour="text-blue-700"
            />
          </div>

          {/* Service breakdown */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
              <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Cost by AWS Service</h3>
            </div>
            {data.services.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">
                No cost data available yet — AWS Cost Explorer has a ~24 hr lag on new accounts.
              </p>
            ) : (
              <div className="divide-y divide-slate-100">
                {data.services.map(s => (
                  <div key={s.service} className="px-5 py-3 flex items-center gap-4">
                    <div className="w-44 flex-shrink-0 text-sm text-slate-700 truncate" title={s.service}>
                      {s.service}
                    </div>
                    <div className="flex-1 flex items-center gap-3">
                      <div className="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${SERVICE_COLOUR[s.service] ?? 'bg-slate-400'}`}
                          style={{ width: `${Math.max(s.pct, 1)}%` }}
                        />
                      </div>
                      <span className="text-xs text-slate-400 w-10 text-right">{s.pct}%</span>
                    </div>
                    <div className="w-20 text-right text-sm font-medium text-slate-800">{fmt(s.cost_usd)}</div>
                  </div>
                ))}
                <div className="px-5 py-3 flex items-center justify-between bg-slate-50">
                  <span className="text-sm font-semibold text-slate-700">Total</span>
                  <span className="text-sm font-bold text-slate-900">{fmt(data.total_usd)}</span>
                </div>
              </div>
            )}
          </div>

          {/* AI usage breakdown */}
          <div className="grid grid-cols-2 gap-4">
            {/* By action */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
                <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">AI Calls by Type</h3>
              </div>
              <div className="divide-y divide-slate-100">
                {Object.entries(data.ai_usage.by_action).length === 0 ? (
                  <p className="text-xs text-slate-400 text-center py-6">No AI calls recorded yet</p>
                ) : Object.entries(data.ai_usage.by_action)
                    .sort((a, b) => b[1] - a[1])
                    .map(([action, count]) => {
                      const pct = data.ai_usage.total_calls > 0
                        ? Math.round(count / data.ai_usage.total_calls * 100)
                        : 0;
                      const label = action === 'ai.chat' ? 'Chat' : action === 'ai.analyze' ? 'Analyze' : action;
                      const colour = action === 'ai.chat' ? 'bg-blue-400' : 'bg-indigo-400';
                      return (
                        <div key={action} className="px-5 py-3 flex items-center gap-3">
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${colour}`} />
                          <span className="text-sm text-slate-700 flex-1">{label}</span>
                          <span className="text-xs text-slate-400 w-8 text-right">{pct}%</span>
                          <span className="text-sm font-medium text-slate-800 w-12 text-right">{count.toLocaleString()}</span>
                        </div>
                      );
                    })
                }
              </div>
            </div>

            {/* By tenant */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
                <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">AI Calls by Client</h3>
              </div>
              <div className="divide-y divide-slate-100">
                {data.ai_usage.by_tenant.length === 0 ? (
                  <p className="text-xs text-slate-400 text-center py-6">No AI calls recorded yet</p>
                ) : data.ai_usage.by_tenant.map(t => {
                  const pct = data.ai_usage.total_calls > 0
                    ? Math.round(t.calls / data.ai_usage.total_calls * 100)
                    : 0;
                  return (
                    <div key={t.tenant_id} className="px-5 py-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-slate-700 truncate">{t.name}</div>
                        <div className="text-xs text-slate-400 font-mono">{t.tenant_id}</div>
                      </div>
                      <span className="text-xs text-slate-400 w-8 text-right">{pct}%</span>
                      <span className="text-sm font-medium text-slate-800 w-12 text-right">{t.calls.toLocaleString()}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Budget guidance */}
          {data.total_usd > 0 && data.period.days > 0 && (
            <div className="bg-slate-50 border border-slate-200 rounded-xl px-5 py-4 space-y-2">
              <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Budget Guidance</h3>
              <div className="grid grid-cols-3 gap-6 text-sm">
                <div>
                  <div className="text-xs text-slate-500 mb-0.5">Daily run rate</div>
                  <div className="font-semibold text-slate-900">
                    {fmt(data.total_usd / data.period.days)} / day
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-0.5">Est. monthly cost</div>
                  <div className="font-semibold text-slate-900">
                    {fmt(data.total_usd / data.period.days * 30)} / month
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-0.5">6-month project budget</div>
                  <div className="font-semibold text-slate-900">
                    {fmt(data.total_usd / data.period.days * 180)}
                  </div>
                </div>
              </div>
            </div>
          )}

          <p className="text-xs text-slate-400 text-right">{data.data_lag_note}</p>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value, sub, colour }: {
  label: string; value: string; sub: string; colour: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 px-5 py-4">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${colour}`}>{value}</div>
      <div className="text-xs text-slate-400 mt-0.5">{sub}</div>
    </div>
  );
}

// ─── Demo Credentials Tab ─────────────────────────────────────────────────────

const DEMO_USERS = [
  { email: 'admin@platform.com',          role: 'admin',          tenant: 'platform', note: 'Full access' },
  { email: 'project-admin@platform.com',  role: 'project_admin',  tenant: 'platform', note: 'Clients + assignments' },
  { email: 'security-admin@platform.com', role: 'security_admin', tenant: 'platform', note: 'Users + audit log' },
  { email: 'consultant@platform.com',     role: 'consultant',     tenant: 'platform', note: 'Assigned to acme + globex' },
  { email: 'client@acme.com',             role: 'client',         tenant: 'acme',     note: 'Acme client portal' },
  { email: 'client@globex.com',           role: 'client',         tenant: 'globex',   note: 'Globex client portal' },
];

function CredentialsTab() {
  const [copied, setCopied] = useState<string | null>(null);

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Demo Credentials</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          All accounts use password <span className="font-mono font-semibold text-slate-700">Mitre2025!</span> — provisioned automatically on deploy.
        </p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50">
              <th className="text-left px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Email</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Role</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Access</th>
              <th className="px-5 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {DEMO_USERS.map(u => (
              <tr key={u.email} className="hover:bg-slate-50">
                <td className="px-5 py-3 font-mono text-xs text-slate-800">{u.email}</td>
                <td className="px-5 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${ROLE_BADGE[u.role] || 'bg-slate-100 text-slate-600'}`}>
                    {ROLE_LABELS[u.role] || u.role}
                  </span>
                </td>
                <td className="px-5 py-3 text-xs text-slate-500">{u.note}</td>
                <td className="px-5 py-3 text-right">
                  <button
                    onClick={() => copy(u.email)}
                    className="text-xs text-slate-400 hover:text-slate-700 transition-colors"
                  >
                    {copied === u.email ? '✓ copied' : 'copy'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-4">
        <p className="text-xs font-semibold text-amber-800 mb-1">Demo environment only</p>
        <p className="text-xs text-amber-700">
          These accounts are recreated on every deployment. Do not use for real client work.
        </p>
      </div>
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
