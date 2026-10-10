import { defineManifest } from '@crxjs/vite-plugin';
import { APP_NAME } from '../../brand/src/index.ts';

const DAPP_MATCHES = ['http://localhost/*', 'https://app.uniswap.org/*', 'https://app.aave.com/*'];

export default defineManifest({
  manifest_version: 3,
  name: APP_NAME,
  version: '0.1.0',
  action: { default_popup: 'src/popup/index.html' },
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  permissions: ['storage'],
  // Base Sepolia RPC: read calls dApps make through the injected provider (src/background/dapp).
  // Solana devnet RPC: test-network balance and faucet airdrops (src/background/testnet).
  host_permissions: ['http://localhost:8787/*', 'https://sepolia.base.org/*', 'https://api.devnet.solana.com/*'],
  // dApp provider (P3): inpage runs in the page's world to expose EIP-1193 / EIP-6963, content relays
  // to the background. Limited to the demo dApps instead of <all_urls>, so other sites cannot see the wallet.
  content_scripts: [
    {
      matches: DAPP_MATCHES,
      js: ['src/inpage/index.ts'],
      run_at: 'document_start',
      world: 'MAIN',
    },
    {
      matches: DAPP_MATCHES,
      js: ['src/content/index.ts'],
      run_at: 'document_start',
    },
  ],
  content_security_policy: {
    // WASM core (P1) runs in the extension pages and the service worker.
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
});
