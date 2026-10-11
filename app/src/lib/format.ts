import type { RiskBand } from "./ferra"

export function shortAddr(a: string, head = 6, tail = 4): string {
  if (!a) return ""
  const s = a.includes(":") && !a.startsWith("0x") ? a : a // TON "0:abc…" keeps its prefix
  if (s.length <= head + tail + 2) return s
  return `${s.slice(0, head)}…${s.slice(-tail)}`
}

export function shortNode(id: string): string {
  const i = id.indexOf(":")
  return i < 0 ? shortAddr(id) : shortAddr(id.slice(i + 1))
}

export function networkOf(id: string): string {
  const i = id.indexOf(":")
  return i < 0 ? "" : id.slice(0, i)
}

export function fmtAmount(units: number, symbol = ""): string {
  if (!isFinite(units)) return "–"
  const abs = Math.abs(units)
  let s: string
  if (abs === 0) s = "0"
  else if (abs >= 1000)
    s = units.toLocaleString(undefined, { maximumFractionDigits: 0 })
  else if (abs >= 1)
    s = units.toLocaleString(undefined, { maximumFractionDigits: 2 })
  else if (abs >= 0.0001)
    s = units.toLocaleString(undefined, { maximumFractionDigits: 4 })
  else s = units.toExponential(2)
  return symbol ? `${s} ${symbol}` : s
}

export function fmtDate(ts: number | null | undefined): string {
  if (!ts) return "–"
  return new Date(ts * 1000).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function fmtDay(ts: number | null | undefined): string {
  if (!ts) return "–"
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  })
}

export function relTime(
  ts: number | null | undefined,
  now = Date.now() / 1000,
): string {
  if (!ts) return ""
  const d = Math.max(0, now - ts)
  if (d < 60) return "just now"
  if (d < 3600) return `${Math.floor(d / 60)} min ago`
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} days ago`
  if (d < 86400 * 365) return `${Math.floor(d / (86400 * 30))} months ago`
  return `${(d / (86400 * 365)).toFixed(1)} years ago`
}

export function fmtDuration(secs: number): string {
  if (secs < 3600) return `${Math.round(secs / 60)} min`
  if (secs < 86400) return `${Math.round(secs / 3600)} h`
  return `${Math.round(secs / 86400)} days`
}

export const BAND_RANK: Record<string, number> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
}
export function bandRank(b: RiskBand | null | undefined): number {
  return b ? BAND_RANK[b] : 0
}
export function worstBand(
  a: RiskBand | null,
  b: RiskBand | null,
): RiskBand | null {
  return bandRank(a) >= bandRank(b) ? a : b
}

export function kindLabel(kind: string): string {
  return kind.replace(/_/g, " ")
}

export async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* clipboard unavailable in the preview */
  }
}
