/**
 * API client utility for making authenticated requests to the backend.
 *
 * When `setActiveClientTenant(id)` is called (by the consultant client-switcher),
 * every subsequent request includes `X-Client-Tenant: <id>` so the backend
 * scopes the call to that client's tenant.
 */

const API_ENDPOINT = import.meta.env.VITE_API_ENDPOINT;

let _activeClientTenant: string | null = null;

export function setActiveClientTenant(tenantId: string | null) {
  _activeClientTenant = tenantId;
}

export function getActiveClientTenant(): string | null {
  return _activeClientTenant;
}

async function getAuthToken(): Promise<string> {
  const { fetchAuthSession } = await import('aws-amplify/auth');
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) throw new Error('No auth token available');
  return token;
}

function clientTenantHeaders(): Record<string, string> {
  return _activeClientTenant ? { 'X-Client-Tenant': _activeClientTenant } : {};
}

// Types
export interface Citation {
  source_name: string;
  doc_type: string;
  module: string;
  chunk_index: number;
  excerpt: string;
  score: number;
}

export interface ChatResponse {
  answer: string;
  citations: Citation[];
  model_id: string;
  latency_ms: number;
}

export interface Finding {
  category: string;
  title: string;
  severity: string;
  detail: string;
  recommendation: string;
  evidence?: string[];
}

export interface AnalyzeResponse {
  findings: Finding[];
  summary: string;
  model_id: string;
  latency_ms: number;
}

export interface DeliveryFinding {
  traffic_light: 'red' | 'yellow' | 'green';
  title: string;
  detail: string;
  evidence: string[];
  recommendation: string;
}

export interface DeliveryReviewResponse {
  summary: string;
  findings: DeliveryFinding[];
  doc_id: string;
  model_id: string;
}

export interface AssignedClient {
  tenant_id: string;
  name: string;
  industry: string;
}

export interface AdminUser {
  sub: string;
  email: string;
  tenant_id: string;
  role: string;
  status: string;
  enabled: boolean;
  created_at: string;
}

export interface AuditEntry {
  tenant_id: string;
  user_id: string;
  kind: string;
  model_id: string;
  latency_ms: number;
  prompt_preview: string;
  response_preview: string;
  created_at: string;
}

// Generic API
export const api = {
  async get(path: string) {
    const token = await getAuthToken();
    const response = await fetch(`${API_ENDPOINT}${path}`, {
      method: 'GET',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
        ...clientTenantHeaders(),
      },
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || `HTTP ${response.status}`);
    }
    return response.json();
  },

  async post(path: string, body: any) {
    const token = await getAuthToken();
    const response = await fetch(`${API_ENDPOINT}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
        ...clientTenantHeaders(),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || `HTTP ${response.status}`);
    }
    return response.json();
  },
};

// Domain API functions
export async function chat(
  message: string,
  history: any[] = [],
  options: { module?: string; doc_id?: string } = {}
): Promise<ChatResponse> {
  return api.post('/chat', { message, history, ...options });
}

export async function ingestDoc(params: {
  s3_key: string;
  doc_id: string;
  doc_type: string;
  module: string;
  source_name?: string;
  folder_path?: string;
}) {
  return api.post('/ingest', params);
}

export async function analyzeDoc(docId: string, focus: string = 'all', mode?: string): Promise<AnalyzeResponse> {
  return api.post('/analyze', { doc_id: docId, focus, ...(mode ? { mode } : {}) });
}

export async function deleteDoc(docId: string): Promise<void> {
  await api.post('/documents/delete', { doc_id: docId });
}

export async function publishDoc(docId: string, published: boolean): Promise<void> {
  await api.post('/documents/publish', { doc_id: docId, published });
}

// Consultant client-switcher
export async function getMyClients(): Promise<AssignedClient[]> {
  const r = await api.get('/consultant/my-clients');
  return r.clients ?? [];
}

// Security Admin
export async function listUsers(): Promise<AdminUser[]> {
  const r = await api.get('/admin/list-users');
  return r.users ?? [];
}

export async function resetPassword(email: string, temporaryPassword: string): Promise<void> {
  await api.post('/admin/reset-password', { email, temporary_password: temporaryPassword });
}

export async function getAuditLog(params: {
  limit?: number;
  tenant_id?: string;
  kind?: string;
} = {}): Promise<AuditEntry[]> {
  const qs = new URLSearchParams();
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.tenant_id) qs.set('tenant_id', params.tenant_id);
  if (params.kind) qs.set('kind', params.kind);
  const r = await api.get(`/admin/audit-log${qs.toString() ? '?' + qs : ''}`);
  return r.entries ?? [];
}

// Project Admin
export async function assignConsultant(
  consultantSub: string,
  consultantEmail: string,
  clientTenantId: string,
  action: 'assign' | 'unassign'
): Promise<void> {
  await api.post('/admin/assign-consultant', {
    consultant_sub: consultantSub,
    consultant_email: consultantEmail,
    client_tenant_id: clientTenantId,
    action,
  });
}

export async function createUser(params: {
  email: string;
  tenant_id: string;
  role: string;
  temporary_password?: string;
}): Promise<{ email: string; temporary_password: string }> {
  return api.post('/admin/create-user', params);
}

export async function createTenant(params: {
  tenant_id: string;
  name: string;
  industry?: string;
  region?: string;
  folder_structure_template?: string;
}): Promise<void> {
  await api.post('/admin/create-tenant', params);
}

export async function listTenants(): Promise<any[]> {
  const r = await api.get('/admin/list-tenants');
  return r.tenants ?? [];
}
