import {
  Activity,
  Bell,
  ChevronDown,
  CircleHelp,
  Command,
  ExternalLink,
  Gauge,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  RotateCcw,
  Settings,
  ShieldCheck,
  Sun,
  TrendingUp,
  WalletCards,
  X,
} from "lucide-react"
import { useState } from "react"
import {
  getPersona,
  getRiskReport,
  getScenario,
  personas,
  scenarios,
} from "../data/demo"
import type { DashboardSection, PersonaId, ScenarioId, Theme } from "../types"
import Brand from "./Brand"
import ExtensionShell from "./ExtensionShell"
import { Badge, Button, Card, Segmented } from "./ui"
import { APP_NAME } from "@sqw/brand"

export default function CustomerDashboard({
  theme,
  personaId,
  scenarioId,
  onThemeChange,
  onPersonaChange,
  onScenarioChange,
  onRestart,
}: {
  theme: Theme
  personaId: PersonaId
  scenarioId: ScenarioId
  onThemeChange: () => void
  onPersonaChange: (persona: PersonaId) => void
  onScenarioChange: (scenario: ScenarioId) => void
  onRestart: () => void
}) {
  const [section, setSection] = useState<DashboardSection>("overview")
  const [mobileMenu, setMobileMenu] = useState(false)
  const persona = getPersona(personaId)
  const scenario = getScenario(scenarioId)
  const report = getRiskReport(scenarioId, personaId)
  const navigation = [
    {
      id: "overview" as const,
      label: "Overview",
      icon: <LayoutDashboard size={18} />,
    },
    { id: "risk" as const, label: "Risk center", icon: <Gauge size={18} /> },
    {
      id: "activity" as const,
      label: "Activity",
      icon: <Activity size={18} />,
    },
    {
      id: "security" as const,
      label: "Security profile",
      icon: <ShieldCheck size={18} />,
    },
  ]

  return (
    <div className="dashboard">
      <aside
        className={mobileMenu ? "dashboard-sidebar open" : "dashboard-sidebar"}
      >
        <div className="sidebar-brand">
          <Brand />
          <button className="mobile-close" onClick={() => setMobileMenu(false)}>
            <X />
          </button>
        </div>
        <nav aria-label="Customer dashboard">
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
              {item.id === "risk" && <Badge tone="moderate">2</Badge>}
            </button>
          ))}
        </nav>
        <div className="sidebar-help">
          <CircleHelp size={19} />
          <strong>Need help?</strong>
          <span>Talk to the Swissquote digital assets team.</span>
          <button>
            Open support <ExternalLink size={13} />
          </button>
        </div>
        <button className="restart-button" onClick={onRestart}>
          <RotateCcw size={17} /> Restart demo
        </button>
        <div className="sidebar-profile">
          <span className="user-avatar">JD</span>
          <span>
            <strong>Jordan Davis</strong>
            <small>Client · CH-8042</small>
          </span>
          <ChevronDown size={16} />
        </div>
      </aside>

      <div className="dashboard-main">
        <header className="dashboard-header">
          <button
            className="mobile-menu"
            onClick={() => setMobileMenu(true)}
            aria-label="Open navigation"
          >
            <Menu />
          </button>
          <div className="dashboard-command">
            <Command size={16} />
            <span>Search or jump to…</span>
            <kbd>⌘ K</kbd>
          </div>
          <div className="dashboard-header-actions">
            <button
              onClick={onThemeChange}
              aria-label={`Switch to ${
                theme === "dark" ? "light" : "dark"
              } theme`}
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button aria-label="Notifications">
              <Bell size={18} />
              <span className="notification-dot" />
            </button>
            <Badge tone="low">
              <span className="live-dot" /> Systems operational
            </Badge>
          </div>
        </header>

        <main className="dashboard-content">
          <div className="dashboard-title">
            <div>
              <span className="eyebrow">{APP_NAME.toUpperCase()} CONTROL CENTER</span>
              <h1>Good morning, Jordan.</h1>
              <p>
                Co-signing and risk analysis are active on your account.
              </p>
            </div>
            <Button variant="secondary" icon={<WalletCards size={17} />}>
              Wallet 7Vxq…3A9m
            </Button>
          </div>

          <Card className="demo-control">
            <div className="demo-control-copy">
              <span>
                <Badge tone="brand">LIVE DEMO</Badge> See how {APP_NAME} adapts
              </span>
              <p>
                Switch profile and scenario. The embedded wallet updates
                immediately.
              </p>
            </div>
            <Segmented
              label="Risk profile"
              value={personaId}
              onChange={onPersonaChange}
              options={personas.map((item) => ({
                value: item.id,
                label: item.shortName,
              }))}
            />
          </Card>

          <div className="dashboard-grid">
            <div className="dashboard-left">
              <div className="metric-grid">
                <Card className="metric-card portfolio-metric">
                  <span className="metric-label">Total portfolio</span>
                  <strong>$184,392.60</strong>
                  <span className="positive-change">
                    <TrendingUp size={15} /> $2,184.20 (1.20%) today
                  </span>
                  <div className="allocation-bar">
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="allocation-legend">
                    <span>
                      <i className="eth-dot" />
                      ETH 34%
                    </span>
                    <span>
                      <i className="sol-dot" />
                      SOL 6%
                    </span>
                    <span>
                      <i className="stable-dot" />
                      Stablecoins 60%
                    </span>
                  </div>
                </Card>
                <Card className="metric-card">
                  <span className="metric-icon">
                    <ShieldCheck size={19} />
                  </span>
                  <span className="metric-label">Co-signing status</span>
                  <strong className="status-title">All systems active</strong>
                  <div className="status-list">
                    <span>
                      <i />
                      Swissquote co-signing
                    </span>
                    <span>
                      <i />
                      Passkey authentication
                    </span>
                    <span>
                      <i />
                      Policy monitoring
                    </span>
                  </div>
                </Card>
              </div>

              <Card className="insight-card">
                <div className="insight-topline">
                  <span className="metric-icon">
                    <Gauge size={19} />
                  </span>
                  <div>
                    <span className="eyebrow">PERSONALISED ANALYSIS</span>
                    <h2>{persona.name}</h2>
                  </div>
                  <Badge tone="low">Active</Badge>
                </div>
                <p>{persona.insight}</p>
                <div className="policy-grid">
                  <div>
                    <span>Transaction limit</span>
                    <strong>{persona.transactionLimit}</strong>
                  </div>
                  <div>
                    <span>Daily cap</span>
                    <strong>{persona.dailyLimit}</strong>
                  </div>
                  <div>
                    <span>Primary focus</span>
                    <strong>{persona.emphasis}</strong>
                  </div>
                </div>
              </Card>

              <div className="scenario-section">
                <div className="section-title-row">
                  <div>
                    <span className="eyebrow">RISK SCENARIO LAB</span>
                    <h2>Test every risk state</h2>
                  </div>
                  <span>4 deterministic demos</span>
                </div>
                <div className="scenario-grid">
                  {scenarios.map((item) => {
                    const itemReport = getRiskReport(item.id, personaId)
                    return (
                      <button
                        key={item.id}
                        onClick={() => onScenarioChange(item.id)}
                        className={
                          scenarioId === item.id
                            ? `scenario-card selected tier-${itemReport.tier}`
                            : `scenario-card tier-${itemReport.tier}`
                        }
                      >
                        <div>
                          <Badge tone={itemReport.tier}>
                            {itemReport.score}/100 · {itemReport.tier}
                          </Badge>
                          {scenarioId === item.id && (
                            <span className="selected-dot" />
                          )}
                        </div>
                        <strong>{item.label}</strong>
                        <p>{item.summary}</p>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>

            <aside className="extension-column">
              <div className="extension-column-heading">
                <div>
                  <span className="eyebrow">CHROME EXTENSION</span>
                  <strong>Live wallet preview</strong>
                </div>
                <Badge tone={report.tier}>
                  {report.tier} · {report.score}
                </Badge>
              </div>
              <ExtensionShell personaId={personaId} scenarioId={scenarioId} />
              <p className="preview-caption">
                Selected: {scenario.title} · Open the request from the wallet.
              </p>
            </aside>
          </div>
        </main>
      </div>
      {mobileMenu && (
        <button
          className="sidebar-scrim"
          onClick={() => setMobileMenu(false)}
          aria-label="Close navigation"
        />
      )}
    </div>
  )
}
