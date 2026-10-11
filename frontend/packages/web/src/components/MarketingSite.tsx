import {
  ArrowRight,
  Blocks,
  Check,
  ChevronDown,
  Fingerprint,
  LockKeyhole,
  Moon,
  Network,
  ShieldCheck,
  Sun,
  Zap,
} from "lucide-react"
import type { Theme } from "../types"
import Brand from "./Brand"
import { Badge, Button, Card } from "./ui"
import { APP_NAME } from "@sqw/brand"

export default function MarketingSite({
  theme,
  onThemeChange,
  onStart,
}: {
  theme: Theme
  onThemeChange: () => void
  onStart: () => void
}) {
  return (
    <div className="marketing-page">
      <header className="marketing-header">
        <Brand />
        <nav className="desktop-nav" aria-label="Primary navigation">
          <a href="#product">Product</a>
          <a href="#security">Security</a>
          <a href="#how">How it works</a>
        </nav>
        <div className="header-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={onThemeChange}
            aria-label={`Switch to ${
              theme === "dark" ? "light" : "dark"
            } theme`}
            icon={theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          >
            <span className="desktop-only">
              {theme === "dark" ? "Light" : "Dark"}
            </span>
          </Button>
          <Button size="sm" onClick={onStart}>
            Access wallet
          </Button>
        </div>
      </header>

      <main>
        <section className="hero" id="product">
          <div className="hero-copy">
            <Badge tone="brand">
              <ShieldCheck size={14} />
              Dual signature with Swissquote
            </Badge>
            <h1>Your crypto wallet, with a second signature.</h1>
            <p className="hero-lede">
              {APP_NAME} gives you direct access to Ethereum and Solana while
              Swissquote assesses, signs, and records every critical action.
            </p>
            <div className="hero-actions">
              <Button
                size="lg"
                onClick={onStart}
                icon={<ArrowRight size={18} />}
              >
                Explore the wallet
              </Button>
              <Button
                size="lg"
                variant="secondary"
                onClick={() =>
                  document
                    .querySelector("#how")
                    ?.scrollIntoView({ behavior: "smooth" })
                }
                icon={<ChevronDown size={18} />}
              >
                See how it works
              </Button>
            </div>
            <div className="trust-row">
              <span>
                <Check size={15} /> Non-custodial control
              </span>
              <span>
                <Check size={15} /> Passkey signed
              </span>
              <span>
                <Check size={15} /> Real-time assessment
              </span>
            </div>
          </div>

          <div
            className="hero-product"
            aria-label={`${APP_NAME} wallet risk review preview`}
          >
            <div className="ambient ambient-one" />
            <div className="ambient ambient-two" />
            <div className="browser-frame">
              <div className="browser-bar">
                <span />
                <span />
                <span />
                <div className="browser-domain">
                  <LockKeyhole size={12} />
                  demoswap.example
                </div>
              </div>
              <div className="preview-wallet">
                <div className="preview-header">
                  <Brand compact />
                  <Badge tone="moderate">Moderate · 48</Badge>
                </div>
                <div className="preview-kicker">REVIEW THIS TRADE</div>
                <div className="preview-amount">
                  18.40 <small>SOL</small>
                </div>
                <div className="token-route">
                  <span className="token-orb">S</span>
                  <div>
                    <strong>SOL → MOONCAT</strong>
                    <small>via a verified DemoSwap program</small>
                  </div>
                </div>
                <div className="preview-risk">
                  <div className="risk-icon">
                    <Zap size={18} />
                  </div>
                  <div>
                    <strong>Position concentration reaches 34%</strong>
                    <p>Higher than your usual exposure to a new token.</p>
                  </div>
                </div>
                <Button className="full-width">Review with {APP_NAME}</Button>
              </div>
            </div>
          </div>
        </section>

        <section className="trust-strip" aria-label="Product capabilities">
          <div>
            <strong>2</strong>
            <span>Networks supported</span>
          </div>
          <div>
            <strong>&lt;2s</strong>
            <span>Typical assessment</span>
          </div>
          <div>
            <strong>24/7</strong>
            <span>Policy monitoring</span>
          </div>
          <div>
            <strong>1</strong>
            <span>Swissquote identity</span>
          </div>
        </section>

        <section className="section how-section" id="how">
          <div className="section-heading">
            <span className="eyebrow">HOW {APP_NAME.toUpperCase()} WORKS</span>
            <h2>Move fast. Stay deliberate.</h2>
            <p>
              Risk analysis that appears at the moment it matters, not as another
              dashboard to manage. You always decide.
            </p>
          </div>
          <div className="process-grid">
            {[
              {
                icon: <Network />,
                number: "01",
                title: "Connect",
                copy: "Use Ethereum and Solana dApps with one Swissquote-linked identity.",
              },
              {
                icon: <Blocks />,
                number: "02",
                title: "Assess",
                copy: `${APP_NAME} checks contract, market, destination, policy, and personal context.`,
              },
              {
                icon: <Fingerprint />,
                number: "03",
                title: "Sign",
                copy: "Approve with your passkey. Swissquote adds the second signature and records the audit trail.",
              },
            ].map((item) => (
              <Card key={item.number} className="process-card">
                <span className="process-number">{item.number}</span>
                <span className="process-icon">{item.icon}</span>
                <h3>{item.title}</h3>
                <p>{item.copy}</p>
              </Card>
            ))}
          </div>
        </section>

        <section className="section adaptive-section" id="security">
          <div className="adaptive-panel">
            <div className="adaptive-copy">
              <span className="eyebrow">ANALYSIS SHAPED AROUND YOU</span>
              <h2>One transfer. Three different signals.</h2>
              <p>
                A $1M transfer can be routine for one customer and a serious
                anomaly for another. {APP_NAME} considers how you use crypto—not
                only what the transaction contains.
              </p>
              <Button
                variant="secondary"
                onClick={onStart}
                icon={<ArrowRight size={18} />}
              >
                Build your profile
              </Button>
            </div>
            <div className="persona-stack">
              <div className="persona-row">
                <div>
                  <span>Long-term Holder</span>
                  <small>Rare high-value activity</small>
                </div>
                <Badge tone="high">High · 91</Badge>
              </div>
              <div className="persona-row">
                <div>
                  <span>Active Trader</span>
                  <small>Above expected daily range</small>
                </div>
                <Badge tone="high">High · 76</Badge>
              </div>
              <div className="persona-row active">
                <div>
                  <span>Frequency Trader</span>
                  <small>Volume fits; destination is new</small>
                </div>
                <Badge tone="moderate">Moderate · 57</Badge>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="marketing-footer">
        <Brand compact />
        <span>Interactive prototype · No real funds or credentials</span>
        <span>© 2025 Swissquote Group</span>
      </footer>
    </div>
  )
}
