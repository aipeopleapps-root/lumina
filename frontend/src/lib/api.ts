/**
 * API client utility for making authenticated requests to the backend.
 *
 * When `setActiveClientTenant(id)` is called (by the consultant client-switcher),
 * every subsequent request includes `X-Client-Tenant: <id>` so the backend
 * scopes the call to that client's tenant.
 */

import { getAccessToken } from './msal';

const API_ENDPOINT = import.meta.env.VITE_API_ENDPOINT;

let _activeClientTenant: string | null = null;

export function setActiveClientTenant(tenantId: string | null) {
  _activeClientTenant = tenantId;
}

export function getActiveClientTenant(): string | null {
  return _activeClientTenant;
}

async function getAuthToken(): Promise<string> {
  return getAccessToken();
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
        'Authorization': `Bearer ${token}`,
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
        'Authorization': `Bearer ${token}`,
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

  async patch(path: string, body: any) {
    const token = await getAuthToken();
    const response = await fetch(`${API_ENDPOINT}${path}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
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
  const r = await api.get('/manage/list-users');
  return r.users ?? [];
}

export async function resetPassword(email: string, temporaryPassword: string): Promise<void> {
  await api.post('/manage/reset-password', { email, temporary_password: temporaryPassword });
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
  const r = await api.get(`/manage/audit-log${qs.toString() ? '?' + qs : ''}`);
  return r.entries ?? [];
}

// Assignments — consultants OR project_admins scoped to a client. Storage field names
// (consultant_sub/consultant_email) predate project_admin support and just mean "the
// assignee" now, regardless of role — see functions/admin_assign_consultant/handler.py.
export interface Assignment {
  consultant_sub: string;
  consultant_email: string;
  client_tenant_id: string;
  client_name: string;
  assignee_role: 'consultant' | 'project_admin';
}

export async function listAssignments(): Promise<Assignment[]> {
  const r = await api.get('/manage/assignments');
  return r.assignments ?? [];
}

export async function assignConsultant(
  consultantSub: string,
  consultantEmail: string,
  clientTenantId: string,
  action: 'assign' | 'unassign',
  assigneeRole: 'consultant' | 'project_admin' = 'consultant'
): Promise<void> {
  await api.post('/manage/assign-consultant', {
    consultant_sub: consultantSub,
    consultant_email: consultantEmail,
    client_tenant_id: clientTenantId,
    action,
    assignee_role: assigneeRole,
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
  return api.post('/manage/create-user', params);
}

export async function createTenant(params: {
  tenant_id: string;
  name: string;
  industry?: string;
  region?: string;
  folder_structure_template?: string;
}): Promise<void> {
  await api.post('/manage/create-tenant', params);
}

export async function listTenants(): Promise<any[]> {
  const r = await api.get('/manage/list-tenants');
  return r.tenants ?? [];
}

export async function archiveClient(tenantId: string, action: 'archive' | 'restore'): Promise<void> {
  await api.post('/manage/archive-client', { tenant_id: tenantId, action });
}

export async function updateTenant(params: {
  tenant_id: string;
  name?: string;
  industry?: string;
  region?: string;
}): Promise<void> {
  await api.post('/manage/update-tenant', params);
}

export async function deleteTenant(tenantId: string): Promise<{ removed_assignments: number }> {
  return api.post('/manage/delete-tenant', { tenant_id: tenantId });
}

// Test Automation Suite environments — one client tenant can have several Workday
// environments (sandbox, preview, a production mirror, ...), see
// functions/test_automation/handler.py's /test-automation/environments routes and
// migrations/008_test_automation_environments.sql.
export interface TestEnvironment {
  environment_id: string;
  tenant_id: string;
  name: string;
  is_active: boolean;
  nightly_enabled: boolean;
  nightly_run_id: string | null;
  has_credential: boolean;
  created_at: string;
  updated_at: string;
}

export async function listTestEnvironments(tenantId: string): Promise<{ environments: TestEnvironment[] }> {
  return api.get(`/test-automation/environments?tenant_id=${encodeURIComponent(tenantId)}`);
}

export async function createTestEnvironment(tenantId: string, name: string): Promise<TestEnvironment> {
  return api.post('/test-automation/environments', { tenant_id: tenantId, name });
}

export async function updateTestEnvironment(
  environmentId: string,
  updates: Partial<Pick<TestEnvironment, 'name' | 'is_active' | 'nightly_enabled' | 'nightly_run_id'>>
): Promise<TestEnvironment> {
  return api.patch(`/test-automation/environments/${encodeURIComponent(environmentId)}`, updates);
}

// Per-environment Workday credentials — see functions/admin_tenant_credentials/handler.py.
// The password is write-only from this UI's perspective: getTenantCredentialStatus() only
// ever returns whether one is configured, never the value.
export interface TenantCredentialStatus {
  tenant_id: string;
  environment_id: string;
  has_credential: boolean;
  updated_at?: string;
  updated_by?: string;
}

export async function getTenantCredentialStatus(tenantId: string, environmentId: string): Promise<TenantCredentialStatus> {
  return api.get(`/manage/tenant-credentials?tenant_id=${encodeURIComponent(tenantId)}&environment_id=${encodeURIComponent(environmentId)}`);
}

export async function setTenantWorkdayCredential(params: {
  tenant_id: string;
  environment_id: string;
  workday_username: string;
  workday_password: string;
  workday_url: string;
}): Promise<{ tenant_id: string; environment_id: string; has_credential: boolean }> {
  return api.post('/manage/tenant-credentials', params);
}

export async function manageUser(email: string, action: 'disable' | 'enable' | 'delete'): Promise<void> {
  await api.post('/manage/manage-user', { email, action });
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
  return api.get(`/manage/costs?days=${days}`);
}

// Firm-wide industry-knowledge document tagging (admin only) — feeds
// functions/common/industry_knowledge.py, distinct from the per-tenant
// consultant document flow (uploadProcessDiagram/putFileToS3 above are the
// per-tenant equivalent).
export type IndustryDocApp = 'rfp-reimagine' | 'blueprint-match' | 'ask-stuey';
export type IndustryDocType =
  | 'rfp_excerpt' | 'case_study' | 'proposal_content' | 'blueprint' | 'cover_letter_template'
  | 'pricing_sku' | 'process_delivery' | 'product_overview' | 'workday_documentation'
  | 'other';

export interface IndustryDoc {
  source_name: string;
  industry: string;
  apps: IndustryDocApp[];
  doc_type: IndustryDocType;
  module: string;
  chunk_count: number;
  created_at: string;
  effective_date: string | null;
  is_current: boolean;
  is_canonical: boolean;
  aliases: string;
  region: string;
  reviewed: boolean;
  client_facing: boolean;
  source_url: string;
}

export async function getIndustryDocUploadUrl(filename: string): Promise<{ url: string; key: string; content_type: string }> {
  return api.post('/manage/industry-docs/upload-url', { filename });
}

interface IndustryDocMetaFields {
  effective_date?: string;
  is_current?: boolean;
  is_canonical?: boolean;
  aliases?: string;
  region?: string;
  reviewed?: boolean;
  client_facing?: boolean;
}

export async function uploadIndustryDoc(params: IndustryDocMetaFields & {
  s3_key: string;
  industry: string;
  apps: IndustryDocApp[];
  doc_type: IndustryDocType;
  module?: string;
  source_name?: string;
}): Promise<{ source_name: string; chunks_indexed: number }> {
  return api.post('/manage/industry-docs/upload', params);
}

// Fetches a page from an allowlisted public domain (currently doc.workday.com
// only — see admin_industry_docs/handler.py's _ALLOWED_WEB_DOMAINS) and
// indexes it the same way an uploaded file would be.
export async function ingestIndustryDocUrl(params: IndustryDocMetaFields & {
  url: string;
  industry: string;
  apps: IndustryDocApp[];
  doc_type: IndustryDocType;
  module?: string;
  source_name?: string;
  follow_sublinks?: boolean;
}): Promise<{
  source_name: string;
  chunks_indexed: number;
  source_url: string;
  sublinks_indexed: { source_name: string; source_url: string; chunks_indexed: number }[];
}> {
  return api.post('/manage/industry-docs/ingest-url', params);
}

// Edits an already-indexed document's tags in place — everything upload sets
// except the file/content itself. Re-embeds server-side only if aliases
// changed; every other field is a plain metadata update.
export async function updateIndustryDocMetadata(params: IndustryDocMetaFields & {
  industry: string;
  source_name: string;
  apps: IndustryDocApp[];
  doc_type: IndustryDocType;
  module?: string;
}): Promise<{ source_name: string; chunks_updated: number; chunks_reembedded: number }> {
  return api.post('/manage/industry-docs/update-metadata', params);
}

export async function listIndustryDocs(): Promise<IndustryDoc[]> {
  const r = await api.get('/manage/industry-docs/list');
  return r.documents ?? [];
}

export interface AskStueySource {
  source_name: string;
  doc_type: string;
  module: string;
  score: number;
  url: string | null;
  is_canonical: boolean;
  is_current: boolean;
}

export type AskStueyConfidence = 'high' | 'medium' | 'low' | 'none';

// Regular is today's persona, unchanged. Cranky is an old, reluctant, grumpy-but-
// always-respectful version of Stuey — same grounding/retrieval rules server-side
// (functions/ask_stuey_chat/handler.py's _SYSTEM_BY_MODE), only the voice changes.
export type AskStueyMode = 'regular' | 'cranky';

export async function askStueyChat(params: {
  message: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  mode?: AskStueyMode;
}): Promise<{ reply: string; sources: AskStueySource[]; confidence: AskStueyConfidence }> {
  return api.post('/ask-stuey/chat', params);
}

export async function askStueyFeedback(params: {
  message: string;
  reply: string;
  sources: string[];
  rating: 'up' | 'down';
  comment?: string;
}): Promise<void> {
  await api.post('/ask-stuey/feedback', params);
}

export async function deleteIndustryDoc(industry: string, sourceName: string): Promise<void> {
  await api.post('/manage/industry-docs/delete', { industry, source_name: sourceName });
}

// Platform Home tile state, per view ("consultant" = real staff, "demo" = the
// demo walkthrough account). GET is available to any authenticated role —
// PlatformHome uses it to gray out WIP tiles for its own inferred view; POST
// is admin-only. `view` param on GET only takes effect for admin callers
// (used by AdminPanel's Apps tab to load both views' config for editing);
// non-admins always get their own inferred view regardless of what's passed.
export type AppVisibilityView = 'consultant' | 'demo';
export type WipApps = Record<string, string>; // appId -> admin-written reason

export async function getAppVisibility(view?: AppVisibilityView): Promise<{ view: AppVisibilityView; wip_apps: WipApps }> {
  const qs = view ? `?view=${view}` : '';
  return api.get(`/manage/app-visibility${qs}`);
}

export async function setAppVisibility(view: AppVisibilityView, wipApps: WipApps): Promise<void> {
  await api.post('/manage/app-visibility', { view, wip_apps: wipApps });
}

// Admin-configurable per-app settings — every app's schema + currently-
// resolved values (default, or an admin override if one exists). Admin-only
// both directions; unlike app visibility there's no non-admin runtime reader
// on the frontend side, since handlers read settings server-side directly.
export type AppSettingType = 'number' | 'boolean' | 'select' | 'string_list';

export interface AppSettingDef {
  key: string;
  label: string;
  type: AppSettingType;
  default: unknown;
  description: string;
  min: number | null;
  max: number | null;
  step: number | null;
  options: string[] | null;
}

export type AppSettingValues = Record<string, unknown>;

export interface AppSettingsEntry {
  schema: AppSettingDef[];
  values: AppSettingValues;
}

export async function getAppSettings(): Promise<{ apps: Record<string, AppSettingsEntry> }> {
  return api.get('/manage/app-settings');
}

export async function updateAppSettings(app: string, settings: AppSettingValues): Promise<void> {
  await api.post('/manage/app-settings', { app, settings });
}

// Test Automation Suite — requirements/user-stories/config-workbook/BPW ->
// user stories -> test scenarios -> test steps -> 3-sheet Excel export.
// Retires the old Test Script Generator (generate_tests) entirely — see
// functions/test_automation/handler.py's module docstring.

export type TestAutomationInputType = 'requirements' | 'user_stories' | 'config_workbook' | 'bpw';

export type TestAutomationRunStatus =
  | 'parsing' | 'generating_stories' | 'needs_review'
  | 'generating_scenarios' | 'scenarios_ready'
  | 'generating_steps' | 'steps_ready'
  | 'exporting' | 'completed' | 'failed';

export interface TestAutomationRequirement {
  row_number: number;
  requirement_id: string;
  requirement_text: string;
  module: string | null;
  priority: string | null;
}

export interface TestAutomationUserStory {
  requirement_id: string;
  story_id: string | null;
  as_a: string;
  i_want: string;
  so_that: string;
  acceptance_criteria: string[];
  story_label?: string;
}

export interface TestAutomationConfigItem {
  item_id: string;
  sheet_name: string;
  action: string;
  reference_id: string;
  display_name: string;
  additional_fields: Record<string, string>;
}

export interface TestAutomationBPWStep {
  process_name: string;
  step_number: string;
  step_type: string;
  step_name: string;
  role: string;
  description: string;
  condition: string | null;
}

export interface TestAutomationBPWProcess {
  process_name: string;
  overview: string | null;
  objective: string | null;
  business_trigger: string | null;
  approval_routes: Record<string, string>[];
}

export interface TestAutomationBPWItems {
  bpw_steps: TestAutomationBPWStep[];
  bpw_processes: TestAutomationBPWProcess[];
}

// Independent from TestAutomationRunStatus (the generation pipeline) — a completed/exported
// run's execution_status separately progresses not_executed -> pending -> running ->
// passed/failed/error, potentially re-run multiple times. See migration 007.
export type TestAutomationExecutionStatus = 'not_executed' | 'pending' | 'running' | 'passed' | 'failed' | 'error';

export interface TestAutomationScenario {
  scenario_id: string;
  source_ref: string;
  scenario_type: 'Positive' | 'Negative';
  title: string;
  description: string;
  preconditions: string[];
  scenario_label?: string;
  execution_status: TestAutomationExecutionStatus;
  execution_started_at: string | null;
  execution_completed_at: string | null;
}

export interface TestAutomationStepExecutionResult {
  note?: string;
  screenshot_key?: string | null;
}

export interface TestAutomationStep {
  step_id: string;
  scenario_id: string;
  step_number: number;
  action: string;
  expected_result: string;
  test_data: string | null;
  scenario_label?: string;
  step_label?: string;
  execution_status: TestAutomationExecutionStatus;
  execution_result: TestAutomationStepExecutionResult | null;
  last_executed_at: string | null;
}

// Fixed lists for the Build tab's run-configuration fields (migration 009) — single source of
// truth shared by the Build form and the Reports/Test-Executions filter dropdowns. Mirrored
// server-side in test_automation/handler.py's _VALID_TEST_PHASES/_VALID_MODULES; keep in sync.
export const TEST_PHASES = ['SIT', 'UAT', 'Regression', 'Parallel', 'Production Validation'] as const;
export type TestPhase = typeof TEST_PHASES[number];

export const TEST_MODULES = ['HCM', 'Payroll', 'Absence', 'Recruiting', 'Benefits'] as const;
export type TestModule = typeof TEST_MODULES[number];

export interface TestAutomationRun {
  run_id: string;
  run_name: string | null;
  file_name: string;
  input_type: TestAutomationInputType;
  input_items: TestAutomationRequirement[] | TestAutomationUserStory[] | TestAutomationConfigItem[] | TestAutomationBPWItems;
  status: TestAutomationRunStatus;
  output_blob_key: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  execution_status: TestAutomationExecutionStatus;
  test_phase: TestPhase | null;
  module: TestModule | null;
  description: string | null;
  scenarios?: TestAutomationScenario[];
  steps?: TestAutomationStep[];
}

export async function getTestAutomationUploadUrl(filename: string): Promise<{ url: string; key: string; content_type: string }> {
  return api.post('/test-automation/upload-url', { filename });
}

export async function createTestAutomationRun(params: {
  s3_key: string; filename: string;
  run_name?: string; test_phase?: TestPhase; module?: TestModule; description?: string;
}): Promise<TestAutomationRun & { status: string }> {
  return api.post('/test-automation/runs', params);
}

export async function listTestAutomationRuns(): Promise<{ runs: TestAutomationRun[] }> {
  return api.get('/test-automation/runs');
}

// Admin-only: every run for a tenant regardless of which consultant created it — used to
// pick which run's scenarios become an environment's "nightly regression suite"
// (see WorkdayCredentialsModal / TestEnvironment.nightly_run_id).
export async function listAllTestAutomationRunsForTenant(tenantId: string): Promise<{ runs: TestAutomationRun[] }> {
  return api.get(`/test-automation/runs?all=true&tenant_id=${encodeURIComponent(tenantId)}`);
}

// tenantId is only for the admin cross-client Test Executions drill-down (super_admin/
// project_admin) — every other caller omits it and gets their own ctx.tenant_id, unchanged.
export async function getTestAutomationRun(runId: string, tenantId?: string): Promise<TestAutomationRun> {
  const suffix = tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : '';
  return api.get(`/test-automation/runs/${runId}${suffix}`);
}

export async function triggerTestAutomationScenarios(
  runId: string,
  inputItems?: TestAutomationRun['input_items'],
): Promise<{ run_id: string; status: string }> {
  return api.post(`/test-automation/runs/${runId}/scenarios`, inputItems !== undefined ? { input_items: inputItems } : {});
}

export async function triggerTestAutomationSteps(
  runId: string,
  scenarios?: TestAutomationScenario[],
): Promise<{ run_id: string; status: string }> {
  return api.post(`/test-automation/runs/${runId}/steps`, scenarios !== undefined ? { scenarios } : {});
}

export async function exportTestAutomationRun(runId: string): Promise<{ run_id: string; status: string; download_url: string }> {
  return api.post(`/test-automation/runs/${runId}/export`, {});
}

export async function getTestAutomationDownloadUrl(runId: string): Promise<{ download_url: string }> {
  return api.get(`/test-automation/runs/${runId}/download`);
}

export async function triggerTestAutomationExecute(
  runId: string,
  environmentId: string,
): Promise<{ run_id: string; execution_status: TestAutomationExecutionStatus; scenario_count: number }> {
  return api.post(`/test-automation/runs/${runId}/execute`, { environment_id: environmentId });
}

export async function getTestAutomationScreenshotUrl(runId: string, key: string, tenantId?: string): Promise<{ url: string }> {
  const tenantSuffix = tenantId ? `&tenant_id=${encodeURIComponent(tenantId)}` : '';
  return api.get(`/test-automation/runs/${runId}/screenshot-url?key=${encodeURIComponent(key)}${tenantSuffix}`);
}

// Reporting dashboard — aggregate rollup across executed runs, separate from the
// build-wizard "recent runs" picker above. See functions/test_automation/handler.py's
// _reports_dashboard.
export interface TestAutomationReportRow {
  run_id: string;
  tenant_id?: string;  // only present when fetched with `all: true` (cross-client rollup)
  file_name: string;
  run_name: string | null;
  test_phase: TestPhase | null;
  module: TestModule | null;
  environment_id: string | null;
  environment_name: string | null;
  execution_status: TestAutomationExecutionStatus;
  updated_at: string;
  scenario_counts: { total: number; passed: number; failed: number; error: number; pending: number };
}

export interface TestAutomationReportSummary {
  total_runs: number;
  total_scenarios: number;
  passed: number;
  failed: number;
  error: number;
  pending: number;
  pass_rate: number | null;
}

export async function getTestAutomationReports(params?: {
  environmentId?: string; testPhase?: string; module?: string; since?: string;
  tenantId?: string; all?: boolean;
}): Promise<{ runs: TestAutomationReportRow[]; summary: TestAutomationReportSummary }> {
  const qs = new URLSearchParams();
  if (params?.environmentId) qs.set('environment_id', params.environmentId);
  if (params?.testPhase) qs.set('test_phase', params.testPhase);
  if (params?.module) qs.set('module', params.module);
  if (params?.since) qs.set('since', params.since);
  if (params?.tenantId) qs.set('tenant_id', params.tenantId);
  if (params?.all) qs.set('all', 'true');
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return api.get(`/test-automation/reports${suffix}`);
}

export async function exportTestAutomationResults(runId: string, tenantId?: string): Promise<{ run_id: string; download_url: string }> {
  const suffix = tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : '';
  return api.post(`/test-automation/runs/${runId}/export-results${suffix}`, {});
}

// RFP Reimagine
export const WORKDAY_TIERS = ['Go', 'FastForward', 'Full-scale'] as const;
export type WorkdayTier = typeof WORKDAY_TIERS[number];

export const SCOPE_MODULES = ['HCM', 'Fins', 'Payroll', 'Platform'] as const;
export type ScopeModule = typeof SCOPE_MODULES[number];

export const DELIVERY_APPROACHES = ['Phased', 'Full-scale'] as const;
export type DeliveryApproach = typeof DELIVERY_APPROACHES[number];

export const BUDGET_RANGES = ['Under $2M', '$2M-$5M', '$5M-$10M', '$10M+', 'Not disclosed'] as const;
export type BudgetRange = typeof BUDGET_RANGES[number];

export interface RfpAutopopulateResponse {
  industry: string;
  estimated_employee_count: string;
  headquarters_location: string;
  other_locations: string[];
  confidence: 'high' | 'medium' | 'low';
  notes: string;
}

export interface RfpQuestionnaire {
  client_name: string;
  industry: string;
  estimated_employee_count: string;
  locations: string[];
  workday_tier: WorkdayTier;
  scope_modules: ScopeModule[];
  delivery_approach: DeliveryApproach;
  // Optional context — all sharpen the draft when given, none are required to generate.
  executive_sponsor_name?: string;
  executive_sponsor_title?: string;
  current_systems?: string;
  business_drivers?: string;
  target_go_live?: string;
  key_integrations?: string[];
  budget_range?: BudgetRange | '';
  union_environment?: boolean;
}

export interface RfpDocuments {
  rfp_response: string;
  cover_letter: string;
  project_plan: string;
  resource_plan: string;
}

export interface RfpJobResponse {
  job_id: string;
  status: 'generating' | 'done' | 'error';
  error?: string;
  documents?: RfpDocuments;
}

export async function rfpAutopopulate(companyName: string): Promise<RfpAutopopulateResponse> {
  return api.post('/rfp/autopopulate', { company_name: companyName });
}

export async function rfpGenerate(questionnaire: RfpQuestionnaire): Promise<RfpJobResponse> {
  return api.post('/rfp/generate', questionnaire);
}

export async function getRfpJob(jobId: string): Promise<RfpJobResponse> {
  return api.get(`/rfp/status/${jobId}`);
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
  await api.post('/manage/update-user', params);
}

export async function resetUserMfa(email: string): Promise<void> {
  await api.post('/manage/manage-user', { email, action: 'reset_mfa' });
}

// MFA reset requests
export interface MfaResetRequest {
  email: string;
  requested_at: string;
  ip: string;
}

export async function getMfaResetRequests(): Promise<MfaResetRequest[]> {
  const r = await api.get('/manage/mfa-reset-requests');
  return r.requests ?? [];
}

export async function dismissMfaResetRequest(email: string): Promise<void> {
  await api.post('/manage/mfa-reset-requests', { email, action: 'dismiss' });
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

export type PiAiOpportunity =
  | 'sana_agent' | 'workday_native' | 'partial_ai' | 'human_only';

export interface PiStep {
  step_id: string;
  lane_id: string | null;
  label: string;
  type: string | null;
  systems_touched: string[];
  ai_opportunity: PiAiOpportunity | null;
  ai_rationale: string | null;
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
  ai_opportunity?: PiAiOpportunity;
}

export interface PiLanePatch {
  lane_id: string;
  label?: string;
  persona?: string;
}

export interface PiTobeSwimLane {
  lane_id: string;
  label: string;
  persona: string | null;
  position: number;
}

export interface PiTobeStep {
  step_id: string;
  lane_id: string | null;
  label: string;
  step_type: string | null;
  ai_opportunity: PiAiOpportunity | null;
  systems_touched: string[];
  transformation_note?: string | null;
}

export interface PiTobeConnector {
  from: string;
  to: string;
  condition?: string | null;
}

export interface PiTobeGraph {
  transformation_summary?: string;
  ai_stats?: {
    steps_automated?: number;
    steps_assisted?: number;
    steps_unchanged?: number;
    cycle_time_reduction_pct?: number;
  };
  swimlanes: PiTobeSwimLane[];
  steps: PiTobeStep[];
  connectors: PiTobeConnector[];
}

export interface PiIntervention {
  intervention_id: string;
  title: string;
  impact: 'medium' | 'high';
  description: string;
  replaces_step_ids: string[];
}

export interface PiRecommendations {
  intro: string;
  interventions: PiIntervention[];
}

export interface PiAgentTool {
  name: string;
  purpose: string;
}

export interface PiAgenticStage {
  stage: 'Detect' | 'Plan' | 'Nudge' | 'Insight' | 'Action' | 'Learning Loop';
  label: string;
  description: string;
  builtOn: string;
  agentType: '1P' | '3P' | 'External';
  executionMode: 'Ambient' | 'Delegate';
  groundingRef: string | null;
}

export interface PiMaturity {
  position: number;
  note?: string | null;
}

export interface PiHumanRole {
  tier: 'Human Led' | 'Human Guided' | 'Human Supervised';
  description: string;
}

export interface PiAgenticMetadata {
  stages: PiAgenticStage[];
  maturity: PiMaturity | null;
  humanRoles: PiHumanRole[];
}

export interface PiAgent {
  agent_id: string;
  name: string;
  description: string | null;
  model: string | null;
  tools: PiAgentTool[];
  replaces_step_ids: string[];
  lld_status: 'not_generated' | 'generating' | 'done' | 'failed';
  lld_markdown: string | null;
  lld_error: string | null;
  // Nullable — rows generated before demo generation shipped won't have this
  // set until the agentic workflow is regenerated. Treat null as 'workspace'
  // (the _TOBE_SYSTEM prompt's own default) when displaying/reviewing.
  kind: 'conversational' | 'workspace' | null;
  agentic_metadata?: PiAgenticMetadata | null;
}

export type PiDemoStatus = 'not_generated' | 'generating' | 'done' | 'failed';

export interface PiDemoTheme {
  clientName?: string;
  clientLogoText?: string;
  primaryColor?: string;
}

export interface PiDemoReviewAgent {
  agent_id: string;
  kind: 'conversational' | 'workspace';
  name: string;
  description: string;
}

export interface PiPlanTask {
  task_id: string;
  phase: string;
  name: string;
  start_date: string;
  end_date: string;
  dependencies: string[];
  is_milestone: boolean;
  is_phase_header: boolean;
}

export interface PiChatMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: string;
}

export interface PiPlan {
  plan_id: string | null;
  tasks: PiPlanTask[];
  chat_history: PiChatMessage[];
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
    headers: {
      'Content-Type': 'application/octet-stream',
      // Azure Blob Storage's PUT Blob REST API requires this to create a
      // block blob via a SAS-signed URL — S3 has no equivalent, so this was
      // missing from the original AWS-era port. Without it Blob Storage
      // rejects the request with 400 MissingRequiredHeader.
      'x-ms-blob-type': 'BlockBlob',
    },
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

export interface PiProcessSummary {
  process_id: string;
  source_name: string;
  domain: PiDomain;
  parse_status: PiParseStatus;
  created_at: string;
  agent_count: number;
}

/** Recent processes for this tenant, newest first — backs the Process Intelligence home page. */
export async function listProcesses(): Promise<{ processes: PiProcessSummary[] }> {
  const token = await getAuthToken();
  const res = await fetch(`${API_ENDPOINT}/process-intelligence`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...clientTenantHeaders(),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to load recent processes');
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

/**
 * "Apply & Generate": triggers Agentic Workflow generation (async — same
 * trigger+poll pattern as pi_parse/pi_agent_lld, since generation can exceed
 * API Gateway's 29s hard integration timeout). Returns immediately with
 * status "generating" — poll getTobeGraphAndAgents() until tobe_status is
 * "done" or "failed".
 */
export async function applyRecommendationsAndGenerate(
  processId: string,
  params: { selected_intervention_ids: string[]; additional_directions?: string }
): Promise<{ process_id: string; tobe_status: string }> {
  const token = await getAuthToken();
  const res = await fetch(`${API_ENDPOINT}/process-intelligence/${processId}/tobe`, {
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
    throw new Error(err.error || 'Agentic workflow generation failed');
  }
  return res.json();
}

/** Refetch the last-generated/in-progress Agentic Workflow graph + agents + status. */
export async function getTobeGraphAndAgents(
  processId: string
): Promise<{ tobe: PiTobeGraph | null; proposed_agents: PiAgent[]; tobe_status: string | null; tobe_error: string | null }> {
  const token = await getAuthToken();
  const res = await fetch(`${API_ENDPOINT}/process-intelligence/${processId}/tobe`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...clientTenantHeaders(),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Agentic workflow fetch failed');
  }
  const data = await res.json();
  return {
    tobe: (data.tobe ?? null) as PiTobeGraph | null,
    proposed_agents: (data.proposed_agents ?? []) as PiAgent[],
    tobe_status: data.tobe_status ?? null,
    tobe_error: data.tobe_error ?? null,
  };
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

/** Fetch the last-generated AI Recommendations list, if any. */
export async function getRecommendations(processId: string): Promise<PiRecommendations | null> {
  const token = await getAuthToken();
  const res = await fetch(`${API_ENDPOINT}/process-intelligence/${processId}/recommendations`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...clientTenantHeaders(),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Recommendations fetch failed');
  }
  const data = await res.json();
  return (data.recommendations ?? null) as PiRecommendations | null;
}

/** Generate (or regenerate) the grouped AI Recommendations list via Bedrock. */
export async function generateRecommendations(processId: string): Promise<PiRecommendations> {
  const token = await getAuthToken();
  const res = await fetch(`${API_ENDPOINT}/process-intelligence/${processId}/recommendations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...clientTenantHeaders(),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Recommendations generation failed');
  }
  const data = await res.json();
  return data.recommendations as PiRecommendations;
}

/** Kick off async Agent Design (LLD) document generation for one proposed agent. */
export async function triggerAgentLld(processId: string, agentId: string): Promise<{ agent_id: string; status: string }> {
  const token = await getAuthToken();
  const res = await fetch(`${API_ENDPOINT}/process-intelligence/${processId}/agents/${agentId}/lld`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...clientTenantHeaders(),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'LLD generation trigger failed');
  }
  return res.json();
}

