// Creates the SIMULATED Swissquote attester key in .env (if none) and prints only its address.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import './env.mjs';

const file = new URL('../.env', import.meta.url);
if (!process.env.ATTESTER_PRIVATE_KEY) {
  if (!existsSync(file)) writeFileSync(file, readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));
  const body = readFileSync(file, 'utf8').replace(/^ATTESTER_PRIVATE_KEY=.*$/m, '');
  writeFileSync(file, body.trimEnd() + '\n');
  process.env.ATTESTER_PRIVATE_KEY = generatePrivateKey();
  appendFileSync(file, `ATTESTER_PRIVATE_KEY=${process.env.ATTESTER_PRIVATE_KEY}\n`);
}
console.log(`Attester address (fund it with ~0.006 Base Sepolia ETH): ${privateKeyToAccount(process.env.ATTESTER_PRIVATE_KEY).address}`);
