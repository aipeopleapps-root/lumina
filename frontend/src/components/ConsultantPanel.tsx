import { useState } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { ingestDoc, analyzeDoc, type Finding, type AnalyzeResponse } from '../lib/api';

type Props = { role: string; tenantId: string };

const DOC_TYPES = [
  { value: 'config-workbook', label: 'Configuration workbook' },
  { value: 'bp-workbook', label: 'Business process workbook' },
  { value: 'integration', label: 'Integration document' },
];

const MODULES = ['HCM', 'Absence', 'Payroll', 'Benefits', 'Recruiting', 'Security'];

export default function ConsultantPanel({ role, tenantId }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState('config-workbook');
  const [module, setModule] = useState('Absence');
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canIngest = role === 'consultant' || role === 'admin';

  async function onRun() {
    if (!file) return;
    setError(null);
    setResult(null);

    try {
      setUploading(true);
      setStatus('Requesting upload URL…');
      const uploadUrl = await getPresignedUrl(file.name, tenantId);
      setStatus('Uploading file…');
      const putResp = await fetch(uploadUrl.url, {
        method: 'PUT',
        headers: { 'Content-Type': uploadUrl.content_type },
        body: file,
      });
      if (!putResp.ok) throw new Error(`S3 upload failed: ${putResp.status}`);

      setUploading(false);
      setStatus('Indexing document…');
      const docId = crypto.randomUUID();
      await ingestDoc({
        s3_key: uploadUrl.key,
        doc_id: docId,
        doc_type: docType,
        source_name: file.name,
        module,
      });

      setStatus('Running analysis…');
      setAnalyzing(true);
      const out = await analyzeDoc(docId, 'all');
      setResult(out);
      setStatus(null);
    } catch (err: any) {
      setError(err.message || String(err));
      setStatus(null);
    } finally {
      setUploading(false);
      setAnalyzing(false);
    }
  }

  if (!canIngest) {
    return (
      <div className="text-sm text-slate-500 bg-slate-100 p-4 rounded border border-slate-200">
        Your role ({role}) does not have access to consultant insights.
        Sign in as a consultant or admin user to upload and analyze
        workbooks.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Document type</label>
            <select
              value={docType}
              onChange={(e) => setDocType(e.target.value)}
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm"
            >
              {DOC_TYPES.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Module</label>
            <select
              value={module}
              onChange={(e) => setModule(e.target.value)}
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm"
            >
              {MODULES.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
        </div>
        <input
          type="file"
          accept=".xlsx,.xlsm,.pdf,.docx"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-slate-600 mb-3"
        />
        <button
          onClick={onRun}
          disabled={!file || uploading || analyzing}
          className="px-4 py-2 bg-slate-900 text-white rounded text-sm hover:bg-slate-800 disabled:opacity-50"
        >
          {uploading ? 'Uploading…' : analyzing ? 'Analyzing…' : 'Upload & analyze'}
        </button>
        {status && <p className="text-xs text-slate-500 mt-2">{status}</p>}
        {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      </div>

      {result && (
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h3 className="font-semibold text-sm mb-2">Summary</h3>
          <p className="text-sm text-slate-700 mb-4">{result.summary}</p>

          <h3 className="font-semibold text-sm mb-2">
            Findings ({result.findings.length})
          </h3>
          <ul className="space-y-3">
            {result.findings.map((f, i) => (
              <FindingCard key={i} f={f} />
            ))}
          </ul>

          <p className="text-xs text-slate-400 mt-4">
            Model: {result.model_id}
          </p>
        </div>
      )}
    </div>
  );
}

function FindingCard({ f }: { f: Finding }) {
  const sevClass =
    f.severity === 'high'
      ? 'bg-red-100 text-red-800'
      : f.severity === 'medium'
      ? 'bg-amber-100 text-amber-800'
      : 'bg-slate-100 text-slate-700';
  const catClass =
    f.category === 'risk'
      ? 'bg-red-50 text-red-700 border-red-200'
      : f.category === 'anti-pattern'
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-teal-50 text-teal-700 border-teal-200';
  return (
    <li className="border border-slate-200 rounded-md p-3">
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className={`text-xs px-2 py-0.5 rounded-full ${sevClass}`}>
          {f.severity}
        </span>
        <span className={`text-xs px-2 py-0.5 rounded-full border ${catClass}`}>
          {f.category}
        </span>
        <span className="text-sm font-medium">{f.title}</span>
      </div>
      <p className="text-sm text-slate-700 mb-2">{f.detail}</p>
      {f.evidence && f.evidence.length > 0 && (
        <div className="bg-slate-50 border-l-2 border-slate-300 pl-3 py-1 mb-2">
          {f.evidence.map((e: string, i: number) => (
            <p key={i} className="text-xs text-slate-600 font-mono whitespace-pre-wrap">
              {e}
            </p>
          ))}
        </div>
      )}
      <p className="text-sm text-slate-800">
        <span className="font-medium">Recommendation: </span>
        {f.recommendation}
      </p>
    </li>
  );
}

async function getPresignedUrl(
  filename: string,
  tenantId: string
): Promise<{ url: string; key: string; content_type: string }> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  const api = import.meta.env.VITE_API_ENDPOINT;
  const r = await fetch(`${api}/upload-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ filename }),
  });
  if (!r.ok) {
    throw new Error(`Upload URL request failed: ${r.status}`);
  }
  return r.json();
}
