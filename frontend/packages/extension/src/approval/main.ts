import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/space-grotesk/latin-500.css';
import '@fontsource/space-grotesk/latin-600.css';
import { APP_NAME } from '@sqw/brand';
import '../passkey/host';
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { SIGNIN_PARAM } from '../signin/protocol';
import { AppShell } from '../ui/core/AppShell';
import { Router } from '../ui/core/Router';
import '../ui/screens/onboarding/OnboardingScreen';
import { RuntimeBridge } from '../ui/services/RuntimeBridge';
import { SignInBanner } from './SignInWindow';

// Approval window, opened by the background. Today: website sign-in (?signin=<id>), which reuses
// the extension's login + passkey screens. Transaction approvals for dApps come next.

// Placeholder for dApp transaction approvals (next step).
@customElement('sq-approval-app')
export class ApprovalApp extends LitElement {
  override render() {
    return html`<h1>Approbation</h1>`;
  }
}

const signInId = new URLSearchParams(location.search).get(SIGNIN_PARAM);

if (signInId !== null) {
  document.querySelector('sq-approval-app')?.remove();
  const banner = new SignInBanner();
  banner.requestId = signInId;
  // Always start on onboarding: it asks for the passkey (create, or unlock if already on this device),
  // so every website sign-in carries a fresh, server-verified proof.
  const router = new Router(
    {
      onboarding: () => html`<sq-onboarding-screen></sq-onboarding-screen>`,
      home: () => html`<sq-signin-done .requestId=${signInId}></sq-signin-done>`,
    },
    'onboarding',
  );
  document.body.append(banner, new AppShell(new RuntimeBridge(), router));
}

document.title = APP_NAME;