/** Poll Agent Design (LLD) document generation status/result. */
export async function getAgentLld(processId: string, agentId: string): Promise<PiAgent> {
  const token = await getAuthToken();
  const res = await fetch(`${API_ENDPOINT}/process-intelligence/${processId}/agents/${agentId}/lld`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...clientTenantHeaders(),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'LLD status fetch failed');
  }
  return res.json();
}

/** Apply the consultant's review-step edits and kick off unified demo generation. */
export async function triggerDemoGenerate(
  processId: string,
  params: { agents: PiDemoReviewAgent[]; theme?: PiDemoTheme }
): Promise<{ process_id: string; demo_status: PiDemoStatus }> {
  const token = await getAuthToken();
  const res = await fetch(`${API_ENDPOINT}/process-intelligence/${processId}/demo`, {
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
    throw new Error(err.error || 'Demo generation trigger failed');
  }
  return res.json();
}

/** Poll unified demo generation status. download_url is freshly signed on every call. */
export async function getDemoGenerate(processId: string): Promise<{
  process_id: string;
  demo_status: PiDemoStatus;
  download_url: string | null;
  demo_error: string | null;
  demo_agent_ids: string[] | null;
}> {
  const token = await getAuthToken();
  const res = await fetch(`${API_ENDPOINT}/process-intelligence/${processId}/demo`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...clientTenantHeaders(),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Demo status fetch failed');
  }
  return res.json();
}

/** Fetch the current AI Planning Assistant plan for a process, if any. */
export async function getPlan(processId: string): Promise<PiPlan> {
  const token = await getAuthToken();
  const res = await fetch(`${API_ENDPOINT}/process-intelligence/${processId}/plan`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...clientTenantHeaders(),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Plan fetch failed');
  }
  return res.json();
}

/** Send a natural-language instruction to the AI Planning Assistant (chat or "Update plan"). */
export async function updatePlanWithInstruction(processId: string, instruction: string): Promise<PiPlan> {
  const token = await getAuthToken();
  const res = await fetch(`${API_ENDPOINT}/process-intelligence/${processId}/plan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...clientTenantHeaders(),
    },
    body: JSON.stringify({ instruction }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Plan update failed');
  }
  return res.json();
}

/** Directly save a manually-edited task list (no Bedrock call). */
export async function savePlanTasks(processId: string, tasks: PiPlanTask[]): Promise<PiPlan> {
  const token = await getAuthToken();
  const res = await fetch(`${API_ENDPOINT}/process-intelligence/${processId}/plan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...clientTenantHeaders(),
    },
    body: JSON.stringify({ tasks }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Plan save failed');
  }
  return res.json();
}

// ── BP Workbook Generation ──────────────────────────────────────────────────
// Routed through APIM's separate 'bp-workbook' API (its own small Node Function
// App — see bicep/modules/bpworkbook.bicep). generateSession runs the whole
// pipeline (parse → LLM enrich → build docx → upload) synchronously in one
// request and returns the finished download URL — there's no job/poll model
// here, unlike RFP Reimagine's generate+poll flow.

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

async function fileField(file: File | null | undefined): Promise<{ name: string; data: string } | undefined> {
  if (!file) return undefined;
  return { name: file.name, data: await fileToBase64(file) };
}

export interface BpWorkbookGenerateResponse {
  sessionId: string;
  processId: string;
  downloadUrl: string;
  filename: string;
  summary: {
    stepCount: number;
    swimLaneCount: number;
    conditionCount: number;
    enriched: boolean;
  };
  warnings: string[];
}

export interface BpWorkbookSession {
  id: string;
  processId: string;
  fileName: string;
  createdAt: string;
  status: 'completed' | 'failed';
  stepCount?: number;
  enriched?: boolean;
  downloadUrl: string | null;
}

export async function bpWorkbookGenerate(params: {
  visioFile: File;
  securityFile?: File | null;
  systemNotifFile?: File | null;
  customNotifFile?: File | null;
  templateFile?: File | null;
  customInstructions?: string;
}): Promise<BpWorkbookGenerateResponse> {
  const [visioFile, securityFile, systemNotifFile, customNotifFile, templateFile] = await Promise.all([
    fileField(params.visioFile),
    fileField(params.securityFile),
    fileField(params.systemNotifFile),
    fileField(params.customNotifFile),
    fileField(params.templateFile),
  ]);
  return api.post('/bp-workbook/sessions', {
    visioFile, securityFile, systemNotifFile, customNotifFile, templateFile,
    customInstructions: params.customInstructions || '',
  });
}

export async function listBpWorkbookSessions(): Promise<BpWorkbookSession[]> {
  const r = await api.get('/bp-workbook/sessions');
  return r.sessions ?? [];
}

export async function getBpWorkbookDownloadUrl(sessionId: string): Promise<{ downloadUrl: string; filename: string }> {
  return api.get(`/bp-workbook/sessions/${sessionId}/download`);
}
