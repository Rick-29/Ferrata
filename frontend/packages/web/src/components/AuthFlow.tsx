import {
  ArrowLeft,
  ArrowRight,
  Check,
  Fingerprint,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react"
import { useState } from "react"
import type { JourneyStep } from "../types"
import Brand from "./Brand"
import { Badge, Button, Card, Field } from "./ui"
import { APP_NAME } from "@sqw/brand"

export default function AuthFlow({
  step,
  onBack,
  onContinue,
}: {
  step: Extract<JourneyStep, "signin" | "passkey">
  onBack: () => void
  onContinue: () => void
}) {
  const [userId, setUserId] = useState("ferrata.demo")
  const [password, setPassword] = useState("swissquote")
  const [errors, setErrors] = useState<{ userId?: string; password?: string }>(
    {},
  )
  const [loading, setLoading] = useState(false)

  const submit = () => {
    const nextErrors = {
      userId: userId.trim() ? undefined : "Enter your demo Swissquote ID",
      password: password.trim() ? undefined : "Enter your demo password",
    }
    setErrors(nextErrors)
    if (nextErrors.userId || nextErrors.password) return
    setLoading(true)
    window.setTimeout(() => {
      setLoading(false)
      onContinue()
    }, 650)
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
          <h1>Swissquote identity. {APP_NAME} co-signing.</h1>
          <p>
            Your funds remain yours. Swissquote evaluates and co-signs sensitive
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
              <LockKeyhole /> Auditable co-signing
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
                  Use the demo details below. Never enter real credentials in
                  this prototype.
                </p>
              </div>
              <div className="demo-credentials">
                <span>Demo access</span>
                <code>ferrata.demo / swissquote</code>
              </div>
              <div className="auth-fields">
                <Field
                  label="Swissquote ID"
                  value={userId}
                  onChange={(event) => setUserId(event.target.value)}
                  error={errors.userId}
                  autoComplete="username"
                />
                <Field
                  label="Password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  error={errors.password}
                  type="password"
                  autoComplete="current-password"
                />
              </div>
              <Button
                className="full-width"
                size="lg"
                loading={loading}
                onClick={submit}
              >
                {loading ? "Checking identity" : "Continue"}
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
