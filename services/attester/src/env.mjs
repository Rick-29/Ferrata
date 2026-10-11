// Loads services/attester/.env (gitignored). The attester key lives only here, never in Git.
import { existsSync, readFileSync } from 'node:fs';

const file = new URL('../.env', import.meta.url);
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && match[2] !== '' && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

export function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (services/attester/.env)`);
  return value;
}
