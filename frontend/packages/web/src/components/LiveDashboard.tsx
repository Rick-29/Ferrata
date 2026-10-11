import {
  Activity,
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Copy,
  ExternalLink,
  FlaskConical,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Menu,
  Moon,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sun,
  X,
} from "lucide-react"
import { useCallback, useEffect, useState, type ReactElement } from "react"
import {
  FerrataReadError,
  readFerrata,
  shortAddress,
  signInWithFerrata,
  type ActivityRow,
  type FerrataIdentity,
  type LiveWallet,
  type RecoveryStatus,
  type RiskBand,
  type TestnetWallet,
} from "../lib/ferrata"
import type { Theme } from "../types"
import Brand from "./Brand"
import { Badge, Button, Card } from "./ui"
import { APP_NAME } from "@sqw/brand"

type Section = "overview" | "activity" | "testnet" | "security"

interface LiveData {
  readonly wallet: LiveWallet
  readonly activity: readonly ActivityRow[]
  readonly testnet: readonly TestnetWallet[]
  readonly recovery: RecoveryStatus
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: LiveData; readonly at: Date }
  | { readonly kind: "locked" | "signed_out" | "not_installed" }
  | { readonly kind: "error"; readonly message: string }

/** English labels for the Ferra chain event kinds (the extension's own labels are French). */
const KIND_LABELS: Readonly<Record<string, string>> = {
  account_created: "Wallet created",
  faucet: "Demo funds received",
  cosigned: "Transfer",
  escape_start: "Escape hatch started",
  escape_cancel: "Escape hatch cancelled",
  escape_exit: "Escape hatch exit",
  owner_rotation: "Passkey replaced (recovery)",
  flag: "Flag",
  external: "External transaction",
  settings_changed: "Settings changed",
  recovery_key_set: "Recovery phone registered",
  address_report: "Address reported",
}

const RISK_TONE: Readonly<Record<RiskBand, "low" | "moderate" | "high" | "sanctioned">> = {
  Low: "low",
  Medium: "moderate",
  High: "high",
  Critical: "sanctioned",
}

const NETWORK_MARK: Readonly<Record<string, string>> = { "solana-devnet": "sol", "base-sepolia": "eth", "eth-sepolia": "eth" }

/**
 * The dashboard with the client's real wallet (after "Sign in with Ferrata"). Same layout and
 * style as the scripted demo; every figure comes from the Ferrata extension, read-only.
 */
