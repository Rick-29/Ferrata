// Sign-in through the Ferrata extension (option A). The website never handles a password or a key:
// it finds the extension (EIP-6963, like any dApp), asks it `sqw_signIn`, and the extension runs the
// Swissquote login + passkey in its own window, then returns who signed in.

export interface FerrataIdentity {
  readonly address: string
  readonly clientId: string
  readonly displayName: string
}

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

interface ProviderDetail {
  info: { uuid: string; name: string; icon: string; rdns: string }
  provider: Eip1193Provider
}

const FERRATA_RDNS = "com.swissquote.wallet"

export type SignInError =
  /** No Ferrata extension on this browser (or not allowed on this site). */
  | "not_installed"
  /** The user closed the Ferrata window or clicked "Refuser". */
  | "refused"
  /** The extension refused this site (not Ferrata's own origin). */
  | "not_allowed"
  | "failed"

export class FerrataSignInError extends Error {
  constructor(readonly reason: SignInError, message: string) {
    super(message)
  }
}

/** Finds the Ferrata extension's provider; resolves null if it does not announce itself in time. */
export function findFerrata(timeoutMs = 1500): Promise<Eip1193Provider | null> {
  return new Promise((resolve) => {
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<ProviderDetail>).detail
      if (detail?.info?.rdns !== FERRATA_RDNS) return
      cleanup()
      resolve(detail.provider)
    }
    const timer = window.setTimeout(() => {
      cleanup()
      resolve(null)
    }, timeoutMs)
    const cleanup = () => {
      window.clearTimeout(timer)
      window.removeEventListener("eip6963:announceProvider", onAnnounce)
    }
    window.addEventListener("eip6963:announceProvider", onAnnounce)
    window.dispatchEvent(new Event("eip6963:requestProvider"))
  })
}

function isIdentity(v: unknown): v is FerrataIdentity {
  if (typeof v !== "object" || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.address === "string" && typeof o.clientId === "string" && typeof o.displayName === "string"
}

/** Opens the Ferrata window (login + passkey) and resolves with the signed-in client. */
export async function signInWithFerrata(): Promise<FerrataIdentity> {
  const provider = await findFerrata()
  if (provider === null) {
    throw new FerrataSignInError("not_installed", "The Ferrata extension was not found in this browser.")
  }
  try {
    const result = await provider.request({ method: "sqw_signIn" })
    if (!isIdentity(result)) throw new FerrataSignInError("failed", "Unexpected answer from the extension.")
    return result
  } catch (error) {
    if (error instanceof FerrataSignInError) throw error
    const code = (error as { code?: number }).code
    if (code === 4001) throw new FerrataSignInError("refused", "Sign-in was cancelled in the Ferrata window.")
    if (code === 4200 || code === 4100) {
      throw new FerrataSignInError("not_allowed", "This site is not allowed to sign in with Ferrata.")
    }
    throw new FerrataSignInError("failed", (error as Error).message ?? "Sign-in failed.")
  }
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}

// ---------- Live dashboard: read-only wallet data answered by the extension ----------
// Shapes of `extension/src/background/site/SiteReader.ts`. The extension keeps the keys and the
// Swissquote session; the website only ever receives these already formatted values.

export type RiskBand = "Low" | "Medium" | "High" | "Critical"

export interface WalletBalance {
  readonly symbol: string
  readonly decimals: number
  readonly amount: string
  readonly formatted: string
}

export interface LiveWallet {
  readonly address: string
  readonly network: string
  readonly balances: readonly WalletBalance[]
}

export interface ActivityRow {
  readonly key: string
  readonly kind: string
  readonly label: string
  readonly network: string
  readonly timestamp: number
  readonly amount: string | null
  readonly direction: "in" | "out" | "none"
  readonly counterparty: string | null
  readonly riskLevel: RiskBand | null
  readonly reviewedRisk: RiskBand | null
  readonly flags: readonly unknown[]
  readonly hasReceipt: boolean
  readonly explorerUrl: string | null
}

export interface TestnetWallet {
  readonly network: string
  readonly label: string
  readonly symbol: string
  readonly address: string
  readonly balance: string | null
  readonly explorerUrl: string
}

export interface RecoveryAlert {
  readonly id: string
  readonly unlockAt: number
  readonly reasons: readonly string[]
  readonly newKeyFingerprint: string
  readonly contested: boolean
}

export interface RecoveryStatus {
  readonly phoneFingerprint: string | null
  readonly alerts: readonly RecoveryAlert[]
}

export type ReadError =
  /** The wallet auto-locked (15 min): unlock it in the Ferrata window. */
  | "locked"
  /** No Swissquote session in the extension any more. */
  | "signed_out"
  | "not_installed"
  | "failed"

export class FerrataReadError extends Error {
  constructor(readonly reason: ReadError, message: string) {
    super(message)
  }
}

interface ReadMethods {
  sqw_wallet: LiveWallet
  sqw_activity: readonly ActivityRow[]
  sqw_testnet: readonly TestnetWallet[]
  sqw_recovery: RecoveryStatus
}

/** One read-only call to the extension (first-party website only). */
export async function readFerrata<M extends keyof ReadMethods>(method: M): Promise<ReadMethods[M]> {
  const provider = await findFerrata()
  if (provider === null) throw new FerrataReadError("not_installed", "The Ferrata extension was not found in this browser.")
  try {
    return (await provider.request({ method })) as ReadMethods[M]
  } catch (error) {
    const { code, message } = error as { code?: number; message?: string }
    if (code === 4100 && message === "locked") throw new FerrataReadError("locked", "The wallet is locked.")
    if (code === 4100) throw new FerrataReadError("signed_out", "Sign in again with Ferrata.")
    throw new FerrataReadError("failed", message ?? "The extension could not answer.")
  }
}
