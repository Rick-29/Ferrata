import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Swissquote Wallet',
  version: '0.1.0',
  action: { default_popup: 'src/popup/index.html' },
  permissions: ['storage'],
  host_permissions: ['http://localhost:8787/*'],
  content_security_policy: {
    // WASM core (P1) runs in the extension pages and the service worker.
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
});
