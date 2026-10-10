import { html } from 'lit';
import { AppShell } from '../ui/core/AppShell';
import { Router } from '../ui/core/Router';
import '../ui/screens/confirm/ConfirmScreen';
import '../ui/screens/home/HomeScreen';
import '../ui/screens/onboarding/OnboardingScreen';
import '../ui/screens/send/SendScreen';
import { FakeBridge } from '../ui/services/FakeBridge';

// Composition root of the popup. Swap FakeBridge for the real bridge once P3's background exists.
const bridge = new FakeBridge();
const router = new Router(
  {
    onboarding: () => html`<sq-onboarding-screen></sq-onboarding-screen>`,
    home: () => html`<sq-home-screen></sq-home-screen>`,
    send: () => html`<sq-send-screen></sq-send-screen>`,
    confirm: ({ preview, asset }) => html`<sq-confirm-screen .preview=${preview} .asset=${asset}></sq-confirm-screen>`,
  },
  'onboarding',
);

document.body.append(new AppShell(bridge, router));
