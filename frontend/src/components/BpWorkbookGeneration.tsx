import { useEffect, useState } from 'react';
import {
  bpWorkbookGenerate,
  listBpWorkbookSessions,
  type BpWorkbookGenerateResponse,
  type BpWorkbookSession,
} from '../lib/api';
import { Spinner } from './Spinner';

// ── Design tokens (matches ProcessIntelligence.tsx / TestAutomationSuite.tsx / RfpReimagine.tsx) ──
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';
const CARD = '#FFFFFF';
const TEXT = '#1D1D1F';
const MUTED = '#6E6E73';
const BORDER = '#E5E5EA';
const INK = '#0C0D0D';
const ACCENT = '#2563EB'; // matches PlatformHome.tsx's APP_ACCENTS['bp-workbook-generation']

type Props = { tenantId: string; clientName?: string; onBack: () => void };

type OptionalSlot = 'securityFile' | 'systemNotifFile' | 'customNotifFile' | 'templateFile';

const OPTIONAL_UPLOADS: { slot: OptionalSlot; label: string; hint: string; accept: string }[] = [
  { slot: 'securityFile', label: 'Security Policy', hint: 'Section 9 — business process security matrix (.xlsx)', accept: '.xlsx' },
  { slot: 'systemNotifFile', label: 'System Notifications', hint: 'Section 11.1 — system-generated notification rules (.xlsx)', accept: '.xlsx' },
  { slot: 'customNotifFile', label: 'Custom Notifications', hint: 'Section 11.2 — custom notification rules (.xlsx)', accept: '.xlsx' },
  { slot: 'templateFile', label: 'Custom Template', hint: 'Override the default 20-section template (.docx)', accept: '.docx' },
];

function labelStyle(): React.CSSProperties {
  return { fontSize: 12, fontWeight: 600, color: TEXT, display: 'block', marginBottom: 6 };
}
function fieldStyle(): React.CSSProperties {
  return { width: '100%', border: `1px solid #D2D2D7`, borderRadius: 8, padding: '8px 12px', fontSize: 14, fontFamily: FONT, boxSizing: 'border-box' };
}

