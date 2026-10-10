# Swissquote Wallet — Middleware Spec

## Scope and rules

P3 owns the TypeScript glue between UI, Rust and the chain: the `@sqw/sdk` package, the extension's background worker and dApp provider, all on-chain integration, mock data, and the legal/business material. P3 is the only person whose code imports `viem`, the WASM module, or `fetch`.

**Non-negotiables**

1. Ports and adapters: the SDK's application layer depends on interfaces only; each external system (WASM, Swissquote API, bundler, chain RPC, WebAuthn) is one adapter class behind one interface.
2. The WASM module is imported in exactly one file (`WasmWalletCore` adapter). Nothing else knows WASM exists.
3. Every adapter converts external failures into a typed `SdkError` at its edge; no raw exception crosses a port.
4. Use an audited smart-account implementation and its SDK; never write or modify account contracts.
5. The hour-1 spike (passkey signer + paymaster on Base Sepolia, from the extension origin) gates the whole plan; report the result to the team by hour 2.

## Package layout

A pnpm monorepo with four TS packages; dependencies point from UI toward the SDK, and from the SDK's application layer toward its ports, never to adapters directly.

```text
ts/
├── packages/
│   ├── types/            # generated from Rust api-types (ts-rs); never edited by hand
│   ├── core-wasm/        # wasm-pack output from P1; never edited by hand
│   ├── sdk/
│   │   └── src/
│   │       ├── ports/        # interfaces: CoreEngine, SwissquoteApi, AccountProvider, PasskeyAuthenticator, ChainReader
│   │       ├── adapters/     # WasmWalletCore, HttpSwissquoteApi, SmartAccountProvider, WebAuthnPasskey, ViemChainReader
│   │       ├── app/          # use cases: CreateWallet, SendTransaction, StartRecovery, CancelRecovery, EscapeHatch
│   │       ├── ui-contract/  # UiApi, UiEvents, UiError (shared with P2)
│   │       ├── errors.ts     # SdkError, Result<T, E>
│   │       └── container.ts  # composition root: builds adapters, injects into use cases
│   └── extension/
│       └── src/background/   # router: UiBridge messages + EIP-1193 requests → use cases
│           src/inpage/, src/content/  # EIP-1193 provider for dApps
└── fixtures/             # mock accounts, sanctions list, exposure graph, KYC scripts
```

| Layer | May import | Must not import |
| --- | --- | --- |
| `app/` use cases | `ports/`, `errors.ts`, `types` | `adapters/`, `viem`, WASM, `chrome.*` |
| `adapters/` | `ports/`, external libs | `app/` |
| `container.ts` | everything | — (only place that knows concrete classes) |
| `extension/background` | `sdk` public API | adapters directly |

## Ports

Five interfaces define everything the use cases need; each adapter implements exactly one, and each has a fake for tests and for P2's fixtures.

```ts
// ports/CoreEngine.ts — implemented by WasmWalletCore (the ONLY file importing @sqw/core-wasm)
export interface CoreEngine {
  assess(req: TxRequestDto, signals: ExternalSignalsDto): Result<RiskAssessmentDto, SdkError>;
  buildEntry(input: LogEntryInputDto): Result<LogEntryDto, SdkError>;
  verifyLog(log: AuditLogDto): Result<{ head: Hex }, SdkError>;
}

// ports/PasskeyAuthenticator.ts — implemented by WebAuthnPasskey
export interface PasskeyAuthenticator {
  create(user: AccountRef): Promise<Result<PasskeyPublicKey, SdkError>>;
  sign(challenge: Hex): Promise<Result<WebAuthnSignature, SdkError>>;
}

// ports/AccountProvider.ts — implemented by SmartAccountProvider (account SDK + bundler + paymaster)
export interface AccountProvider {
  address(signer: PasskeyPublicKey): Promise<Result<Address, SdkError>>;
  prepare(tx: TxRequestDto): Promise<Result<PreparedUserOp, SdkError>>;      // includes paymaster data
  submit(op: SignedUserOp): Promise<Result<TxHash, SdkError>>;
  startEscapeHatch(to: Address): Promise<Result<TxHash, SdkError>>;
}

// ports/SwissquoteApi.ts — implemented by HttpSwissquoteApi (calls P1's Axum service)
export interface SwissquoteApi {
  login(creds: MockCredentials): Promise<Result<Session, SdkError>>;
  register(req: RegisterWalletReq): Promise<Result<void, SdkError>>;
  cosign(req: CosignReq): Promise<Result<CosignOutcome, SdkError>>;
  justify(holdId: string, text: string): Promise<Result<HoldState, SdkError>>;
  startRecovery(req: StartRecoveryReq): Promise<Result<RecoveryState, SdkError>>;
  cancelRecovery(id: string, proof: CancelProof): Promise<Result<RecoveryState, SdkError>>;
}

// ports/ChainReader.ts — implemented by ViemChainReader
export interface ChainReader {
  balances(a: Address): Promise<Result<Balance[], SdkError>>;
  simulate(tx: TxRequestDto): Promise<Result<BalanceDelta[], SdkError>>;
}
```

Use cases are classes taking ports in the constructor, e.g. `new SendTransaction(core, passkey, account, sq, chain)`, with one public `execute()` returning `Result`. Only `container.ts` calls these constructors.

## Flows

Each flow is one use-case class; the steps below are its `execute()` in order. Two platform constraints shape all of them.

**Platform constraints (verify in the hour-1 spike)**