export default function LiveDashboard({
  identity,
  theme,
  onThemeChange,
  onSignOut,
}: {
  identity: FerrataIdentity
  theme: Theme
  onThemeChange: () => void
  onSignOut: () => void
}) {
  const [section, setSection] = useState<Section>("overview")
  const [mobileMenu, setMobileMenu] = useState(false)
  const [state, setState] = useState<LoadState>({ kind: "loading" })
  const [unlocking, setUnlocking] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setState((current) => (current.kind === "ready" ? current : { kind: "loading" }))
    try {
      const [wallet, activity, testnet, recovery] = await Promise.all([
        readFerrata("sqw_wallet"),
        readFerrata("sqw_activity"),
        readFerrata("sqw_testnet"),
        readFerrata("sqw_recovery"),
      ])
      setState({ kind: "ready", data: { wallet, activity, testnet, recovery }, at: new Date() })
    } catch (error) {
      if (error instanceof FerrataReadError && error.reason !== "failed") setState({ kind: error.reason })
      else setState({ kind: "error", message: (error as Error).message })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** Locked or signed out: the Ferrata window runs the login and the passkey again. */
  const unlock = async () => {
    setUnlocking(true)
    try {
      await signInWithFerrata()
      await load()
    } catch {
      // Cancelled in the Ferrata window: stay on the locked card.
    } finally {
      setUnlocking(false)
    }
  }

  const copyAddress = async (address: string) => {
    await navigator.clipboard.writeText(address)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const navigation: readonly { id: Section; label: string; icon: ReactElement }[] = [
    { id: "overview", label: "Overview", icon: <LayoutDashboard size={18} /> },
    { id: "activity", label: "Activity", icon: <Activity size={18} /> },
    { id: "testnet", label: "Test networks", icon: <FlaskConical size={18} /> },
    { id: "security", label: "Security & recovery", icon: <ShieldCheck size={18} /> },
  ]
  const ready = state.kind === "ready" ? state.data : null
  const alerts = ready?.recovery.alerts ?? []

  return (
    <div className="dashboard">
      <aside className={mobileMenu ? "dashboard-sidebar open" : "dashboard-sidebar"}>
        <div className="sidebar-brand">
          <Brand />
          <button className="mobile-close" onClick={() => setMobileMenu(false)}>
            <X />
          </button>
        </div>
        <nav aria-label="Wallet dashboard">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={section === item.id ? "active" : ""}
              onClick={() => {
                setSection(item.id)
                setMobileMenu(false)
              }}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.id === "security" && alerts.length > 0 && <Badge tone="sanctioned">{alerts.length}</Badge>}
            </button>
          ))}
        </nav>
        <button className="restart-button" onClick={onSignOut}>
          <LogOut size={17} /> Sign out
        </button>
        <div className="sidebar-profile">
          <span className="user-avatar">{initials(identity.displayName)}</span>
          <span>
            <strong>{identity.displayName}</strong>
            <small>
              {identity.clientId} · {shortAddress(identity.address)}
            </small>
          </span>
        </div>
      </aside>

      <div className="dashboard-main">
        <header className="dashboard-header">
          <button className="mobile-menu" onClick={() => setMobileMenu(true)} aria-label="Open navigation">
            <Menu />
          </button>
          <div className="dashboard-command">
            <KeyRound size={16} />
            <span>Live data from your {APP_NAME} extension · read-only</span>
          </div>
          <div className="dashboard-header-actions">
            <button onClick={() => void load()} aria-label="Refresh" title="Refresh">
              <RefreshCw size={18} />
            </button>
            <button onClick={onThemeChange} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            {state.kind === "ready" ? (
              <Badge tone="low">
                <span className="live-dot" /> Wallet connected
              </Badge>
            ) : (
              <Badge tone="moderate">Wallet not readable</Badge>
            )}
          </div>
        </header>

        <main className="dashboard-content">
          <div className="dashboard-title">
            <div>
              <span className="eyebrow">{APP_NAME.toUpperCase()} CONTROL CENTER</span>
              <h1>Hello, {identity.displayName.split(" ")[0]}.</h1>
              <p>
                Self-custody: your passkey alone authorises a transfer. Swissquote analyses each one and warns you, but
                can never move or block your funds.
              </p>
            </div>
            <Button variant="secondary" icon={<Copy size={17} />} onClick={() => void copyAddress(identity.address)}>
              {copied ? "Copied" : `Wallet ${shortAddress(identity.address)}`}
            </Button>
          </div>

          {alerts.map((alert) => (
            <Card key={alert.id} className="live-alert">
              <AlertTriangle size={20} />
              <div>
                <strong>A recovery of your wallet is in progress</strong>
                <p>
                  A new passkey (fingerprint <code>{alert.newKeyFingerprint}</code>) will replace yours{" "}
                  {formatRemaining(alert.unlockAt)}.{" "}
                  {alert.contested
                    ? "This recovery is contested: your passkey alone can no longer cancel it. Contact Swissquote if this is not you."
                    : "Not you? Open the Ferrata extension and cancel it with your passkey."}
                </p>
                {alert.reasons.length > 0 && (
                  <ul>
                    {alert.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          ))}

          {state.kind === "ready" ? (
            <Sections section={section} data={state.data} onSection={setSection} />
          ) : (
            <StatusCard state={state} unlocking={unlocking} onUnlock={() => void unlock()} onRetry={() => void load()} />
          )}
          {state.kind === "ready" && (
            <p className="live-footnote">Updated {state.at.toLocaleTimeString()} · from the {APP_NAME} extension</p>
          )}
        </main>
      </div>
      {mobileMenu && <button className="sidebar-scrim" onClick={() => setMobileMenu(false)} aria-label="Close navigation" />}
    </div>
  )
}

function Sections({ section, data, onSection }: { section: Section; data: LiveData; onSection: (s: Section) => void }) {
  switch (section) {
    case "overview":
      return (
        <>
          <div className="metric-grid">
            <Card className="metric-card">
              <span className="metric-label">Wallet on {data.wallet.network}</span>
              <div className="live-assets">
                {data.wallet.balances.map((b) => (
                  <div className="live-asset" key={b.symbol}>
                    <span className={`asset-mark ${b.symbol.toLowerCase()}`}>{b.symbol.slice(0, 4)}</span>
                    <strong>{b.formatted}</strong>
                    <small>{b.symbol}</small>
                  </div>
                ))}
              </div>
            </Card>
            <ProtectionCard recovery={data.recovery} />
          </div>
          <Card className="live-card">
            <div className="section-title-row">
              <div>
                <span className="eyebrow">RECENT ACTIVITY</span>
                <h2>On the Ferra chain</h2>
              </div>
              <button className="live-link" onClick={() => onSection("activity")}>
                See all
              </button>
            </div>
            <ActivityList rows={data.activity.slice(0, 5)} />
          </Card>
          <Card className="live-card">
            <div className="section-title-row">
              <div>
                <span className="eyebrow">TEST NETWORKS</span>
                <h2>Public test networks</h2>
              </div>
              <button className="live-link" onClick={() => onSection("testnet")}>
                Details
              </button>
            </div>
            <TestnetList wallets={data.testnet} />
          </Card>
        </>
      )
    case "activity":
      return (
        <Card className="live-card">
          <div className="section-title-row">
            <div>
              <span className="eyebrow">ACTIVITY</span>
              <h2>Every event on your Ferra chain journal</h2>
            </div>
            <span>{data.activity.length} events</span>
          </div>
          <ActivityList rows={data.activity} />
        </Card>
      )
    case "testnet":
      return (
        <Card className="live-card">
          <div className="section-title-row">
            <div>
              <span className="eyebrow">TEST NETWORKS</span>
              <h2>Real public test networks, test coins only</h2>
            </div>
          </div>
          <TestnetList wallets={data.testnet} detailed />
          <p className="live-note">
            These addresses are held by keys in your {APP_NAME} extension; each send is approved by your passkey and
            recorded on the Ferra chain. Send and receive from the extension.
          </p>
        </Card>
      )
    case "security":
      return (
        <>
          <div className="metric-grid">
            <ProtectionCard recovery={data.recovery} />
            <Card className="metric-card">
              <span className="metric-icon">
                <Smartphone size={19} />
              </span>
              <span className="metric-label">Recovery phone</span>
              {data.recovery.phoneFingerprint ? (
                <>
                  <strong className="status-title">Associated</strong>
                  <code className="live-fingerprint">{data.recovery.phoneFingerprint}</code>
                </>
              ) : (
                <>
                  <strong className="status-title">Not associated</strong>
                  <p className="live-note">
                    In the extension: Settings → Recovery phone. Without it, a lost passkey cannot be recovered.
                  </p>
                </>
              )}
            </Card>
          </div>
          <Card className="live-card">
            <span className="eyebrow">HOW RECOVERY WORKS</span>
            <div className="policy-grid">
              <div>
                <span>To pay</span>
                <strong>Your passkey alone</strong>
              </div>
              <div>
                <span>To recover a lost passkey</span>
                <strong>Recovery phone + Swissquote identity check</strong>
              </div>
              <div>
                <span>Then</span>
                <strong>A smart delay, cancellable by your current passkey</strong>
              </div>
            </div>
            <p className="live-note">
              Swissquote alone can never replace your key or move your funds: without your recovery phone, the Ferra
              chain refuses the rotation.
            </p>
          </Card>
        </>
      )
  }
}

function ProtectionCard({ recovery }: { recovery: RecoveryStatus }) {
  return (
    <Card className="metric-card">
      <span className="metric-icon">
        <ShieldCheck size={19} />
      </span>
      <span className="metric-label">Protection status</span>
      <strong className="status-title">{recovery.alerts.length > 0 ? "Recovery in progress" : "All systems active"}</strong>
      <div className="status-list">
        <span>
          <i />
          Passkey (self-custody)
        </span>
        <span>
          <i />
          Swissquote risk analysis
        </span>
        <span className={recovery.phoneFingerprint ? "" : "live-off"}>
          <i />
          Recovery phone {recovery.phoneFingerprint ? recovery.phoneFingerprint : "missing"}
        </span>
      </div>
    </Card>
  )
}

function ActivityList({ rows }: { rows: readonly ActivityRow[] }) {
  if (rows.length === 0) return <p className="live-note">No activity yet.</p>
  return (
    <div className="live-list">
      {rows.map((row) => (
        <div className="live-row" key={row.key}>
          <span className={`live-icon ${row.direction}`}>
            {row.direction === "in" ? <ArrowDownLeft size={16} /> : row.direction === "out" ? <ArrowUpRight size={16} /> : <LockKeyhole size={15} />}
          </span>
          <span className="live-main">
            <strong>{KIND_LABELS[row.kind] ?? row.label}</strong>
            <small>
              {new Date(row.timestamp * 1000).toLocaleString()} · {row.network}
              {row.counterparty ? ` · ${shortAddress(row.counterparty)}` : ""}
            </small>
          </span>
          <span className="live-tags">
            {row.riskLevel && <Badge tone={RISK_TONE[row.riskLevel]}>{row.riskLevel}</Badge>}
            {row.hasReceipt && <Badge tone="brand">Analysed</Badge>}
          </span>
          <span className={`live-amount ${row.direction}`}>
            {row.amount ? `${row.direction === "out" ? "−" : row.direction === "in" ? "+" : ""}${row.amount}` : ""}
            {row.explorerUrl && (
              <a href={row.explorerUrl} target="_blank" rel="noopener noreferrer" aria-label="Open in explorer">
                <ExternalLink size={13} />
              </a>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

function TestnetList({ wallets, detailed = false }: { wallets: readonly TestnetWallet[]; detailed?: boolean }) {
  return (
    <div className="live-list">
      {wallets.map((w) => (
        <div className="live-row" key={w.network}>
          <span className={`asset-mark ${NETWORK_MARK[w.network] ?? "eth"}`}>{w.symbol}</span>
          <span className="live-main">
            <strong>{w.label}</strong>
            <small>{detailed ? w.address : shortAddress(w.address)}</small>
          </span>
          <span />
          <span className="live-amount">
            {w.balance === null ? "unavailable" : `${w.balance} ${w.symbol}`}
            <a href={w.explorerUrl} target="_blank" rel="noopener noreferrer" aria-label="Open in explorer">
              <ExternalLink size={13} />
            </a>
          </span>
        </div>
      ))}
    </div>
  )
}

function StatusCard({
  state,
  unlocking,
  onUnlock,
  onRetry,
}: {
  state: Exclude<LoadState, { kind: "ready" }>
  unlocking: boolean
  onUnlock: () => void
  onRetry: () => void
}) {
  if (state.kind === "loading") {
    return (
      <Card className="live-card">
        <p className="live-note">Reading your wallet from the {APP_NAME} extension…</p>
      </Card>
    )
  }
  const copy =
    state.kind === "locked"
      ? { title: "Your wallet is locked", body: "It locks itself after 15 minutes. Unlock it with your passkey in the Ferrata window." }
      : state.kind === "signed_out"
        ? { title: "Signed out of the extension", body: "Sign in again: Swissquote login, then your passkey." }
        : state.kind === "not_installed"
          ? { title: "Ferrata extension not found", body: "Install or enable it in this browser, then reload this page." }
          : { title: "The extension could not answer", body: state.kind === "error" ? state.message : "" }
  return (
    <Card className="live-card live-status">
      <LockKeyhole size={22} />
      <strong>{copy.title}</strong>
      <p className="live-note">{copy.body}</p>
      {state.kind === "locked" || state.kind === "signed_out" ? (
        <Button onClick={onUnlock} loading={unlocking} icon={<KeyRound size={17} />}>
          Unlock with {APP_NAME}
        </Button>
      ) : (
        <Button variant="secondary" onClick={onRetry} icon={<RefreshCw size={17} />}>
          Retry
        </Button>
      )}
    </Card>
  )
}

function formatRemaining(unlockAt: number): string {
  const secs = Math.max(0, unlockAt - Math.floor(Date.now() / 1000))
  if (secs === 0) return "now"
  if (secs < 3_600) return `in ${Math.ceil(secs / 60)} min`
  if (secs < 172_800) return `in ${Math.ceil(secs / 3_600)} h`
  return `in ${Math.ceil(secs / 86_400)} days`
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase()
}
