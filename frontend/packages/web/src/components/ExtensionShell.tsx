import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  BadgeCheck,
  Landmark,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Copy,
  ExternalLink,
  Fingerprint,
  Gauge,
  Globe2,
  House,
  Info,
  KeyRound,
  LockKeyhole,
  MoreHorizontal,
  Network,
  QrCode,
  RefreshCw,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  WalletCards,
  X,
  Zap,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { activity, getPersona, getRiskReport, getScenario } from "../data/demo"
import type {
  ExtensionScreen,
  PersonaId,
  RiskTier,
  ScenarioId,
  SecuritySettings,
} from "../types"
import { APP_NAME } from "@sqw/brand"
import Brand from "./Brand"
import { Badge, Button, Card, Field } from "./ui"

const tierLabels: Record<RiskTier, string> = {
  low: "Low risk",
  moderate: "Moderate risk",
  high: "High risk",
  sanctioned: "Sanctioned address",
}

export default function ExtensionShell({
  personaId,
  scenarioId,
}: {
  personaId: PersonaId
  scenarioId: ScenarioId
}) {
  const [screen, setScreen] = useState<ExtensionScreen>("home")
  const [acknowledged, setAcknowledged] = useState(false)
  const [copied, setCopied] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)
  const persona = getPersona(personaId)
  const scenario = getScenario(scenarioId)
  const report = getRiskReport(scenarioId, personaId)
  const [settings, setSettings] = useState<SecuritySettings>({
    transactionLimit:
      personaId === "holder" ? 10 : personaId === "active" ? 25 : 50,
    dailyLimit:
      personaId === "holder"
        ? 50000
        : personaId === "active"
          ? 250000
          : 2000000,
    confirmationThreshold: personaId === "holder" ? 5 : 20,
    expiryMinutes: 15,
  })

  useEffect(() => {
    setScreen("home")
    setAcknowledged(false)
  }, [personaId, scenarioId])

  const copyAddress = () => {
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  const startScenario = () => {
    setAcknowledged(false)
    setScreen(scenarioId === "mismatch" ? "compose" : "connect")
  }

  const goBack = () => {
    const backMap: Partial<Record<ExtensionScreen, ExtensionScreen>> = {
      connect: "home",
      compose: scenarioId === "mismatch" ? "home" : "connect",
      review: "compose",
      passkey: "review",
      success: "home",
      activity: "home",
      settings: "home",
    }
    setScreen(backMap[screen] ?? "home")
  }

  return (
    <div className="extension-shell">
      <div className="extension-topline">
        <div className="extension-dots">
          <span />
          <span />
          <span />
        </div>
        <div className="extension-url">
          <LockKeyhole size={11} /> {APP_NAME} extension
        </div>
        <MoreHorizontal size={15} />
      </div>
      <div className="extension-app">
        {screen === "home" ? (
          <ExtensionHome
            personaId={personaId}
            copied={copied}
            onCopy={copyAddress}
            onStart={startScenario}
            onActivity={() => setScreen("activity")}
            onSettings={() => setScreen("settings")}
          />
        ) : (
          <>
            <div className="extension-flow-header">
              <button
                className="icon-button"
                onClick={goBack}
                aria-label="Go back"
              >
                <ArrowLeft size={18} />
              </button>
              <Brand compact />
              <button
                className="icon-button"
                onClick={() => setScreen("home")}
                aria-label="Close flow"
              >
                <X size={18} />
              </button>
            </div>
            {screen === "connect" && (
              <ConnectScreen
                onCancel={() => setScreen("home")}
                onConnect={() => setScreen("compose")}
              />
            )}
            {screen === "compose" && (
              <ComposeScreen
                scenarioId={scenarioId}
                onCancel={() => setScreen("home")}
                onReview={() => setScreen("review")}
              />
            )}
            {screen === "review" && (
              <ReviewScreen
                personaId={personaId}
                scenarioId={scenarioId}
                acknowledged={acknowledged}
                onAcknowledged={setAcknowledged}
                onContinue={() => setScreen("passkey")}
                onCancel={() => setScreen("home")}
              />
            )}
            {screen === "passkey" && (
              <PasskeyScreen onConfirm={() => setScreen("success")} />
            )}
            {screen === "success" && (
              <SuccessScreen
                onActivity={() => setScreen("activity")}
                onDone={() => setScreen("home")}
              />
            )}
            {screen === "activity" && <ActivityScreen />}
            {screen === "settings" && (
              <SettingsScreen
                personaId={personaId}
                settings={settings}
                saved={settingsSaved}
                onChange={setSettings}
                onSave={() => {
                  setSettingsSaved(true)
                  window.setTimeout(() => setSettingsSaved(false), 1800)
                }}
              />
            )}
          </>
        )}
      </div>
      <span className="sr-status" aria-live="polite">
        {copied
          ? "Wallet address copied"
          : settingsSaved
            ? "Security settings saved"
            : ""}
      </span>
    </div>
  )
}

