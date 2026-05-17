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
  event_id: string;
  event_ts: string;
  action: string;
  user_id: string;
  user_email: string;
  role: string;
  ip_address: string;
  resource_type: string;
  resource_id: string;
  resource_name: string;
  details: Record<string, unknown>;
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
  action?: string;
} = {}): Promise<AuditEntry[]> {
  const qs = new URLSearchParams();
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.tenant_id) qs.set('tenant_id', params.tenant_id);
  if (params.action) qs.set('action', params.action);
  const r = await api.get(`/admin/audit-log${qs.toString() ? '?' + qs : ''}`);
  return r.entries ?? [];
}

// Project Admin
export interface Assignment {
  consultant_sub: string;
  consultant_email: string;
  client_tenant_id: string;
  client_name: string;
}

export async function listAssignments(): Promise<Assignment[]> {
  const r = await api.get('/admin/assignments');
  return r.assignments ?? [];
}

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

export async function archiveClient(tenantId: string, action: 'archive' | 'restore'): Promise<void> {
  await api.post('/admin/archive-client', { tenant_id: tenantId, action });
}

export async function manageUser(email: string, action: 'disable' | 'enable' | 'delete'): Promise<void> {
  await api.post('/admin/manage-user', { email, action });
}

// SOW Validator
export interface SowFinding {
  traffic_light: 'red' | 'yellow' | 'green';
  deliverable: string;
  detail: string;
  evidence: string[];
  recommendation: string;
}

export interface SowValidateResponse {
  sow_name: string;
  sow_doc_id: string;
  findings: SowFinding[];
  summary: string;
  model_id: string;
  latency_ms: number;
}

export async function validateSow(sowDocId: string): Promise<SowValidateResponse> {
  return api.post('/sow/validate', { sow_doc_id: sowDocId });
}

// Cost summary
export interface ServiceCost {
  service: string;
  service_raw: string;
  cost_usd: number;
  pct: number;
}

export interface CostSummary {
  period: { start: string; end: string; days: number };
  total_usd: number;
  bedrock_usd: number;
  currency: string;
  services: ServiceCost[];
  ai_usage: {
    total_calls: number;
    by_action: Record<string, number>;
    by_tenant: { tenant_id: string; name: string; calls: number }[];
  };
  data_lag_note: string;
}

export async function getCostSummary(days = 30): Promise<CostSummary> {
  return api.get(`/admin/costs?days=${days}`);
}

// Change Impact Advisor
export interface ImpactModule {
  module: string;
  severity: 'high' | 'medium' | 'low' | 'none';
  impact: string;
  actions: string[];
}

export interface ChangeImpactResponse {
  change: string;
  summary: string;
  impacts: ImpactModule[];
  risks: string[];
  recommendation: string;
  model_id: string;
  latency_ms: number;
}

export async function assessChange(changeDescription: string): Promise<ChangeImpactResponse> {
  return api.post('/change-impact', { change_description: changeDescription });
}

// Test Script Generator
export interface GenerateTestsResponse {
  doc_id: string;
  source_name: string;
  test_count: number;
  test_type: string;
  latency_ms: number;
}

export async function generateTestScripts(
  sourceDocId: string,
  testType: 'sit' | 'uat' | 'both'
): Promise<GenerateTestsResponse> {
  return api.post('/test-scripts/generate', { source_doc_id: sourceDocId, test_type: testType });
}
