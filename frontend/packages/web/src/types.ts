export type Theme = "light" | "dark"

export type JourneyStep = "landing" | "signin" | "passkey" | "profile" | "dashboard"

export type PersonaId = "holder" | "active" | "frequency"

export type RiskTier = "low" | "moderate" | "high" | "refused"

export type ScenarioId = "routine" | "exposure" | "mismatch" | "regulatory"

export type ExtensionScreen = "home" | "connect" | "compose" | "review" | "passkey" | "success" | "activity" | "settings"

export type DashboardSection = "overview" | "risk" | "activity" | "security"

export interface Persona {
  id: PersonaId
  name: string
  shortName: string
  description: string
  emphasis: string
  transactionLimit: string
  dailyLimit: string
  insight: string
}

export interface Scenario {
  id: ScenarioId
  tier: RiskTier
  label: string
  title: string
  summary: string
  amount: string
  asset: string
  destination: string
  reasons: string[]
  action: string
}

export interface RiskReport {
  score: number
  tier: RiskTier
  headline: string
  personalReason: string
}

export interface ActivityItem {
  id: string
  title: string
  meta: string
  amount: string
  tier: RiskTier
}

export interface SecuritySettings {
  transactionLimit: number
  dailyLimit: number
  confirmationThreshold: number
  expiryMinutes: number
}
