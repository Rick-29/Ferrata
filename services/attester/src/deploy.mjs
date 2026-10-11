// Deploys FerraRecovery with this attester as Swissquote's key and writes RECOVERY_CONTRACT to .env.
import { appendFileSync } from 'node:fs';
import { account, artifact, publicClient, walletClient } from './chain.mjs';

const minDelay = BigInt(process.env.MIN_DELAY_SECS || '60');
const hash = await walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [account.address, minDelay] });
console.log(`deploy tx: https://sepolia.basescan.org/tx/${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('deployment failed');
appendFileSync(new URL('../.env', import.meta.url), `RECOVERY_CONTRACT=${receipt.contractAddress}\n`);
console.log(`FerraRecovery: ${receipt.contractAddress} (attester ${account.address}, min delay ${minDelay}s)`);
