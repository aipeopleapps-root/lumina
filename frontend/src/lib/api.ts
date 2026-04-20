import { fetchAuthSession } from 'aws-amplify/auth';

const API = import.meta.env.VITE_API_ENDPOINT;

async function authHeaders(): Promise<HeadersInit> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

export type IngestRequest = {
  s3_key: string;
  doc_id: string;
  doc_type: string;
  source_name: string;
  module?: string;
};

export async function ingestDoc(req: IngestRequest) {
  const r = await fetch(`${API}/ingest`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(req),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export type Finding = {
  category: 'risk' | 'anti-pattern' | 'best-practice';
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  evidence: string[];
  recommendation: string;
};

export type AnalyzeResponse = {
  doc_id: string;
  summary: string;
  findings: Finding[];
  model_id: string;
};

export async function analyzeDoc(doc_id: string, focus: string = 'all'): Promise<AnalyzeResponse> {
  const r = await fetch(`${API}/analyze`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ doc_id, focus }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export type Citation = {
  source_name: string;
  doc_type: string;
  module: string | null;
  chunk_index: number;
  excerpt: string;
  score: number;
};

export type ChatResponse = {
  answer: string;
  citations: Citation[];
  model_id: string;
  latency_ms: number;
};

export async function chat(
  message: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  module?: string
): Promise<ChatResponse> {
  const r = await fetch(`${API}/chat`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ message, history, module }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
