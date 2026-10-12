import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { analyzeDoc, deleteDoc, publishDoc, validateSow, generateStatusReport, api, type Finding, type AnalyzeResponse, type SowFinding, type SowValidateResponse, type StatusReportResponse, type StatusWorkstream } from '../lib/api';
import { type BulkAction } from './FileExplorer';
import { PublishReviewModal } from './PublishReviewModal';
import { UploadModal } from './UploadModal';
import { PolicyAdvisor } from './PolicyAdvisor';
import { ConsultantChat } from './ConsultantChat';
import { Toast } from './Toast';
import { Spinner } from './Spinner';
import type { FolderTemplate } from './FolderTemplateSelector';

interface Document {
  doc_id: string;
  source_name: string;
  doc_type: string;
  module: string;
  chunk_count: number;
  uploaded_at: string;
  s3_key: string;
  folder_path: string;
  published?: boolean;
}

// Process Intelligence is no longer a sub-page here — it's its own top-level
// view (App.tsx renders <ProcessIntelligence> directly, same pattern as RFP
// Reimagine), so a consultant launching it never sees this Documents shell
// at all. 'go-live-check' | 'weekly-report' | 'workday-coach' are reachable
// only via initialNav (App.tsx routes their Platform Home tiles straight
// here) — they deliberately don't appear as sidebar buttons, since each is
// its own focused destination. See StandaloneResultPane/AssistantPane below.
export type NavSection = 'documents' | 'go-live-check' | 'weekly-report' | 'workday-coach';
// activeNav/onNavChange are controlled by the caller (App.tsx, backed by the URL) rather than
// owned here — a plain `initialNav` seed previously meant the parent never learned when the
// user switched panes inside the workspace (a real bug: refresh always landed back on
// whichever pane the workspace was launched into, not wherever the user actually was).
type Props = { role: string; tenantId: string; clientName?: string; activeNav: NavSection; onNavChange: (nav: NavSection) => void };

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';
const SIDEBAR_W = 220;

