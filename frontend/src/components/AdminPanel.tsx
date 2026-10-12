import { useState, useEffect, useMemo } from 'react';
import {
  listTenants, listUsers, listAssignments, createTenant, createUser,
  resetPassword, getAuditLog, assignConsultant, getCostSummary,
  archiveClient, updateTenant, deleteTenant, manageUser, updateUser, resetUserMfa,
  getMfaResetRequests, dismissMfaResetRequest,
  setTenantWorkdayCredential,
  listTestEnvironments, createTestEnvironment, updateTestEnvironment, type TestEnvironment,
  listAllTestAutomationRunsForTenant, type TestAutomationRun,
  getIndustryDocUploadUrl, uploadIndustryDoc, ingestIndustryDocUrl, updateIndustryDocMetadata, listIndustryDocs, deleteIndustryDoc, putFileToS3,
  getAppVisibility, setAppVisibility, getAppSettings, updateAppSettings,
  type AdminUser, type AuditEntry, type CostSummary, type MfaResetRequest,
  type IndustryDoc, type IndustryDocApp, type IndustryDocType,
  type AppVisibilityView, type WipApps,
  type AppSettingsEntry, type AppSettingDef, type AppSettingValues,
} from '../lib/api';
import { FolderTemplateSelector, type FolderTemplate } from './FolderTemplateSelector';
import { api } from '../lib/api';
import { ALL_APP_IDS, APP_LABELS } from './PlatformHome';
import { ReportDashboard, ReportDetail } from './TestAutomationReports';

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
  email: string;
  // Controlled by the caller (App.tsx, backed by the URL) rather than owned here, so a
  // refresh/deep-link/bookmark lands on the same tab instead of always resetting to default.
  tab: Tab;
  onTabChange: (tab: Tab) => void;
}

export type Tab = 'clients' | 'users' | 'audit' | 'costs' | 'test_executions' | 'knowledge' | 'settings';

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';

const ROLE_LABELS: Record<string, string> = {
  consultant: 'Consultant',
  project_admin: 'Project Admin',
  super_admin: 'Super Admin',
};

const ROLE_BADGE: Record<string, string> = {
  consultant: 'bg-indigo-100 text-indigo-700',
  project_admin: 'bg-amber-100 text-amber-700',
  super_admin: 'bg-[#1D1D1F] text-white',
};