function ExtensionHome({
  personaId,
  copied,
  onCopy,
  onStart,
  onActivity,
  onSettings,
}: {
  personaId: PersonaId
  copied: boolean
  onCopy: () => void
  onStart: () => void
  onActivity: () => void
  onSettings: () => void
}) {
  const persona = getPersona(personaId)
  return (
    <div className="wallet-home">
      <div className="wallet-header">
        <Brand compact />
        <button className="network-chip">
          <span className="solana-mark">S</span> Solana{" "}
          <ChevronDown size={13} />
        </button>
        <button className="avatar-button" aria-label="Account menu">
          JD
        </button>
      </div>
      <div className="wallet-balance">
        <div className="balance-topline">
          <span>Total balance</span>
          <Badge tone="low">
            <ShieldCheck size={12} /> Self-custody
          </Badge>
        </div>
        <strong>$184,392.60</strong>
        <span className="balance-change">
          +$2,184.20 <small>+1.20% today</small>
        </span>
        <button className="address-button" onClick={onCopy}>
          7Vxq…3A9m <Copy size={13} /> {copied && <small>Copied</small>}
        </button>
      </div>
      <div className="wallet-actions">
        <button onClick={onStart}>
          <span>
            <Send size={18} />
          </span>
          Send
        </button>
        <button>
          <span>
            <ArrowDownLeft size={18} />
          </span>
          Receive
        </button>
        <button onClick={onStart}>
          <span>
            <Globe2 size={18} />
          </span>
          Connect
        </button>
      </div>
      <Card className="protection-mini">
        <div className="protection-icon">
          <Sparkles size={18} />
        </div>
        <div>
          <strong>{persona.shortName} risk profile</strong>
          <span>{persona.transactionLimit} transaction policy</span>
        </div>
        <ChevronDown size={15} />
      </Card>
      <div className="wallet-section-heading">
        <span>Assets</span>
        <button>Manage</button>
      </div>
      <div className="asset-list">
        {[
          {
            mark: "S",
            name: "Solana",
            ticker: "SOL",
            amount: "64.82",
            value: "$11,829.64",
            cls: "sol",
          },
          {
            mark: "E",
            name: "Ethereum",
            ticker: "ETH",
            amount: "18.40",
            value: "$62,518.00",
            cls: "eth",
          },
          {
            mark: "$",
            name: "USD Coin",
            ticker: "USDC",
            amount: "85,045",
            value: "$85,045.00",
            cls: "usdc",
          },
          {
            mark: "₮",
            name: "Tether",
            ticker: "USDT",
            amount: "25,000",
            value: "$25,000.00",
            cls: "usdt",
          },
        ].map((asset) => (
          <button className="asset-row" key={asset.ticker}>
            <span className={`asset-mark ${asset.cls}`}>{asset.mark}</span>
            <span className="asset-name">
              <strong>{asset.name}</strong>
              <small>{asset.ticker}</small>
            </span>
            <span className="asset-value">
              <strong>{asset.amount}</strong>
              <small>{asset.value}</small>
            </span>
          </button>
        ))}
      </div>
      <Card className="connected-app">
        <span className="dapp-mark">D</span>
        <div>
          <strong>DemoSwap</strong>
          <small>Connected dApp · demo</small>
        </div>
        <Button size="sm" onClick={onStart}>
          Open
        </Button>
      </Card>
      <div className="wallet-tabs" aria-label="Wallet navigation">
        <button className="active">
          <House size={17} />
          Wallet
        </button>
        <button onClick={onActivity}>
          <Activity size={17} />
          Activity
        </button>
        <button onClick={onSettings}>
          <ShieldCheck size={17} />
          Security
        </button>
      </div>
    </div>
  )
}

