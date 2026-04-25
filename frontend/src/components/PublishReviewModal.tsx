import { useState, useEffect } from 'react';
import { api, analyzeDoc, type DeliveryFinding } from '../lib/api';

interface Document {
  doc_id: string;
  source_name: string;
  s3_key: string;
}

interface Props {
  doc: Document;
  onConfirmPublish: () => void;
  onCancel: () => void;
}

const TRAFFIC_CONFIG = {
  red: {
    label: 'Must Fix Before Release',
    icon: '🔴',
    headerClass: 'bg-red-50 border-red-200 text-red-900',
    badgeClass: 'bg-red-100 text-red-700',
    borderClass: 'border-red-200',
    countClass: 'text-red-600',
  },
  yellow: {
    label: 'Review Before Release',
    icon: '🟡',
    headerClass: 'bg-amber-50 border-amber-200 text-amber-900',
    badgeClass: 'bg-amber-100 text-amber-700',
    borderClass: 'border-amber-200',
    countClass: 'text-amber-600',
  },
  green: {
    label: 'Looks Good',
    icon: '🟢',
    headerClass: 'bg-green-50 border-green-200 text-green-900',
    badgeClass: 'bg-green-100 text-green-700',
    borderClass: 'border-green-200',
    countClass: 'text-green-600',
  },
};

function FindingCard({ finding }: { finding: DeliveryFinding }) {
  const [open, setOpen] = useState(finding.traffic_light === 'red');
  const cfg = TRAFFIC_CONFIG[finding.traffic_light];

  return (
    <div className={`border rounded-lg overflow-hidden ${cfg.borderClass}`}>
      <button
        onClick={() => setOpen(v => !v)}
        className={`w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-black/[0.02] transition-colors`}
      >
        <span className="text-base flex-shrink-0">{cfg.icon}</span>
        <span className="text-sm font-medium text-slate-800 flex-1">{finding.title}</span>
        <span className="text-slate-400 text-xs">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-inherit">
          <p className="text-sm text-slate-700 leading-relaxed pt-3">{finding.detail}</p>
          {finding.evidence && finding.evidence.length > 0 && (
            <div className="bg-slate-50 border-l-2 border-slate-300 rounded-r pl-3 py-2">
              {finding.evidence.map((e, i) => (
                <p key={i} className="text-xs text-slate-600 font-mono italic">"{e}"</p>
              ))}
            </div>
          )}
          {finding.recommendation && (
            <div className={`rounded-lg px-3 py-2 ${cfg.badgeClass}`}>
              <p className="text-xs font-semibold mb-0.5">Action required</p>
              <p className="text-xs leading-relaxed">{finding.recommendation}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function PublishReviewModal({ doc, onConfirmPublish, onCancel }: Props) {
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<string | null>(null);
  const [findings, setFindings] = useState<DeliveryFinding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    analyzeDoc(doc.doc_id, 'all', 'delivery_review')
      .then(result => {
        setSummary(result.summary);
        setFindings((result as any).findings || []);
      })
      .catch(err => setError(err.message || 'Review failed'))
      .finally(() => setLoading(false));
  }, [doc.doc_id]);

  async function handleDownload() {
    try {
      const r = await api.post('/documents/download-url', { s3_key: doc.s3_key });
      window.open(r.url, '_blank');
    } catch {
      alert('Failed to download document');
    }
  }

  async function handlePublish() {
    setPublishing(true);
    onConfirmPublish();
  }

  const redFindings    = findings.filter(f => f.traffic_light === 'red');
  const yellowFindings = findings.filter(f => f.traffic_light === 'yellow');
  const greenFindings  = findings.filter(f => f.traffic_light === 'green');
  const hasBlockers    = redFindings.length > 0;

  return (
    /* Backdrop */
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-200 flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Quality Review</h2>
            <p className="text-xs text-slate-500 mt-0.5 truncate max-w-sm">{doc.source_name}</p>
          </div>
          <button onClick={onCancel} className="text-slate-400 hover:text-slate-700 text-lg leading-none mt-0.5">✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <div className="w-10 h-10 border-2 border-slate-200 border-t-slate-700 rounded-full animate-spin" />
              <div className="text-center">
                <p className="text-sm font-medium text-slate-700">Reviewing before release…</p>
                <p className="text-xs text-slate-400 mt-1">Acting as delivery manager — checking for issues</p>
              </div>
            </div>
          ) : error ? (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-sm font-medium text-red-800 mb-1">Review failed</p>
              <p className="text-xs text-red-600">{error}</p>
            </div>
          ) : (
            <>
              {/* Summary */}
              {summary && (
                <div className="bg-slate-50 rounded-xl p-4">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Delivery Manager Summary</p>
                  <p className="text-sm text-slate-700 leading-relaxed">{summary}</p>
                </div>
              )}

              {/* Score strip */}
              <div className="grid grid-cols-3 gap-3">
                {(['red', 'yellow', 'green'] as const).map(tl => {
                  const count = findings.filter(f => f.traffic_light === tl).length;
                  const cfg = TRAFFIC_CONFIG[tl];
                  return (
                    <div key={tl} className={`border rounded-xl px-4 py-3 text-center ${cfg.headerClass}`}>
                      <div className="text-2xl font-bold">{count}</div>
                      <div className="text-xs mt-0.5 font-medium">{cfg.label}</div>
                    </div>
                  );
                })}
              </div>

              {/* Red findings */}
              {redFindings.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                    🔴 Must Fix Before Release
                    <span className="bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full">{redFindings.length}</span>
                  </p>
                  <div className="space-y-2">
                    {redFindings.map((f, i) => <FindingCard key={i} finding={f} />)}
                  </div>
                </div>
              )}

              {/* Yellow findings */}
              {yellowFindings.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                    🟡 Review Before Release
                    <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">{yellowFindings.length}</span>
                  </p>
                  <div className="space-y-2">
                    {yellowFindings.map((f, i) => <FindingCard key={i} finding={f} />)}
                  </div>
                </div>
              )}

              {/* Green findings */}
              {greenFindings.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                    🟢 Looks Good
                    <span className="bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full">{greenFindings.length}</span>
                  </p>
                  <div className="space-y-2">
                    {greenFindings.map((f, i) => <FindingCard key={i} finding={f} />)}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer actions */}
        {!loading && (
          <div className={`px-6 py-4 border-t flex items-center gap-3 ${hasBlockers ? 'bg-red-50 border-red-200' : 'border-slate-200'}`}>
            {hasBlockers && (
              <p className="text-xs text-red-700 flex-1">
                <span className="font-semibold">{redFindings.length} blocker{redFindings.length !== 1 ? 's' : ''}</span> — fix before releasing to client
              </p>
            )}
            {!hasBlockers && <div className="flex-1" />}

            <button
              onClick={handleDownload}
              className="px-4 py-2 text-sm border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors"
            >
              Download
            </button>
            <button
              onClick={onCancel}
              className="px-4 py-2 text-sm border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handlePublish}
              disabled={publishing}
              className={`px-4 py-2 text-sm rounded-lg font-medium transition-colors disabled:opacity-50 ${
                hasBlockers
                  ? 'bg-slate-700 text-white hover:bg-slate-900'
                  : 'bg-green-600 text-white hover:bg-green-700'
              }`}
            >
              {publishing ? 'Publishing…' : hasBlockers ? 'Publish Anyway' : 'Publish to Client'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