// ── Icons ──────────────────────────────────────────────────────────────────────
function IcGrid() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
      <rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/>
      <rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>
    </svg>
  );
}
function IcDocs() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
      <path d="M3 4a1 1 0 011-1h6l3 3v7a1 1 0 01-1 1H4a1 1 0 01-1-1V4z"/>
      <path d="M10 3v3h3M6 9h4M6 12h3"/>
    </svg>
  );
}
function IcChat() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
      <path d="M14 2H2a1 1 0 00-1 1v7a1 1 0 001 1h3.5l2.5 3 2.5-3H14a1 1 0 001-1V3a1 1 0 00-1-1z"/>
      <path d="M5 6.5h6M5 8.5h4"/>
    </svg>
  );
}
function IcUpload() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
      <path d="M8 11V3M5 6l3-3 3 3"/><path d="M3 13h10"/>
    </svg>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function ConsultantPanel({ role, tenantId, clientName, activeNav, onNavChange }: Props) {
  const [folderTemplate, setFolderTemplate] = useState<FolderTemplate | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [processingDocId, setProcessingDocId] = useState<string | null>(null);
  const [goLiveCheckMode, setGoLiveCheckMode] = useState(false);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [resultDocName, setResultDocName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [sowResult, setSowResult] = useState<SowValidateResponse | null>(null);
  const [validatingSow, setValidatingSow] = useState(false);
  const [pendingPublishDoc, setPendingPublishDoc] = useState<Document | null>(null);
  const [previewDoc, setPreviewDoc] = useState<Document | null>(null);
  const [bulkModalAction, setBulkModalAction] = useState<BulkAction | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [statusReport, setStatusReport] = useState<StatusReportResponse | null>(null);
  const [generatingReport, setGeneratingReport] = useState(false);
  const [assistantMode, setAssistantMode] = useState<'coach' | 'policy'>('coach');
  const [toast, setToast] = useState<{ message: string; id: number } | null>(null);

  const canIngest = role === 'consultant' || role === 'super_admin' || role === 'project_admin';

  const loadDocuments = useCallback(() => {
    setDocsLoading(true);
    api.get('/documents/list')
      .then((data) => setDocuments(data.documents || []))
      .catch((err) => console.error('Failed to load documents:', err))
      .finally(() => setDocsLoading(false));
  }, [tenantId]);

  useEffect(() => {
    setDocuments([]); setResult(null); setResultDocName(null); setError(null); setShowUploadModal(false);
    Promise.all([api.get('/tenant/folder-structure'), api.get('/documents/list')])
      .then(([structData, docsData]) => { setFolderTemplate(structData.template ?? null); setDocuments(docsData.documents || []); })
      .catch(console.error).finally(() => setDocsLoading(false));
  }, [tenantId]);

  async function onAnalyse(doc: Document) {
    setGoLiveCheckMode(false); setPreviewDoc(null); setError(null); setResult(null); setSowResult(null);
    setResultDocName(doc.source_name); setAnalyzing(true); setShowResults(true); setProcessingDocId(doc.doc_id);
    try { const out = await analyzeDoc(doc.doc_id, 'all'); setResult(out); }
    catch (err: any) { setError(err.message || String(err)); setResultDocName(null); }
    finally { setAnalyzing(false); setProcessingDocId(null); }
  }

  async function onValidateSow(doc: Document) {
    setGoLiveCheckMode(false); setPreviewDoc(null); setError(null); setResult(null); setSowResult(null);
    setResultDocName(doc.source_name); setValidatingSow(true); setShowResults(true); setProcessingDocId(doc.doc_id);
    try { const out = await validateSow(doc.doc_id); setSowResult(out); }
    catch (err: any) { setError(err.message || String(err)); setResultDocName(null); }
    finally { setValidatingSow(false); setProcessingDocId(null); }
  }

  async function onGoLiveCheck() {
    const sowDoc = documents.find(d => d.doc_type === 'sow');
    if (!sowDoc) { setGoLiveCheckMode(false); setError('No Statement of Work found. Upload your SOW to run a readiness check.'); setShowResults(true); return; }
    setGoLiveCheckMode(true); setPreviewDoc(null); setError(null); setResult(null); setSowResult(null); setStatusReport(null);
    setResultDocName(sowDoc.source_name); setValidatingSow(true); setShowResults(true); setProcessingDocId(sowDoc.doc_id);
    try { const out = await validateSow(sowDoc.doc_id); setSowResult(out); }
    catch (err: any) { setError(err.message || String(err)); setGoLiveCheckMode(false); }
    finally { setValidatingSow(false); setProcessingDocId(null); }
  }

  async function onGenerateReport() {
    setGoLiveCheckMode(false); setPreviewDoc(null); setError(null); setResult(null); setSowResult(null); setStatusReport(null);
    setGeneratingReport(true); setShowResults(true);
    try { const out = await generateStatusReport(); setStatusReport(out); loadDocuments(); }
    catch (err: any) { setError(err.message || String(err)); }
    finally { setGeneratingReport(false); }
  }

  async function handleBulkAction(action: BulkAction, docs: Document[]) {
    switch (action) {
      case 'download': {
        setBulkProgress({ done: 0, total: docs.length });
        let i = 0;
        for (const doc of docs) { try { const r = await api.post('/documents/download-url', { s3_key: doc.s3_key }); window.open(r.url, '_blank'); } catch { /* skip */ } setBulkProgress({ done: ++i, total: docs.length }); }
        setBulkProgress(null); setBulkModalAction(null);
        break;
      }
      case 'delete': {
        const names = docs.map(d => d.source_name).join('\n  • ');
        if (!confirm(`Delete ${docs.length} document${docs.length > 1 ? 's' : ''}?\n\n  • ${names}\n\nThis cannot be undone.`)) return;
        setBulkProgress({ done: 0, total: docs.length });
        let i = 0;
        for (const doc of docs) { try { await deleteDoc(doc.doc_id); } catch { /* skip */ } setBulkProgress({ done: ++i, total: docs.length }); }
        setBulkProgress(null); setBulkModalAction(null);
        loadDocuments(); break;
      }
      case 'publish': {
        const eligible = docs.filter(d => !d.published);
        setBulkProgress({ done: 0, total: eligible.length });
        let i = 0;
        for (const doc of eligible) { try { await publishDoc(doc.doc_id, true); } catch { /* skip */ } setBulkProgress({ done: ++i, total: eligible.length }); }
        setBulkProgress(null); setBulkModalAction(null);
        loadDocuments(); break;
      }
      case 'unpublish': {
        const eligible = docs.filter(d => d.published);
        setBulkProgress({ done: 0, total: eligible.length });
        let i = 0;
        for (const doc of eligible) { try { await publishDoc(doc.doc_id, false); } catch { /* skip */ } setBulkProgress({ done: ++i, total: eligible.length }); }
        setBulkProgress(null); setBulkModalAction(null);
        loadDocuments(); break;
      }
      case 'analyse':
        setBulkModalAction(null); setShowResults(true);
        for (const doc of docs) {
          setError(null); setResult(null); setSowResult(null); setResultDocName(doc.source_name);
          setAnalyzing(true); setProcessingDocId(doc.doc_id);
          try { const out = await analyzeDoc(doc.doc_id, 'all'); setResult(out); }
          catch (err: any) { setError(err.message || String(err)); setResultDocName(null); }
          finally { setAnalyzing(false); setProcessingDocId(null); }
        }
        break;
    }
  }

  // activeNav is now a controlled prop (URL-backed) — reset the result/preview state whenever
  // it changes, replacing what the old navTo() did inline before also setting local state.
  useEffect(() => {
    setShowResults(false); setPreviewDoc(null);
    setResult(null); setSowResult(null); setStatusReport(null); setError(null); setGoLiveCheckMode(false);
  }, [activeNav]);

  // Go-Live Check and Weekly Report are launched directly from their own Platform
  // Home tiles (see App.tsx's launchApp) rather than picked from a menu, so they
  // auto-run as soon as this workspace lands on them — once documents have
  // settled, so onGoLiveCheck can actually find the SOW doc.
  useEffect(() => {
    if (docsLoading) return;
    if (activeNav === 'go-live-check' && !sowResult && !validatingSow && !error) onGoLiveCheck();
    if (activeNav === 'weekly-report' && !statusReport && !generatingReport && !error) onGenerateReport();
  }, [activeNav, docsLoading]);

  if (!canIngest) {
    return (
      <div style={{ fontFamily: FONT }} className="text-sm text-slate-500 bg-slate-100 p-4 rounded border border-slate-200">
        Your role ({role}) does not have access to consultant insights.
      </div>
    );
  }

  const policyDocs = documents.filter(d => d.doc_type === 'hr_policy');

  return (
    <>
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden', fontFamily: FONT, background: '#F5F5F7' }}>

        {/* ── Sidebar ── */}
        <div style={{ width: SIDEBAR_W, flexShrink: 0, background: '#FFFFFF', borderRight: '1px solid #E5E5EA', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Client header */}
          <div style={{ padding: '20px 16px 14px', borderBottom: '1px solid #F5F5F7' }}>
            <p style={{ fontSize: 10, fontWeight: 600, color: '#86BC25', textTransform: 'uppercase', letterSpacing: '0.09em', margin: 0 }}>Client</p>
            <p style={{ fontSize: 15, fontWeight: 700, color: '#1D1D1F', margin: '4px 0 0', lineHeight: 1.3 }}>{clientName || 'No client selected'}</p>
          </div>

          {/* Nav */}
          <nav style={{ padding: '8px 8px 0', flex: 1 }}>
            {([
              { id: 'documents' as NavSection, label: 'Documents', icon: <IcDocs />, badge: documents.length > 0 ? documents.length : null },
            ]).map(({ id, label, icon, badge }) => {
              const active = activeNav === id;
              return (
                <button key={id} onClick={() => onNavChange(id)} style={{
                  display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
                  padding: '8px 10px', borderRadius: 999, border: 'none', cursor: 'pointer', marginBottom: 2,
                  background: active ? '#ECF4EE' : 'transparent', color: active ? '#0F6FEC' : '#3A3A3C', fontFamily: FONT,
                }}>
                  <span style={{ color: active ? '#0F6FEC' : '#8E8E93' }}>{icon}</span>
                  <span style={{ fontSize: 13, fontWeight: active ? 600 : 500, flex: 1 }}>{label}</span>
                  {badge !== null && (
                    <span style={{ fontSize: 11, fontWeight: 600, color: active ? '#0F6FEC' : '#8E8E93', background: active ? '#DBEAFE' : '#F2F2F7', padding: '1px 6px', borderRadius: 10 }}>
                      {badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Footer */}
          <div style={{ padding: '12px 12px 16px', borderTop: '1px solid #F5F5F7' }}>
            {canIngest && folderTemplate && (
              <button onClick={() => setShowUploadModal(true)} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%',
                padding: '9px 12px', borderRadius: 999, border: 'none', cursor: 'pointer',
                background: '#1D1D1F', color: '#FFFFFF', fontSize: 13, fontWeight: 600, fontFamily: FONT,
              }}>
                <IcUpload /> Upload
              </button>
            )}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, padding: '2px 2px' }}>
              <span style={{ fontSize: 11, color: '#8E8E93' }}>{documents.length} doc{documents.length !== 1 ? 's' : ''}</span>
              <button onClick={loadDocuments} disabled={docsLoading} style={{ fontSize: 13, color: '#8E8E93', background: 'none', border: 'none', cursor: 'pointer', opacity: docsLoading ? 0.5 : 1 }}>↻</button>
            </div>
          </div>
        </div>

        {/* ── Content ── */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {activeNav === 'documents' ? (
            <DocumentsPane documents={documents} docsLoading={docsLoading} processingDocId={processingDocId}
              previewDoc={previewDoc} showResults={showResults} result={result} sowResult={sowResult} statusReport={statusReport}
              error={error} analyzing={analyzing} validatingSow={validatingSow} generatingReport={generatingReport}
              resultDocName={resultDocName} goLiveCheckMode={goLiveCheckMode} canIngest={canIngest} folderTemplate={folderTemplate}
              onPreview={(doc) => { setShowResults(false); setResult(null); setSowResult(null); setStatusReport(null); setError(null); setGoLiveCheckMode(false); setPreviewDoc(doc); }}
              onAnalyse={onAnalyse} onValidateSow={onValidateSow}
              onDownload={async (doc) => { setProcessingDocId(doc.doc_id); try { const r = await api.post('/documents/download-url', { s3_key: doc.s3_key }); window.open(r.url, '_blank'); } catch { alert('Failed to download'); } finally { setProcessingDocId(null); } }}
              onDelete={async (doc) => { if (!confirm(`Delete "${doc.source_name}"? This cannot be undone.`)) return; setProcessingDocId(doc.doc_id); try { await deleteDoc(doc.doc_id); if (previewDoc?.doc_id === doc.doc_id) setPreviewDoc(null); loadDocuments(); } catch { alert('Failed to delete'); } finally { setProcessingDocId(null); } }}
              onPublish={(doc, pub) => { if (pub) setPendingPublishDoc(doc); else { setProcessingDocId(doc.doc_id); publishDoc(doc.doc_id, false).then(loadDocuments).catch(() => alert('Failed to unpublish')).finally(() => setProcessingDocId(null)); } }}
              onCloseResults={() => { setShowResults(false); setPreviewDoc(null); setResult(null); setSowResult(null); setStatusReport(null); setError(null); setGoLiveCheckMode(false); }}
              onBulkActions={(a: BulkAction) => setBulkModalAction(a)} onOpenUpload={() => setShowUploadModal(true)} />
          ) : activeNav === 'go-live-check' ? (
            <StandaloneResultPane title="Go-Live Check" loading={validatingSow} loadingLabel="Validating against SOW…"
              onBack={() => onNavChange('documents')}>
              {sowResult && <GoLiveReadinessPanel sowResult={sowResult} />}
              {error && <ErrorPanel message={error} />}
            </StandaloneResultPane>
          ) : activeNav === 'weekly-report' ? (
            <StandaloneResultPane title="Weekly Report" loading={generatingReport} loadingLabel="Generating status report…"
              onBack={() => onNavChange('documents')}>
              {statusReport && <StatusReportPanel report={statusReport} />}
              {error && <ErrorPanel message={error} />}
            </StandaloneResultPane>
          ) : (
            <AssistantPane mode={assistantMode} setMode={setAssistantMode} clientName={clientName} policyDocs={policyDocs} />
          )}
        </div>
      </div>

      {showUploadModal && folderTemplate && (
        <UploadModal template={folderTemplate} onClose={() => setShowUploadModal(false)}
          onUploaded={(msg) => { loadDocuments(); setToast({ message: msg, id: Date.now() }); }} />
      )}
      {toast && <Toast key={toast.id} message={toast.message} type="success" onDismiss={() => setToast(null)} />}
      {bulkModalAction && (
        <BulkActionModal action={bulkModalAction} documents={documents} preSelected={new Set()}
          progress={bulkProgress}
          onClose={() => setBulkModalAction(null)}
          onExecute={(docs) => handleBulkAction(bulkModalAction, docs)} />
      )}
      {pendingPublishDoc && (
        <PublishReviewModal doc={pendingPublishDoc}
          onConfirmPublish={async () => { try { await publishDoc(pendingPublishDoc!.doc_id, true); loadDocuments(); } catch { alert('Failed to publish'); } finally { setPendingPublishDoc(null); } }}
          onCancel={() => setPendingPublishDoc(null)} />
      )}
    </>
  );
}

// ── Overview pane (unused — no caller renders it) ────────────────────────────
function OverviewPane({ documents, statusReport, sowResult, analyzing, validatingSow, generatingReport, goLiveCheckMode, showResults, result, error, resultDocName, onGoLiveCheck, onGenerateReport, onBulkActions, onViewDocuments }: {
  documents: Document[]; statusReport: StatusReportResponse | null; sowResult: SowValidateResponse | null;
  analyzing: boolean; validatingSow: boolean; generatingReport: boolean; goLiveCheckMode: boolean;
  showResults: boolean; result: AnalyzeResponse | null; error: string | null; resultDocName: string | null;
  onGoLiveCheck: () => void; onGenerateReport: () => void;
  onBulkActions: (a: BulkAction) => void; onViewDocuments: () => void;
}) {
  const modules = [...new Set(documents.map(d => d.module).filter(Boolean))];
  const highRisks = statusReport?.key_risks?.filter(r => r.severity === 'high').length ?? 0;
  const redFindings = sowResult?.findings?.filter(f => f.traffic_light === 'red').length ?? 0;
  const totalRisks = highRisks + redFindings;
  const greenCount = sowResult?.findings?.filter(f => f.traffic_light === 'green').length ?? 0;
  const totalFindings = sowResult?.findings?.length ?? 0;
  let healthPct: number | null = null;
  let healthColor: 'green' | 'amber' | 'red' = 'amber';
  if (totalFindings > 0) { healthPct = Math.round((greenCount / totalFindings) * 100); healthColor = healthPct >= 80 ? 'green' : healthPct >= 55 ? 'amber' : 'red'; }
  else if (statusReport) { const s = statusReport.overall_status; healthPct = s === 'green' ? 85 : s === 'yellow' ? 63 : 40; healthColor = s === 'green' ? 'green' : s === 'yellow' ? 'amber' : 'red'; }
  const hvc = healthColor === 'green' ? '#16A34A' : healthColor === 'amber' ? '#D97706' : '#DC2626';
  const isLoading = analyzing || validatingSow || generatingReport;

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '28px 32px' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#1D1D1F', margin: 0, letterSpacing: '-0.3px' }}>Overview</h1>
        <p style={{ fontSize: 13, color: '#6E6E73', margin: '4px 0 0' }}>Implementation health and quick actions</p>
      </div>

      {/* Metric cards */}
      {documents.length > 0 && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: healthPct !== null ? 10 : 28 }}>
            <MetricCard label="Documents" value={documents.length} sub={`${modules.length} module${modules.length !== 1 ? 's' : ''}`} />
            <MetricCard label="Open Risks" value={totalRisks} sub={totalRisks === 0 ? 'All clear' : `${redFindings} critical`} valueColor={totalRisks === 0 ? '#16A34A' : totalRisks > 3 ? '#DC2626' : '#D97706'} />
            <MetricCard label="Health" value={healthPct !== null ? `${healthPct}%` : '—'} sub={healthPct === null ? 'Run go-live check' : healthPct >= 80 ? 'On track' : healthPct >= 55 ? 'At risk' : 'Action needed'} valueColor={healthPct === null ? '#D1D1D6' : hvc} />
          </div>
          {healthPct !== null && (
            <div style={{ height: 3, background: '#F2F2F7', borderRadius: 4, overflow: 'hidden', marginBottom: 28 }}>
              <div style={{ height: '100%', width: `${healthPct}%`, background: hvc, borderRadius: 4 }} />
            </div>
          )}
        </>
      )}

      {/* Quick actions */}
      <div style={{ marginBottom: 28 }}>
        <p style={{ fontSize: 11, fontWeight: 600, color: '#6E6E73', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>Quick Actions</p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <AppleBtn label={validatingSow && goLiveCheckMode ? 'Checking…' : 'Go-live Check'} variant="primary" disabled={isLoading} onClick={onGoLiveCheck} />
          <AppleBtn label={generatingReport ? 'Generating…' : 'Weekly Report'} variant="secondary" disabled={isLoading} onClick={onGenerateReport} />
          <AppleBtn label="View Documents" variant="ghost" disabled={false} onClick={onViewDocuments} />
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', background: '#fff', borderRadius: 12, border: '1px solid #E5E5EA', marginBottom: 20 }}>
          <Spinner size={18} trackColor="#E5E5EA" />
          <div>
            <p style={{ fontSize: 13, fontWeight: 600, color: '#1D1D1F', margin: 0 }}>{validatingSow ? 'Validating against SOW…' : generatingReport ? 'Generating status report…' : 'Analysing…'}</p>
            <p style={{ fontSize: 11, color: '#6E6E73', margin: '2px 0 0' }}>This may take 30–60 seconds</p>
          </div>
        </div>
      )}

      {/* Results */}
      {showResults && !isLoading && goLiveCheckMode && sowResult && (
        <ResultSection title="Go-live Readiness"><GoLiveReadinessPanel sowResult={sowResult} /></ResultSection>
      )}
      {showResults && !isLoading && !goLiveCheckMode && sowResult && (
        <ResultSection title={`SOW Validation — ${resultDocName ?? ''}`}>
          <div className="space-y-4">
            <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4">
              <p className="text-xs font-medium text-indigo-600 uppercase tracking-wide mb-2">Executive Summary</p>
              <p className="text-sm text-slate-700 leading-relaxed">{sowResult.summary}</p>
            </div>
            <div className="flex items-center gap-3 text-xs">
              {(['green','yellow','red'] as const).map(tl => { const c={green:'bg-green-100 text-green-700',yellow:'bg-amber-100 text-amber-700',red:'bg-red-100 text-red-700'};const l={green:'Evidenced',yellow:'Partial',red:'Gap'}; return <span key={tl} className={`px-2.5 py-1 rounded-full font-medium ${c[tl]}`}>{sowResult.findings.filter(f=>f.traffic_light===tl).length} {l[tl]}</span>; })}
            </div>
            <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">{sowResult.findings.map((f,i)=><SowFindingCard key={i} f={f} first={i===0}/>)}</div>
          </div>
        </ResultSection>
      )}
      {showResults && !isLoading && statusReport && (
        <ResultSection title={`Weekly Status Report — Week ending ${statusReport.week_ending}`}>
          <StatusReportPanel report={statusReport} />
        </ResultSection>
      )}
      {showResults && !isLoading && result && (
        <ResultSection title={`AI Analysis — ${resultDocName ?? ''}`}>
          <div className="space-y-4">
            <div className="bg-slate-50 rounded-xl p-4"><p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Summary</p><p className="text-sm text-slate-700 leading-relaxed">{result.summary}</p></div>
            <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">{result.findings.map((f,i)=><FindingCard key={i} f={f} first={i===0}/>)}</div>
          </div>
        </ResultSection>
      )}
      {showResults && !isLoading && error && (
        <div style={{ padding: '14px 16px', background: '#FEF2F2', borderRadius: 10, border: '1px solid #FECACA' }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: '#B91C1C', margin: '0 0 4px' }}>Action failed</p>
          <p style={{ fontSize: 12, color: '#DC2626', margin: 0 }}>{error}</p>
        </div>
      )}

      {documents.length === 0 && !isLoading && (
        <div style={{ padding: '32px 20px', background: '#fff', borderRadius: 12, border: '1px solid #E5E5EA', textAlign: 'center' }}>
          <div style={{ width: 44, height: 44, background: '#F5F5F7', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', color: '#8E8E93' }}><IcDocs /></div>
          <p style={{ fontSize: 14, fontWeight: 600, color: '#1D1D1F', margin: '0 0 6px' }}>No documents yet</p>
          <p style={{ fontSize: 13, color: '#6E6E73', margin: 0, lineHeight: 1.5 }}>Upload documents using the button in the sidebar to get started.</p>
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, sub, valueColor }: { label: string; value: number | string; sub: string; valueColor?: string }) {
  return (
    <div style={{ background: '#fff', borderRadius: 14, padding: '16px 18px', border: '1px solid #E5E5EA' }}>
      <p style={{ fontSize: 11, fontWeight: 600, color: '#6E6E73', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }}>{label}</p>
      <p style={{ fontSize: 28, fontWeight: 700, color: valueColor || '#1D1D1F', margin: '0 0 4px', letterSpacing: '-0.5px', fontVariantNumeric: 'tabular-nums' as const }}>{value}</p>
      <p style={{ fontSize: 11, color: '#8E8E93', margin: 0 }}>{sub}</p>
    </div>
  );
}

function AppleBtn({ label, variant, disabled, onClick }: { label: string; variant: 'primary'|'secondary'|'ghost'; disabled: boolean; onClick: () => void }) {
  const s = variant === 'primary' ? { background: '#0C0D0D', color: '#fff', border: 'none' }
    : variant === 'secondary' ? { background: '#fff', color: '#1D1D1F', border: '1px solid #D1D1D6' }
    : { background: 'transparent', color: '#0C0D0D', border: '1px solid transparent' };
  return (
    <button onClick={onClick} disabled={disabled} style={{ padding: '9px 18px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, fontFamily: FONT, ...s }}>
      {label}
    </button>
  );
}

function ResultSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <p style={{ fontSize: 11, fontWeight: 600, color: '#6E6E73', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>{title}</p>
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #E5E5EA', padding: 20 }}>{children}</div>
    </div>
  );
}

// ── Documents pane ─────────────────────────────────────────────────────────────
const DT_LABEL: Record<string, string> = {
  'sow':'Statement of Work','config-workbook':'Configuration Workbooks','process-diagram':'Process Diagrams',
  'hr_policy':'HR Policies','bpd':'Business Process Documents','test-script':'Test Scripts',
  'status-report':'Status Reports','document':'Documents',
};
const DT_ORDER = ['sow','config-workbook','process-diagram','hr_policy','bpd','test-script','status-report','document'];
const DT_COLOR: Record<string, string> = {
  'sow':'#3B5BDB','config-workbook':'#2F9E44','process-diagram':'#0C8599',
  'hr_policy':'#7048E8','bpd':'#E8590C','test-script':'#1971C2','status-report':'#5F3DC4','document':'#6E6E73',
};

function groupDocs(docs: Document[]) {
  const b = new Map<string, Document[]>();
  for (const d of docs) { const k = DT_LABEL[d.doc_type] ? d.doc_type : 'document'; if (!b.has(k)) b.set(k, []); b.get(k)!.push(d); }
  return DT_ORDER.filter(dt => b.has(dt)).map(dt => ({ dt, label: DT_LABEL[dt], color: DT_COLOR[dt] ?? '#6E6E73', docs: b.get(dt)! }));
}

function ago(iso: string) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 2) return 'Just now'; if (m < 60) return `${m}m ago`;
  const h = Math.floor(m/60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h/24); return d < 7 ? `${d}d ago` : `${Math.floor(d/7)}w ago`;
}

function DocumentsPane({ documents, docsLoading, processingDocId, previewDoc, showResults, result, sowResult, statusReport, error, analyzing, validatingSow, generatingReport, resultDocName, goLiveCheckMode, canIngest, folderTemplate, onPreview, onAnalyse, onValidateSow, onDownload, onDelete, onPublish, onCloseResults, onBulkActions, onOpenUpload }: {
  documents: Document[]; docsLoading: boolean; processingDocId: string | null; previewDoc: Document | null;
  showResults: boolean; result: AnalyzeResponse | null; sowResult: SowValidateResponse | null; statusReport: StatusReportResponse | null;
  error: string | null; analyzing: boolean; validatingSow: boolean; generatingReport: boolean;
  resultDocName: string | null; goLiveCheckMode: boolean; canIngest: boolean; folderTemplate: FolderTemplate | null;
  onPreview: (d: Document) => void; onAnalyse: (d: Document) => void; onValidateSow: (d: Document) => void;
  onDownload: (d: Document) => void; onDelete: (d: Document) => void;
  onPublish: (d: Document, pub: boolean) => void; onCloseResults: () => void;
  onBulkActions: (a: BulkAction) => void; onOpenUpload: () => void;
}) {
  const [search, setSearch] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const bulkRef = useRef<HTMLButtonElement>(null);
  const bulkMenuRef = useRef<HTMLDivElement>(null);
  const [bulkPos, setBulkPos] = useState({ top: 0, right: 0 });

  useEffect(() => {
    if (!bulkOpen) return;
    function close(e: MouseEvent) { if (bulkRef.current?.contains(e.target as Node)) return; if (bulkMenuRef.current?.contains(e.target as Node)) return; setBulkOpen(false); }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [bulkOpen]);

  const filtered = useMemo(() => search ? documents.filter(d => d.source_name.toLowerCase().includes(search.toLowerCase())) : documents, [documents, search]);
  const groups = useMemo(() => groupDocs(filtered), [filtered]);
  const isLoading = analyzing || validatingSow || generatingReport;
  const showDetail = showResults || !!previewDoc;

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left: list */}
      <div style={{ width: 320, flexShrink: 0, background: '#fff', borderRight: '1px solid #E5E5EA', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 12px 8px', borderBottom: '1px solid #F5F5F7' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
                style={{ width: '100%', padding: '7px 10px 7px 28px', borderRadius: 8, border: '1px solid #E5E5EA', fontSize: 13, fontFamily: FONT, outline: 'none', background: '#F5F5F7', color: '#1D1D1F', boxSizing: 'border-box' }} />
              <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: '#8E8E93' }}>⌕</span>
            </div>
            <button ref={bulkRef} onClick={() => { if (bulkRef.current) { const r = bulkRef.current.getBoundingClientRect(); setBulkPos({ top: r.bottom+4, right: window.innerWidth-r.right }); } setBulkOpen(v=>!v); }}
              disabled={documents.length === 0} title="Bulk actions"
              style={{ padding: '7px 10px', borderRadius: 999, border: '1px solid #E5E5EA', background: '#F5F5F7', color: '#3A3A3C', fontSize: 15, cursor: 'pointer', opacity: documents.length===0?0.4:1, lineHeight: 1 }}>
              ···
            </button>
          </div>
          <p style={{ fontSize: 11, color: '#8E8E93', margin: '7px 2px 0' }}>
            {documents.length} document{documents.length!==1?'s':''}
            {search && filtered.length !== documents.length && ` · ${filtered.length} matching`}
          </p>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {docsLoading ? (
            <div style={{ display:'flex',justifyContent:'center',alignItems:'center',height:100 }}>
              <Spinner size={18} color="#8E8E93" trackColor="#E5E5EA" />
            </div>
          ) : documents.length === 0 ? (
            <div style={{ padding:'40px 20px',textAlign:'center' }}>
              <p style={{ fontSize:13,color:'#6E6E73',margin:'0 0 4px',fontWeight:500 }}>No documents</p>
              {canIngest && folderTemplate && <button onClick={onOpenUpload} style={{ marginTop:10,padding:'7px 14px',borderRadius: 999,border:'none',background:'#1D1D1F',color:'#fff',fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:FONT }}>Upload first document</button>}
            </div>
          ) : groups.length === 0 ? (
            <div style={{ padding:'40px 20px',textAlign:'center' }}><p style={{ fontSize:13,color:'#6E6E73',margin:0 }}>No results for "{search}"</p></div>
          ) : (
            <div style={{ padding:'8px 0' }}>
              {groups.map(g => <DocGroup key={g.dt} group={g} previewDocId={previewDoc?.doc_id??null} processingDocId={processingDocId} onPreview={onPreview} onAnalyse={onAnalyse} onValidateSow={onValidateSow} onDownload={onDownload} onDelete={onDelete} onPublish={onPublish} />)}
            </div>
          )}
        </div>
      </div>

      {/* Right: detail */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: '#F5F5F7' }}>
        {!showDetail ? (
          <div style={{ display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:'100%',gap:12 }}>
            <div style={{ width:48,height:48,background:'#E5E5EA',borderRadius:14,display:'flex',alignItems:'center',justifyContent:'center',color:'#8E8E93' }}><IcDocs /></div>
            <div style={{ textAlign:'center' }}>
              <p style={{ fontSize:14,fontWeight:600,color:'#3A3A3C',margin:'0 0 4px' }}>Select a document</p>
              <p style={{ fontSize:13,color:'#8E8E93',margin:0,maxWidth:220,lineHeight:1.5 }}>Click any document to preview and run AI analysis</p>
            </div>
          </div>
        ) : (
          <div style={{ height:'100%',display:'flex',flexDirection:'column',background:'#fff' }}>
            {/* Detail header */}
            <div style={{ padding:'13px 16px 11px',borderBottom:'1px solid #E5E5EA',display:'flex',alignItems:'center',gap:10,flexShrink:0 }}>
              <div style={{ flex:1,minWidth:0 }}>
                <p style={{ fontSize:14,fontWeight:600,color:'#1D1D1F',margin:0,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis' }}>
                  {previewDoc && !isLoading && !result && !sowResult && !statusReport && !error ? previewDoc.source_name
                    : goLiveCheckMode && (sowResult||validatingSow) ? 'Go-live Readiness'
                    : statusReport||generatingReport ? 'Weekly Status Report'
                    : sowResult||validatingSow ? 'SOW Validation'
                    : 'AI Analysis'}
                </p>
                {resultDocName && !previewDoc && !statusReport && <p style={{ fontSize:11,color:'#6E6E73',margin:'2px 0 0',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',maxWidth:260 }}>{resultDocName}</p>}
                {statusReport && <p style={{ fontSize:11,color:'#6E6E73',margin:'2px 0 0' }}>Week ending {statusReport.week_ending}</p>}
                {previewDoc && !isLoading && !result && !sowResult && !statusReport && !error && (
                  <p style={{ fontSize:11,color:'#8E8E93',margin:'2px 0 0',textTransform:'uppercase',letterSpacing:'0.05em' }}>{DT_LABEL[previewDoc.doc_type]??previewDoc.doc_type.replace(/-/g,' ')}{previewDoc.published&&<span style={{ marginLeft:8,color:'#16A34A' }}>● Published</span>}</p>
                )}
              </div>
              <button onClick={onCloseResults} style={{ width:28,height:28,borderRadius: 999,border:'none',background:'#F5F5F7',color:'#6E6E73',cursor:'pointer',fontSize:14,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}>✕</button>
            </div>

            {/* Detail body */}
            {previewDoc && !isLoading && !result && !sowResult && !statusReport && !error ? (
              <div style={{ flex:1,overflow:'hidden' }}>
                <DocumentPreviewPanel doc={previewDoc} onAnalyse={onAnalyse} onValidateSow={onValidateSow} onPublish={onPublish} onDownload={onDownload} onDelete={onDelete} />
              </div>
            ) : (
              <div style={{ flex:1,overflowY:'auto',padding:16 }}>
                {isLoading ? (
                  <div style={{ display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:'100%',gap:14 }}>
                    <Spinner size={28} />
                    <div style={{ textAlign:'center' }}>
                      <p style={{ fontSize:14,fontWeight:600,color:'#1D1D1F',margin:'0 0 4px' }}>{validatingSow?'Validating against SOW…':generatingReport?'Generating status report…':'Analysing document…'}</p>
                      <p style={{ fontSize:12,color:'#6E6E73',margin:0 }}>This may take 30–60 seconds</p>
                    </div>
                  </div>
                ) : goLiveCheckMode && sowResult ? <GoLiveReadinessPanel sowResult={sowResult} />
                : sowResult ? (
                  <div className="space-y-4">
                    <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4"><p className="text-xs font-medium text-indigo-600 uppercase tracking-wide mb-2">Executive Summary</p><p className="text-sm text-slate-700 leading-relaxed">{sowResult.summary}</p></div>
                    <div className="flex items-center gap-3 text-xs">{(['green','yellow','red'] as const).map(tl=>{const c={green:'bg-green-100 text-green-700',yellow:'bg-amber-100 text-amber-700',red:'bg-red-100 text-red-700'};const l={green:'Evidenced',yellow:'Partial',red:'Gap'};return <span key={tl} className={`px-2.5 py-1 rounded-full font-medium ${c[tl]}`}>{sowResult.findings.filter(f=>f.traffic_light===tl).length} {l[tl]}</span>;})}</div>
                    <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">{sowResult.findings.map((f,i)=><SowFindingCard key={i} f={f} first={i===0}/>)}</div>
                    <p className="text-xs text-slate-300 pt-2">Model: {sowResult.model_id}</p>
                  </div>
                ) : statusReport ? <StatusReportPanel report={statusReport} />
                : result ? (
                  <div className="space-y-4">
                    <div className="bg-slate-50 rounded-xl p-4"><p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Summary</p><p className="text-sm text-slate-700 leading-relaxed">{result.summary}</p></div>
                    <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">{result.findings.map((f,i)=><FindingCard key={i} f={f} first={i===0}/>)}</div>
                    <p className="text-xs text-slate-300 pt-2">Model: {result.model_id}</p>
                  </div>
                ) : error ? (
                  <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3"><p className="text-sm font-medium text-red-700 mb-1">Action failed</p><p className="text-xs text-red-600">{error}</p></div>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bulk actions dropdown */}
      {bulkOpen && (
        <div ref={bulkMenuRef} style={{ position:'fixed',top:bulkPos.top,right:bulkPos.right,zIndex:9999,background:'#fff',border:'1px solid #E5E5EA',borderRadius:12,boxShadow:'0 4px 20px rgba(0,0,0,0.1)',minWidth:180,overflow:'hidden',padding:'6px 0' }}>
          <p style={{ padding:'0 12px 6px',fontSize:10,fontWeight:600,color:'#8E8E93',textTransform:'uppercase',letterSpacing:'0.08em',margin:0 }}>Bulk Actions</p>
          {([['analyse','Analyse','#4F46E5'],['publish','Publish','#16A34A'],['unpublish','Unpublish','#D97706'],['download','Download','#3A3A3C'],['delete','Delete','#DC2626']] as [BulkAction,string,string][]).map(([a,l,c])=>(
            <button key={a} onClick={()=>{setBulkOpen(false);onBulkActions(a);}} style={{ display:'block',width:'100%',textAlign:'left',padding:'8px 14px',fontSize:13,color:c,background:'none',border:'none',cursor:'pointer',fontFamily:FONT }}>{l}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function DocGroup({ group, previewDocId, processingDocId, onPreview, onAnalyse, onValidateSow, onDownload, onDelete, onPublish }: {
  group: { dt: string; label: string; color: string; docs: Document[] }; previewDocId: string | null; processingDocId: string | null;
  onPreview:(d:Document)=>void; onAnalyse:(d:Document)=>void; onValidateSow:(d:Document)=>void;
  onDownload:(d:Document)=>void; onDelete:(d:Document)=>void; onPublish:(d:Document,pub:boolean)=>void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div style={{ marginBottom: 2 }}>
      <button onClick={()=>setCollapsed(v=>!v)} style={{ display:'flex',alignItems:'center',gap:7,width:'100%',padding:'5px 14px',background:'none',border:'none',cursor:'pointer',fontFamily:FONT }}>
        <span style={{ width:6,height:6,borderRadius:'50%',background:group.color,flexShrink:0 }} />
        <span style={{ fontSize:10,fontWeight:700,color:'#6E6E73',textTransform:'uppercase',letterSpacing:'0.08em',flex:1,textAlign:'left' }}>{group.label}</span>
        <span style={{ fontSize:11,color:'#8E8E93',fontWeight:600 }}>{group.docs.length}</span>
        <span style={{ fontSize:8,color:'#8E8E93',marginLeft:2 }}>{collapsed?'▶':'▼'}</span>
      </button>
      {!collapsed && group.docs.map(doc=>(
        <DocRow key={doc.doc_id} doc={doc} active={previewDocId===doc.doc_id} processing={processingDocId===doc.doc_id}
          onPreview={onPreview} onAnalyse={onAnalyse} onValidateSow={onValidateSow} onDownload={onDownload} onDelete={onDelete} onPublish={onPublish} />
      ))}
    </div>
  );
}

function DocRow({ doc, active, processing, onPreview, onAnalyse, onValidateSow, onDownload, onDelete, onPublish }: {
  doc: Document; active: boolean; processing: boolean;
  onPreview:(d:Document)=>void; onAnalyse:(d:Document)=>void; onValidateSow:(d:Document)=>void;
  onDownload:(d:Document)=>void; onDelete:(d:Document)=>void; onPublish:(d:Document,pub:boolean)=>void;
}) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top:0,left:0 });
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function close(e: MouseEvent) { if (menuBtnRef.current?.contains(e.target as Node)) return; if (menuRef.current?.contains(e.target as Node)) return; setMenuOpen(false); }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  return (
    <div onClick={()=>onPreview(doc)} onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)}
      style={{ display:'flex',alignItems:'center',gap:8,padding:'7px 14px 7px 22px',cursor:'pointer',
        background: active?'#ECF4EE':hovered?'#F7F7F7':'transparent',
        borderLeft: `2px solid ${active?'#0C0D0D':'transparent'}`, position:'relative' }}>
      <div style={{ flexShrink:0,color:active?'#0C0D0D':'#8E8E93' }}>
        {processing ? <Spinner size={14} /> : <IcDocs />}
      </div>
      <div style={{ flex:1,minWidth:0 }}>
        <p style={{ fontSize:13,fontWeight:active?600:500,color:active?'#0F6FEC':'#1D1D1F',margin:0,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis' }}>{doc.source_name}</p>
        <p style={{ fontSize:11,color:'#8E8E93',margin:'1px 0 0' }}>{ago(doc.uploaded_at)}{doc.published&&<span style={{ marginLeft:6,color:'#16A34A' }}>●</span>}</p>
      </div>
      <button ref={menuBtnRef} onClick={e=>{e.stopPropagation();if(menuBtnRef.current){const r=menuBtnRef.current.getBoundingClientRect();setMenuPos({top:r.bottom+2,left:r.left});}setMenuOpen(v=>!v);}}
        style={{ width:24,height:24,borderRadius: 999,border:'none',background:menuOpen?'#E5E5EA':'transparent',color:'#6E6E73',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',fontSize:14,flexShrink:0,opacity:hovered||menuOpen?1:0 }}>···</button>
      {menuOpen && (
        <div ref={menuRef} onClick={e=>e.stopPropagation()}
          style={{ position:'fixed',top:menuPos.top,left:menuPos.left,zIndex:9999,background:'#fff',border:'1px solid #E5E5EA',borderRadius: 999,boxShadow:'0 4px 16px rgba(0,0,0,0.1)',minWidth:160,overflow:'hidden',padding:'4px 0' }}>
          {doc.doc_type==='sow'
            ? <MItem label="Validate SOW" color="#4F46E5" onClick={()=>{setMenuOpen(false);onValidateSow(doc);}} />
            : <MItem label="Analyse" color="#4F46E5" onClick={()=>{setMenuOpen(false);onAnalyse(doc);}} />}
          <div style={{ height:1,background:'#F5F5F7',margin:'4px 0' }} />
          <MItem label={doc.published?'Unpublish':'Publish'} color={doc.published?'#D97706':'#16A34A'} onClick={()=>{setMenuOpen(false);onPublish(doc,!doc.published);}} />
          <MItem label="Download" color="#3A3A3C" onClick={()=>{setMenuOpen(false);onDownload(doc);}} />
          <div style={{ height:1,background:'#F5F5F7',margin:'4px 0' }} />
          <MItem label="Delete" color="#DC2626" onClick={()=>{setMenuOpen(false);onDelete(doc);}} />
        </div>
      )}
    </div>
  );
}

function MItem({ label, color, onClick }: { label:string; color:string; onClick:()=>void }) {
  return <button onClick={onClick} style={{ display:'block',width:'100%',textAlign:'left',padding:'7px 14px',fontSize:13,color,background:'none',border:'none',cursor:'pointer',fontFamily:FONT }}>{label}</button>;
}

// ── Standalone result panes (Go-Live Check / Weekly Report) ────────────────────
// Both are launched directly from their own Platform Home tile and auto-run on
// arrival (see the useEffect in the main component) — this is just the shell:
// header, back button, loading state, and wherever the caller puts the result.
function StandaloneResultPane({ title, loading, loadingLabel, onBack, children }: {
  title: string; loading: boolean; loadingLabel: string; onBack: () => void; children: React.ReactNode;
}) {
  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '28px 32px' }}>
      <button onClick={onBack} style={{ background: 'none', border: 'none', color: '#6E6E73', fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 20, fontFamily: FONT }}>
        ← Back to Documents
      </button>
      <h1 style={{ fontSize: 24, fontWeight: 700, color: '#1D1D1F', margin: '0 0 20px', letterSpacing: '-0.3px' }}>{title}</h1>
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', background: '#fff', borderRadius: 12, border: '1px solid #E5E5EA' }}>
          <Spinner size={18} trackColor="#E5E5EA" />
          <p style={{ fontSize: 13, fontWeight: 600, color: '#1D1D1F', margin: 0 }}>{loadingLabel}</p>
        </div>
      ) : children}
    </div>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div style={{ padding: '14px 16px', background: '#FEF2F2', borderRadius: 10, border: '1px solid #FECACA' }}>
      <p style={{ fontSize: 13, fontWeight: 600, color: '#B91C1C', margin: '0 0 4px' }}>Action failed</p>
      <p style={{ fontSize: 12, color: '#DC2626', margin: 0 }}>{message}</p>
    </div>
  );
}

// ── Assistant pane ─────────────────────────────────────────────────────────────
function AssistantPane({ mode, setMode, clientName, policyDocs }: {
  mode: 'coach'|'policy'; setMode:(m:'coach'|'policy')=>void; clientName?: string; policyDocs: Document[];
}) {
  return (
    <div style={{ display:'flex',flexDirection:'column',height:'100%',overflow:'hidden',background:'#fff' }}>
      <div style={{ padding:'16px 20px 0',borderBottom:'1px solid #E5E5EA',flexShrink:0 }}>
        <div style={{ display:'flex',alignItems:'center',marginBottom:14 }}>
          <div style={{ display:'inline-flex',background:'#F2F2F7',borderRadius:10,padding:3,gap:2 }}>
            {([{id:'coach' as const,label:'Workday Coach'},{id:'policy' as const,label:'Policy Advisor'}]).map(({id,label})=>(
              <button key={id} onClick={()=>setMode(id)} style={{ padding:'6px 14px',borderRadius: 999,border:'none',cursor:'pointer',fontSize:13,fontWeight:600,fontFamily:FONT,background:mode===id?'#FFFFFF':'transparent',color:mode===id?'#1D1D1F':'#6E6E73',boxShadow:mode===id?'0 1px 3px rgba(0,0,0,0.12)':'none' }}>{label}</button>
            ))}
          </div>
          <p style={{ marginLeft:'auto',fontSize:12,color:'#8E8E93' }}>{mode==='policy'?`${policyDocs.length} policy doc${policyDocs.length!==1?'s':''} in context`:'Workday implementation guidance'}</p>
        </div>
      </div>
      <div style={{ flex:1,minHeight:0,overflow:'hidden' }}>
        {mode==='coach' ? <ConsultantChat clientName={clientName}/> : <PolicyAdvisor policyDocs={policyDocs} clientName={clientName}/>}
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function topCategory(doc: { doc_type: string; folder_path: string; module: string }): string {
  if (doc.folder_path && doc.folder_path !== '/') { const parts = doc.folder_path.replace(/^\//, '').split('/'); if (parts[0]) return parts[0]; }
  switch (doc.doc_type) {
    case 'sow': return 'Statement of Work';
    case 'hr_policy': return 'HR Policies & Knowledge';
    case 'config-workbook': return 'Configuration Workbooks';
    default: return 'Other Documents';
  }
}

// ── Bulk Action Modal ──────────────────────────────────────────────────────────
const BULK_CFG: Record<BulkAction, { title: string; btn: string; btnCls: string; hint?: string; filter?: (d: Document) => boolean; }> = {
  analyse:   { title: 'Analyse Documents',   btn: 'Analyse',   btnCls: 'bg-indigo-600 hover:bg-indigo-700 text-white' },
  publish:   { title: 'Publish Documents',   btn: 'Publish',   btnCls: 'bg-green-600 hover:bg-green-700 text-white',  hint: 'Showing draft documents only',     filter: d => !d.published },
  unpublish: { title: 'Unpublish Documents', btn: 'Unpublish', btnCls: 'bg-amber-500 hover:bg-amber-600 text-white',  hint: 'Showing published documents only', filter: d => !!d.published },
  download:  { title: 'Download Documents',  btn: 'Download',  btnCls: 'bg-slate-700 hover:bg-slate-800 text-white' },
  delete:    { title: 'Delete Documents',    btn: 'Delete',    btnCls: 'bg-red-600 hover:bg-red-700 text-white',      hint: 'This action cannot be undone' },
};

function BulkActionModal({ action, documents, preSelected, progress, onClose, onExecute }: {
  action: BulkAction; documents: Document[]; preSelected: Set<string>;
  progress: { done: number; total: number } | null;
  onClose: () => void; onExecute: (docs: Document[]) => void;
}) {
  const cfg = BULK_CFG[action];
  const eligible = cfg.filter ? documents.filter(cfg.filter) : documents;
  const [selected, setSelected] = useState<Set<string>>(() => { const init = new Set<string>(); for (const id of preSelected) { if (eligible.some(d => d.doc_id === id)) init.add(id); } return init; });
  const grouped = useMemo(() => { const map = new Map<string, Document[]>(); for (const doc of eligible) { const cat = topCategory(doc); if (!map.has(cat)) map.set(cat, []); map.get(cat)!.push(doc); } return map; }, [eligible]);
  const selectedList = eligible.filter(d => selected.has(d.doc_id));
  function toggle(id: string) { setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  function toggleAll() { setSelected(selected.size === eligible.length ? new Set() : new Set(eligible.map(d => d.doc_id))); }
  const busy = progress !== null;
  const pct = busy && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]">
        <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
          <div><h2 className="text-base font-semibold text-slate-900">{cfg.title}</h2>{cfg.hint && <p className="text-xs text-slate-400 mt-0.5">{cfg.hint}</p>}</div>
          {!busy && <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors">✕</button>}
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {busy ? (
            <div className="space-y-2 py-6">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span className="w-3.5 h-3.5 border-2 border-indigo-200 border-t-indigo-600 rounded-full animate-spin flex-shrink-0" />
                <span>{cfg.btn}ing… <span className="text-slate-400">({progress.done}/{progress.total})</span></span>
              </div>
              <div className="h-1 bg-slate-200 rounded-full overflow-hidden">
                <div className="h-full bg-indigo-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
              </div>
            </div>
          ) : eligible.length === 0 ? <p className="text-sm text-slate-400 text-center py-10">No eligible documents</p> : (
            <div className="space-y-3">
              <div className="flex items-center justify-between"><p className="text-xs text-slate-500">{selected.size} of {eligible.length} selected</p><button onClick={toggleAll} className="text-xs text-indigo-600 hover:text-indigo-800 font-medium">{selected.size === eligible.length ? 'Deselect all' : 'Select all'}</button></div>
              {[...grouped.entries()].map(([cat, docs]) => (
                <div key={cat} className="border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-2 bg-slate-50 text-xs font-semibold text-slate-600">{cat}</div>
                  <div className="divide-y divide-slate-100">{docs.map(doc => (<label key={doc.doc_id} className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${selected.has(doc.doc_id) ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}><input type="checkbox" checked={selected.has(doc.doc_id)} onChange={() => toggle(doc.doc_id)} className="w-3.5 h-3.5 rounded border-slate-300 accent-indigo-600 flex-shrink-0" /><span className="text-xs text-slate-700 truncate flex-1">{doc.source_name}</span>{doc.published !== undefined && <span className={`text-[10px] font-medium flex-shrink-0 ${doc.published ? 'text-green-600' : 'text-amber-600'}`}>{doc.published ? '● Published' : '● Draft'}</span>}</label>))}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2 flex-shrink-0">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900 rounded-full hover:bg-slate-100 disabled:opacity-50 transition-colors">Cancel</button>
          <button onClick={() => onExecute(selectedList)} disabled={busy || selectedList.length === 0} className={`px-4 py-2 text-sm font-medium rounded-full disabled:opacity-50 transition-colors ${cfg.btnCls}`}>{cfg.btn} ({selectedList.length})</button>
        </div>
      </div>
    </div>
  );
}

// ── Document Preview Panel ─────────────────────────────────────────────────────
function DocumentPreviewPanel({ doc, onAnalyse, onValidateSow, onPublish, onDownload, onDelete }: {
  doc: Document; onAnalyse?: (d: Document) => void; onValidateSow?: (d: Document) => void;
  onPublish?: (d: Document, published: boolean) => void;
  onDownload: (d: Document) => void; onDelete?: (d: Document) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loadingUrl, setLoadingUrl] = useState(true);
  const [urlError, setUrlError] = useState(false);
  const isPdf = doc.source_name.toLowerCase().endsWith('.pdf') || doc.doc_type === 'sow';
  const isSow = doc.doc_type === 'sow';

  useEffect(() => {
    setUrl(null); setLoadingUrl(true); setUrlError(false);
    api.post('/documents/download-url', { s3_key: doc.s3_key }).then(r => setUrl(r.url)).catch(() => setUrlError(true)).finally(() => setLoadingUrl(false));
  }, [doc.doc_id]);

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden" style={{ height: '100%' }}>
      <div className="flex-1 min-h-0 relative bg-slate-50">
        {loadingUrl && <div className="absolute inset-0 flex items-center justify-center"><span className="w-6 h-6 border-2 border-slate-200 border-t-slate-500 rounded-full animate-spin" /></div>}
        {urlError && <div className="absolute inset-0 flex items-center justify-center"><p className="text-xs text-red-500">Failed to load preview</p></div>}
        {url && isPdf && <iframe src={url} className="w-full h-full border-0" title={doc.source_name} />}
        {url && !isPdf && (
          <div className="flex flex-col items-center justify-center h-full gap-4 p-6">
            <div className="w-16 h-20 bg-white border border-slate-200 rounded-xl shadow-sm flex items-center justify-center" style={{ color: '#8E8E93' }}><IcDocs /></div>
            <div className="text-center"><p className="text-sm font-medium text-slate-700 break-all">{doc.source_name}</p><p className="text-xs text-slate-400 mt-1 uppercase tracking-wide">{doc.doc_type.replace(/-/g, ' ')}</p></div>
            <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors">Open document ↗</a>
          </div>
        )}
      </div>
      <div className="px-4 py-3 border-t border-slate-100 bg-white shrink-0">
        <div className="flex flex-wrap gap-1.5">
          {isSow && onValidateSow && <button onClick={() => onValidateSow(doc)} className="px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-full transition-colors">Validate SOW</button>}
          {!isSow && onAnalyse && <button onClick={() => onAnalyse(doc)} className="px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-full transition-colors">Analyse</button>}
          {onPublish && <button onClick={() => onPublish(doc, !doc.published)} className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${doc.published ? 'bg-amber-100 text-amber-700 hover:bg-amber-200' : 'bg-green-600 text-white hover:bg-green-700'}`}>{doc.published ? 'Unpublish' : 'Publish'}</button>}
          <button onClick={() => onDownload(doc)} className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-full transition-colors">Download</button>
          {onDelete && <button onClick={() => onDelete(doc)} className="px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-full transition-colors">Delete</button>}
        </div>
      </div>
    </div>
  );
}

function FindingCard({ f, first }: { f: Finding; first?: boolean }) {
  const [open, setOpen] = useState(false);
  const sevClass = f.severity === 'high' ? 'bg-red-100 text-red-700' : f.severity === 'medium' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600';
  const catClass = f.category === 'risk' ? 'text-red-600' : f.category === 'anti-pattern' ? 'text-amber-600' : 'text-teal-600';
  return (
    <div className={first ? '' : 'border-t border-slate-100'}>
      <button onClick={() => setOpen(v => !v)} className="w-full text-left px-3 py-2.5 flex items-start gap-2 hover:bg-slate-50 transition-colors">
        <span className={`mt-0.5 text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${sevClass}`}>{f.severity}</span>
        <span className="text-xs font-medium text-slate-800 flex-1 leading-snug">{f.title}</span>
        <span className={`text-xs flex-shrink-0 mt-0.5 ${catClass}`}>{open ? '▴' : '▾'}</span>
      </button>
      {open && (<div className="px-3 pb-3 space-y-2 border-t border-slate-100"><p className="text-xs text-slate-600 pt-2 leading-relaxed">{f.detail}</p>{f.evidence && f.evidence.length > 0 && (<div className="bg-slate-50 border-l-2 border-slate-300 pl-2.5 py-1.5 rounded-r">{f.evidence.map((e, i) => <p key={i} className="text-xs text-slate-500 font-mono whitespace-pre-wrap">{e}</p>)}</div>)}<p className="text-xs text-slate-700"><span className="font-medium">Recommendation: </span>{f.recommendation}</p></div>)}
    </div>
  );
}

function SowFindingCard({ f, first }: { f: SowFinding; first?: boolean }) {
  const [open, setOpen] = useState(false);
  const tlDot: Record<string, string> = { green: 'bg-green-500', yellow: 'bg-amber-400', red: 'bg-red-500' };
  const tlLabel: Record<string, string> = { green: 'Evidenced', yellow: 'Partial', red: 'Gap' };
  const tlText: Record<string, string> = { green: 'text-green-700', yellow: 'text-amber-700', red: 'text-red-700' };
  return (
    <div className={first ? '' : 'border-t border-slate-100'}>
      <button onClick={() => setOpen(v => !v)} className="w-full text-left px-3 py-2.5 flex items-start gap-2 hover:bg-slate-50 transition-colors">
        <span className={`mt-1 w-2.5 h-2.5 rounded-full flex-shrink-0 ${tlDot[f.traffic_light] ?? 'bg-slate-400'}`} />
        <span className="text-xs font-medium text-slate-800 flex-1 leading-snug">{f.deliverable}</span>
        <span className={`text-xs flex-shrink-0 mt-0.5 font-medium ${tlText[f.traffic_light] ?? 'text-slate-500'}`}>{tlLabel[f.traffic_light]} {open ? '▴' : '▾'}</span>
      </button>
      {open && (<div className="px-3 pb-3 space-y-2 border-t border-slate-100"><p className="text-xs text-slate-600 pt-2 leading-relaxed">{f.detail}</p>{f.evidence && f.evidence.length > 0 && (<div className="bg-slate-50 border-l-2 border-slate-300 pl-2.5 py-1.5 rounded-r">{f.evidence.map((e, i) => <p key={i} className="text-xs text-slate-500 font-mono whitespace-pre-wrap">{e}</p>)}</div>)}<p className="text-xs text-slate-700"><span className="font-medium">Recommendation: </span>{f.recommendation}</p></div>)}
    </div>
  );
}

function StatusReportPanel({ report }: { report: StatusReportResponse }) {
  const sc = { green: { bg: 'bg-green-50', border: 'border-green-200', dot: 'bg-green-500', text: 'text-green-700' }, yellow: { bg: 'bg-amber-50', border: 'border-amber-200', dot: 'bg-amber-400', text: 'text-amber-700' }, red: { bg: 'bg-red-50', border: 'border-red-200', dot: 'bg-red-500', text: 'text-red-700' } }[report.overall_status] ?? { bg: 'bg-amber-50', border: 'border-amber-200', dot: 'bg-amber-400', text: 'text-amber-700' };
  const statusLabel: Record<string, string> = { green: 'On Track', yellow: 'At Risk', red: 'Action Required' };
  return (
    <div className="space-y-5">
      <div className={`rounded-xl border p-4 ${sc.bg} ${sc.border}`}>
        <div className="flex items-center gap-2 mb-3"><span className={`w-3 h-3 rounded-full flex-shrink-0 ${sc.dot}`} /><span className={`text-xs font-semibold uppercase tracking-wide ${sc.text}`}>{statusLabel[report.overall_status] ?? report.overall_status} — {report.overall_status_reason}</span></div>
        <p className="text-sm text-slate-700 leading-relaxed">{report.exec_summary}</p>
      </div>
      {report.highlights.length > 0 && (<div><p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Highlights</p><ul className="space-y-1.5">{report.highlights.map((h, i) => (<li key={i} className="flex items-start gap-2"><span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-violet-400 flex-shrink-0" /><span className="text-xs text-slate-700 leading-relaxed">{h}</span></li>))}</ul></div>)}
      {report.workstreams.length > 0 && (<div><p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Workstreams <span className="text-slate-400 normal-case font-normal">({report.workstreams.length})</span></p><div className="border border-slate-200 rounded-lg bg-white overflow-hidden">{report.workstreams.map((ws, i) => <WorkstreamCard key={i} ws={ws} first={i===0} />)}</div></div>)}
      {report.decisions_needed.length > 0 && (<div><p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Decisions Needed</p><div className="border border-amber-200 rounded-lg overflow-hidden">{report.decisions_needed.map((d, i) => (<div key={i} className={`bg-amber-50 px-3 py-2.5 ${i > 0 ? 'border-t border-amber-100' : ''}`}><p className="text-xs font-medium text-slate-800 mb-1.5">{d.decision}</p><div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500"><span>Owner: <span className="font-medium text-slate-700">{d.owner}</span></span><span>By: <span className="font-medium text-slate-700">{d.deadline}</span></span></div>{d.impact_if_delayed && <p className="text-xs text-amber-700 mt-1.5">⚠ {d.impact_if_delayed}</p>}</div>))}</div></div>)}
      {report.key_risks.length > 0 && (<div><p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Key Risks</p><div className="border border-slate-200 rounded-lg overflow-hidden">{report.key_risks.map((r, i) => (<div key={i} className={`px-3 py-2.5 ${r.severity === 'high' ? 'bg-red-50' : 'bg-amber-50'} ${i > 0 ? 'border-t border-slate-200' : ''}`}><div className="flex items-start gap-2 mb-1"><span className={`text-xs font-semibold px-1.5 py-0.5 rounded uppercase flex-shrink-0 ${r.severity === 'high' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{r.severity}</span><span className="text-xs font-medium text-slate-800 leading-snug">{r.risk}</span></div><p className="text-xs text-slate-600">Mitigation: {r.mitigation}</p></div>))}</div></div>)}
      {report.upcoming_milestones.length > 0 && (<div><p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Upcoming Milestones</p><div className="space-y-1.5">{report.upcoming_milestones.map((m, i) => { const icon = { on_track: '✓', at_risk: '⚠', delayed: '✗' }[m.status] ?? '→'; const cls = { on_track: 'text-green-600', at_risk: 'text-amber-600', delayed: 'text-red-600' }[m.status] ?? 'text-slate-500'; return (<div key={i} className="flex items-center gap-2.5"><span className={`text-sm font-bold flex-shrink-0 ${cls}`}>{icon}</span><span className="text-xs text-slate-700 flex-1">{m.milestone}</span><span className="text-xs text-slate-400 flex-shrink-0">{m.due}</span></div>); })}</div></div>)}
      {report.next_week_focus.length > 0 && (<div><p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Next Week Focus</p><ul className="space-y-1.5">{report.next_week_focus.map((f, i) => (<li key={i} className="flex items-start gap-2"><span className="text-violet-400 text-xs mt-0.5 flex-shrink-0">→</span><span className="text-xs text-slate-700">{f}</span></li>))}</ul></div>)}
      <p className="text-xs text-slate-300 pt-2">Model: {report.model_id} · {report.latency_ms}ms</p>
    </div>
  );
}

function GoLiveReadinessPanel({ sowResult }: { sowResult: SowValidateResponse }) {
  const green = sowResult.findings.filter(f => f.traffic_light === 'green').length;
  const yellow = sowResult.findings.filter(f => f.traffic_light === 'yellow').length;
  const red = sowResult.findings.filter(f => f.traffic_light === 'red').length;
  const total = sowResult.findings.length;
  const pct = total > 0 ? Math.round((green / total) * 100) : 0;
  const barCls = pct >= 80 ? 'bg-green-500' : pct >= 55 ? 'bg-amber-400' : 'bg-red-500';
  const pctCls = pct >= 80 ? 'text-green-600' : pct >= 55 ? 'text-amber-600' : 'text-red-600';
  const label = pct >= 80 ? 'On Track' : pct >= 55 ? 'At Risk' : 'Action Required';
  return (
    <div className="space-y-5">
      <div className="bg-slate-50 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2"><div><p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Readiness Score</p><p className={`text-xs font-medium mt-0.5 ${pctCls}`}>{label}</p></div><span className={`text-3xl font-bold ${pctCls}`}>{pct}%</span></div>
        <div className="w-full bg-slate-200 rounded-full h-2.5 overflow-hidden mb-2"><div className={`h-2.5 rounded-full ${barCls}`} style={{ width: `${pct}%` }} /></div>
        <div className="flex gap-4 text-xs"><span className="text-green-700 font-medium">{green} Evidenced</span><span className="text-amber-700 font-medium">{yellow} Partial</span><span className="text-red-700 font-medium">{red} Gap</span></div>
      </div>
      <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4"><p className="text-xs font-medium text-indigo-600 uppercase tracking-wide mb-2">Assessment</p><p className="text-sm text-slate-700 leading-relaxed">{sowResult.summary}</p></div>
      {red > 0 && (<div><p className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-2">Gaps — Action Required ({red})</p><div className="border border-red-200 rounded-lg bg-white overflow-hidden">{sowResult.findings.filter(f => f.traffic_light === 'red').map((f, i) => <ReadinessCheckItem key={i} f={f} first={i===0} />)}</div></div>)}
      {yellow > 0 && (<div><p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2">Partial — Monitor ({yellow})</p><div className="border border-amber-200 rounded-lg bg-white overflow-hidden">{sowResult.findings.filter(f => f.traffic_light === 'yellow').map((f, i) => <ReadinessCheckItem key={i} f={f} first={i===0} />)}</div></div>)}
      {green > 0 && (<div><p className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-2">Evidenced — Ready ({green})</p><div className="border border-slate-200 rounded-lg bg-white overflow-hidden">{sowResult.findings.filter(f => f.traffic_light === 'green').map((f, i) => <ReadinessCheckItem key={i} f={f} first={i===0} />)}</div></div>)}
      <p className="text-xs text-slate-300 pt-2">Model: {sowResult.model_id}</p>
    </div>
  );
}

function ReadinessCheckItem({ f, first }: { f: SowFinding; first?: boolean }) {
  const [open, setOpen] = useState(false);
  const icon = { green: '✓', yellow: '~', red: '✗' }[f.traffic_light] ?? '·';
  const iconCls = { green: 'text-green-600', yellow: 'text-amber-600', red: 'text-red-600' }[f.traffic_light] ?? 'text-slate-500';
  return (
    <div className={first ? '' : 'border-t border-slate-100'}>
      <button onClick={() => setOpen(v => !v)} className="w-full text-left px-3 py-2 flex items-start gap-2 hover:bg-slate-50 transition-colors">
        <span className={`font-bold text-sm flex-shrink-0 mt-0.5 ${iconCls}`}>{icon}</span>
        <span className="text-xs text-slate-800 flex-1 leading-snug">{f.deliverable}</span>
        <span className="text-xs text-slate-400 flex-shrink-0">{open ? '▴' : '▾'}</span>
      </button>
      {open && (<div className="px-3 pb-2.5 space-y-1.5 border-t border-slate-100 pt-2"><p className="text-xs text-slate-600 leading-relaxed">{f.detail}</p>{f.recommendation && <p className="text-xs text-slate-700"><span className="font-medium">Action: </span>{f.recommendation}</p>}</div>)}
    </div>
  );
}

function WorkstreamCard({ ws, first }: { ws: StatusWorkstream; first?: boolean }) {
  const [open, setOpen] = useState(false);
  const dotColors: Record<string, string> = { green: 'bg-green-500', yellow: 'bg-amber-400', red: 'bg-red-500' };
  return (
    <div className={first ? '' : 'border-t border-slate-100'}>
      <button onClick={() => setOpen(v => !v)} className="w-full text-left px-3 py-2.5 flex items-start gap-2 hover:bg-slate-50 transition-colors">
        <span className={`mt-1 w-2.5 h-2.5 rounded-full flex-shrink-0 ${dotColors[ws.status] ?? 'bg-slate-400'}`} />
        <div className="flex-1 min-w-0"><span className="text-xs font-medium text-slate-800 leading-snug">{ws.name}</span>{!open && <p className="text-xs text-slate-400 mt-0.5 truncate">{ws.summary}</p>}</div>
        <span className="text-xs text-slate-400 flex-shrink-0 mt-0.5">{open ? '▴' : '▾'}</span>
      </button>
      {open && (<div className="px-3 pb-3 space-y-3 border-t border-slate-100 pt-2">
        <p className="text-xs text-slate-600 leading-relaxed">{ws.summary}</p>
        {ws.completed_this_week.length > 0 && (<div><p className="text-xs font-medium text-slate-500 mb-1">Completed this week</p><ul className="space-y-0.5">{ws.completed_this_week.map((item, i) => (<li key={i} className="flex items-start gap-1.5 text-xs text-slate-700"><span className="text-green-500 mt-0.5 flex-shrink-0">✓</span>{item}</li>))}</ul></div>)}
        {ws.in_progress.length > 0 && (<div><p className="text-xs font-medium text-slate-500 mb-1">In progress</p><ul className="space-y-0.5">{ws.in_progress.map((item, i) => (<li key={i} className="flex items-start gap-1.5 text-xs text-slate-700"><span className="text-blue-400 mt-0.5 flex-shrink-0">→</span>{item}</li>))}</ul></div>)}
        {ws.risks.length > 0 && (<div><p className="text-xs font-medium text-slate-500 mb-1">Risks</p><ul className="space-y-0.5">{ws.risks.map((risk, i) => (<li key={i} className="flex items-start gap-1.5 text-xs text-amber-700"><span className="mt-0.5 flex-shrink-0">⚠</span>{risk}</li>))}</ul></div>)}
        {ws.detail && <p className="text-xs text-slate-500 leading-relaxed border-t border-slate-100 pt-2">{ws.detail}</p>}
      </div>)}
    </div>
  );
}
