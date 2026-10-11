import {
  ArrowLeft,
  ArrowRight,
  Check,
  Fingerprint,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react"
import { useState } from "react"
import { FerrataSignInError, signInWithFerrata, type FerrataIdentity } from "../lib/ferrata"
import type { JourneyStep } from "../types"
import Brand from "./Brand"
import { Badge, Button, Card } from "./ui"
import { APP_NAME } from "@sqw/brand"

/** Messages for each way sign-in through the extension can end without a client. */
const SIGN_IN_ERRORS: Record<FerrataSignInError["reason"], string> = {
  not_installed:
    "Ferrata extension not found. Install it (chrome://extensions → Load unpacked → frontend/packages/extension/dist), then reload this page.",
  refused: "Sign-in cancelled in the Ferrata window.",
  not_allowed: "The Ferrata extension does not allow this site to sign in.",
  failed: "Sign-in failed. Please try again.",
}

export default function AuthFlow({
  step,
  onBack,
  onContinue,
  onSignedIn,
}: {
  step: Extract<JourneyStep, "signin" | "passkey">
  onBack: () => void
  onContinue: () => void
  /** Real sign-in: the Ferrata extension ran the Swissquote login and the passkey. */
  onSignedIn: (identity: FerrataIdentity) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const submit = async () => {
    setError(null)
    setLoading(true)
    try {
      onSignedIn(await signInWithFerrata())
    } catch (cause) {
      setError(cause instanceof FerrataSignInError ? SIGN_IN_ERRORS[cause.reason] : SIGN_IN_ERRORS.failed)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page">
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={17} /> Back
      </button>
      <div className="auth-layout">
        <div className="auth-story">
          <Brand />
          <Badge tone="brand">SWISSQUOTE SIGN-IN</Badge>
          <h1>Swissquote identity. {APP_NAME} dual signature.</h1>
          <p>
            Your funds remain yours. Swissquote evaluates and adds its signature to sensitive
            actions, but can never move assets without you.
          </p>
          <div className="auth-benefits">
            <span>
              <ShieldCheck /> Policy checks before signing
            </span>
            <span>
              <Fingerprint /> Passkey-backed approval
            </span>
            <span>
              <LockKeyhole /> Auditable dual signature
            </span>
          </div>
        </div>

        <Card className="auth-card">
          <div className="auth-progress" aria-label="Authentication progress">
            {["Swissquote ID", "Passkey", "Ready"].map((label, index) => {
              const activeIndex = step === "signin" ? 0 : 1
              return (
                <div
                  key={label}
                  className={
                    index <= activeIndex
                      ? "progress-step active"
                      : "progress-step"
                  }
                >
                  <span>
                    {index < activeIndex ? <Check size={13} /> : index + 1}
                  </span>
                  <small>{label}</small>
                </div>
              )
            })}
          </div>

          {step === "signin" ? (
            <>
              <div className="auth-card-heading">
                <span className="eyebrow">WELCOME BACK</span>
                <h2>Sign in to {APP_NAME}</h2>
                <p>
                  Sign in with your {APP_NAME} wallet. A window opens: your
                  Swissquote login, then your passkey (fingerprint, face or
                  PIN). This site never sees a password or a key.
                </p>
              </div>
              <div className="demo-credentials">
                <span>Demo access</span>
                <code>alice / demo</code>
              </div>
              {error && (
                <p className="field-error" role="alert">
                  {error}
                </p>
              )}
              <Button
                className="full-width"
                size="lg"
                loading={loading}
                onClick={() => void submit()}
                icon={<Fingerprint size={18} />}
              >
                {loading ? "Confirm in the Ferrata window…" : `Sign in with ${APP_NAME}`}
              </Button>
            </>
          ) : (
            <div className="passkey-panel">
              <span className="passkey-visual">
                <Fingerprint size={38} />
              </span>
              <div>
                <span className="eyebrow">PASSKEY CONFIRMATION</span>
                <h2>Confirm it’s you</h2>
                <p>
                  Use this device’s passkey to unlock {APP_NAME}. This prototype
                  simulates the device prompt.
                </p>
              </div>
              <div className="device-card">
                <span>
                  <LockKeyhole size={20} />
                </span>
                <div>
                  <strong>This device</strong>
                  <small>Chrome · Passkey available</small>
                </div>
                <Badge tone="low">Ready</Badge>
              </div>
              <Button
                className="full-width"
                size="lg"
                onClick={onContinue}
                icon={<ArrowRight size={18} />}
              >
                Confirm with passkey
              </Button>
              <Button className="full-width" variant="ghost" onClick={onBack}>
                Use another method
              </Button>
            </div>
          )}
        </Card>
      </div>
      <p className="prototype-note">
        Interactive prototype · No real credentials are processed
      </p>
    </div>
  )
}
