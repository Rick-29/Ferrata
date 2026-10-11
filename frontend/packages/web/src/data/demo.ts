import type {
  ActivityItem,
  Persona,
  PersonaId,
  RiskReport,
  Scenario,
  ScenarioId,
} from "../types"
import { APP_NAME } from "@sqw/brand"

export const personas: Persona[] = [
  {
    id: "holder",
    name: "Long-term Holder",
    shortName: "Holder",
    description: "You move assets rarely and prioritize capital preservation.",
    emphasis: "Unusual transfers and destination integrity",
    transactionLimit: "10% of balance",
    dailyLimit: "$50,000",
    insight:
      `${APP_NAME} will add friction when an action differs sharply from your usual long-term pattern.`,
  },
  {
    id: "active",
    name: "Active Trader",
    shortName: "Active Trader",
    description:
      "You trade regularly and want balanced risk analysis without slowing down.",
    emphasis: "Market quality, slippage, and exposure",
    transactionLimit: "25% of balance",
    dailyLimit: "$250,000",
    insight:
      "Your risk model balances execution speed with concentration and market-quality checks.",
  },
  {
    id: "frequency",
    name: "High-Frequency Trader",
    shortName: "Frequency Trader",
    description:
      "You interact with dApps frequently and expect high wallet turnover.",
    emphasis: "Contract integrity and counterparty signals",
    transactionLimit: "50% of balance",
    dailyLimit: "$2,000,000",
    insight:
      "Routine volume creates less friction; known malicious contracts still trigger the strongest warning and a second confirmation.",
  },
]

export const scenarios: Scenario[] = [
  {
    id: "routine",
    tier: "low",
    label: "Routine trade",
    title: "Verified dApp swap",
    summary:
      "A small SOL swap through a recognized program with normal slippage.",
    amount: "0.80",
    asset: "SOL",
    destination: "DemoSwap · DSwp…9Ke",
    reasons: [
      "Recognized program on a verified domain",
      "Transaction size fits your pattern",
      "Slippage is within your policy",
    ],
    action: "Continue with passkey",
  },
  {
    id: "exposure",
    tier: "moderate",
    label: "High exposure",
    title: "Concentrated token position",
    summary:
      "This trade would place a material share of your available SOL into one new token.",
    amount: "18.40",
    asset: "SOL",
    destination: "DemoSwap · DSwp…9Ke",
    reasons: [
      "Position concentration reaches 34%",
      "Token launched 18 minutes ago",
      "Liquidity is currently limited",
    ],
    action: "Acknowledge and continue",
  },
  {
    id: "mismatch",
    tier: "high",
    label: "Profile mismatch",
    title: "Large USDC transfer",
    summary:
      "A high-value transfer to a new address that may not match your expected behavior.",
    amount: "1,000,000",
    asset: "USDC",
    destination: "0x8d20…91E4",
    reasons: [
      "Destination has no prior history",
      "Amount exceeds your default policy",
      "No matching Swissquote beneficiary",
    ],
    action: "Complete enhanced confirmation",
  },
  {
    id: "regulatory",
    tier: "sanctioned",
    label: "Sanctioned address",
    title: "Transfer to a sanctioned address",
    summary:
      "This address is on a public sanctions list. Swissquote strongly advises against it, but the decision is yours.",
    amount: "2,500",
    asset: "USDC",
    destination: "0x71cB…0A19",
    // Self-custody: Swissquote warns and explains, it never refuses. Sanctions lists are public.
    reasons: [
      "Destination is on a public sanctions list (SECO, UN, OFAC)",
      "Sending funds there may be illegal for you",
    ],
    action: "Acknowledge and continue",
  },
]

const reports: Record<ScenarioId, Record<PersonaId, RiskReport>> = {
  routine: {
    holder: {
      score: 14,
      tier: "low",
      headline: "This action appears consistent and low risk.",
      personalReason:
        "The amount is small enough to remain within your holder policy.",
    },
    active: {
      score: 9,
      tier: "low",
      headline: "This looks like a routine verified trade.",
      personalReason:
        "The size and venue align with your regular trading profile.",
    },
    frequency: {
      score: 6,
      tier: "low",
      headline: "No material anomaly detected.",
      personalReason:
        "This interaction fits your established high-frequency activity.",
    },
  },
  exposure: {
    holder: {
      score: 68,
      tier: "high",
      headline: "This trade creates unusual concentration.",
      personalReason:
        "A new speculative asset would become a major position for a long-term holder.",
    },
    active: {
      score: 48,
      tier: "moderate",
      headline: "Review the concentration before continuing.",
      personalReason:
        "The trade is plausible for you, but its size and liquidity deserve attention.",
    },
    frequency: {
      score: 38,
      tier: "moderate",
      headline: "Market conditions add execution risk.",
      personalReason:
        "The activity is familiar, but the current liquidity is below your normal range.",
    },
  },
  mismatch: {
    holder: {
      score: 91,
      tier: "high",
      headline: "This transfer is highly unusual for you.",
      personalReason:
        "The amount is 20× your daily policy and goes to a new destination.",
    },
    active: {
      score: 76,
      tier: "high",
      headline: "This transfer requires enhanced confirmation.",
      personalReason:
        "The value is above your expected range and the destination is new.",
    },
    frequency: {
      score: 57,
      tier: "moderate",
      headline: "The size is plausible, but the destination needs review.",
      personalReason:
        "High turnover fits your profile; the unrecognized counterparty does not.",
    },
  },
  regulatory: {
    holder: {
      score: 100,
      tier: "sanctioned",
      headline: "This address is on a sanctions list. Swissquote strongly advises against sending.",
      personalReason:
        "This applies to every profile. Swissquote does not block it: you remain the sole decision-maker.",
    },
    active: {
      score: 100,
      tier: "sanctioned",
      headline: "This address is on a sanctions list. Swissquote strongly advises against sending.",
      personalReason:
        "This applies to every profile. Swissquote does not block it: you remain the sole decision-maker.",
    },
    frequency: {
      score: 100,
      tier: "sanctioned",
      headline: "This address is on a sanctions list. Swissquote strongly advises against sending.",
      personalReason:
        "This applies to every profile. Swissquote does not block it: you remain the sole decision-maker.",
    },
  },
}

export function getPersona(id: PersonaId) {
  return personas.find((persona) => persona.id === id) ?? personas[1]
}

export function getScenario(id: ScenarioId) {
  return scenarios.find((scenario) => scenario.id === id) ?? scenarios[0]
}

export function getRiskReport(scenarioId: ScenarioId, personaId: PersonaId) {
  return reports[scenarioId][personaId]
}

export const activity: ActivityItem[] = [
  {
    id: "1",
    title: "DemoSwap trade",
    meta: "Today, 14:32 · 6EF8…F6P",
    amount: "−0.80 SOL",
    tier: "low",
  },
  {
    id: "2",
    title: "USDC transfer",
    meta: "Yesterday, 18:11 · 0x8d20…91E4",
    amount: "−12,400 USDC",
    tier: "moderate",
  },
  {
    id: "3",
    title: "USDC received",
    meta: "May 18, 10:04 · Swissquote",
    amount: "+25,000 USDC",
    tier: "low",
  },
  {
    id: "4",
    title: "Transfer to sanctioned address cancelled by you",
    meta: "May 17, 21:48 · after warning",
    amount: "Not sent",
    tier: "sanctioned",
  },
]
