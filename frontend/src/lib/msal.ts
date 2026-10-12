/**
 * MSAL setup — replaces aws-amplify/auth's Cognito wiring.
 *
 * Single exported `msalInstance` is used two ways: wrapped in `<MsalProvider>`
 * in main.tsx for the React component tree (useMsal()/useIsAuthenticated()),
 * and imported directly here by api.ts's getAuthToken(), which isn't a
 * component and can't use hooks.
 *
 * Entra handles the entire sign-in experience (password, MFA challenge,
 * forced password reset) on its own hosted pages — none of that is app code
 * anymore, unlike the Cognito version's hand-rolled TOTP/new-password step
 * machine in App.tsx. loginRedirect() sends the user to Entra; Entra redirects
 * back with a token once everything (including any Conditional Access MFA
 * policy) is satisfied.
 */

import { PublicClientApplication, InteractionRequiredAuthError, type AccountInfo } from '@azure/msal-browser';

const clientId = import.meta.env.VITE_AZURE_CLIENT_ID;
const tenantId = import.meta.env.VITE_AZURE_TENANT_ID;
const apiScope = import.meta.env.VITE_AZURE_API_SCOPE; // e.g. api://<client-id>/access_as_user

export const msalInstance = new PublicClientApplication({
  auth: {
    clientId,
    authority: `https://login.microsoftonline.com/${tenantId}`,
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: 'localStorage', // survives the full-page redirect round trip
  },
});

export const loginRequest = { scopes: [apiScope] };

export interface UserClaims {
  email: string;
  tenantId: string;
  role: string;
  firstName: string;
  lastName: string;
}

// Directory-extension optional claims (tenant_id/role) show up on the token under
// a short `extn.<name>` form, NOT the `extension_<appId-no-dashes>_<name>` name
// Graph uses for the underlying user attribute (that longer name is what
// functions/common/graph.py and bicep/scripts/register-entra-app.sh use when
// reading/writing the attribute VALUE via Graph API calls — a different context
// from what Entra names the claim on an issued token). Confirmed by decoding a
// real token, not from documentation — see docs/AZURE_MIGRATION.md Log. Values
// also come back as single-element arrays (extensionProperty is schema-capable
// of being multi-valued), not plain strings, even though only one value is ever
// set.
function firstOf(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

export function claimsFromAccount(account: AccountInfo): UserClaims {
  const claims = (account.idTokenClaims ?? {}) as Record<string, unknown>;
  return {
    email: (claims.email as string) ?? account.username ?? '',
    tenantId: firstOf(claims['extn.tenant_id']) ?? '(none)',
    role: firstOf(claims['extn.role']) ?? '',
    firstName: (claims.given_name as string) ?? '',
    lastName: (claims.family_name as string) ?? '',
  };
}

/**
 * Access token for API calls — tries silent acquisition first (works across
 * page loads as long as the account/session is still valid), falls back to
 * an interactive redirect only when Entra actually requires it (expired
 * session, step-up auth, etc). Mirrors the old getAuthToken()'s job in
 * api.ts, but callers now get an access token scoped to the API
 * (VITE_AZURE_API_SCOPE), not an ID token — APIM's validate-jwt policy
 * (bicep/modules/apim.bicep) validates the access token.
 */
export async function getAccessToken(): Promise<string> {
  // TEMPORARY local-only test shim — bypasses MSAL entirely when set, so the RFP Reimagine
  // local-backend test (see docs/AZURE_MIGRATION.md session 13 log) can drive the real
  // component/api.ts code without a live interactive sign-in. Must be reverted before commit.
  if (import.meta.env.VITE_LOCAL_DEV_TOKEN) return import.meta.env.VITE_LOCAL_DEV_TOKEN as string;
  const account = msalInstance.getActiveAccount();
  if (!account) {
    throw new Error('No signed-in account — call loginRedirect first');
  }
  try {
    const result = await msalInstance.acquireTokenSilent({ ...loginRequest, account });
    return result.accessToken;
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      await msalInstance.acquireTokenRedirect(loginRequest);
      // acquireTokenRedirect navigates away; execution does not continue here.
      throw new Error('Redirecting for re-authentication…');
    }
    throw err;
  }
}