function ConnectScreen({
  onCancel,
  onConnect,
}: {
  onCancel: () => void
  onConnect: () => void
}) {
  return (
    <div className="extension-screen connect-screen">
      <div className="dapp-lockup">
        <span className="dapp-mark large">D</span>
        <div className="link-line">
          <span />
          <Network size={15} />
          <span />
        </div>
        <span className="ferrata-shield">
          <ShieldCheck size={23} />
        </span>
      </div>
      <span className="eyebrow">CONNECTION REQUEST</span>
      <h2>Connect to DemoSwap?</h2>
      <p className="screen-lede">
        Review what this verified site can request from your wallet.
      </p>
      <Card className="domain-card">
        <div>
          <Globe2 size={18} />
          <span>
            <strong>DemoSwap</strong>
            <small>https://demoswap.example</small>
          </span>
        </div>
        <Badge tone="low">
          <BadgeCheck size={12} /> Verified
        </Badge>
      </Card>
      <div className="permission-list">
        <div>
          <Check size={16} />
          <span>
            <strong>View your public address</strong>
            <small>Required to show your wallet balance</small>
          </span>
        </div>
        <div>
          <Check size={16} />
          <span>
            <strong>Request transactions</strong>
            <small>You approve every request with {APP_NAME}</small>
          </span>
        </div>
        <div className="denied">
          <X size={16} />
          <span>
            <strong>Move funds without approval</strong>
            <small>Never permitted</small>
          </span>
        </div>
      </div>
      <Card className="network-row">
        <span className="solana-mark">S</span>
        <div>
          <small>Network</small>
          <strong>Solana Mainnet</strong>
        </div>
        <ChevronDown size={16} />
      </Card>
      <div className="screen-actions">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onConnect}>Connect</Button>
      </div>
      <p className="screen-footnote">
        <ShieldCheck size={14} /> Connection alone cannot move funds.
      </p>
    </div>
  )
}

function ComposeScreen({
  scenarioId,
  onCancel,
  onReview,
}: {
  scenarioId: ScenarioId
  onCancel: () => void
  onReview: () => void
}) {
  const scenario = getScenario(scenarioId)
  const isTransfer = scenarioId === "mismatch"
  return (
    <div className="extension-screen compose-screen">
      <div className="screen-title-row">
        <div>
          <span className="eyebrow">
            {isTransfer ? "SEND ASSET" : "DAPP SWAP"}
          </span>
          <h2>{scenario.title}</h2>
        </div>
        <Badge tone={scenario.tier}>{tierLabels[scenario.tier]}</Badge>
      </div>
      <Card className="amount-card">
        <span>You {isTransfer ? "send" : "pay"}</span>
        <div className="amount-input">
          <strong>{scenario.amount}</strong>
          <button>
            <span
              className={
                scenario.asset === "SOL" ? "asset-mark sol" : "asset-mark usdc"
              }
            >
              {scenario.asset === "SOL" ? "S" : "$"}
            </span>
            {scenario.asset}
            <ChevronDown size={14} />
          </button>
        </div>
        <small>
          {isTransfer ? "≈ $1,000,000.00" : "≈ $3,360.24"} · Available 85,045
          USDC / 64.82 SOL
        </small>
      </Card>
      {!isTransfer && (
        <>
          <div className="swap-divider">
            <span>
              <ArrowDownLeft size={15} />
            </span>
          </div>
          <Card className="amount-card receive-card">
            <span>You receive (estimated)</span>
            <div className="amount-input">
              <strong>2,480,500</strong>
              <button>
                <span className="token-mini">M</span>MOONCAT
              </button>
            </div>
            <small>Price impact 1.8%</small>
          </Card>
        </>
      )}
      <Card className="transaction-details">
        <div>
          <span>{isTransfer ? "To" : "Route"}</span>
          <strong>{scenario.destination}</strong>
        </div>
        <div>
          <span>Network fee</span>
          <strong>{isTransfer ? "$1.84" : "0.00042 SOL"}</strong>
        </div>
        <div>
          <span>{isTransfer ? "Arrival" : "Slippage"}</span>
          <strong>{isTransfer ? "~30 seconds" : "2.0%"}</strong>
        </div>
      </Card>
      <div className="ferrata-check-callout">
        <span>
          <ShieldCheck size={20} />
        </span>
        <div>
          <strong>{APP_NAME} assessment required</strong>
          <p>
            Swissquote will check this action against your profile and policy.
          </p>
        </div>
      </div>
      <div className="screen-actions stacked">
        <Button size="lg" onClick={onReview} icon={<Sparkles size={17} />}>
          Review with {APP_NAME}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel request
        </Button>
      </div>
    </div>
  )
}

