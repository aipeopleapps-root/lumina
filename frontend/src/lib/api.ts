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
  given_name: string;
  family_name: string;
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
  options: { module?: string; doc_id?: string; doc_ids?: string[]; mode?: string } = {}
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
  given_name: string;
  family_name: string;
  tenant_id: string;
  role: string;
  temporary_password?: string;
}): Promise<{ email: string; given_name: string; family_name: string; temporary_password: string }> {
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
  functional_count: number;
  integration_count: number;
  total_count: number;
  test_type: string;
  latency_ms: number;
}

export interface GenerateTestsJobResponse {
  job_id: string;
  status: 'processing' | 'done' | 'error';
  error?: string;
  doc_id?: string;
  source_name?: string;
  functional_count?: number;
  integration_count?: number;
  total_count?: number;
  test_type?: string;
  latency_ms?: number;
}

export async function generateTestScripts(
  sourceDocIds: string[],
): Promise<GenerateTestsJobResponse> {
  return api.post('/test-scripts/generate', { source_doc_ids: sourceDocIds });
}

export async function getTestScriptJob(jobId: string): Promise<GenerateTestsJobResponse> {
  return api.get(`/test-scripts/status/${jobId}`);
}

// Weekly Status Report
export interface StatusWorkstream {
  name: string;
  status: 'green' | 'yellow' | 'red';
  summary: string;
  completed_this_week: string[];
  in_progress: string[];
  risks: string[];
  detail: string;
}

export interface StatusDecision {
  decision: string;
  owner: string;
  deadline: string;
  impact_if_delayed: string;
}

export interface StatusRisk {
  severity: 'high' | 'medium';
  risk: string;
  mitigation: string;
}

export interface StatusMilestone {
  milestone: string;
  due: string;
  status: 'on_track' | 'at_risk' | 'delayed';
}

export interface StatusReportResponse {
  doc_id: string;
  report_name: string;
  week_ending: string;
  overall_status: 'green' | 'yellow' | 'red';
  overall_status_reason: string;
  exec_summary: string;
  highlights: string[];
  workstreams: StatusWorkstream[];
  decisions_needed: StatusDecision[];
  key_risks: StatusRisk[];
  upcoming_milestones: StatusMilestone[];
  next_week_focus: string[];
  model_id: string;
  latency_ms: number;
}

export async function generateStatusReport(weekEnding?: string): Promise<StatusReportResponse> {
  return api.post('/status-report/generate', weekEnding ? { week_ending: weekEnding } : {});
}

// User management
export async function updateUser(params: {
  email: string;
  given_name?: string;
  family_name?: string;
  role?: string;
  tenant_id?: string;
}): Promise<void> {
  await api.post('/admin/update-user', params);
}

export async function resetUserMfa(email: string): Promise<void> {
  await api.post('/admin/manage-user', { email, action: 'reset_mfa' });
}

// MFA reset requests
export interface MfaResetRequest {
  email: string;
  requested_at: string;
  ip: string;
}

export async function getMfaResetRequests(): Promise<MfaResetRequest[]> {
  const r = await api.get('/admin/mfa-reset-requests');
  return r.requests ?? [];
}

export async function dismissMfaResetRequest(email: string): Promise<void> {
  await api.post('/admin/mfa-reset-requests', { email, action: 'dismiss' });
}

// Public — no auth token needed (user is stuck at MFA challenge)
export async function requestMfaReset(email: string): Promise<void> {
  const response = await fetch(`${API_ENDPOINT}/mfa/request-reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!response.ok) throw new Error('Failed to submit reset request');
}

// ── Process Intelligence ──────────────────────────────────────────────────────

export type PiDomain =
  | 'recruiting' | 'onboarding' | 'self_service'
  | 'payroll' | 'job_architecture' | 'performance';

export type PiParseStatus =
  | 'uploading' | 'parsing' | 'needs_review' | 'ready' | 'failed';

export interface PiUploadResponse {
  process_id: string;
  upload_url: string;
  s3_key: string;
}

export interface PiParseWarning {
  field: string;
  item_id: string;
  message: string;
}

export interface PiStatusResponse {
  process_id: string;
  parse_status: PiParseStatus;
  parse_confidence: number | null;
  parse_warnings: PiParseWarning[];
  parse_error: string | null;
  domain: string;
  source_name: string;
  created_at: string;
  updated_at: string;
}

export interface PiSwimLane {
  lane_id: string;
  label: string;
  persona: string | null;
  position: number;
}

export interface PiStep {
  step_id: string;
  lane_id: string | null;
  label: string;
  type: string | null;
  systems_touched: string[];
  avg_cycle_time_hrs: number | null;
  notes: string | null;
  position_x: number | null;
  position_y: number | null;
  parse_confidence: number;
}

export interface PiConnector {
  connector_id: number;
  from: string;
  to: string;
  condition: string | null;
  parse_confidence: number;
}

export interface PiGraph {
  process_id: string;
  domain: string;
  source_name: string;
  parse_status: PiParseStatus;
  parse_confidence: number | null;
  parse_warnings: PiParseWarning[];
  created_at: string;
  swimlanes: PiSwimLane[];
  steps: PiStep[];
  connectors: PiConnector[];
}

export interface PiStepPatch {
  step_id: string;
  label?: string;
  step_type?: string;
  lane_id?: string | null;
  systems_touched?: string[];
}

export interface PiLanePatch {
  lane_id: string;
  label?: string;
  persona?: string;
}

/** Step 1: get a presigned PUT URL + create Aurora record. */
export async function uploadProcessDiagram(params: {
  filename: string;
  domain: PiDomain;
  source_name?: string;
}): Promise<PiUploadResponse> {
  const token = await getAuthToken();
  const res = await fetch(`${API_ENDPOINT}/process-intelligence/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...clientTenantHeaders(),
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Upload failed');
  }
  return res.json();
}

/** Step 2: PUT the file bytes directly to S3 using the presigned URL. */
export async function putFileToS3(uploadUrl: string, file: File): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) throw new Error('S3 upload failed');
}

/** Step 3: trigger async Visio parsing. */
export async function triggerParseDiagram(processId: string): Promise<{ process_id: string; status: string }> {
  const token = await getAuthToken();
  const res = await fetch(`${API_ENDPOINT}/process-intelligence/${processId}/parse`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...clientTenantHeaders(),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Parse trigger failed');
  }
  return res.json();
}

/** Poll parse status. Call repeatedly until parse_status is not 'parsing'. */
export async function getGraphStatus(processId: string): Promise<PiStatusResponse> {
  const token = await getAuthToken();
  const res = await fetch(`${API_ENDPOINT}/process-intelligence/${processId}/status`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...clientTenantHeaders(),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Status fetch failed');
  }
  return res.json();
}

/** Fetch the full parsed graph (swimlanes + steps + connectors). */
export async function getProcessGraph(processId: string): Promise<PiGraph> {
  const token = await getAuthToken();
  const res = await fetch(`${API_ENDPOINT}/process-intelligence/${processId}/graph`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...clientTenantHeaders(),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Graph fetch failed');
  }
  return res.json();
}

/** Apply consultant corrections to the parsed graph. */
export async function patchProcessGraph(
  processId: string,
  patches: { step_patches?: PiStepPatch[]; lane_patches?: PiLanePatch[] }
): Promise<void> {
  const token = await getAuthToken();
  const res = await fetch(`${API_ENDPOINT}/process-intelligence/${processId}/graph`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...clientTenantHeaders(),
    },
    body: JSON.stringify(patches),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Patch failed');
  }
}
