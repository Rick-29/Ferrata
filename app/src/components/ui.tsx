import type { ReactNode } from "react"
import { riskColor, type RiskBand } from "@/lib/ferra"

export const Icon = ({ name, size = 18 }: { name: string; size?: number }) => {
  const paths: Record<string, ReactNode> = {
    file: (
      <>
        <path d="M5 2.8h8l4 4V21H5z" />
        <path d="M13 2.8V7h4M8 12h6M8 16h6" />
      </>
    ),
    report: (
      <>
        <path d="M4 19V5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1 0-4h12" />
        <path d="M8 7h6M8 11h5" />
      </>
    ),
    graph: (
      <>
        <circle cx="5" cy="12" r="2.2" />
        <circle cx="12" cy="6" r="2.2" />
        <circle cx="19" cy="14" r="2.2" />
        <path d="m7 10.5 3.2-3M14 7.5l3.3 4.8" />
      </>
    ),
    shield: (
      <>
        <path d="M12 2.5 20 6v5.5c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6z" />
        <path d="m8.5 12 2.3 2.3 4.8-5" />
      </>
    ),
    alert: (
      <>
        <path d="m12 3 9 17H3z" />
        <path d="M12 9v5M12 17.5v.1" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m15.5 15.5 5 5" />
      </>
    ),
    check: <path d="m5 12 4.5 4.5L19 7" />,
    close: <path d="m5 5 14 14M19 5 5 19" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    copy: (
      <>
        <rect x="8" y="8" width="11" height="12" rx="2" />
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2" />
      </>
    ),
    fit: (
      <>
        <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
      </>
    ),
    upload: (
      <>
        <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" />
        <path d="M4 15v5h16v-5" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: (
      <>
        <path d="M20 12a8 8 0 1 1-2.3-5.7" />
        <path d="M20 4v5h-5" />
      </>
    ),
    link: (
      <>
        <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 6.8" />
        <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" />
      </>
    ),
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
      </>
    ),
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </>
    ),
    moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
    layout: (
      <>
        <rect x="3" y="4" width="7" height="16" rx="1" />
        <rect x="14" y="4" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="6" rx="1" />
      </>
    ),
  }
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

export const RiskChip = ({
  risk,
  small = false,
  trusted = true,
}: {
  risk: RiskBand | null
  small?: boolean
  trusted?: boolean
}) => (
  <span
    className={`risk-chip ${small ? "small" : ""}`}
    style={{ "--risk": riskColor(risk, trusted) } as React.CSSProperties}
  >
    <span className="risk-dot" />
    {!trusted ? "Untrusted" : (risk ?? "Pending")}
  </span>
)

export const NetworkBadge = ({
  name,
  title,
}: {
  name: string
  title?: string
}) => {
  const n = name.toLowerCase()
  const key = n.includes("sepolia")
    ? "sepolia"
    : n.startsWith("eth")
      ? "ethereum"
      : n.startsWith("ton")
        ? "ton"
        : n.startsWith("bitcoin") || n.startsWith("btc")
          ? "bitcoin"
          : n.startsWith("sol")
            ? "solana"
            : n.startsWith("ferra")
              ? "ferra"
              : n
  return (
    <span className={`network network-${key}`} title={title ?? name}>
      {name.slice(0, 3).toUpperCase()}
    </span>
  )
}