function ReviewScreen({
  personaId,
  scenarioId,
  acknowledged,
  onAcknowledged,
  onContinue,
  onCancel,
}: {
  personaId: PersonaId
  scenarioId: ScenarioId
  acknowledged: boolean
  onAcknowledged: (value: boolean) => void
  onContinue: () => void
  onCancel: () => void
}) {
  const scenario = getScenario(scenarioId)
  const report = getRiskReport(scenarioId, personaId)
  const persona = getPersona(personaId)
  const needsAck = report.tier !== "low"
  const tierIcon =
    report.tier === "sanctioned" ? (
      <Landmark />
    ) : report.tier === "high" ? (
      <AlertOctagon />
    ) : report.tier === "moderate" ? (
      <AlertTriangle />
    ) : (
      <ShieldCheck />
    )
  return (
    <div className={`extension-screen review-screen risk-${report.tier}`}>
      <div className="risk-score-header">
        <div className="risk-emblem">{tierIcon}</div>
        <div>
          <span className="eyebrow">{APP_NAME.toUpperCase()} RISK ASSESSMENT</span>
          <h2>{tierLabels[report.tier]}</h2>
        </div>
        <div className="score-ring">
          <strong>{report.score}</strong>
          <small>/100</small>
        </div>
      </div>
      <Card className="risk-summary">
        <strong>{report.headline}</strong>
        <p>{scenario.summary}</p>
        <div className="risk-meter">
          <span style={{ width: `${report.score}%` }} />
        </div>
      </Card>
      {scenario.reasons.length > 0 && (
        <div className="report-section">
          <span className="report-label">WHAT WE FOUND</span>
          {scenario.reasons.map((reason, index) => (
            <div className="finding-row" key={reason}>
              <span>{index + 1}</span>
              <p>{reason}</p>
            </div>
          ))}
        </div>
      )}
      <Card className="personal-context">
        <Gauge size={20} />
        <div>
          <span>Why this matters for a {persona.shortName}</span>
          <p>{report.personalReason}</p>
        </div>
      </Card>
      <div className="portfolio-impact">
        <span className="report-label">PORTFOLIO IMPACT</span>
        <div>
          <span>{scenario.asset} balance</span>
          <strong>
            {scenario.amount} {scenario.asset}
          </strong>
        </div>
        <div>
          <span>Destination</span>
          <strong>{scenario.destination}</strong>
        </div>
        <div>
          <span>Policy status</span>
          <strong>
            {report.tier === "sanctioned"
              ? "Strongest warning: you decide"
              : report.tier === "low"
                ? "Within limits"
                : "Exception required"}
          </strong>
        </div>
      </div>
      {needsAck && (
        <label className="acknowledgement">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => onAcknowledged(event.target.checked)}
          />
          <span>
            <strong>I understand this risk</strong>
            <small>
              I reviewed the destination, amount, and portfolio impact.
            </small>
          </span>
        </label>
      )}
        <div className="screen-actions stacked">
          <Button
            size="lg"
            disabled={needsAck && !acknowledged}
            onClick={onContinue}
            icon={<Fingerprint size={18} />}
          >
            {report.tier === "low"
              ? "Continue with passkey"
              : "Acknowledge and continue"}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel transaction
          </Button>
        </div>
      <p className="legal-copy">
        {APP_NAME} analysis is indicative: it does not guarantee the detection
        of fraudulent transactions and does not block them. You remain the
        sole decision-maker for your transactions.
      </p>
    </div>
  )
}

