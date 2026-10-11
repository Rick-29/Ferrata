// Compiles FerraRecovery.sol with the official solc-js (pinned to the pragma) into FerraRecovery.json.
import { readFileSync, writeFileSync } from 'node:fs';
import solc from 'solc';

const source = readFileSync(new URL('./FerraRecovery.sol', import.meta.url), 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'FerraRecovery.sol': { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const problems = (output.errors ?? []).filter((e) => e.severity === 'error' || e.severity === 'warning');
for (const p of problems) console.error(p.formattedMessage);
if (problems.some((p) => p.severity === 'error')) process.exit(1);
const { abi, evm } = output.contracts['FerraRecovery.sol'].FerraRecovery;
writeFileSync(new URL('./FerraRecovery.json', import.meta.url), JSON.stringify({ abi, bytecode: `0x${evm.bytecode.object}` }, null, 2) + '\n');
console.log(`FerraRecovery compiled: ${evm.bytecode.object.length / 2} bytes, ${problems.length} warnings`);