export default function BpWorkbookGeneration({ clientName, onBack }: Props) {
  const [visioFile, setVisioFile] = useState<File | null>(null);
  const [optionalFiles, setOptionalFiles] = useState<Partial<Record<OptionalSlot, File>>>({});
  const [customInstructions, setCustomInstructions] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const [status, setStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<BpWorkbookGenerateResponse | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  const [recentSessions, setRecentSessions] = useState<BpWorkbookSession[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);

  useEffect(() => {
    listBpWorkbookSessions()
      .then(setRecentSessions)
      .catch(() => setRecentSessions([]))
      .finally(() => setLoadingSessions(false));
  }, []);

  function setOptionalFile(slot: OptionalSlot, file: File | null) {
    setOptionalFiles(prev => {
      const next = { ...prev };
      if (file) next[slot] = file; else delete next[slot];
      return next;
    });
  }

  function onDropVisio(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) setVisioFile(f);
  }

  const canGenerate = !!visioFile && status !== 'generating';

  async function handleGenerate() {
    if (!visioFile) return;
    setStatus('generating');
    setGenError(null);
    setResult(null);
    try {
      const resp = await bpWorkbookGenerate({
        visioFile,
        securityFile: optionalFiles.securityFile,
        systemNotifFile: optionalFiles.systemNotifFile,
        customNotifFile: optionalFiles.customNotifFile,
        templateFile: optionalFiles.templateFile,
        customInstructions,
      });
      setResult(resp);
      setStatus('done');
      listBpWorkbookSessions().then(setRecentSessions).catch(() => {});
    } catch (err: any) {
      setStatus('error');
      setGenError(err.message || 'Generation failed');
    }
  }

  function startOver() {
    setVisioFile(null);
    setOptionalFiles({});
    setCustomInstructions('');
    setStatus('idle');
    setResult(null);
    setGenError(null);
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', fontFamily: FONT, background: '#F5F5F7' }}>
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '28px 24px 60px' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: MUTED, fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 16 }}>
          ← Back
        </button>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: TEXT, margin: '0 0 4px' }}>BP Workbook Generation</h1>
        <p style={{ fontSize: 13, color: MUTED, margin: '0 0 24px' }}>
          Generate the 20-section Business Process Workbook{clientName ? ` for ${clientName}` : ''} directly from a Visio Econ Map.
        </p>

        {status === 'generating' && (
          <div style={{ background: CARD, borderRadius: 14, border: `1px solid ${BORDER}`, padding: 48, textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
              <Spinner size={28} />
            </div>
            <p style={{ fontSize: 14, fontWeight: 600, color: TEXT, margin: 0 }}>Generating your BP Workbook…</p>
            <p style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
              Parsing the Econ Map, enriching with AI, and building the 20-section document. This can take a few minutes for a large process.
            </p>
          </div>
        )}

        {status === 'error' && (
          <div style={{ background: CARD, borderRadius: 14, border: `1px solid ${BORDER}`, padding: 32, textAlign: 'center' }}>
            <p style={{ fontSize: 14, fontWeight: 600, color: '#dc2626', margin: 0 }}>Generation failed</p>
            <p style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>{genError}</p>
            <button onClick={startOver} style={{ marginTop: 16, padding: '8px 16px', borderRadius: 999, border: `1px solid #D2D2D7`, background: '#fff', color: '#3A3A3C', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
              Try again
            </button>
          </div>
        )}

        {status === 'done' && result && (
          <div style={{ background: CARD, borderRadius: 14, border: `1px solid ${BORDER}`, padding: 28 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: '#EAF1FE', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>📘</div>
              <div>
                <p style={{ fontSize: 15, fontWeight: 700, color: TEXT, margin: 0 }}>{result.filename}</p>
                <p style={{ fontSize: 12, color: MUTED, margin: '2px 0 0' }}>Process {result.processId} · {result.summary.stepCount} steps · {result.summary.swimLaneCount} swim lanes</p>
              </div>
            </div>

            {result.warnings.length > 0 && (
              <div style={{ background: '#FFF8E6', border: '1px solid #F5D98A', borderRadius: 10, padding: '10px 14px', marginBottom: 16 }}>
                {result.warnings.map((w, i) => (
                  <p key={i} style={{ fontSize: 12, color: '#8A6500', margin: i === 0 ? 0 : '4px 0 0' }}>{w}</p>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <a href={result.downloadUrl} download={result.filename} style={{
                flex: 1, textAlign: 'center', padding: '11px 16px', borderRadius: 999, fontSize: 13.5, fontWeight: 700,
                background: INK, color: '#fff', textDecoration: 'none', fontFamily: FONT,
              }}>
                Download Workbook
              </a>
              <button onClick={startOver} style={{ padding: '11px 20px', borderRadius: 999, border: `1px solid #D2D2D7`, background: '#fff', color: '#3A3A3C', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
                New Workbook
              </button>
            </div>
          </div>
        )}

        {status === 'idle' && (
          <div style={{ display: 'flex', gap: 28 }}>
            <div style={{ flex: 1, maxWidth: 480 }}>
              <h3 style={{ fontSize: 12, fontWeight: 600, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px' }}>
                1. Econ Map
              </h3>
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDropVisio}
                onClick={() => document.getElementById('bpw-visio-input')?.click()}
                style={{
                  border: `2px dashed ${dragOver ? INK : visioFile ? '#34C759' : '#C7C7CC'}`,
                  borderRadius: 14, background: dragOver ? '#F0F8FF' : CARD, cursor: 'pointer',
                  padding: 24, transition: 'all 0.2s',
                }}>
                <input id="bpw-visio-input" type="file" accept=".vsdx" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) setVisioFile(f); }} />
                {visioFile ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 40, height: 40, borderRadius: 10, background: '#EAF1FE', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 18 }}>🗺️</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ color: TEXT, fontWeight: 600, fontSize: 13.5, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{visioFile.name}</p>
                      <p style={{ color: MUTED, fontSize: 11.5, margin: '3px 0 0' }}>{(visioFile.size / 1024).toFixed(1)} KB</p>
                    </div>
                    <button onClick={e => { e.stopPropagation(); setVisioFile(null); }} style={{ color: '#C7C7CC', fontSize: 20, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>×</button>
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', padding: '10px 0' }}>
                    <p style={{ color: TEXT, fontWeight: 500, fontSize: 13.5, margin: 0 }}>Drop a Visio Econ Map here</p>
                    <p style={{ color: MUTED, fontSize: 11.5, margin: '4px 0 0' }}>or click to browse — .vsdx, required</p>
                  </div>
                )}
              </div>

              <h3 style={{ fontSize: 12, fontWeight: 600, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '24px 0 10px' }}>
                2. Optional Inputs
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {OPTIONAL_UPLOADS.map(opt => {
                  const file = optionalFiles[opt.slot];
                  return (
                    <div key={opt.slot}
                      onClick={() => document.getElementById(`bpw-opt-${opt.slot}`)?.click()}
                      style={{
                        border: `1px solid ${file ? '#34C759' : BORDER}`, borderRadius: 10, background: CARD,
                        padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                      }}>
                      <input id={`bpw-opt-${opt.slot}`} type="file" accept={opt.accept} style={{ display: 'none' }}
                        onChange={e => { const f = e.target.files?.[0] ?? null; setOptionalFile(opt.slot, f); }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: 13, fontWeight: 600, color: TEXT, margin: 0 }}>{opt.label}</p>
                        <p style={{ fontSize: 11, color: MUTED, margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {file ? file.name : opt.hint}
                        </p>
                      </div>
                      {file && (
                        <button onClick={e => { e.stopPropagation(); setOptionalFile(opt.slot, null); }} style={{ color: '#C7C7CC', fontSize: 18, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 }}>×</button>
                      )}
                    </div>
                  );
                })}
              </div>

              <h3 style={{ fontSize: 12, fontWeight: 600, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '24px 0 10px' }}>
                3. Custom Instructions
              </h3>
              <div>
                <label style={labelStyle()}>Free-text overrides <span style={{ fontWeight: 400, color: '#8E8E93' }}>(optional)</span></label>
                <textarea style={{ ...fieldStyle(), minHeight: 72, resize: 'vertical' }}
                  placeholder="e.g. Set Section 10 approval threshold to $5,000; mark step 4 as manual-only…"
                  value={customInstructions}
                  onChange={e => setCustomInstructions(e.target.value)} />
              </div>

              <button onClick={handleGenerate} disabled={!canGenerate} style={{
                marginTop: 20, width: '100%', padding: '12px 16px', borderRadius: 999, border: 'none',
                background: canGenerate ? INK : BORDER, color: canGenerate ? '#fff' : '#AEAEB2', fontSize: 14, fontWeight: 700,
                cursor: canGenerate ? 'pointer' : 'not-allowed', fontFamily: FONT,
              }}>
                {visioFile ? 'Generate BP Workbook' : 'Upload an Econ Map to continue'}
              </button>
            </div>

            <div style={{ flex: 1 }}>
              <h3 style={{ fontSize: 12, fontWeight: 600, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px' }}>
                Recent Workbooks
              </h3>
              {loadingSessions ? (
                <p style={{ fontSize: 12.5, color: MUTED }}>Loading…</p>
              ) : recentSessions.length === 0 ? (
                <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, textAlign: 'center' }}>
                  <p style={{ fontSize: 12.5, color: MUTED, margin: 0 }}>No workbooks generated yet.</p>
                </div>
              ) : (
                <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden' }}>
                  {recentSessions.map((s, idx) => (
                    <div key={s.id} style={{
                      padding: '12px 18px', borderTop: idx > 0 ? '1px solid #F5F5F7' : 'none',
                      display: 'flex', alignItems: 'center', gap: 10,
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: 13, fontWeight: 600, color: TEXT, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {s.processId} — {s.fileName}
                        </p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                          <span style={{ fontSize: 10.5, color: MUTED }}>{new Date(s.createdAt).toLocaleDateString()}</span>
                          <span style={{ fontSize: 10.5, color: '#C7C7CC' }}>·</span>
                          <span style={{ fontSize: 10.5, fontWeight: 600, color: s.status === 'failed' ? '#DC2626' : '#16A34A' }}>
                            {s.status === 'failed' ? 'Failed' : 'Completed'}
                          </span>
                        </div>
                      </div>
                      {s.downloadUrl && (
                        <a href={s.downloadUrl} download style={{ fontSize: 12, fontWeight: 600, color: ACCENT, textDecoration: 'none', flexShrink: 0 }}>
                          Download
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