function PasskeyScreen({ onConfirm }: { onConfirm: () => void }) {
  const [signing, setSigning] = useState(false)
  return (
    <div className="extension-screen passkey-screen">
      <div className="passkey-orbit">
        <span className="orbit-ring" />
        <span className="passkey-main">
          <Fingerprint size={42} />
        </span>
        <span className="orbit-check">
          <ShieldCheck size={17} />
        </span>
      </div>
      <span className="eyebrow">FINAL APPROVAL</span>
      <h2>Confirm with your passkey</h2>
      <p className="screen-lede">
        Your passkey alone authorises this action. Swissquote has analysed it and
        records its analysis in your audit trail.
      </p>
      <div className="signing-steps">
        <div className="active">
          <span>
            <KeyRound size={17} />
          </span>
          <div>
            <strong>Your passkey</strong>
            <small>Authorise on this device</small>
          </div>
          <Badge tone="brand">Now</Badge>
        </div>
        <div>
          <span>
            <ShieldCheck size={17} />
          </span>
          <div>
            <strong>Swissquote analysis</strong>
            <small>Policy confirmation</small>
          </div>
          <Badge>Next</Badge>
        </div>
        <div>
          <span>
            <Network size={17} />
          </span>
          <div>
            <strong>Network submission</strong>
            <small>Recorded in your audit log</small>
          </div>
        </div>
      </div>
      <Button
        className="full-width"
        size="lg"
        loading={signing}
        onClick={() => {
          setSigning(true)
          window.setTimeout(onConfirm, 850)
        }}
      >
        {signing ? "Signing…" : "Confirm and sign"}
      </Button>
      <p className="screen-footnote">
        <LockKeyhole size={14} /> {APP_NAME} never receives your passkey.
      </p>
    </div>
  )
}

