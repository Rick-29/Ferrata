import { useEffect, useState } from "react"
import AuthFlow from "./components/AuthFlow"
import CustomerDashboard from "./components/CustomerDashboard"
import MarketingSite from "./components/MarketingSite"
import ProfileSetup from "./components/ProfileSetup"
import type { FerrataIdentity } from "./lib/ferrata"
import type { JourneyStep, PersonaId, ScenarioId, Theme } from "./types"

function getInitialTheme(): Theme {
  const saved = window.localStorage.getItem("ferrata-theme")
  if (saved === "light" || saved === "dark") return saved
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark"
}

export default function App() {
  const [step, setStep] = useState<JourneyStep>("landing")
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [persona, setPersona] = useState<PersonaId>("active")
  const [scenario, setScenario] = useState<ScenarioId>("exposure")
  /** Who signed in through the Ferrata extension (passkey verified by Swissquote). */
  const [identity, setIdentity] = useState<FerrataIdentity | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    window.localStorage.setItem("ferrata-theme", theme)
  }, [theme])

  const toggleTheme = () =>
    setTheme((current) => (current === "dark" ? "light" : "dark"))

  if (step === "landing") {
    return (
      <MarketingSite
        theme={theme}
        onThemeChange={toggleTheme}
        onStart={() => setStep("signin")}
      />
    )
  }

  if (step === "signin" || step === "passkey") {
    return (
      <AuthFlow
        step={step}
        onBack={() => setStep(step === "signin" ? "landing" : "signin")}
        onContinue={() => setStep(step === "signin" ? "passkey" : "profile")}
        onSignedIn={(signedIn) => {
          // The passkey step already happened in the Ferrata window.
          setIdentity(signedIn)
          setStep("profile")
        }}
      />
    )
  }

  if (step === "profile") {
    return (
      <ProfileSetup
        initialPersona={persona}
        onBack={() => setStep("passkey")}
        onComplete={(nextPersona) => {
          setPersona(nextPersona)
          setStep("dashboard")
        }}
      />
    )
  }

  return (
    <CustomerDashboard
      theme={theme}
      personaId={persona}
      scenarioId={scenario}
      onThemeChange={toggleTheme}
      onPersonaChange={setPersona}
      onScenarioChange={setScenario}
      identity={identity}
      onRestart={() => {
        setIdentity(null)
        setStep("landing")
        setScenario("exposure")
      }}
    />
  )
}
