import { defineManifest } from '@crxjs/vite-plugin';
import { APP_NAME } from '../../brand/src/index.ts';

export default defineManifest({
  manifest_version: 3,
  name: APP_NAME,
  version: '0.1.0',
  action: { default_popup: 'src/popup/index.html' },
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  permissions: ['storage'],
  host_permissions: ['http://localhost:8787/*'],
  content_security_policy: {
    // WASM core (P1) runs in the extension pages and the service worker.
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
});
