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