export function AdminPanel({ role, email, tab, onTabChange }: Props) {
  const isSuperAdmin = role === 'super_admin';
  const isProjectAdmin = role === 'project_admin' || isSuperAdmin;

  return (
    <div className="h-full flex flex-col bg-[#F5F5F7]" style={{ fontFamily: FONT }}>
      {/* Tab bar */}
      <div className="bg-white border-b border-[#E5E5EA] px-6 flex gap-1 pt-3">
        {isProjectAdmin && (
          <>
            <TabBtn id="clients" label="Clients" active={tab} setTab={onTabChange} />
            <TabBtn id="users" label="Users" active={tab} setTab={onTabChange} />
            <TabBtn id="costs" label="Platform Costs" active={tab} setTab={onTabChange} />
          </>
        )}
        {isSuperAdmin && (
          <TabBtn id="audit" label="Audit Log" active={tab} setTab={onTabChange} />
        )}
        {isSuperAdmin && (
          <>
            <TabBtn id="test_executions" label="Test Executions" active={tab} setTab={onTabChange} />
            <TabBtn id="knowledge" label="Knowledge Base" active={tab} setTab={onTabChange} />
            <TabBtn id="settings" label="App Settings" active={tab} setTab={onTabChange} />
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'clients' && isProjectAdmin && <ClientsTab />}
        {tab === 'users' && isProjectAdmin && <UsersTab callerRole={role} callerEmail={email} />}
        {tab === 'audit' && isSuperAdmin && <AuditTab />}
        {tab === 'costs' && isProjectAdmin && <CostsTab />}
        {tab === 'test_executions' && isSuperAdmin && <TestExecutionsTab />}
        {tab === 'knowledge' && isSuperAdmin && <KnowledgeBaseTab />}
        {tab === 'settings' && isSuperAdmin && <AppSettingsTab />}
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
          ? 'border-[#0C0D0D] text-[#1D1D1F]'
          : 'border-transparent text-[#6E6E73] hover:text-[#3A3A3C]'
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<Client | null>(null);
  const [showEdit, setShowEdit] = useState<Client | null>(null);
  const [editForm, setEditForm] = useState({ name: '', industry: '', region: '' });
  const [confirmDelete, setConfirmDelete] = useState<Client | null>(null);
  const [showCredentials, setShowCredentials] = useState<Client | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [templates, setTemplates] = useState<FolderTemplate[]>([]);
  const [form, setForm] = useState({
    tenant_id: '', name: '', industry: '', region: '',
    folder_structure_template: 'standard_workday',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    load();
    api.get('/manage/get-templates').then(d => setTemplates(d.templates || [])).catch(() => {});
  }, []);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      setClients(await listTenants());
    } catch (err: any) {
      setLoadError(err.message || String(err));
    } finally {
      setLoading(false);
    }
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

  async function handleEditSave(e: React.FormEvent) {
    e.preventDefault();
    if (!showEdit) return;
    setSaving(true);
    try {
      await updateTenant({ tenant_id: showEdit.tenant_id, ...editForm });
      setClients(prev => prev.map(c => c.tenant_id === showEdit.tenant_id ? { ...c, ...editForm } : c));
      setShowEdit(null);
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally { setSaving(false); }
  }

  async function handleDelete(client: Client) {
    setActing(client.tenant_id);
    setConfirmDelete(null);
    try {
      await deleteTenant(client.tenant_id);
      setClients(prev => prev.filter(c => c.tenant_id !== client.tenant_id));
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
          <h2 className="text-base font-semibold text-[#1D1D1F]">Clients</h2>
          <p className="text-xs text-[#6E6E73] mt-0.5">All client tenants on the platform</p>
        </div>
        <div className="flex items-center gap-3">
          {archivedCount > 0 && (
            <button
              onClick={() => setShowArchived(v => !v)}
              className="text-xs text-[#6E6E73] hover:text-[#1D1D1F] underline"
            >
              {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
            </button>
          )}
          <button onClick={() => setShowCreate(true)}
            className="px-3 py-2 bg-[#0C0D0D] text-white text-sm rounded-full hover:bg-[#2A2A2C] transition-colors">
            + New Client
          </button>
        </div>
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700 flex items-center justify-between gap-3">
          <span>Failed to load clients: {loadError}</span>
          <button onClick={load} className="text-xs underline whitespace-nowrap">Retry</button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-2 border-[#E5E5EA] border-t-[#0C0D0D] rounded-full animate-spin" />
        </div>
      ) : loadError ? null : (
        <div className="bg-white rounded-xl border border-[#E5E5EA] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#F0F0F0] bg-[#FAFAFA]">
                <th className="text-left px-5 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Client</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Industry</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Region</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Users</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Docs</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Status</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F0F0F0]">
              {visible.map(c => {
                const isArchived = c.status === 'archived';
                const isActing = acting === c.tenant_id;
                return (
                  <tr key={c.tenant_id} className={isArchived ? 'opacity-50 bg-[#FAFAFA]' : 'hover:bg-[#FAFAFA]'}>
                    <td className="px-5 py-3">
                      <div className={`font-medium ${isArchived ? 'text-[#6E6E73]' : 'text-[#1D1D1F]'}`}>{c.name}</div>
                      <div className="text-xs text-[#8E8E93] font-mono">{c.tenant_id}</div>
                    </td>
                    <td className="px-5 py-3 text-[#6E6E73]">{c.industry || '—'}</td>
                    <td className="px-5 py-3 text-[#6E6E73]">{c.region || '—'}</td>
                    <td className="px-5 py-3 text-[#3A3A3C]">{c.user_count}</td>
                    <td className="px-5 py-3 text-[#3A3A3C]">{c.document_count}</td>
                    <td className="px-5 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        isArchived ? 'bg-[#F5F5F7] text-[#6E6E73]' : 'bg-green-100 text-green-700'
                      }`}>{isArchived ? 'Archived' : 'Active'}</span>
                    </td>
                    <td className="px-5 py-3 text-right">
                      {isActing ? (
                        <span className="inline-block w-4 h-4 border-2 border-[#E5E5EA] border-t-[#0C0D0D] rounded-full animate-spin" />
                      ) : (
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => { setShowEdit(c); setEditForm({ name: c.name, industry: c.industry, region: c.region }); }}
                            className="text-xs text-[#6E6E73] hover:text-[#1D1D1F] border border-[#E5E5EA] rounded px-2 py-1 hover:border-[#8E8E93] transition-colors"
                          >
                            Edit
                          </button>
                          {!isArchived && (
                            <button
                              onClick={() => setShowCredentials(c)}
                              className="text-xs text-[#6E6E73] hover:text-indigo-700 border border-[#E5E5EA] rounded px-2 py-1 hover:border-indigo-300 transition-colors"
                            >
                              Workday Creds
                            </button>
                          )}
                          {isArchived ? (
                            <>
                              <button
                                onClick={() => handleArchive(c, 'restore')}
                                className="text-xs text-indigo-600 hover:text-indigo-800 border border-indigo-200 rounded px-2 py-1 hover:border-indigo-400 transition-colors"
                              >
                                Restore
                              </button>
                              <button
                                onClick={() => setConfirmDelete(c)}
                                className="text-xs text-red-500 hover:text-red-700 border border-red-200 rounded px-2 py-1 hover:border-red-400 transition-colors"
                              >
                                Delete
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => setConfirmArchive(c)}
                              className="text-xs text-[#6E6E73] hover:text-amber-700 border border-[#E5E5EA] rounded px-2 py-1 hover:border-amber-300 transition-colors"
                            >
                              Archive
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visible.length === 0 && (
            <div className="text-center py-12 text-[#8E8E93] text-sm">No clients yet</div>
          )}
        </div>
      )}

      {/* Archive confirmation */}
      {confirmArchive && (
        <Modal title="Archive Client" onClose={() => setConfirmArchive(null)}>
          <div className="space-y-4">
            <p className="text-sm text-[#3A3A3C]">
              Archive <span className="font-semibold">{confirmArchive.name}</span>?
            </p>
            <p className="text-xs text-[#6E6E73] leading-relaxed">
              The client's data and documents are preserved. Their users will no longer appear in assignments.
              You can restore the client at any time.
            </p>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setConfirmArchive(null)}
                className="flex-1 px-4 py-2 text-sm border border-[#E5E5EA] rounded-full hover:bg-[#FAFAFA]">
                Cancel
              </button>
              <button onClick={() => handleArchive(confirmArchive, 'archive')}
                className="flex-1 px-4 py-2 text-sm rounded-full font-medium text-white bg-amber-600 hover:bg-amber-700">
                Archive Client
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <Modal title="Delete Client" onClose={() => setConfirmDelete(null)}>
          <div className="space-y-4">
            <p className="text-sm text-[#3A3A3C]">
              Permanently delete <span className="font-semibold">{confirmDelete.name}</span>?
            </p>
            <p className="text-xs text-[#6E6E73] leading-relaxed">
              This removes the client tenant record and any consultant assignments to it. Their uploaded
              documents are preserved (not deleted). This action cannot be undone.
            </p>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setConfirmDelete(null)}
                className="flex-1 px-4 py-2 text-sm border border-[#E5E5EA] rounded-full hover:bg-[#FAFAFA]">
                Cancel
              </button>
              <button onClick={() => handleDelete(confirmDelete)}
                className="flex-1 px-4 py-2 text-sm rounded-full font-medium text-white bg-red-600 hover:bg-red-700">
                Delete Client
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showEdit && (
        <Modal title={`Edit Client — ${showEdit.name}`} onClose={() => setShowEdit(null)}>
          <form onSubmit={handleEditSave} className="space-y-4">
            <Field label="Organisation Name *">
              <input required placeholder="Acme Corporation" value={editForm.name}
                onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Industry">
                <input placeholder="Manufacturing" value={editForm.industry}
                  onChange={e => setEditForm({ ...editForm, industry: e.target.value })}
                  className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
              </Field>
              <Field label="Region">
                <input placeholder="North America" value={editForm.region}
                  onChange={e => setEditForm({ ...editForm, region: e.target.value })}
                  className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
              </Field>
            </div>
            <Field label="Client ID" hint="Not editable — this is the permanent key for the tenant's data">
              <input disabled value={showEdit.tenant_id}
                className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm bg-[#F5F5F7] text-[#8E8E93] font-mono" />
            </Field>
            <ModalActions onCancel={() => setShowEdit(null)} saving={saving} label="Save Changes" />
          </form>
        </Modal>
      )}

      {showCreate && (
        <Modal title="New Client" onClose={() => setShowCreate(false)}>
          <form onSubmit={handleCreate} className="space-y-4">
            <Field label="Client ID *" hint="Lowercase, alphanumeric, dashes ok">
              <input required placeholder="acme-corp" value={form.tenant_id}
                onChange={e => setForm({ ...form, tenant_id: e.target.value.toLowerCase() })}
                className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
            </Field>
            <Field label="Organisation Name *">
              <input required placeholder="Acme Corporation" value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Industry">
                <input placeholder="Manufacturing" value={form.industry}
                  onChange={e => setForm({ ...form, industry: e.target.value })}
                  className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
              </Field>
              <Field label="Region">
                <input placeholder="North America" value={form.region}
                  onChange={e => setForm({ ...form, region: e.target.value })}
                  className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
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

      {showCredentials && (
        <WorkdayCredentialsModal client={showCredentials} onClose={() => setShowCredentials(null)} />
      )}
    </div>
  );
}

// ─── Workday Credentials Modal ──────────────────────────────────────────────
// One client can have several Workday environments (sandbox, preview, a production
// mirror, ...) — each gets its own credential (Key Vault, execution-worker/runner.py
// logs in with it) and can independently be scheduled for nightly regression. Write-only
// from this UI's perspective — a saved password is never fetched back or displayed,
// only a "configured" marker (see functions/admin_tenant_credentials/handler.py).
function WorkdayCredentialsModal({ client, onClose }: { client: Client; onClose: () => void }) {
  const [environments, setEnvironments] = useState<TestEnvironment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addingName, setAddingName] = useState('');
  const [creating, setCreating] = useState(false);
  const [expandedEnv, setExpandedEnv] = useState<string | null>(null);

  useEffect(() => { load(); }, [client.tenant_id]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const { environments } = await listTestEnvironments(client.tenant_id);
      setEnvironments(environments);
      if (environments.length > 0 && expandedEnv === null) setExpandedEnv(environments[0].environment_id);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleAddEnvironment(e: React.FormEvent) {
    e.preventDefault();
    if (!addingName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createTestEnvironment(client.tenant_id, addingName.trim());
      setAddingName('');
      await load();
      setExpandedEnv(created.environment_id);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal title={`Workday Environments — ${client.name}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-[#8E8E93] leading-relaxed">
          One client can have several Workday environments (sandbox, preview, a production
          mirror, ...) — each gets its own credential and can be scheduled for nightly
          regression independently. Sandbox/preview Workday tenants recommended for now
          (no MFA/SSO support).
        </p>

        {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-[#E5E5EA] border-t-[#0C0D0D] rounded-full animate-spin" />
          </div>
        ) : (
          <div>
            {environments.length === 0 && (
              <p className="text-sm text-[#8E8E93] text-center py-4">No environments configured yet — add one below.</p>
            )}
            {environments.length > 0 && (
              <div className="border border-[#E5E5EA] rounded-xl overflow-hidden">
                {environments.map((env, idx) => (
                  <EnvironmentRow
                    key={env.environment_id}
                    tenantId={client.tenant_id}
                    environment={env}
                    expanded={expandedEnv === env.environment_id}
                    onToggle={() => setExpandedEnv(expandedEnv === env.environment_id ? null : env.environment_id)}
                    onChanged={load}
                    first={idx === 0}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <form onSubmit={handleAddEnvironment} className="flex gap-2 pt-3 border-t border-[#F0F0F0]">
          <input placeholder="e.g. Sandbox, Preview, Prod Mirror" value={addingName}
            onChange={e => setAddingName(e.target.value)}
            className="flex-1 border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
          <button type="submit" disabled={creating || !addingName.trim()}
            className="px-4 py-2 text-sm rounded-full font-medium text-white bg-[#0C0D0D] hover:bg-[#2A2A2C] disabled:opacity-50 transition-colors whitespace-nowrap">
            {creating ? 'Adding…' : '+ Add Environment'}
          </button>
        </form>
      </div>
    </Modal>
  );
}

function EnvironmentRow({ tenantId, environment, expanded, onToggle, onChanged, first }: {
  tenantId: string; environment: TestEnvironment; expanded: boolean; onToggle: () => void; onChanged: () => void; first?: boolean;
}) {
  const [form, setForm] = useState({ workday_url: '', workday_username: '', workday_password: '' });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<TestAutomationRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [savingNightly, setSavingNightly] = useState(false);

  useEffect(() => {
    if (expanded && runs.length === 0) {
      setRunsLoading(true);
      listAllTestAutomationRunsForTenant(tenantId)
        .then(({ runs }) => setRuns(runs.filter(r => r.status === 'steps_ready' || r.status === 'completed')))
        .catch(() => {})
        .finally(() => setRunsLoading(false));
    }
  }, [expanded]);

  async function handleSaveCredential(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await setTenantWorkdayCredential({ tenant_id: tenantId, environment_id: environment.environment_id, ...form });
      setSaved(true);
      setForm({ workday_url: '', workday_username: '', workday_password: '' });
      onChanged();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleNightlyChange(nightly_enabled: boolean, nightly_run_id: string) {
    setSavingNightly(true);
    setError(null);
    try {
      await updateTestEnvironment(environment.environment_id, { nightly_enabled, nightly_run_id: nightly_run_id || null });
      onChanged();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSavingNightly(false);
    }
  }

  return (
    <div className={first ? '' : 'border-t border-[#E5E5EA]'}>
      <button type="button" onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-[#FAFAFA] transition-colors">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-[#1D1D1F]">{environment.name}</span>
          {environment.has_credential ? (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200">Configured</span>
          ) : (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#F5F5F7] text-[#6E6E73] border border-[#E5E5EA]">No credential</span>
          )}
          {environment.nightly_enabled && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">Nightly on</span>
          )}
        </div>
        <span className="text-[#8E8E93] text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="px-4 py-4 border-t border-[#F0F0F0] space-y-4">
          {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

          <form onSubmit={handleSaveCredential} className="space-y-3">
            <Field label="Workday Sign-In URL *" hint="e.g. https://wd5.myworkday.com/acme/login.htmld">
              <input required type="url" placeholder="https://wd5.myworkday.com/acme/login.htmld"
                value={form.workday_url} onChange={e => setForm({ ...form, workday_url: e.target.value })}
                className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
            </Field>
            <Field label="Service Account Username *">
              <input required value={form.workday_username}
                onChange={e => setForm({ ...form, workday_username: e.target.value })}
                className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
            </Field>
            <Field label="Service Account Password *">
              <input required type="password" value={form.workday_password}
                onChange={e => setForm({ ...form, workday_password: e.target.value })}
                className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
            </Field>
            {saved && <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">Saved.</p>}
            <button type="submit" disabled={saving}
              className="w-full px-4 py-2 text-sm rounded-full font-medium text-white bg-[#0C0D0D] hover:bg-[#2A2A2C] disabled:opacity-50 transition-colors">
              {saving ? 'Saving…' : environment.has_credential ? 'Replace Credential' : 'Save Credential'}
            </button>
          </form>

          <div className="pt-3 border-t border-[#F0F0F0] space-y-2">
            <label className="flex items-center gap-2 text-sm text-[#3A3A3C]">
              <input type="checkbox" checked={environment.nightly_enabled} disabled={savingNightly}
                onChange={e => handleNightlyChange(e.target.checked, environment.nightly_run_id || '')} />
              Run nightly
            </label>
            {environment.nightly_enabled && (
              <Field label="Nightly regression suite" hint="Re-runs this run's already-generated scenarios against live Workday every night — no regeneration.">
                <select value={environment.nightly_run_id || ''} disabled={savingNightly || runsLoading}
                  onChange={e => handleNightlyChange(true, e.target.value)}
                  className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]">
                  <option value="">— select a completed run —</option>
                  {runs.map(r => (
                    <option key={r.run_id} value={r.run_id}>{r.run_name || r.file_name} ({r.run_id.slice(0, 8)})</option>
                  ))}
                </select>
              </Field>
            )}
          </div>
        </div>
      )}
    </div>
  );
}


// ─── Users Tab ────────────────────────────────────────────────────────────────

function UsersTab({ callerRole, callerEmail }: { callerRole: string; callerEmail: string }) {
  const isSuperAdmin = callerRole === 'super_admin';

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showReset, setShowReset] = useState<AdminUser | null>(null);
  const [showEdit, setShowEdit] = useState<AdminUser | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AdminUser | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [form, setForm] = useState({ email: '', given_name: '', family_name: '', tenant_id: '', role: 'consultant', temporary_password: 'TempPass123!' });
  const [editForm, setEditForm] = useState({ given_name: '', family_name: '', role: '', tenant_id: '' });
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [mfaRequests, setMfaRequests] = useState<MfaResetRequest[]>([]);
  const [mfaRequestsLoading, setMfaRequestsLoading] = useState(false);
  const [actingMfa, setActingMfa] = useState<string | null>(null);
  const [showDemoCreds, setShowDemoCreds] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null);

  // Assignments — merged into this same page (was a separate "Assignments" tab) so an admin
  // can create a user and put them on a client's team in one place. assignments[userSub] =
  // Set of assigned client tenant_ids.
  const [assignments, setAssignments] = useState<Record<string, Set<string>>>({});
  const [addingFor, setAddingFor] = useState<string | null>(null);

  useEffect(() => {
    load();
    listTenants().then(setClients).catch(() => {});
    loadAssignments();
    if (isSuperAdmin) loadMfaRequests();
  }, []);

  async function loadAssignments() {
    try {
      const existing = await listAssignments();
      const map: Record<string, Set<string>> = {};
      for (const a of existing) {
        if (!map[a.consultant_sub]) map[a.consultant_sub] = new Set();
        map[a.consultant_sub].add(a.client_tenant_id);
      }
      setAssignments(map);
    } catch { /* leave empty */ }
  }

  // Which clients the caller (if project_admin, not super_admin) is themselves assigned to —
  // matches the backend permission split: a project_admin can only manage consultant
  // assignments for a client they're themselves assigned to. null = unrestricted (super_admin).
  const myAssignedClientIds = useMemo(() => {
    if (isSuperAdmin) return null;
    const me = users.find(u => u.email === callerEmail);
    return me ? (assignments[me.sub] ?? new Set<string>()) : new Set<string>();
  }, [isSuperAdmin, users, assignments, callerEmail]);

  function canManageAssignment(user: AdminUser, tenantId: string): boolean {
    if (isSuperAdmin) return true;
    if (user.role !== 'consultant') return false; // assigning a project_admin is super_admin-only
    return myAssignedClientIds?.has(tenantId) ?? false;
  }

  async function assignClient(user: AdminUser, tenantId: string) {
    const key = `${user.sub}+${tenantId}`;
    setActing(key);
    setAddingFor(null);
    try {
      await assignConsultant(user.sub, user.email, tenantId, 'assign', user.role as 'consultant' | 'project_admin');
      setAssignments(prev => {
        const next = new Set(prev[user.sub] ?? []);
        next.add(tenantId);
        return { ...prev, [user.sub]: next };
      });
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally { setActing(null); }
  }

  async function unassignClient(user: AdminUser, tenantId: string) {
    const key = `${user.sub}-${tenantId}`;
    setActing(key);
    try {
      await assignConsultant(user.sub, user.email, tenantId, 'unassign');
      setAssignments(prev => {
        const next = new Set(prev[user.sub] ?? []);
        next.delete(tenantId);
        return { ...prev, [user.sub]: next };
      });
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally { setActing(null); }
  }

  async function loadMfaRequests() {
    setMfaRequestsLoading(true);
    try { setMfaRequests(await getMfaResetRequests()); }
    catch { setMfaRequests([]); }
    finally { setMfaRequestsLoading(false); }
  }

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

  async function handleEditSave(e: React.FormEvent) {
    e.preventDefault();
    if (!showEdit) return;
    setSaving(true);
    try {
      await updateUser({ email: showEdit.email, ...editForm });
      setUsers(prev => prev.map(u =>
        u.sub === showEdit.sub ? { ...u, ...editForm } : u
      ));
      setShowEdit(null);
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally { setSaving(false); }
  }

  async function handleResetMfa(user: AdminUser) {
    setActing(user.sub);
    try {
      await resetUserMfa(user.email);
      alert(`MFA reset for ${user.email}. They will be prompted to set up MFA on next login.`);
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally { setActing(null); }
  }

  async function handleApproveMfaReset(email: string) {
    setActingMfa(email);
    try {
      await resetUserMfa(email);
      await dismissMfaResetRequest(email);
      setMfaRequests(prev => prev.filter(r => r.email !== email));
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally { setActingMfa(null); }
  }

  async function handleDismissMfaRequest(email: string) {
    setActingMfa(email);
    try {
      await dismissMfaResetRequest(email);
      setMfaRequests(prev => prev.filter(r => r.email !== email));
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally { setActingMfa(null); }
  }

  // project_admin sees only staff they could plausibly assign (consultant/project_admin) —
  // never super_admin accounts, which are outside their concern entirely.
  const visible = isSuperAdmin ? users : users.filter(u => u.role === 'consultant' || u.role === 'project_admin');
  const filtered = visible.filter(u =>
    !search || u.email.includes(search) || u.tenant_id.includes(search) || u.role.includes(search)
  );

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-[#1D1D1F]">Users</h2>
          <p className="text-xs text-[#6E6E73] mt-0.5">
            {isSuperAdmin
              ? 'All platform users. Reset passwords, disable/remove accounts, and manage client assignments.'
              : 'Consultants and project admins, and which of your clients each is assigned to.'}
          </p>
        </div>
        <div className="flex gap-2">
          <input
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D] w-48"
          />
          <button onClick={() => setShowCreate(true)}
            className="px-3 py-2 bg-[#0C0D0D] text-white text-sm rounded-full hover:bg-[#2A2A2C] transition-colors">
            + New User
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-[#E5E5EA] border-t-[#0C0D0D] rounded-full animate-spin" /></div>
      ) : (
        <div className="bg-white rounded-xl border border-[#E5E5EA] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#F0F0F0] bg-[#FAFAFA]">
                <th className="text-left px-5 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">User</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Tenant</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Role</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Assigned Clients</th>
                {isSuperAdmin && <th className="text-left px-5 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Status</th>}
                <th className="text-left px-5 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F0F0F0]">
              {filtered.map(u => {
                const isActing = typeof acting === 'string' && (acting === u.sub || acting.startsWith(`${u.sub}+`) || acting.startsWith(`${u.sub}-`));
                const isDisabled = !u.enabled;
                const canEdit = isSuperAdmin || u.role === 'consultant';
                const assigned = assignments[u.sub] ?? new Set<string>();
                const unassignedClients = clients.filter(c => c.status !== 'archived' && !assigned.has(c.tenant_id) && canManageAssignment(u, c.tenant_id));
                const isAddingHere = addingFor === u.sub;
                return (
                  <tr key={u.sub} className={isDisabled ? 'opacity-60 bg-[#FAFAFA]' : 'hover:bg-[#FAFAFA]'}>
                    <td className="px-5 py-3">
                      {(u.given_name || u.family_name) && (
                        <div className={`font-medium ${isDisabled ? 'text-[#6E6E73]' : 'text-[#1D1D1F]'}`}>
                          {u.given_name} {u.family_name}
                        </div>
                      )}
                      <div className={`text-sm ${(u.given_name || u.family_name) ? 'text-[#6E6E73]' : `font-medium ${isDisabled ? 'text-[#6E6E73]' : 'text-[#1D1D1F]'}`}`}>{u.email}</div>
                      <div className="text-xs text-[#8E8E93] font-mono">{u.sub.slice(0, 12)}…</div>
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-[#6E6E73]">{u.tenant_id || '—'}</td>
                    <td className="px-5 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${ROLE_BADGE[u.role] || 'bg-[#F5F5F7] text-[#6E6E73]'}`}>
                        {ROLE_LABELS[u.role] || u.role}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      {u.role === 'super_admin' ? (
                        <span className="text-xs text-[#8E8E93] italic">All clients</span>
                      ) : (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {[...assigned].map(tenantId => {
                            const client = clients.find(c => c.tenant_id === tenantId);
                            const removable = canManageAssignment(u, tenantId);
                            const chipActing = acting === `${u.sub}-${tenantId}`;
                            return (
                              <span key={tenantId} className="inline-flex items-center gap-1 bg-indigo-50 border border-indigo-200 text-indigo-800 text-xs rounded-full px-2 py-0.5">
                                {client?.name || tenantId}
                                {removable && (
                                  <button onClick={() => unassignClient(u, tenantId)} disabled={!!acting}
                                    className="text-indigo-400 hover:text-red-600 disabled:opacity-40 leading-none font-semibold">
                                    {chipActing ? '…' : '×'}
                                  </button>
                                )}
                              </span>
                            );
                          })}
                          {assigned.size === 0 && <span className="text-xs text-[#8E8E93] italic">None</span>}
                          {unassignedClients.length > 0 && (
                            <div className="relative">
                              <button onClick={() => setAddingFor(isAddingHere ? null : u.sub)} disabled={!!acting}
                                className="text-xs text-[#6E6E73] hover:text-[#1D1D1F] border border-dashed border-[#E5E5EA] hover:border-[#8E8E93] rounded-full px-2 py-0.5 disabled:opacity-40 transition-colors">
                                + Add
                              </button>
                              {isAddingHere && (
                                <div className="absolute left-0 top-full mt-1 z-10 bg-white border border-[#E5E5EA] rounded-xl shadow-lg min-w-[180px] py-1">
                                  <div className="px-3 py-1.5 text-xs font-medium text-[#8E8E93] uppercase tracking-wide border-b border-[#F0F0F0] mb-1">Add client</div>
                                  {unassignedClients.map(c => (
                                    <button key={c.tenant_id} onClick={() => assignClient(u, c.tenant_id)} disabled={!!acting}
                                      className="w-full text-left px-3 py-2 text-sm text-[#3A3A3C] hover:bg-[#FAFAFA] disabled:opacity-40 transition-colors">
                                      {c.name}
                                    </button>
                                  ))}
                                  <div className="border-t border-[#F0F0F0] mt-1 pt-1">
                                    <button onClick={() => setAddingFor(null)} className="w-full text-left px-3 py-1.5 text-xs text-[#8E8E93] hover:text-[#6E6E73]">Cancel</button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    {isSuperAdmin && (
                      <td className="px-5 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          u.enabled ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                        }`}>
                          {u.enabled ? u.status || 'Active' : 'Disabled'}
                        </span>
                      </td>
                    )}
                    <td className="px-5 py-3">
                      {isActing ? (
                        <span className="inline-block w-4 h-4 border-2 border-[#E5E5EA] border-t-[#0C0D0D] rounded-full animate-spin" />
                      ) : (
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {canEdit && (
                            <button
                              onClick={() => { setShowEdit(u); setEditForm({ given_name: u.given_name || '', family_name: u.family_name || '', role: u.role, tenant_id: u.tenant_id }); }}
                              className="text-xs text-[#6E6E73] hover:text-[#1D1D1F] border border-[#E5E5EA] rounded px-2 py-1 hover:border-[#8E8E93] transition-colors"
                            >
                              Edit
                            </button>
                          )}
                          {isSuperAdmin && (
                            <>
                              <button
                                onClick={() => handleResetMfa(u)}
                                className="text-xs text-indigo-600 hover:text-indigo-800 border border-indigo-200 rounded px-2 py-1 hover:border-indigo-400 transition-colors"
                              >
                                Reset MFA
                              </button>
                              <button
                                onClick={() => setShowReset(u)}
                                className="text-xs text-[#6E6E73] hover:text-[#1D1D1F] border border-[#E5E5EA] rounded px-2 py-1 hover:border-[#8E8E93] transition-colors"
                              >
                                Reset PW
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
                            </>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="text-center py-12 text-[#8E8E93] text-sm">No users found</div>
          )}
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <Modal title="Delete User" onClose={() => setConfirmDelete(null)}>
          <div className="space-y-4">
            <p className="text-sm text-[#3A3A3C]">
              Permanently delete <span className="font-semibold">{confirmDelete.email}</span>?
            </p>
            <p className="text-xs text-[#6E6E73] leading-relaxed">
              This removes the user from Entra ID. Their uploaded documents and audit history are preserved.
              This action cannot be undone.
            </p>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setConfirmDelete(null)}
                className="flex-1 px-4 py-2 text-sm border border-[#E5E5EA] rounded-full hover:bg-[#FAFAFA]">
                Cancel
              </button>
              <button onClick={() => handleManageUser(confirmDelete, 'delete')}
                className="flex-1 px-4 py-2 text-sm rounded-full font-medium text-white bg-red-600 hover:bg-red-700">
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
                  className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
              </Field>
              <Field label="Last Name *">
                <input required placeholder="Smith" value={form.family_name}
                  onChange={e => setForm({ ...form, family_name: e.target.value })}
                  className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
              </Field>
            </div>
            <Field label="Email *">
              <input required type="email" placeholder="user@example.com" value={form.email}
                onChange={e => setForm({ ...form, email: e.target.value.toLowerCase() })}
                className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
            </Field>
            {isSuperAdmin ? (
              <Field label="Role *">
                <select required value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]">
                  <option value="consultant">Consultant</option>
                  <option value="project_admin">Project Admin</option>
                  <option value="super_admin">Super Admin</option>
                </select>
              </Field>
            ) : (
              // project_admin can only create consultants — matches the backend guard in
              // admin_create_user (creating a project_admin/super_admin is a privilege grant).
              <Field label="Role">
                <div className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm bg-[#FAFAFA] text-[#6E6E73]">Consultant</div>
              </Field>
            )}
            <Field label="Client">
              <select value={form.tenant_id} onChange={e => setForm({ ...form, tenant_id: e.target.value })} className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]">
                <option value="">Platform-level (no tenant)</option>
                {clients.map(c => <option key={c.tenant_id} value={c.tenant_id}>{c.name} ({c.tenant_id})</option>)}
              </select>
            </Field>
            <Field label="Temporary Password" hint="User must change on first login">
              <input value={form.temporary_password}
                onChange={e => setForm({ ...form, temporary_password: e.target.value })}
                className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
            </Field>
            <ModalActions onCancel={() => setShowCreate(false)} saving={saving} label="Create User" />
          </form>
        </Modal>
      )}

      {showReset && (
        <ResetPasswordModal user={showReset} onClose={() => setShowReset(null)} />
      )}

      {showEdit && (
        <Modal title={`Edit User — ${showEdit.email}`} onClose={() => setShowEdit(null)}>
          <form onSubmit={handleEditSave} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="First Name">
                <input placeholder="Jane" value={editForm.given_name}
                  onChange={e => setEditForm({ ...editForm, given_name: e.target.value })}
                  className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
              </Field>
              <Field label="Last Name">
                <input placeholder="Smith" value={editForm.family_name}
                  onChange={e => setEditForm({ ...editForm, family_name: e.target.value })}
                  className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
              </Field>
            </div>
            {isSuperAdmin ? (
              <Field label="Role">
                <select value={editForm.role} onChange={e => setEditForm({ ...editForm, role: e.target.value })}
                  className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]">
                  <option value="consultant">Consultant</option>
                  <option value="project_admin">Project Admin</option>
                  <option value="super_admin">Super Admin</option>
                </select>
              </Field>
            ) : (
              <Field label="Role">
                <div className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm bg-[#FAFAFA] text-[#6E6E73]">Consultant</div>
              </Field>
            )}
            <Field label="Client">
              <select value={editForm.tenant_id} onChange={e => setEditForm({ ...editForm, tenant_id: e.target.value })}
                className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]">
                <option value="">Platform-level (no tenant)</option>
                {clients.map(c => <option key={c.tenant_id} value={c.tenant_id}>{c.name} ({c.tenant_id})</option>)}
              </select>
            </Field>
            <ModalActions onCancel={() => setShowEdit(null)} saving={saving} label="Save Changes" />
          </form>
        </Modal>
      )}

      {/* MFA Reset Requests */}
      {(mfaRequests.length > 0 || mfaRequestsLoading) && (
        <div className="bg-white rounded-xl border border-amber-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-amber-100 bg-amber-50 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-amber-900">MFA Reset Requests</h3>
              <p className="text-xs text-amber-700 mt-0.5">
                Verify the user's identity out-of-band before approving.
              </p>
            </div>
            {mfaRequestsLoading && (
              <div className="w-4 h-4 border-2 border-amber-300 border-t-amber-700 rounded-full animate-spin" />
            )}
          </div>
          <div className="divide-y divide-[#F0F0F0]">
            {mfaRequests.map(req => {
              const isActing = actingMfa === req.email;
              const ts = req.requested_at ? new Date(req.requested_at) : null;
              return (
                <div key={req.email} className="px-5 py-3 flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-[#1D1D1F]">{req.email}</div>
                    <div className="text-xs text-[#8E8E93] mt-0.5">
                      {ts ? ts.toLocaleString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                      {req.ip && <span className="ml-2 font-mono">{req.ip}</span>}
                    </div>
                  </div>
                  {isActing ? (
                    <span className="inline-block w-4 h-4 border-2 border-[#E5E5EA] border-t-[#0C0D0D] rounded-full animate-spin" />
                  ) : (
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleApproveMfaReset(req.email)}
                        className="text-xs text-green-700 hover:text-green-900 border border-green-300 rounded px-3 py-1 hover:border-green-500 transition-colors font-medium"
                      >
                        Approve Reset
                      </button>
                      <button
                        onClick={() => handleDismissMfaRequest(req.email)}
                        className="text-xs text-[#6E6E73] hover:text-[#3A3A3C] border border-[#E5E5EA] rounded px-3 py-1 hover:border-[#8E8E93] transition-colors"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Demo Credentials — moved here from its own tab; reference-only, super_admin only. */}
      {isSuperAdmin && (
        <div className="bg-white rounded-xl border border-[#E5E5EA] overflow-hidden">
          <button
            onClick={() => setShowDemoCreds(v => !v)}
            className="w-full px-5 py-3 flex items-center justify-between bg-[#FAFAFA] hover:bg-[#F5F5F7] transition-colors"
          >
            <div className="text-left">
              <h3 className="text-sm font-semibold text-[#1D1D1F]">Demo Credentials</h3>
              <p className="text-xs text-[#8E8E93] mt-0.5">Reference logins for the seeded demo environment.</p>
            </div>
            <span className="text-[#8E8E93] text-xs">{showDemoCreds ? '▲' : '▼'}</span>
          </button>
          {showDemoCreds && (
            <div className="border-t border-[#F0F0F0]">
              <p className="text-xs text-[#6E6E73] px-5 pt-3">
                All accounts use password <span className="font-mono font-semibold text-[#3A3A3C]">Mitre2025!</span> — provisioned by running the bootstrap admin action, not automatically on every deploy.
              </p>
              <table className="w-full text-sm mt-2">
                <thead>
                  <tr className="border-b border-[#F0F0F0] bg-[#FAFAFA]">
                    <th className="text-left px-5 py-2 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Email</th>
                    <th className="text-left px-5 py-2 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Role</th>
                    <th className="text-left px-5 py-2 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Access</th>
                    <th className="px-5 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F0F0F0]">
                  {DEMO_USERS.map(u => (
                    <tr key={u.email} className="hover:bg-[#FAFAFA]">
                      <td className="px-5 py-2.5 font-mono text-xs text-[#1D1D1F]">{u.email}</td>
                      <td className="px-5 py-2.5">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${ROLE_BADGE[u.role] || 'bg-[#F5F5F7] text-[#6E6E73]'}`}>
                          {ROLE_LABELS[u.role] || u.role}
                        </span>
                      </td>
                      <td className="px-5 py-2.5 text-xs text-[#6E6E73]">{u.note}</td>
                      <td className="px-5 py-2.5 text-right">
                        <button
                          onClick={() => { navigator.clipboard.writeText(u.email); setCopiedEmail(u.email); setTimeout(() => setCopiedEmail(null), 1500); }}
                          className="text-xs text-[#8E8E93] hover:text-[#3A3A3C] transition-colors"
                        >
                          {copiedEmail === u.email ? '✓ copied' : 'copy'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="m-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                <p className="text-xs font-semibold text-amber-800 mb-1">Demo environment only</p>
                <p className="text-xs text-amber-700">
                  Re-running bootstrap resets these accounts idempotently. Do not use for real client work.
                </p>
              </div>
            </div>
          )}
        </div>
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
          <input required value={password} onChange={e => setPassword(e.target.value)} className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
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
  'admin.consultant_assign':    'bg-[#F5F5F7] text-[#3A3A3C]',
  'admin.consultant_unassign':  'bg-[#F5F5F7] text-[#6E6E73]',
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
  const badge = ACTION_BADGE[entry.action] ?? 'bg-[#F5F5F7] text-[#6E6E73]';
  const resource = entry.resource_name || entry.resource_id || '—';

  return (
    <>
      <tr
        className="hover:bg-[#FAFAFA] cursor-pointer select-none"
        onClick={() => setOpen(o => !o)}
      >
        <td className="px-4 py-3 whitespace-nowrap">
          <div className="text-xs text-[#1D1D1F] font-mono">
            {ts ? ts.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
          </div>
          <div className="text-xs text-[#8E8E93] font-mono">
            {ts ? ts.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}
          </div>
        </td>
        <td className="px-4 py-3">
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${badge}`}>
            {entry.action}
          </span>
        </td>
        <td className="px-4 py-3">
          <div className="text-xs text-[#1D1D1F]">{entry.user_email || entry.user_id.slice(0, 12) + '…'}</div>
          <div className="text-xs text-[#8E8E93]">{entry.role}</div>
        </td>
        <td className="px-4 py-3 font-mono text-xs text-[#6E6E73]">{entry.tenant_id}</td>
        <td className="px-4 py-3 text-xs text-[#6E6E73] max-w-[180px] truncate" title={resource}>{resource}</td>
        <td className="px-4 py-3 font-mono text-xs text-[#8E8E93]">{entry.ip_address}</td>
        <td className="px-4 py-3 text-[#8E8E93] text-xs text-center">{open ? '▲' : '▼'}</td>
      </tr>
      {open && (
        <tr className="bg-[#FAFAFA]">
          <td colSpan={7} className="px-6 py-4">
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <div className="text-[#8E8E93] mb-1 font-medium uppercase tracking-wide text-[10px]">Event</div>
                <div className="font-mono text-[#3A3A3C]">{entry.event_id}</div>
                <div className="font-mono text-[#6E6E73] mt-1">{entry.event_ts}</div>
              </div>
              <div>
                <div className="text-[#8E8E93] mb-1 font-medium uppercase tracking-wide text-[10px]">Resource</div>
                <div className="text-[#3A3A3C]">{entry.resource_type || '—'} / {entry.resource_id || '—'}</div>
                {entry.resource_name && <div className="text-[#6E6E73] mt-0.5">{entry.resource_name}</div>}
              </div>
              {Object.keys(entry.details ?? {}).length > 0 && (
                <div className="col-span-2">
                  <div className="text-[#8E8E93] mb-1 font-medium uppercase tracking-wide text-[10px]">Details</div>
                  <pre className="bg-white border border-[#E5E5EA] rounded-lg px-3 py-2 text-xs text-[#3A3A3C] font-mono whitespace-pre-wrap overflow-auto max-h-48">
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
          <h2 className="text-base font-semibold text-[#1D1D1F]">Audit Log</h2>
          <p className="text-xs text-[#6E6E73] mt-0.5">All platform activity across tenants. Click any row to expand details.</p>
        </div>
        <div className="flex gap-2 items-end flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-[#6E6E73]">Tenant</label>
            <input
              placeholder="acme"
              value={filterTenant}
              onChange={e => setFilterTenant(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && load()}
              className="border border-[#E5E5EA] rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D] w-32"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-[#6E6E73]">Category</label>
            <select
              value={filterAction}
              onChange={e => setFilterAction(e.target.value)}
              className="border border-[#E5E5EA] rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D] w-36"
            >
              {ACTION_GROUPS.map(g => (
                <option key={g.value} value={g.value}>{g.label}</option>
              ))}
            </select>
          </div>
          <button
            onClick={load}
            className="px-3 py-2 bg-[#0C0D0D] text-white text-sm rounded-full hover:bg-[#2A2A2C] transition-colors self-end"
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
          <div className="w-8 h-8 border-2 border-[#E5E5EA] border-t-[#0C0D0D] rounded-full animate-spin" />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-[#E5E5EA] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#F0F0F0] bg-[#FAFAFA]">
                <th className="text-left px-4 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Datetime</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Action</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">User</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Tenant</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Resource</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">IP Address</th>
                <th className="px-4 py-3 w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F0F0F0]">
              {entries.map(e => (
                <AuditRow key={e.event_id || e.event_ts} entry={e} />
              ))}
            </tbody>
          </table>
          {entries.length === 0 && (
            <div className="text-center py-12 text-[#8E8E93] text-sm">No audit entries found</div>
          )}
          {entries.length > 0 && (
            <div className="px-4 py-2 border-t border-[#F0F0F0] text-xs text-[#8E8E93] text-right">
              {entries.length} event{entries.length !== 1 ? 's' : ''}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Platform Costs Tab ───────────────────────────────────────────────────────

// Mirrors functions/admin_cost_summary/handler.py's _SERVICE_LABELS values.
const SERVICE_COLOUR: Record<string, string> = {
  'Azure OpenAI (AI)':                     'bg-purple-500',
  'AI Foundry (AI)':                       'bg-fuchsia-500',
  'Functions (Compute)':                   'bg-orange-400',
  'Cosmos DB (Database)':                  'bg-blue-500',
  'PostgreSQL (Database)':                 'bg-cyan-500',
  'Blob/Queue Storage (Document Storage)': 'bg-green-500',
  'API Management':                        'bg-teal-500',
  'Entra ID (Auth)':                       'bg-indigo-400',
  'Key Vault (Encryption)':                'bg-pink-500',
  'Log Analytics (Logs)':                  'bg-slate-400',
  'Azure Monitor (Logs)':                  'bg-[#FAFAFA]0',
  'VNet / NAT Gateway':                    'bg-yellow-500',
  'Bandwidth / Egress':                    'bg-amber-500',
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
          <h2 className="text-base font-semibold text-[#1D1D1F]">Platform Costs</h2>
          <p className="text-xs text-[#6E6E73] mt-0.5">
            Real Azure spend via Cost Management. Use this to size project budgets accurately.
          </p>
        </div>
        <div className="flex gap-1 bg-[#F5F5F7] rounded-lg p-1">
          {PERIODS.map(p => (
            <button
              key={p.value}
              onClick={() => setDays(p.value)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                days === p.value
                  ? 'bg-white text-[#1D1D1F] shadow-sm'
                  : 'text-[#6E6E73] hover:text-[#3A3A3C]'
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
          <div className="w-8 h-8 border-2 border-[#E5E5EA] border-t-[#0C0D0D] rounded-full animate-spin" />
        </div>
      ) : data && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-4">
            <SummaryCard
              label="Total Azure Spend"
              value={fmt(data.total_usd)}
              sub={`Last ${data.period.days} days`}
              colour="text-[#1D1D1F]"
            />
            <SummaryCard
              label="AI Cost (Azure OpenAI)"
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
          <div className="bg-white rounded-xl border border-[#E5E5EA] overflow-hidden">
            <div className="px-5 py-3 border-b border-[#F0F0F0] bg-[#FAFAFA]">
              <h3 className="text-xs font-semibold text-[#3A3A3C] uppercase tracking-wide">Cost by Azure Service</h3>
            </div>
            {data.services.length === 0 ? (
              <p className="text-sm text-[#8E8E93] text-center py-8">
                No cost data available yet — Azure Cost Management has a ~24 hr lag on new accounts.
              </p>
            ) : (
              <div className="divide-y divide-[#F0F0F0]">
                {data.services.map(s => (
                  <div key={s.service} className="px-5 py-3 flex items-center gap-4">
                    <div className="w-44 flex-shrink-0 text-sm text-[#3A3A3C] truncate" title={s.service}>
                      {s.service}
                    </div>
                    <div className="flex-1 flex items-center gap-3">
                      <div className="flex-1 bg-[#F5F5F7] rounded-full h-2 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${SERVICE_COLOUR[s.service] ?? 'bg-slate-400'}`}
                          style={{ width: `${Math.max(s.pct, 1)}%` }}
                        />
                      </div>
                      <span className="text-xs text-[#8E8E93] w-10 text-right">{s.pct}%</span>
                    </div>
                    <div className="w-20 text-right text-sm font-medium text-[#1D1D1F]">{fmt(s.cost_usd)}</div>
                  </div>
                ))}
                <div className="px-5 py-3 flex items-center justify-between bg-[#FAFAFA]">
                  <span className="text-sm font-semibold text-[#3A3A3C]">Total</span>
                  <span className="text-sm font-bold text-[#1D1D1F]">{fmt(data.total_usd)}</span>
                </div>
              </div>
            )}
          </div>

          {/* AI usage breakdown */}
          <div className="grid grid-cols-2 gap-4">
            {/* By action */}
            <div className="bg-white rounded-xl border border-[#E5E5EA] overflow-hidden">
              <div className="px-5 py-3 border-b border-[#F0F0F0] bg-[#FAFAFA]">
                <h3 className="text-xs font-semibold text-[#3A3A3C] uppercase tracking-wide">AI Calls by Type</h3>
              </div>
              <div className="divide-y divide-[#F0F0F0]">
                {Object.entries(data.ai_usage.by_action).length === 0 ? (
                  <p className="text-xs text-[#8E8E93] text-center py-6">No AI calls recorded yet</p>
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
                          <span className="text-sm text-[#3A3A3C] flex-1">{label}</span>
                          <span className="text-xs text-[#8E8E93] w-8 text-right">{pct}%</span>
                          <span className="text-sm font-medium text-[#1D1D1F] w-12 text-right">{count.toLocaleString()}</span>
                        </div>
                      );
                    })
                }
              </div>
            </div>

            {/* By tenant */}
            <div className="bg-white rounded-xl border border-[#E5E5EA] overflow-hidden">
              <div className="px-5 py-3 border-b border-[#F0F0F0] bg-[#FAFAFA]">
                <h3 className="text-xs font-semibold text-[#3A3A3C] uppercase tracking-wide">AI Calls by Client</h3>
              </div>
              <div className="divide-y divide-[#F0F0F0]">
                {data.ai_usage.by_tenant.length === 0 ? (
                  <p className="text-xs text-[#8E8E93] text-center py-6">No AI calls recorded yet</p>
                ) : data.ai_usage.by_tenant.map(t => {
                  const pct = data.ai_usage.total_calls > 0
                    ? Math.round(t.calls / data.ai_usage.total_calls * 100)
                    : 0;
                  return (
                    <div key={t.tenant_id} className="px-5 py-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-[#3A3A3C] truncate">{t.name}</div>
                        <div className="text-xs text-[#8E8E93] font-mono">{t.tenant_id}</div>
                      </div>
                      <span className="text-xs text-[#8E8E93] w-8 text-right">{pct}%</span>
                      <span className="text-sm font-medium text-[#1D1D1F] w-12 text-right">{t.calls.toLocaleString()}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Budget guidance */}
          {data.total_usd > 0 && data.period.days > 0 && (
            <div className="bg-[#FAFAFA] border border-[#E5E5EA] rounded-xl px-5 py-4 space-y-2">
              <h3 className="text-xs font-semibold text-[#3A3A3C] uppercase tracking-wide">Budget Guidance</h3>
              <div className="grid grid-cols-3 gap-6 text-sm">
                <div>
                  <div className="text-xs text-[#6E6E73] mb-0.5">Daily run rate</div>
                  <div className="font-semibold text-[#1D1D1F]">
                    {fmt(data.total_usd / data.period.days)} / day
                  </div>
                </div>
                <div>
                  <div className="text-xs text-[#6E6E73] mb-0.5">Est. monthly cost</div>
                  <div className="font-semibold text-[#1D1D1F]">
                    {fmt(data.total_usd / data.period.days * 30)} / month
                  </div>
                </div>
                <div>
                  <div className="text-xs text-[#6E6E73] mb-0.5">6-month project budget</div>
                  <div className="font-semibold text-[#1D1D1F]">
                    {fmt(data.total_usd / data.period.days * 180)}
                  </div>
                </div>
              </div>
            </div>
          )}

          <p className="text-xs text-[#8E8E93] text-right">{data.data_lag_note}</p>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value, sub, colour }: {
  label: string; value: string; sub: string; colour: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-[#E5E5EA] px-5 py-4">
      <div className="text-xs text-[#6E6E73] mb-1">{label}</div>
      <div className={`text-2xl font-bold ${colour}`}>{value}</div>
      <div className="text-xs text-[#8E8E93] mt-0.5">{sub}</div>
    </div>
  );
}

// ─── Test Executions Tab (super_admin-only cross-client rollup) ───────────────
// Reuses ReportDashboard/ReportDetail from TestAutomationReports.tsx wholesale (`all: true`
// switches the fetch to functions/test_automation/handler.py's cross-tenant _reports_dashboard
// branch and adds the Client column/filter) rather than a near-duplicate component — the
// table/detail rendering is otherwise identical to the per-client consultant Reports tab.

function TestExecutionsTab() {
  const [selected, setSelected] = useState<{ runId: string; tenantId?: string } | null>(null);

  return (
    <div className="p-6">
      {selected ? (
        <ReportDetail runId={selected.runId} tenantId={selected.tenantId} onBack={() => setSelected(null)} />
      ) : (
        <ReportDashboard all onOpenRun={(runId, tenantId) => setSelected({ runId, tenantId })} />
      )}
    </div>
  );
}

// ─── Knowledge Base Tab (firm-wide industry-knowledge doc tagging) ────────────

const KB_INDUSTRIES = [
  'technology', 'finance', 'healthcare', 'education', 'retail',
  'manufacturing', 'government', 'media', 'other',
] as const;

const KB_APPS: { value: IndustryDocApp; label: string }[] = [
  { value: 'rfp-reimagine', label: 'RFP Reimagine' },
  { value: 'blueprint-match', label: 'Blueprint Match' },
  { value: 'ask-stuey', label: 'Ask Stuey' },
];

const KB_DOC_TYPES: { value: IndustryDocType; label: string }[] = [
  // Original rfp-reimagine / blueprint-match categories.
  { value: 'rfp_excerpt', label: 'RFP Excerpt' },
  { value: 'case_study', label: 'Case Study' },
  { value: 'proposal_content', label: 'Proposal Content' },
  { value: 'blueprint', label: 'Blueprint' },
  { value: 'cover_letter_template', label: 'Cover Letter Template' },
  // Added once Ask Stuey became the dominant uploader — its real content
  // (SKU lists, cutover decks, doc.workday.com pages) was all landing in "Other".
  { value: 'pricing_sku', label: 'Pricing / SKU List' },
  { value: 'process_delivery', label: 'Process / Delivery Deck' },
  { value: 'product_overview', label: 'Product Overview' },
  { value: 'workday_documentation', label: 'Workday Documentation' },
  { value: 'other', label: 'Other' },
];

// Workday's own product/module suite — a fixed list so admins pick a
// consistent name instead of free-typing near-duplicates ("HCM" vs "Core HR").
const WORKDAY_MODULES = [
  'HCM', 'Payroll', 'Absence', 'Benefits', 'Recruiting', 'Talent Management',
  'Compensation', 'Time Tracking', 'Learning', 'Financial Management',
  'Adaptive Planning', 'Procurement', 'Expenses', 'Prism Analytics',
  'Integrations', 'Platform & Security', 'Other',
];

const KB_APP_LABEL: Record<string, string> = Object.fromEntries(KB_APPS.map(a => [a.value, a.label]));
const KB_DOC_TYPE_LABEL: Record<string, string> = Object.fromEntries(KB_DOC_TYPES.map(d => [d.value, d.label]));

function KnowledgeBaseTab() {
  const [docs, setDocs] = useState<IndustryDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [editDoc, setEditDoc] = useState<IndustryDoc | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<IndustryDoc | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try { setDocs(await listIndustryDocs()); }
    finally { setLoading(false); }
  }

  async function handleDelete(doc: IndustryDoc) {
    const key = `${doc.industry}::${doc.source_name}`;
    setActing(key);
    setConfirmDelete(null);
    try {
      await deleteIndustryDoc(doc.industry, doc.source_name);
      setDocs(prev => prev.filter(d => !(d.industry === doc.industry && d.source_name === doc.source_name)));
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally { setActing(null); }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-base font-semibold text-[#1D1D1F]">Knowledge Base</h2>
          <p className="text-xs text-[#6E6E73] mt-0.5">
            Documents that feed the firm-wide RAG knowledge base — tag every upload with the app,
            industry, and document type it's for so retrieval stays scoped correctly.
          </p>
        </div>
        <button onClick={() => setShowUpload(true)}
          className="px-3 py-2 bg-[#0C0D0D] text-white text-sm rounded-full hover:bg-[#2A2A2C] transition-colors">
          + Upload Document
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-2 border-[#E5E5EA] border-t-[#0C0D0D] rounded-full animate-spin" />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-[#E5E5EA] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#F0F0F0] bg-[#FAFAFA]">
                <th className="text-left px-5 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Document</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">App</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Industry</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Type</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Module</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-[#6E6E73] uppercase tracking-wide">Chunks</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F0F0F0]">
              {docs.map(d => {
                const key = `${d.industry}::${d.source_name}`;
                const isActing = acting === key;
                return (
                  <tr key={key} className="hover:bg-[#FAFAFA]">
                    <td className="px-5 py-3 font-medium text-[#1D1D1F]">
                      {d.source_url ? (
                        <a href={d.source_url} target="_blank" rel="noopener noreferrer"
                          className="hover:underline" title={d.source_url}>
                          🔗 {d.source_name}
                        </a>
                      ) : (
                        <div>{d.source_name}</div>
                      )}
                      {(d.is_canonical || !d.is_current || d.region) && (
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {d.is_canonical && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#ECF4EE] text-[#0C0D0D]">⭐ MASTER</span>
                          )}
                          {!d.is_current && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#FDF3E7] text-[#B45309]">SUPERSEDED</span>
                          )}
                          {d.region && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#F5F5F7] text-[#6E6E73]">{d.region}</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap gap-1">
                        {d.apps.length > 0 ? d.apps.map(a => (
                          <span key={a} className="px-2 py-0.5 rounded-full text-xs font-medium bg-[#ECF4EE] text-[#0C0D0D]">
                            {KB_APP_LABEL[a] || a}
                          </span>
                        )) : <span className="text-[#8E8E93]">—</span>}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-[#3A3A3C] capitalize">{d.industry}</td>
                    <td className="px-5 py-3 text-[#3A3A3C]">{KB_DOC_TYPE_LABEL[d.doc_type] || d.doc_type}</td>
                    <td className="px-5 py-3 text-[#6E6E73]">{d.module || '—'}</td>
                    <td className="px-5 py-3 text-[#6E6E73]">{d.chunk_count}</td>
                    <td className="px-5 py-3 text-right">
                      {isActing ? (
                        <span className="inline-block w-4 h-4 border-2 border-[#E5E5EA] border-t-[#6E6E73] rounded-full animate-spin" />
                      ) : (
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => setEditDoc(d)}
                            className="text-xs text-[#3A3A3C] hover:text-[#0C0D0D] border border-[#E5E5EA] rounded px-2 py-1 hover:border-[#D1D1D6] transition-colors"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => setConfirmDelete(d)}
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
          {docs.length === 0 && (
            <div className="text-center py-12 text-[#8E8E93] text-sm">No documents indexed yet</div>
          )}
        </div>
      )}

      {confirmDelete && (
        <Modal title="Delete Document" onClose={() => setConfirmDelete(null)}>
          <div className="space-y-4">
            <p className="text-sm text-[#3A3A3C]">
              Permanently delete <span className="font-semibold">{confirmDelete.source_name}</span> and all
              {' '}{confirmDelete.chunk_count} indexed chunks?
            </p>
            <p className="text-xs text-[#6E6E73] leading-relaxed">
              Any app currently retrieving from this document's industry/app tag will lose this content
              immediately. This action cannot be undone.
            </p>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setConfirmDelete(null)}
                className="flex-1 px-4 py-2 text-sm border border-[#E5E5EA] rounded-full hover:bg-[#FAFAFA]">
                Cancel
              </button>
              <button onClick={() => handleDelete(confirmDelete)}
                className="flex-1 px-4 py-2 text-sm rounded-full font-medium text-white bg-red-600 hover:bg-red-700">
                Delete Document
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showUpload && (
        <UploadIndustryDocModal onClose={() => setShowUpload(false)} onUploaded={() => { setShowUpload(false); load(); }} />
      )}

      {editDoc && (
        <EditIndustryDocModal doc={editDoc} onClose={() => setEditDoc(null)} onSaved={() => { setEditDoc(null); load(); }} />
      )}
    </div>
  );
}

type MetadataFormState = {
  industry: string;
  apps: IndustryDocApp[];
  docType: IndustryDocType;
  module: string;
  effectiveDate: string;
  isCurrent: boolean;
  isCanonical: boolean;
  aliases: string;
  region: string;
  reviewed: boolean;
  clientFacing: boolean;
};

// Shared by UploadIndustryDocModal and EditIndustryDocModal — every field
// _upload()/_update_metadata() accept except the file/URL source itself,
// which each modal handles differently (pick a new file vs. can't change
// the underlying content of an already-indexed document).
function MetadataFields({ state, setState }: {
  state: MetadataFormState;
  setState: (updater: (s: MetadataFormState) => MetadataFormState) => void;
}) {
  function toggleApp(value: IndustryDocApp) {
    setState(s => ({
      ...s,
      apps: s.apps.includes(value) ? s.apps.filter(a => a !== value) : [...s.apps, value],
    }));
  }

  return (
    <>
      <Field label="Apps *" hint="Which platform app(s)' RAG this content feeds — pick one or more">
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {KB_APPS.map(a => (
            <label key={a.value} className="flex items-center gap-1.5 text-sm text-[#3A3A3C]">
              <input type="checkbox" checked={state.apps.includes(a.value)} onChange={() => toggleApp(a.value)}
                className="rounded border-[#D1D1D6]" />
              {a.label}
            </label>
          ))}
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Industry *">
          <select required value={state.industry} onChange={e => setState(s => ({ ...s, industry: e.target.value }))}
            className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm capitalize focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]">
            {KB_INDUSTRIES.map(i => <option key={i} value={i}>{i}</option>)}
          </select>
        </Field>
        <Field label="Document Type *">
          <select required value={state.docType} onChange={e => setState(s => ({ ...s, docType: e.target.value as IndustryDocType }))}
            className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]">
            {KB_DOC_TYPES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Workday Module" hint="Optional">
        <select value={state.module} onChange={e => setState(s => ({ ...s, module: e.target.value }))}
          className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]">
          <option value="">—</option>
          {WORKDAY_MODULES.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>

      <div className="pt-1 border-t border-[#F0F0F0]">
        <p className="text-xs font-semibold text-[#6E6E73] uppercase tracking-wide mt-3 mb-2">
          Accuracy metadata
        </p>
        <p className="text-xs text-[#8E8E93] -mt-1 mb-3">
          Helps Stuey pick the right document and caveat correctly — all optional.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Effective Date" hint="When this content became current">
          <input type="date" value={state.effectiveDate} onChange={e => setState(s => ({ ...s, effectiveDate: e.target.value }))}
            className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
        </Field>
        <Field label="Region" hint="e.g. US, AU/NZ, Global">
          <input value={state.region} onChange={e => setState(s => ({ ...s, region: e.target.value }))} placeholder="Global"
            className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
        </Field>
      </div>

      <Field label="Aliases / Keywords" hint='Comma-separated synonyms consultants might search for (e.g. "TAO, Talent Ops") — folded into search so phrasing mismatches still find it'>
        <input value={state.aliases} onChange={e => setState(s => ({ ...s, aliases: e.target.value }))} placeholder="TAO, Talent Ops"
          className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
      </Field>

      <div className="grid grid-cols-2 gap-y-2">
        <label className="flex items-center gap-2 text-sm text-[#3A3A3C]">
          <input type="checkbox" checked={state.isCurrent} onChange={e => setState(s => ({ ...s, isCurrent: e.target.checked }))}
            className="rounded border-[#D1D1D6]" />
          Current version
        </label>
        <label className="flex items-center gap-2 text-sm text-[#3A3A3C]">
          <input type="checkbox" checked={state.isCanonical} onChange={e => setState(s => ({ ...s, isCanonical: e.target.checked }))}
            className="rounded border-[#D1D1D6]" />
          This is the master/canonical copy
        </label>
        <label className="flex items-center gap-2 text-sm text-[#3A3A3C]">
          <input type="checkbox" checked={state.reviewed} onChange={e => setState(s => ({ ...s, reviewed: e.target.checked }))}
            className="rounded border-[#D1D1D6]" />
          Reviewed for accuracy/brand
        </label>
        <label className="flex items-center gap-2 text-sm text-[#3A3A3C]">
          <input type="checkbox" checked={state.clientFacing} onChange={e => setState(s => ({ ...s, clientFacing: e.target.checked }))}
            className="rounded border-[#D1D1D6]" />
          Safe to share with clients
        </label>
      </div>
    </>
  );
}

function metaFromState(state: MetadataFormState) {
  return {
    industry: state.industry,
    apps: state.apps,
    doc_type: state.docType,
    module: state.module.trim() || undefined,
    effective_date: state.effectiveDate || undefined,
    is_current: state.isCurrent,
    is_canonical: state.isCanonical,
    aliases: state.aliases.trim() || undefined,
    region: state.region.trim() || undefined,
    reviewed: state.reviewed,
    client_facing: state.clientFacing,
  };
}

function UploadIndustryDocModal({ onClose, onUploaded }: { onClose: () => void; onUploaded: () => void }) {
  const [source, setSource] = useState<'file' | 'url'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [state, setState] = useState<MetadataFormState>({
    industry: 'technology', apps: ['rfp-reimagine'], docType: 'rfp_excerpt', module: '',
    effectiveDate: '', isCurrent: true, isCanonical: false, aliases: '', region: '',
    reviewed: false, clientFacing: false,
  });

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (source === 'file' && !file) return;
    if (source === 'url' && !url.trim()) return;
    if (state.apps.length === 0) { setError('Select at least one app'); return; }
    setSaving(true);
    setError('');
    const meta = metaFromState(state);
    try {
      if (source === 'file') {
        const { url: sasUrl, key } = await getIndustryDocUploadUrl(file!.name);
        await putFileToS3(sasUrl, file!);
        const result = await uploadIndustryDoc({ ...meta, s3_key: key, source_name: file!.name });
        onUploaded();
        alert(`Indexed "${result.source_name}" — ${result.chunks_indexed} chunks.`);
      } else {
        const result = await ingestIndustryDocUrl({ ...meta, url: url.trim() });
        onUploaded();
        const subCount = result.sublinks_indexed?.length ?? 0;
        const subNote = subCount > 0
          ? ` Also followed ${subCount} linked page${subCount === 1 ? '' : 's'} from the same section: ${result.sublinks_indexed.map(s => s.source_name).join(', ')}.`
          : '';
        alert(`Indexed "${result.source_name}" — ${result.chunks_indexed} chunks.${subNote}`);
      }
    } catch (err: any) {
      setError(err.message || 'Upload failed');
    } finally { setSaving(false); }
  }

  return (
    <Modal title="Add Knowledge Document" onClose={onClose}>
      <form onSubmit={handleUpload} className="space-y-4">
        <div className="flex gap-1 bg-[#F5F5F7] rounded-lg p-1 w-fit">
          {(['file', 'url'] as const).map(s => (
            <button key={s} type="button" onClick={() => setSource(s)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                source === s ? 'bg-white text-[#1D1D1F] shadow-sm' : 'text-[#6E6E73] hover:text-[#1D1D1F]'
              }`}>
              {s === 'file' ? 'Upload File' : 'Web Page URL'}
            </button>
          ))}
        </div>

        {source === 'file' ? (
          <Field label="File *" hint="PDF, DOCX, PPTX, XLSX, XLSM, TXT, or MD">
            <input required type="file" accept=".pdf,.docx,.pptx,.xlsx,.xlsm,.txt,.md"
              onChange={e => setFile(e.target.files?.[0] ?? null)}
              className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
          </Field>
        ) : (
          <Field label="Page URL *" hint="Currently limited to doc.workday.com — Workday's own public documentation">
            <input required type="url" value={url} onChange={e => setUrl(e.target.value)}
              placeholder="https://doc.workday.com/..."
              className="w-full border border-[#E5E5EA] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]" />
          </Field>
        )}

        <MetadataFields state={state} setState={setState} />

        {error && <p className="text-xs text-red-600">{error}</p>}
        <ModalActions onCancel={onClose} saving={saving} label={source === 'file' ? 'Upload & Index' : 'Fetch & Index'} />
      </form>
    </Modal>
  );
}

function EditIndustryDocModal({ doc, onClose, onSaved }: {
  doc: IndustryDoc; onClose: () => void; onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [state, setState] = useState<MetadataFormState>({
    industry: doc.industry,
    apps: doc.apps,
    docType: doc.doc_type,
    module: doc.module,
    effectiveDate: doc.effective_date ?? '',
    isCurrent: doc.is_current,
    isCanonical: doc.is_canonical,
    aliases: doc.aliases,
    region: doc.region,
    reviewed: doc.reviewed,
    clientFacing: doc.client_facing,
  });

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (state.apps.length === 0) { setError('Select at least one app'); return; }
    setSaving(true);
    setError('');
    try {
      const result = await updateIndustryDocMetadata({
        ...metaFromState(state), source_name: doc.source_name,
      });
      onSaved();
      const reembedNote = result.chunks_reembedded > 0
        ? ` Aliases changed, so ${result.chunks_reembedded} chunk${result.chunks_reembedded === 1 ? '' : 's'} were re-embedded.`
        : '';
      alert(`Updated "${result.source_name}" — ${result.chunks_updated} chunks.${reembedNote}`);
    } catch (err: any) {
      setError(err.message || 'Update failed');
    } finally { setSaving(false); }
  }

  return (
    <Modal title={`Edit "${doc.source_name}"`} onClose={onClose}>
      <form onSubmit={handleSave} className="space-y-4">
        <p className="text-xs text-[#8E8E93] -mt-1">
          Editing tags only — the underlying file/content can't be changed here. Delete and
          re-upload if the content itself is wrong.
        </p>
        <MetadataFields state={state} setState={setState} />
        {error && <p className="text-xs text-red-600">{error}</p>}
        <ModalActions onCancel={onClose} saving={saving} label="Save Changes" />
      </form>
    </Modal>
  );
}

// ─── App Settings Tab (visibility + behavior-tuning, merged into one page) ─────
// Was two separate tabs ("Apps" for Platform Home tile visibility, "App Settings" for
// per-app tuning values) — combined here into two sections of one "App Settings" tab.
// Kept as two independent sub-components (own state/fetch each) rather than merged hooks,
// since they're genuinely separate concerns that happen to share a page now.

const WIP_PLACEHOLDER_REASONS = [
  'Buffing out a few bugs',
  'Off getting a tune-up',
  'Taking a quick breather',
  'Polishing the rough edges',
  'Back shortly — promise',
];

function AppVisibilitySection() {
  const [view, setView] = useState<AppVisibilityView>('consultant');
  const [configs, setConfigs] = useState<Record<AppVisibilityView, WipApps>>({ consultant: {}, demo: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [consultant, demo] = await Promise.all([
        getAppVisibility('consultant'),
        getAppVisibility('demo'),
      ]);
      setConfigs({ consultant: consultant.wip_apps, demo: demo.wip_apps });
    } catch (e: any) {
      setError(e.message || 'Failed to load app visibility');
    } finally {
      setLoading(false);
    }
  }

  const current = configs[view];

  async function save(appId: string, next: WipApps) {
    setSaving(appId);
    try {
      await setAppVisibility(view, next);
      setConfigs(c => ({ ...c, [view]: next }));
    } catch (e: any) {
      alert(`Failed: ${e.message}`);
    } finally {
      setSaving(null);
    }
  }

  function toggleWip(appId: string) {
    const next = { ...current };
    if (appId in next) {
      delete next[appId];
    } else {
      next[appId] = WIP_PLACEHOLDER_REASONS[Math.floor(Math.random() * WIP_PLACEHOLDER_REASONS.length)];
    }
    save(appId, next);
  }

  function updateReason(appId: string, reason: string) {
    setConfigs(c => ({ ...c, [view]: { ...c[view], [appId]: reason } }));
  }

  function commitReason(appId: string) {
    save(appId, current);
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-[#1D1D1F]">App Visibility</h3>
        <p className="text-xs text-[#6E6E73] mt-0.5">
          Control which app tiles are live on Platform Home, separately for real consultants and for
          the demo account. Marking a tile "Work in Progress" doesn't remove it — it grays it out with
          your own reason, so people know it exists without being able to open it.
        </p>
      </div>

      <div className="flex gap-1 bg-[#F5F5F7] rounded-lg p-1 w-fit">
        {(['consultant', 'demo'] as const).map(v => (
          <button key={v} onClick={() => setView(v)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              view === v ? 'bg-white text-[#1D1D1F] shadow-sm' : 'text-[#6E6E73] hover:text-[#1D1D1F]'
            }`}>
            {v === 'consultant' ? 'Consultant View' : 'Demo View'}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-2 border-[#E5E5EA] border-t-[#0C0D0D] rounded-full animate-spin" />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-[#E5E5EA] overflow-hidden divide-y divide-[#F0F0F0]">
          {ALL_APP_IDS.map(appId => {
            const info = APP_LABELS[appId];
            const isWip = appId in current;
            const isSaving = saving === appId;
            return (
              <div key={appId} className="px-5 py-4 flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[#1D1D1F]">{info.name}</div>
                  <div className="text-xs text-[#8E8E93] mt-0.5">{info.tagline}</div>
                  {isWip && (
                    <input
                      value={current[appId]}
                      onChange={e => updateReason(appId, e.target.value)}
                      onBlur={() => commitReason(appId)}
                      placeholder="Reason shown on the tile…"
                      className="mt-2 w-full max-w-sm border border-[#E5E5EA] rounded-md px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]"
                    />
                  )}
                </div>
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-[#F5F5F7] text-[#6E6E73] capitalize flex-shrink-0">
                  {info.scope === 'firm' ? 'Firm-wide' : 'Client-specific'}
                </span>
                <button
                  onClick={() => toggleWip(appId)}
                  disabled={isSaving}
                  role="switch"
                  aria-checked={!isWip}
                  title={isWip ? 'Work in progress — click to make available' : 'Available — click to mark work in progress'}
                  style={{
                    width: 38, height: 22, borderRadius: 999, border: 'none', cursor: isSaving ? 'default' : 'pointer',
                    background: isWip ? '#D1D1D6' : '#0C0D0D', position: 'relative', flexShrink: 0, marginTop: 2,
                    opacity: isSaving ? 0.6 : 1, transition: 'background 0.15s ease',
                  }}
                >
                  <span style={{
                    position: 'absolute', top: 2, left: isWip ? 2 : 18, width: 18, height: 18, borderRadius: '50%',
                    background: '#fff', transition: 'left 0.15s ease', boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
                  }} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Per-app, admin-configurable behavior-tuning values (model params, retrieval
// thresholds, curated value lists) — distinct from the visibility section above (which
// only controls live/WIP visibility) and from Knowledge Base (content
// curation, not scalar settings). Only apps with at least one declared
// setting appear here at all — see functions/common/settings_registry.py.

function formatSettingValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ') || '(none)';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  return String(value);
}

function SettingField({ def, value, overridden, onChange, onReset }: {
  def: AppSettingDef;
  value: unknown;
  overridden: boolean;
  onChange: (value: unknown) => void;
  onReset: () => void;
}) {
  return (
    <div className="py-4 border-b border-[#F0F0F0] last:border-0">
      <div className="flex items-start justify-between gap-6">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-[#1D1D1F]">{def.label}</div>
          {def.description && (
            <p className="text-xs text-[#8E8E93] mt-1 leading-relaxed max-w-md">{def.description}</p>
          )}
        </div>
        <div className="flex-shrink-0 w-52">
          {def.type === 'number' && (
            <input
              type="number"
              value={value as number}
              min={def.min ?? undefined}
              max={def.max ?? undefined}
              step={def.step ?? undefined}
              onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))}
              className="w-full border border-[#E5E5EA] rounded-md px-2.5 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]"
            />
          )}
          {def.type === 'select' && (
            <select
              value={value as string}
              onChange={e => onChange(e.target.value)}
              className="w-full border border-[#E5E5EA] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]"
            >
              {(def.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
          {def.type === 'string_list' && (
            <input
              type="text"
              value={(value as string[] ?? []).join(', ')}
              onChange={e => onChange(e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
              placeholder="comma-separated"
              className="w-full border border-[#E5E5EA] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0C0D0D]"
            />
          )}
          {def.type === 'boolean' && (
            <div className="flex justify-end">
              <button
                onClick={() => onChange(!value)}
                role="switch"
                aria-checked={!!value}
                style={{
                  width: 38, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer',
                  background: value ? '#0C0D0D' : '#D1D1D6', position: 'relative', flexShrink: 0,
                  transition: 'background 0.15s ease',
                }}
              >
                <span style={{
                  position: 'absolute', top: 2, left: value ? 18 : 2, width: 18, height: 18, borderRadius: '50%',
                  background: '#fff', transition: 'left 0.15s ease', boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
                }} />
              </button>
            </div>
          )}
          <div className="mt-1.5 text-right">
            {overridden ? (
              <button onClick={onReset} className="text-[11px] text-[#6E6E73] hover:text-[#1D1D1F] underline decoration-dotted">
                default: {formatSettingValue(def.default)} · Reset
              </button>
            ) : (
              <span className="text-[11px] text-[#AEAEB2]">using default</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AppSettingsTab() {
  const [apps, setApps] = useState<Record<string, AppSettingsEntry>>({});
  const [selectedApp, setSelectedApp] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<AppSettingValues>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { load(); }, []);

  function overridesFor(appId: string, appsMap: Record<string, AppSettingsEntry>): AppSettingValues {
    const entry = appsMap[appId];
    const diffs: AppSettingValues = {};
    for (const def of entry.schema) {
      if (JSON.stringify(entry.values[def.key]) !== JSON.stringify(def.default)) {
        diffs[def.key] = entry.values[def.key];
      }
    }
    return diffs;
  }

  async function load() {
    setLoading(true);
    setError('');
    try {
      const { apps: fetched } = await getAppSettings();
      setApps(fetched);
      const firstApp = Object.keys(fetched)[0] ?? null;
      setSelectedApp(firstApp);
      if (firstApp) setOverrides(overridesFor(firstApp, fetched));
    } catch (e: any) {
      setError(e.message || 'Failed to load app settings');
    } finally {
      setLoading(false);
    }
  }

  function selectApp(appId: string) {
    setSelectedApp(appId);
    setOverrides(overridesFor(appId, apps));
  }

  function setFieldValue(key: string, value: unknown) {
    setOverrides(o => ({ ...o, [key]: value }));
  }

  function resetField(key: string) {
    setOverrides(o => {
      const next = { ...o };
      delete next[key];
      return next;
    });
  }

  async function save() {
    if (!selectedApp) return;
    setSaving(true);
    setError('');
    try {
      await updateAppSettings(selectedApp, overrides);
      setApps(a => {
        const entry = a[selectedApp];
        const values: AppSettingValues = {};
        for (const def of entry.schema) {
          values[def.key] = def.key in overrides ? overrides[def.key] : def.default;
        }
        return { ...a, [selectedApp]: { ...entry, values } };
      });
    } catch (e: any) {
      setError(e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  const appIds = Object.keys(apps);
  const entry = selectedApp ? apps[selectedApp] : null;
  const resolvedValues: AppSettingValues = entry
    ? Object.fromEntries(entry.schema.map(def => [
        def.key, def.key in overrides ? overrides[def.key] : def.default,
      ]))
    : {};

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-8">
      <div>
        <h2 className="text-base font-semibold text-[#1D1D1F]">App Settings</h2>
        <p className="text-xs text-[#6E6E73] mt-0.5">
          Platform Home tile visibility and per-app behavior tuning, in one place.
        </p>
      </div>

      <AppVisibilitySection />

      <div className="border-t border-[#E5E5EA] pt-6 space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-[#1D1D1F]">App Settings</h3>
        <p className="text-xs text-[#6E6E73] mt-0.5">
          Behavior-tuning values for apps that expose them — model parameters, retrieval
          thresholds, curated value lists. Changes apply immediately, no deploy needed. Only apps
          with configurable settings are listed; everything else has none yet.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-2 border-[#E5E5EA] border-t-[#0C0D0D] rounded-full animate-spin" />
        </div>
      ) : appIds.length === 0 ? (
        <div className="text-sm text-[#8E8E93] py-16 text-center">No apps have configurable settings yet.</div>
      ) : (
        <div className="flex gap-5">
          <div className="w-56 flex-shrink-0 bg-white rounded-xl border border-[#E5E5EA] overflow-hidden divide-y divide-[#F0F0F0]">
            {appIds.map(appId => (
              <button
                key={appId}
                onClick={() => selectApp(appId)}
                className={`w-full text-left px-4 py-3 transition-colors ${
                  selectedApp === appId ? 'bg-[#F5F5F7]' : 'hover:bg-[#FAFAFA]'
                }`}
              >
                <div className="text-sm font-medium text-[#1D1D1F] capitalize">{appId.replace(/-/g, ' ')}</div>
                <div className="text-xs text-[#8E8E93] mt-0.5">{apps[appId].schema.length} settings</div>
              </button>
            ))}
          </div>

          {entry && (
            <div className="flex-1 min-w-0 bg-white rounded-xl border border-[#E5E5EA] px-5">
              {entry.schema.map(def => (
                <SettingField
                  key={def.key}
                  def={def}
                  value={resolvedValues[def.key]}
                  overridden={def.key in overrides}
                  onChange={v => setFieldValue(def.key, v)}
                  onReset={() => resetField(def.key)}
                />
              ))}
              <div className="py-4 flex justify-end">
                <button
                  onClick={save}
                  disabled={saving}
                  className="px-4 py-2 bg-[#0C0D0D] text-white text-sm font-medium rounded-full hover:bg-[#2A2A2C] transition-colors disabled:opacity-60"
                >
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

// ─── Demo Credentials Tab ─────────────────────────────────────────────────────

const DEMO_DOMAIN = 'ashmanakoutlook.onmicrosoft.com';

const DEMO_USERS = [
  { email: `admin@${DEMO_DOMAIN}`,         role: 'super_admin',   tenant: 'platform', note: 'Full access, every client' },
  { email: `project-admin@${DEMO_DOMAIN}`, role: 'project_admin', tenant: 'platform', note: 'Full access, scoped to assigned client(s)' },
  { email: `consultant@${DEMO_DOMAIN}`,    role: 'consultant',    tenant: 'platform', note: 'Assigned to acme + globex' },
];


// ─── Shared helpers ───────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-5 border-b border-[#E5E5EA] flex items-center justify-between">
          <h3 className="text-base font-semibold text-[#1D1D1F]">{title}</h3>
          <button onClick={onClose} className="text-[#8E8E93] hover:text-[#3A3A3C] text-lg leading-none">✕</button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-[#3A3A3C] mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-[#8E8E93] mt-1">{hint}</p>}
    </div>
  );
}

function ModalActions({ onCancel, saving, label, destructive }: {
  onCancel: () => void; saving: boolean; label: string; destructive?: boolean;
}) {
  return (
    <div className="flex gap-3 pt-2">
      <button type="button" onClick={onCancel}
        className="flex-1 px-4 py-2 text-sm border border-[#E5E5EA] rounded-full hover:bg-[#FAFAFA] transition-colors">
        Cancel
      </button>
      <button type="submit" disabled={saving}
        className={`flex-1 px-4 py-2 text-sm rounded-full font-medium text-white transition-colors disabled:opacity-50 ${
          destructive ? 'bg-red-600 hover:bg-red-700' : 'bg-[#0C0D0D] hover:bg-[#2A2A2C]'
        }`}>
        {saving ? 'Saving…' : label}
      </button>
    </div>
  );
}
