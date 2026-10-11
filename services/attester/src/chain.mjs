import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { required } from './env.mjs';

export const artifact = JSON.parse(readFileSync(new URL('../../../contracts/FerraRecovery.json', import.meta.url), 'utf8'));
export const account = privateKeyToAccount(required('ATTESTER_PRIVATE_KEY'));
const transport = http(process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org');
export const publicClient = createPublicClient({ chain: baseSepolia, transport });
export const walletClient = createWalletClient({ chain: baseSepolia, transport, account });
