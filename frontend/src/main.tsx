import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { BrowserRouter } from 'react-router-dom';
import { EventType, type EventMessage, type AuthenticationResult } from '@azure/msal-browser';
import { MsalProvider } from '@azure/msal-react';
import { msalInstance } from './lib/msal';
import App from './App';
import StueyStandalone from './components/StueyStandalone';

// Keep MSAL's "active account" pointed at whoever most recently signed in —
// needed for getAccessToken() (lib/msal.ts, used outside React components) to
// know which account to acquire a token for.
msalInstance.addEventCallback((event: EventMessage) => {
  if (
    (event.eventType === EventType.LOGIN_SUCCESS || event.eventType === EventType.ACQUIRE_TOKEN_SUCCESS) &&
    (event.payload as AuthenticationResult)?.account
  ) {
    msalInstance.setActiveAccount((event.payload as AuthenticationResult).account);
  }
});

async function bootstrap() {
  try {
    await msalInstance.initialize();
    await msalInstance.handleRedirectPromise(); // completes the loginRedirect() round trip, if any

    const existingAccounts = msalInstance.getAllAccounts();
    if (!msalInstance.getActiveAccount() && existingAccounts.length > 0) {
      msalInstance.setActiveAccount(existingAccounts[0]);
    }
  } catch (err) {
    // Without this, a failure anywhere above (a misconfigured redirect URI,
    // a CORS-blocked token exchange, a stale/mismatched auth state from a
    // previous attempt, ...) would leave `<div id="root">` permanently
    // empty — no error UI, no console-visible crash boundary, just a blank
    // page. Logging it here at least makes the real cause inspectable.
    console.error('MSAL initialization/redirect handling failed:', err);
  }

  // /stuey is a deliberate exception to the router below — a wholly separate, chrome-less
  // tree (own favicon/manifest injection, own auth check) that predates real routing and
  // doesn't need it; checked here, before BrowserRouter even mounts, same as always.
  const isStueyStandalone = window.location.pathname === '/stuey';

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <MsalProvider instance={msalInstance}>
        {isStueyStandalone ? <StueyStandalone /> : (
          <BrowserRouter>
            <App />
          </BrowserRouter>
        )}
      </MsalProvider>
    </React.StrictMode>
  );
}

bootstrap();
