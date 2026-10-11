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