function SuccessScreen({
  onActivity,
  onDone,
}: {
  onActivity: () => void
  onDone: () => void
}) {
  return (
    <div className="extension-screen success-screen">
      <span className="success-mark">
        <CheckCircle2 size={44} />
      </span>
      <Badge tone="low">SIGNED BY SWISSQUOTE</Badge>
      <h2>Transaction submitted</h2>
      <p className="screen-lede">
        Your passkey authorised it and it was sent to the network. Swissquote's
        analysis is in your audit trail.
      </p>
      <Card className="receipt-card">
        <div className="receipt-row">
          <span>Status</span>
          <Badge tone="low">Confirmed</Badge>
        </div>
        <div className="receipt-row">
          <span>Network</span>
          <strong>Solana Mainnet</strong>
        </div>
        <div className="receipt-row">
          <span>Signature</span>
          <button>
            4kX9…pA71 <Copy size={13} />
          </button>
        </div>
        <div className="receipt-row">
          <span>{APP_NAME} audit ID</span>
          <strong>FR-2048-1198</strong>
        </div>
      </Card>
      <div className="screen-actions stacked">
        <Button size="lg" onClick={onActivity}>
          View in activity
        </Button>
        <Button variant="secondary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}

function ActivityScreen() {
  const [filter, setFilter] = useState<"all" | "flagged">("all")
  const items = useMemo(
    () =>
      filter === "all"
        ? activity
        : activity.filter((item) => item.tier !== "low"),
    [filter],
  )
  return (
    <div className="extension-screen activity-screen">
      <div className="screen-title-row">
        <div>
          <span className="eyebrow">AUDIT TRAIL</span>
          <h2>Activity</h2>
        </div>
        <button className="icon-button" aria-label="Refresh activity">
          <RefreshCw size={17} />
        </button>
      </div>
      <div className="filter-tabs">
        <button
          className={filter === "all" ? "active" : ""}
          onClick={() => setFilter("all")}
        >
          All activity
        </button>
        <button
          className={filter === "flagged" ? "active" : ""}
          onClick={() => setFilter("flagged")}
        >
          Needs attention
        </button>
      </div>
      <div className="activity-list">
        {items.map((item) => (
          <button className="activity-item" key={item.id}>
            <span className={`activity-icon badge-${item.tier}`}>
              {item.tier === "sanctioned" ? (
                <Landmark size={17} />
              ) : item.amount.startsWith("+") ? (
                <ArrowDownLeft size={17} />
              ) : (
                <ArrowUpRight size={17} />
              )}
            </span>
            <span className="activity-copy">
              <strong>{item.title}</strong>
              <small>{item.meta}</small>
            </span>
            <span className="activity-amount">
              <strong>{item.amount}</strong>
              <Badge tone={item.tier}>{tierLabels[item.tier]}</Badge>
            </span>
          </button>
        ))}
      </div>
      <Card className="audit-note">
        <ShieldCheck size={18} />
        <p>
          <strong>Complete audit trail</strong>
          <span>Every assessment, approval, and signature is recorded.</span>
        </p>
      </Card>
    </div>
  )
}

function SettingsScreen({
  personaId,
  settings,
  saved,
  onChange,
  onSave,
}: {
  personaId: PersonaId
  settings: SecuritySettings
  saved: boolean
  onChange: (settings: SecuritySettings) => void
  onSave: () => void
}) {
  const persona = getPersona(personaId)
  return (
    <div className="extension-screen settings-screen">
      <div className="screen-title-row">
        <div>
          <span className="eyebrow">{APP_NAME.toUpperCase()} POLICY</span>
          <h2>Security settings</h2>
        </div>
        <Badge tone="low">Active</Badge>
      </div>
      <Card className="profile-setting">
        <span className="protection-icon">
          <ShieldCheck size={18} />
        </span>
        <div>
          <small>Risk profile</small>
          <strong>{persona.name}</strong>
        </div>
        <Badge tone="brand">Synced</Badge>
      </Card>
      <div className="settings-form">
        <Field
          label="Limit per transaction (% of balance)"
          type="number"
          min="0"
          max="100"
          value={settings.transactionLimit}
          onChange={(event) =>
            onChange({
              ...settings,
              transactionLimit: Number(event.target.value),
            })
          }
          hint="0 disables this policy"
        />
        <Field
          label="Daily cap (USD)"
          type="number"
          min="0"
          value={settings.dailyLimit}
          onChange={(event) =>
            onChange({ ...settings, dailyLimit: Number(event.target.value) })
          }
          hint="Transactions above the cap need enhanced confirmation"
        />
        <Field
          label="Extra confirmation above (% of balance)"
          type="number"
          min="0"
          max="100"
          value={settings.confirmationThreshold}
          onChange={(event) =>
            onChange({
              ...settings,
              confirmationThreshold: Number(event.target.value),
            })
          }
        />
        <Field
          label="Request expires after (minutes)"
          type="number"
          min="1"
          value={settings.expiryMinutes}
          onChange={(event) =>
            onChange({ ...settings, expiryMinutes: Number(event.target.value) })
          }
        />
      </div>
      <Button
        className="full-width"
        size="lg"
        onClick={onSave}
        icon={saved ? <Check size={17} /> : <ShieldCheck size={17} />}
      >
        {saved ? "Settings saved" : "Sign and save settings"}
      </Button>
      <div className="settings-meta">
        <div>
          <span>
            <KeyRound size={16} /> Passkey
          </span>
          <Badge tone="low">Active</Badge>
        </div>
        <div>
          <span>
            <WalletCards size={16} /> Account
          </span>
          <button>
            7Vxq…3A9m <Copy size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}