- WebAuthn is not available in the MV3 service worker. `WebAuthnPasskey` runs in the popup or approval window; the background asks the UI page to perform the passkey step and receives the signature back.
- WASM in the service worker needs `'wasm-unsafe-eval'` in the extension CSP and a static import; no dynamic `import()` in the worker.

**CreateWallet**

1. `sq.login` → session.
2. `passkey.create` → public key.
3. `account.address(publicKey)` → counterfactual address (deployed with the first userOp).
4. `passkey.sign(ownershipChallenge)` → `sq.register` with address, public key, proof.

**SendTransaction**

1. `chain.simulate` + fetch signals → `core.assess` → preview to UI (band, reasons, delta).
2. User confirms → `account.prepare` (paymaster data included) → `passkey.sign(userOpHash)`.
3. `core.buildEntry` → `sq.cosign` → outcome: co-signed / step-up / held / refused.
4. Co-signed → `account.submit` → append receipt locally → emit `tx-confirmed`.

**StartRecovery / CancelRecovery**

1. New device: `passkey.create` → mock KYC attestation → `sq.startRecovery` → guardian approvals submitted on-chain → emit `recovery-started` to every registered device.
2. Any existing device: `passkey.sign(cancelChallenge)` → `sq.cancelRecovery` + on-chain cancel.

**EscapeHatch**

1. `passkey.sign` → `account.startEscapeHatch(to)` → 14-day timer (minutes in demo) → execute without Swissquote.

## Error model

One error code travels from where it happens to the screen: Rust codes are preserved, adapter failures get their own codes, and the UI maps codes to messages in one table.

```ts
// errors.ts
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export class SdkError extends Error {
  constructor(
    readonly code: SdkErrorCode,          // e.g. 'CORE_SEQ_GAP', 'SQ_UNAUTHORIZED', 'PASSKEY_CANCELLED', 'BUNDLER_REJECTED'
    readonly source: 'core' | 'swissquote' | 'passkey' | 'bundler' | 'chain' | 'internal',
    message: string,
    readonly cause?: unknown,
  ) { super(message); }
}
```

| Source | How it arrives | Adapter converts to |
| --- | --- | --- |
| Rust core (WASM) | `JsError` with `"CODE: message"` | `CORE_<CODE>` |
| Swissquote API | HTTP status + `{ code, message }` | `SQ_<code>` |
| WebAuthn | `DOMException` (`NotAllowedError`, …) | `PASSKEY_CANCELLED`, `PASSKEY_UNSUPPORTED` |
| Bundler / paymaster | JSON-RPC error | `BUNDLER_REJECTED`, `PAYMASTER_DENIED` |
| RPC / network | fetch or viem error | `CHAIN_UNAVAILABLE` |

- Hold and refusal are outcomes, not errors (same rule as Rust).
- Retries only in adapters, only for idempotent reads and `CHAIN_UNAVAILABLE`, max 2, with backoff. Never retry a submit.
- `background` converts `SdkError` to `UiError { code, retryable }`; P2 owns the user-facing text.

## Mock data and providers

All mock data lives in `ts/fixtures/` as JSON that both P1's Rust mocks and P2's fake bridge load, so every layer agrees on the same demo world. Every mock is labelled as such in the UI and the pitch.

| Fixture | Contents | Used by |
| --- | --- | --- |
| `accounts.json` | 2 demo clients (real user, attacker persona), mock credentials | Login, recovery demo |
| `allowlist.json` | Test USDC, ETH, 2 allowlisted dApp origins | Low band |
| `sanctions.json` | 2 testnet addresses we control, marked sanctioned | Critical band |
| `exposure-graph.json` | Synthetic graph: 1 address 2 hops from a fake mixer | High band |
| `kyc-scripts.json` | Pass / fail outcomes for the simulated video call | Recovery demo |
| `demo-seed.json` | Pre-funded test wallets, amounts per demo step | Demo rehearsal |

- Testnet funds: claim Base Sepolia ETH and test USDC from faucets in hour 1; faucets rate-limit, so fund demo wallets early and keep a reserve.
- Reconciliation demo: one wallet executes an escape-hatch exit (shortened timer) via a script. It lands on-chain with no co-signed log entry, so the log/chain diff flags it. With co-signing enforced on-chain, this is the only way a transaction can bypass the log.

## Legal/business duties and checklist

P3 presents legal and business (30 of 100 points), so the one-pager is a deliverable with the same weight as code, not an afterthought.

**Legal one-pager must cover, each with a source link:**

- Why co-signing without the ability to move funds is arguably not custody, and what remains open.
- FINMA's expectations on verifying ownership of external self-hosted wallets, and how our signed challenge satisfies them.
- AML / travel-rule trail from receipts and risk bands; data protection (revFADP) for KYC data.

**Checklist**

- [ ] Hour 1: spike — passkey smart account + paymaster from the extension origin on Base Sepolia; report go/no-go by hour 2
- [ ] Hour 1: faucet funds claimed; `UiApi` contract agreed with P2; DTO generation from P1 wired
- [ ] Hour 3: ports, `SdkError`, `container.ts`, fakes for every port
- [ ] Hour 9: `WasmWalletCore` + `SmartAccountProvider` + `HttpSwissquoteApi`; CreateWallet and SendTransaction end to end
- [ ] Hour 14: recovery module, cancel, escape hatch on-chain; fixtures complete
- [ ] Hour 18: legal one-pager with sources; ownership-proof flow
- [ ] Hour 21: `tsc --noEmit`, ESLint, use-case tests with fakes clean; legal/business slides rehearsed; freeze
