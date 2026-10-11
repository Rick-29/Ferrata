import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { CdpClient } from '@coinbase/cdp-sdk';
import { FaucetRelay, type CdpFaucets } from './faucet.ts';

// Local relay to the Coinbase CDP testnet faucet (separate process with its own config, as the
// challenge requires for mocked/third-party services). Listens on 127.0.0.1 only and answers the
// extension only. Run:  npm start   (reads .env: CDP_API_KEY_ID, CDP_API_KEY_SECRET, FAUCET_PORT)

const PORT = Number(process.env['FAUCET_PORT'] ?? 8788);
const keyId = process.env['CDP_API_KEY_ID'];
const keySecret = process.env['CDP_API_KEY_SECRET'];

function cdpFaucets(): CdpFaucets | null {
  if (!keyId || !keySecret) return null;
  const cdp = new CdpClient({ apiKeyId: keyId, apiKeySecret: keySecret });
  return {
    evm: (address) => cdp.evm.requestFaucet({ address, network: 'base-sepolia', token: 'eth' }),
    solana: (address) => cdp.solana.requestFaucet({ address, token: 'sol' }),
  };
}

const relay = new FaucetRelay(cdpFaucets());

/** Only our extension (chrome-extension://…) or a local tool without Origin (curl); never a web page. */
function allowedOrigin(req: IncomingMessage): string | null | false {
  const origin = req.headers.origin;
  if (origin === undefined) return null;
  return origin.startsWith('chrome-extension://') ? origin : false;
}

function send(res: ServerResponse, status: number, body: unknown, origin: string | null): void {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (origin !== null) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  res.writeHead(status, headers).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) {
    raw += String(chunk);
    if (raw.length > 4_096) throw new Error('body too large');
  }
  return JSON.parse(raw);
}

createServer(async (req, res) => {
  const origin = allowedOrigin(req);
  if (origin === false) return send(res, 403, { code: 'FORBIDDEN', message: 'Extension only.' }, null);

  if (req.method === 'OPTIONS') {
    res
      .writeHead(204, {
        'Access-Control-Allow-Origin': origin ?? '*',
        'Access-Control-Allow-Methods': 'POST, GET',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      .end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, configured: Boolean(keyId && keySecret) }, origin);
  }
  if (req.method !== 'POST' || req.url !== '/faucet') return send(res, 404, { code: 'NOT_FOUND' }, origin);

  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { code: 'BAD_REQUEST', message: 'Invalid JSON.' }, origin);
  }
  const result = await relay.claim(body);
  if (result.ok) {
    console.log(`[faucet] ${result.grant.network} -> ${result.grant.txId}`);
    return send(res, 200, result.grant, origin);
  }
  console.warn(`[faucet] refused: ${result.error.code} ${result.error.message}`);
  return send(res, result.error.status, { code: result.error.code, message: result.error.message }, origin);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Faucet relay on http://127.0.0.1:${PORT} (CDP key ${keyId && keySecret ? 'loaded' : 'MISSING: fill .env'})`);
});
