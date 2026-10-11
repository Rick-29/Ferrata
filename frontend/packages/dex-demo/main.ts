// Test dApp for the Swissquote Wallet provider. Discovers wallets the modern way (EIP-6963), then
// drives the selected one through EIP-1193. Serve with:  npx vite frontend/packages/dex-demo --port 5175 (5174 is the Ferrata website)

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

interface ProviderDetail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193Provider;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} missing`);
  return el as T;
};

const wallets = new Map<string, ProviderDetail>();
let selected: ProviderDetail | null = null;
let account: string | null = null;

function log(line: string, kind: 'ok' | 'bad' | '' = ''): void {
  const span = document.createElement('div');
  span.textContent = `${new Date().toLocaleTimeString()}  ${line}`;
  if (kind !== '') span.className = kind;
  $('log').prepend(span);
}

function renderWallets(): void {
  const list = $('wallets');
  list.replaceChildren();
  if (wallets.size === 0) {
    list.innerHTML = '<li>Aucun wallet détecté. Swissquote Wallet est-il chargé et rechargé dans Chrome ?</li>';
    return;
  }
  for (const detail of wallets.values()) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = detail.info.icon;
    img.alt = '';
    const name = document.createElement('span');
    name.textContent = `${detail.info.name} (${detail.info.rdns})`;
    const pick = document.createElement('button');
    pick.textContent = selected?.info.uuid === detail.info.uuid ? 'Sélectionné' : 'Choisir';
    pick.onclick = () => select(detail);
    li.append(img, name, pick);
    list.append(li);
  }
}

function select(detail: ProviderDetail): void {
  selected = detail;
  for (const id of ['connect', 'chain', 'switch-mainnet']) $<HTMLButtonElement>(id).disabled = false;
  log(`Wallet choisi : ${detail.info.name}`);
  renderWallets();
}

async function call(method: string, params: unknown[] = []): Promise<unknown> {
  if (selected === null) throw new Error('Aucun wallet sélectionné');
  try {
    const result = await selected.provider.request({ method, params });
    log(`${method} → ${JSON.stringify(result)}`, 'ok');
    return result;
  } catch (e) {
    const { code, message } = e as { code?: number; message?: string };
    log(`${method} ✗ [${code ?? '?'}] ${message ?? String(e)}`, 'bad');
    throw e;
  }
}

window.addEventListener('eip6963:announceProvider', (event) => {
  const detail = (event as CustomEvent<ProviderDetail>).detail;
  wallets.set(detail.info.uuid, detail);
  renderWallets();
  if (selected === null && detail.info.rdns === 'com.swissquote.wallet') select(detail);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
setTimeout(renderWallets, 1500);

$('connect').onclick = async () => {
  const accounts = await call('eth_requestAccounts').catch(() => null);
  if (Array.isArray(accounts) && typeof accounts[0] === 'string') {
    account = accounts[0];
    $<HTMLButtonElement>('balance').disabled = false;
    $<HTMLButtonElement>('send').disabled = false;
  }
};
$('chain').onclick = () => void call('eth_chainId').catch(() => undefined);
$('balance').onclick = async () => {
  const wei = await call('eth_getBalance', [account, 'latest']).catch(() => null);
  if (typeof wei === 'string') log(`Solde : ${Number(BigInt(wei)) / 1e18} ETH (Base Sepolia)`);
};
$('switch-mainnet').onclick = () => void call('wallet_switchEthereumChain', [{ chainId: '0x1' }]).catch(() => undefined);
$('send').onclick = () =>
  void call('eth_sendTransaction', [{ from: account, to: account, value: '0x0' }]).catch(() => undefined);
