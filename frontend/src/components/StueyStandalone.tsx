import { useEffect, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import { loginRequest } from '../lib/msal';
import AskStuey from './AskStuey';
import { LuminaLogo } from './LuminaLogo';

// Served at /stuey (see main.tsx's path check) — a bare, chat-only page with
// no Platform Home chrome around it, so Chrome's own "Create shortcut… →
// Open as window" (right-click the address bar, or the ⋮ menu → Cast, save,
// and share → Create shortcut) turns it into a clean, single-purpose Stuey
// app window instead of opening the whole platform. No manifest/PWA install
// prompt needed for that — it works on any URL already; this page just makes
// sure there's a URL worth shortcutting to.
export default function StueyStandalone() {
  const { instance, accounts } = useMsal();
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // index.html has no favicon/manifest of its own, and there's only one
    // index.html for the whole SPA — so both are injected here at runtime,
    // specifically for this route, rather than in the HTML.
    //
    // Confirmed live: the raw favicon alone (stuey-avatar.jpg — a 767×758,
    // non-square JPEG) wasn't enough. Chrome's "Create shortcut → Open as
    // window" icon pipeline wants a clean square PNG and falls back to a
    // generic letter tile when it doesn't get one, which is exactly what
    // showed up in the Dock. stuey-icon-192/512.png (cropped square, proper
    // PNG) fixes the favicon path; the manifest additionally gives Chrome a
    // real icon set to pull from if it treats this as an installable PWA
    // rather than a plain shortcut — covers both code paths.
    document.title = 'Ask Stuey';

    let icon = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!icon) {
      icon = document.createElement('link');
      icon.rel = 'icon';
      document.head.appendChild(icon);
    }
    icon.type = 'image/png';
    icon.href = '/stuey-icon-192.png';

    let manifest = document.querySelector<HTMLLinkElement>("link[rel='manifest']");
    if (!manifest) {
      manifest = document.createElement('link');
      manifest.rel = 'manifest';
      document.head.appendChild(manifest);
    }
    manifest.href = '/stuey-manifest.json';
  }, []);

  useEffect(() => {
    // Mirrors App.tsx's refreshMe() dev-token bypass — see that file for why
    // it exists (local backend testing without a live interactive sign-in).
    const devToken = import.meta.env.VITE_LOCAL_DEV_TOKEN as string | undefined;
    if (devToken && !instance.getActiveAccount() && !accounts[0]) {
      setSignedIn(true);
      setReady(true);
      return;
    }
    const account = instance.getActiveAccount() ?? accounts[0] ?? null;
    setSignedIn(!!account);
    setReady(true);
  }, [accounts.length]);

  async function onSignIn() {
    setSigningIn(true);
    setError(null);
    try {
      await instance.loginRedirect(loginRequest);
    } catch (err: any) {
      setError(err.message || String(err));
      setSigningIn(false);
    }
  }

  if (!ready) {
    return (
      <div style={{ minHeight: '100vh', background: '#0C0D0D', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 28, height: 28, border: '2px solid rgba(255,255,255,0.2)', borderTopColor: 'rgba(255,255,255,0.7)', borderRadius: '50%', animation: 'stuey-standalone-spin 0.8s linear infinite' }} />
        <style>{'@keyframes stuey-standalone-spin { to { transform: rotate(360deg); } }'}</style>
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div style={{
        minHeight: '100vh', background: '#0C0D0D', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 20, fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif',
      }}>
        <LuminaLogo size={40} />
        <div style={{ textAlign: 'center' }}>
          <h1 style={{ color: '#fff', fontSize: 20, fontWeight: 700, margin: 0 }}>Ask Stuey</h1>
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginTop: 6 }}>Sign in to keep chatting</p>
        </div>
        <button onClick={onSignIn} disabled={signingIn} style={{
          padding: '10px 20px', borderRadius: 999, border: 'none', background: '#16A34A', color: '#fff',
          fontSize: 14, fontWeight: 600, cursor: signingIn ? 'default' : 'pointer', opacity: signingIn ? 0.7 : 1,
        }}>
          {signingIn ? 'Redirecting…' : 'Sign in with Microsoft'}
        </button>
        {error && <p style={{ color: '#F87171', fontSize: 12, maxWidth: 320, textAlign: 'center' }}>{error}</p>}
      </div>
    );
  }

  return <AskStuey context="platform-home" open onOpenChange={() => {}} standalone />;
}
