/**
 * API client utility for making authenticated requests to the backend
 */

const API_ENDPOINT = import.meta.env.VITE_API_ENDPOINT;

async function getAuthToken(): Promise<string> {
  const { fetchAuthSession } = await import('aws-amplify/auth');
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) {
    throw new Error('No auth token available');
  }
  return token;
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

// Generic API functions
export const api = {
  async get(path: string) {
    const token = await getAuthToken();
    const response = await fetch(`${API_ENDPOINT}${path}`, {
      method: 'GET',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
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

// Specific API functions (for backward compatibility with existing components)
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

export async function analyzeDoc(docId: string, focus: string = 'all'): Promise<AnalyzeResponse> {
  return api.post('/analyze', { doc_id: docId, focus });
}

export async function deleteDoc(docId: string): Promise<void> {
  await api.post('/documents/delete', { doc_id: docId });
}

export async function publishDoc(docId: string, published: boolean): Promise<void> {
  await api.post('/documents/publish', { doc_id: docId, published });
}
