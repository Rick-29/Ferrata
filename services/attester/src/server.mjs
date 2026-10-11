// SIMULATED Swissquote recovery service: a separate process with its own key (.env) and storage
// (data/recoveries.json). It attests that the identity check passed and sets the timelock, then
// relays the on-chain calls. It cannot recover anything alone: FerraRecovery also requires the
// recovery phone's signature. The identity check itself is simulated (`kyc: "pass" | "fail"`).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { getAddress, isAddress, isHex } from 'viem';
import { account, artifact, publicClient, walletClient } from './chain.mjs';
import { required } from './env.mjs';

const CONTRACT = getAddress(required('RECOVERY_CONTRACT'));
const PORT = Number(process.env.ATTESTER_PORT || 8790);
const MAX_BODY = 16 * 1024;
const store = new URL('../data/recoveries.json', import.meta.url);
const contract = { address: CONTRACT, abi: artifact.abi };

const load = () => (existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : []);
function record(entry) {
  mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
  writeFileSync(store, JSON.stringify([...load(), { ...entry, at: new Date().toISOString() }], null, 2));
}

const isBytes32 = (v) => isHex(v) && v.length === 66;
const isSig = (v) => isHex(v) && v.length === 132;

async function start(body) {
  const { account: wallet, x, y, oldIndex, phoneSig, kyc, delaySecs } = body;
  if (!isAddress(wallet) || !isBytes32(x) || !isBytes32(y) || !Number.isInteger(oldIndex) || oldIndex < 0 || !isSig(phoneSig)) {
    return [400, { error: 'BAD_REQUEST' }];
  }
  // SIMULATED identity check: in production, the video identification and the KYC provider.
  if (kyc !== 'pass') {
    record({ kind: 'refused', account: wallet, reason: 'identity check failed (simulated)' });
    return [403, { error: 'KYC_FAILED' }];
  }
  const minDelay = await publicClient.readContract({ ...contract, functionName: 'minDelay' });
  const delay = BigInt(Math.max(Number(minDelay), Number.isInteger(delaySecs) ? delaySecs : 0));
  const nonce = await publicClient.readContract({ ...contract, functionName: 'nonceOf', args: [wallet] });
  const digest = await publicClient.readContract({ ...contract, functionName: 'attesterDigest', args: [wallet, x, y, BigInt(oldIndex), nonce, delay] });
  const attesterSig = await account.signMessage({ message: { raw: digest } });
  const args = [wallet, x, y, BigInt(oldIndex), delay, phoneSig, attesterSig];
  // Simulate first: a bad phone signature or a pending recovery fails here, with no gas spent.
  await publicClient.simulateContract({ ...contract, functionName: 'start', args, account });
  const hash = await walletClient.writeContract({ ...contract, functionName: 'start', args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') return [502, { error: 'START_REVERTED', hash }];
  const pending = await publicClient.readContract({ ...contract, functionName: 'pendingOf', args: [wallet] });
  record({ kind: 'started', account: wallet, hash, delay: Number(delay) });
  return [200, { hash, unlockAt: Number(pending[3]), contested: pending[4], delaySecs: Number(delay) }];
}

async function execute(body) {
  if (!isAddress(body.account)) return [400, { error: 'BAD_REQUEST' }];
  await publicClient.simulateContract({ ...contract, functionName: 'execute', args: [body.account], account });
  const hash = await walletClient.writeContract({ ...contract, functionName: 'execute', args: [body.account] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') return [502, { error: 'EXECUTE_REVERTED', hash }];
  record({ kind: 'executed', account: body.account, hash });
  return [200, { hash }];
}

async function status(wallet) {
  if (!isAddress(wallet)) return [400, { error: 'BAD_REQUEST' }];
  const [phone, pending, nonce] = await Promise.all([
    publicClient.readContract({ ...contract, functionName: 'phoneOf', args: [wallet] }),
    publicClient.readContract({ ...contract, functionName: 'pendingOf', args: [wallet] }),
    publicClient.readContract({ ...contract, functionName: 'nonceOf', args: [wallet] }),
  ]);
  return [200, { phone, nonce: Number(nonce), pending: pending[3] === 0n ? null : { x: pending[0], y: pending[1], oldIndex: Number(pending[2]), unlockAt: Number(pending[3]), contested: pending[4] } }];
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) reject(new Error('BODY_TOO_LARGE'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}));
    req.on('error', reject);
  });
}

createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  const url = new URL(req.url, 'http://local');
  try {
    let result;
    if (req.method === 'GET' && url.pathname === '/info') {
      result = [200, { attester: account.address, contract: CONTRACT, chainId: 84532, simulated: true }];
    } else if (req.method === 'GET' && url.pathname.startsWith('/recovery/')) {
      result = await status(url.pathname.slice('/recovery/'.length));
    } else if (req.method === 'POST' && url.pathname === '/recovery/start') {
      result = await start(await readBody(req));
    } else if (req.method === 'POST' && url.pathname === '/recovery/execute') {
      result = await execute(await readBody(req));
    } else {
      result = [404, { error: 'NOT_FOUND' }];
    }
    res.writeHead(result[0], { 'content-type': 'application/json' }).end(JSON.stringify(result[1]));
  } catch (error) {
    // The revert reason (BadPhoneSignature, Timelocked…) is what the client needs to see.
    const message = error?.shortMessage ?? error?.message ?? 'failed';
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'CHAIN_ERROR', message }));
  }
}).listen(PORT, () => console.log(`SIMULATED Swissquote attester on :${PORT} · ${account.address} · FerraRecovery ${CONTRACT}`));
