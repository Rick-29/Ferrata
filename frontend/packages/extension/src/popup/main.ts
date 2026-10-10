import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/space-grotesk/latin-500.css';
import '@fontsource/space-grotesk/latin-600.css';
import { APP_NAME } from '@sqw/brand';
import { html } from 'lit';
import { AppShell } from '../ui/core/AppShell';
import { Router } from '../ui/core/Router';
import '../ui/screens/activity/ActivityScreen';
import '../ui/screens/confirm/ConfirmScreen';
import '../ui/screens/home/HomeScreen';
import '../ui/screens/onboarding/OnboardingScreen';
import '../ui/screens/send/SendScreen';
import '../ui/screens/settings/SettingsScreen';
import { FakeBridge } from '../ui/services/FakeBridge';
import { RuntimeBridge } from '../ui/services/RuntimeBridge';
import type { UiBridge } from '../ui/services/UiBridge';

// Composition root of the popup. VITE_BRIDGE=fake runs fully offline on the demo world
// (no backend needed); anything else uses the background worker against the real backend.
const bridge: UiBridge = import.meta.env.VITE_BRIDGE === 'fake' ? new FakeBridge() : new RuntimeBridge();

// The background keeps the session between popup openings: go straight Home when it is still valid.
const resumed = await bridge.getWallet();
const router = new Router(
  {
    onboarding: () => html`<sq-onboarding-screen></sq-onboarding-screen>`,
    home: () => html`<sq-home-screen></sq-home-screen>`,
    send: () => html`<sq-send-screen></sq-send-screen>`,
    confirm: ({ preview, asset }) => html`<sq-confirm-screen .preview=${preview} .asset=${asset}></sq-confirm-screen>`,
    activity: () => html`<sq-activity-screen></sq-activity-screen>`,
    settings: () => html`<sq-settings-screen></sq-settings-screen>`,
  },
  resumed.ok ? 'home' : 'onboarding',
);

document.body.append(new AppShell(bridge, router));

document.title = APP_NAME;
