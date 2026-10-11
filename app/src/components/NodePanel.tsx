// The right-hand panel for a selected address: why it is coloured the way it is (the backend's

// reasons), the transfers with its neighbours newest first, the online preview, and the buttons

// that grow the graph from here.

import { useEffect, useState } from "react"

import { openUrl } from "@tauri-apps/plugin-opener"

import { ferra, riskColor, type NodeInsight } from "@/lib/ferra"

import type { GEdge, GNode } from "@/lib/graphStore"

import {
  copy,
  fmtAmount,
  fmtDate,
  fmtDay,
  relTime,
  shortAddr,
  shortNode,
} from "@/lib/format"

import { Icon, NetworkBadge, RiskChip } from "./ui"

interface Props {
  node: GNode

  edges: GEdge[]

  online: boolean

  close: () => void

  expand: () => void

  loadOlder: () => void

  select: (id: string) => void
}

export default function NodePanel({
  node,
  edges,
  online,
  close,
  expand,
  loadOlder,
  select,
}: Props) {
  const [tab, setTab] = useState<"why" | "transfers" | "account">("why")

  const [insight, setInsight] = useState<NodeInsight | null>(null)

  const [insightErr, setInsightErr] = useState<string | null>(null)

  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true

    setInsight(null)

    setInsightErr(null)

    setLoading(true)

    ferra

      .nodeInsight(node.id, online)

      .then((i) => alive && setInsight(i))

      .catch(
        (e) =>
          alive &&
          setInsightErr((e as { message?: string }).message ?? String(e)),
      )

      .finally(() => alive && setLoading(false))

    return () => {
      alive = false
    }
  }, [node.id, online])

  const transfers = edges

    .flatMap((e) =>
      e.transfers.map((t) => ({
        t,
        e,
        other: t.from === node.id ? t.to : t.from,
        out: t.from === node.id,
      })),
    )

    .sort((a, b) => b.t.timestamp - a.t.timestamp)

  const info = insight?.node.info ?? node.info

  const explorer =
    transfers.find((x) => x.t.explorer_url)?.t.explorer_url ?? null

  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <div>
          <span>{node.is_wallet ? "WALLET UNDER REVIEW" : "ADDRESS"}</span>
          <strong>
            <NetworkBadge name={node.network} />{" "}
            {node.label ?? shortAddr(node.address, 10, 6)}
          </strong>
        </div>
        <button className="icon-button" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <div className="detail-tabs">
        <button
          className={tab === "why" ? "active" : ""}
          onClick={() => setTab("why")}
        >
          Why{insight ? <i>{insight.reasons.length}</i> : null}
        </button>
        <button
          className={tab === "transfers" ? "active" : ""}
          onClick={() => setTab("transfers")}
        >
          Transfers<i>{transfers.length}</i>
        </button>
        <button
          className={tab === "account" ? "active" : ""}
          onClick={() => setTab("account")}
        >
          Account
        </button>
      </div>
      <div className="detail-scroll">
        <section className="event-hero">
          <div className="event-badges">
            <RiskChip risk={node.worst_risk} />
            {node.sanctioned && (
              <span className="tag critical">SANCTIONED</span>
            )}
            {node.scam && <span className="tag critical">SCAM</span>}
            {node.reports > 0 && (
              <span className="tag high">
                {node.reports} report{node.reports > 1 ? "s" : ""}
              </span>
            )}
            {node.is_account && !node.is_wallet && (
              <span className="tag">Ferra account</span>
            )}
          </div>
          <button
            className="hash-copy"
            onClick={() => void copy(node.address)}
            title="Copy address"
          >
            {node.address} <Icon name="copy" size={13} />
          </button>
          <div className="panel-actions">
            {!node.expanded ? (
              <button
                className="primary-button"
                onClick={expand}
                disabled={node.loading}
              >
                <Icon name="plus" size={14} />{" "}
                {node.loading ? "Loading…" : "Expand interactions"}
              </button>
            ) : !node.exhausted ? (
              <button
                className="secondary-button"
                onClick={loadOlder}
                disabled={node.loading}
              >
                <Icon name="plus" size={14} />{" "}
                {node.loading
                  ? "Loading…"
                  : node.cursor?.startsWith("c:")
                    ? "Load more from the chain"
                    : "Load older from the indexer"}
              </button>
            ) : (
              <span className="muted">
                All known transfers loaded
                {node.source ? ` · ${node.source}` : ""}
              </span>
            )}
            {explorer && (
              <button
                className="secondary-button"
                onClick={() => void openUrl(explorer)}
              >
                <Icon name="link" size={14} /> Explorer
              </button>
            )}
          </div>
          {node.error && <p className="error-line">{node.error}</p>}
          <p className="muted">
            {node.tx_count
              ? `${node.tx_count} transactions`
              : "no transactions seen"}{" "}
            · {node.in_count} in · {node.out_count} out
            {node.first_seen ? ` · first ${fmtDay(node.first_seen)}` : ""}
            {node.last_seen ? ` · last ${relTime(node.last_seen)}` : ""}
          </p>
        </section>

        {tab === "why" && (
          <section className="detail-section">
            <div className="section-label">REASONING</div>
            {loading && (
              <p className="muted">
                Checking the chain
                {online && !node.is_wallet ? " and the origin network" : ""}…
              </p>
            )}
            {insightErr && <p className="muted">{insightErr}</p>}
            {insight?.reasons.map((r) => (
              <div
                key={r.code}
                className="flag-card"
                style={{ borderLeftColor: riskColor(r.severity) }}
              >
                <div>
                  <RiskChip risk={r.severity} small />
                  <span>
                    {r.events.length
                      ? `${r.events.length} EVENT${
                          r.events.length > 1 ? "S" : ""
                        }`
                      : ""}
                  </span>
                </div>
                <strong>{r.code}</strong>
                <p>{r.message}</p>
              </div>
            ))}
            {insight && insight.reasons.length === 0 && (
              <p className="muted">
                Nothing on the chain involves this address yet.
              </p>
            )}
            {insight?.preview && (
              <div className="preview-box">
                <div className="section-label">
                  MODEL PREVIEW · PAYING THIS ADDRESS
                </div>
                <div className="preview-odds">
                  <RiskChip risk={insight.preview.band} />
                  <strong>
                    {insight.preview.odds_vs_baseline.toFixed(1)}×
                  </strong>
                  <small>vs. a typical transfer</small>
                </div>
                <p>{insight.preview.summary}</p>
                {insight.preview.factors.slice(0, 6).map((f) => (
                  <div key={f.code} className="contribution">
                    <span>
                      <i
                        style={{
                          width: `${Math.min(100, Math.abs(f.contribution) * 40)}%`,
                          background:
                            f.odds_multiplier >= 1 ? "#f26b1d33" : "#2eb67d33",
                        }}
                      />
                      {f.message}
                    </span>
                    <em
                      style={{
                        color: f.odds_multiplier >= 1 ? "#f18d54" : "#2eb67d",
                      }}
                    >
                      ×{f.odds_multiplier.toFixed(1)}
                    </em>
                  </div>
                ))}
                {insight.preview.provenance && (
                  <p className="muted">
                    Provenance on {insight.preview.provenance.network.name}:{" "}
                    {insight.preview.provenance.risk} (score{" "}
                    {insight.preview.provenance.score},{" "}
                    {insight.preview.provenance.events_checked} events checked)
                    {insight.preview.provenance.reasons.length
                      ? ` · ${insight.preview.provenance.reasons.map((r) => r.code).join(", ")}`
                      : ""}
                  </p>
                )}
              </div>
            )}
            {insight?.preview_error && (
              <p className="muted">Preview: {insight.preview_error}</p>
            )}
            {insight && insight.reports.length > 0 && (
              <>
                <div className="section-label" style={{ marginTop: 14 }}>
                  REPORTS · {insight.reports.length}
                </div>
                {insight.reports.map((r, i) => (
                  <div
                    key={i}
                    className="flag-card"
                    style={{ borderLeftColor: riskColor("High") }}
                  >
                    <div>
                      <strong>{r.category.toUpperCase()}</strong>
                      <span>{fmtDay(r.at)}</span>
                    </div>
                    <p>
                      {r.reason} <em className="muted">— {r.reporter}</em>
                    </p>
                  </div>
                ))}
              </>
            )}
          </section>
        )}

        {tab === "transfers" && (
          <section className="detail-section related">
            <div className="section-label row-label">
              <span>TRANSFERS · NEWEST FIRST</span>
              <span className="muted">{edges.length} counterparties</span>
            </div>
            {transfers.length === 0 && (
              <p className="muted">
                {node.expanded
                  ? "No transfers known."
                  : "Expand the node to load its transfers."}
              </p>
            )}
            {transfers.map(({ t, other, out }) => (
              <button
                key={t.id}
                onClick={() => select(other)}
                title={`Select ${other}`}
              >
                <span
                  className="rel-dot"
                  style={{
                    background: t.trusted
                      ? riskColor(t.risk)
                      : riskColor(null, false),
                  }}
                />
                <span>
                  <strong>
                    {out ? "→" : "←"}{" "}
                    {fmtAmount(t.amount_units, t.asset_symbol)}{" "}
                    {out ? "to" : "from"} {shortNode(other)}
                  </strong>
                  <small>
                    {fmtDate(t.timestamp)} · {t.network}
                    {t.kind !== "observed"
                      ? ` · ${t.kind.replace("_", " ")}`
                      : " · indexer"}
                    {t.flag_codes.length ? ` · ${t.flag_codes.join(", ")}` : ""}
                  </small>
                </span>
                <RiskChip risk={t.risk} small trusted={t.trusted} />
              </button>
            ))}
          </section>
        )}

        {tab === "account" && (
          <section className="detail-section">
            <div className="section-label">ON ITS NETWORK</div>
            {!info && (
              <p className="muted">
                {online
                  ? loading
                    ? "Fetching…"
                    : node.network === "ferra"
                      ? "Ferra accounts are described by the chain file."
                      : "No account information from the indexer."
                  : "Switch to online to fetch account information."}
              </p>
            )}
            {info && (
              <div className="kv">
                {info.name && <Row k="Name" v={info.name} />}
                {info.labels.length > 0 && (
                  <Row k="Labels" v={info.labels.join(", ")} />
                )}
                <Row
                  k="Balance"
                  v={
                    info.balance
                      ? fmtAmount(
                          Number(info.balance) / 10 ** info.native_decimals,
                          info.native_symbol,
                        )
                      : "–"
                  }
                />
                <Row
                  k="Transactions"
                  v={info.tx_count?.toLocaleString() ?? "–"}
                />
                <Row k="First seen" v={fmtDay(info.first_seen)} />
                <Row
                  k="Last active"
                  v={
                    info.last_active
                      ? `${fmtDay(info.last_active)} · ${relTime(info.last_active)}`
                      : "–"
                  }
                />
                <Row k="Contract" v={info.is_contract ? "yes" : "no"} />
                <Row k="Scam label" v={info.is_scam ? "YES" : "no"} />
                {info.tokens.slice(0, 8).map((t) => (
                  <Row
                    key={t.address}
                    k={t.symbol}
                    v={fmtAmount(Number(t.amount) / 10 ** t.decimals)}
                  />
                ))}
              </div>
            )}
            {node.aliases.length > 0 && (
              <>
                <div className="section-label" style={{ marginTop: 14 }}>
                  ADDRESSES ON OTHER NETWORKS
                </div>
                {node.aliases.map((a) => (
                  <div key={a.id} className="kv-row">
                    <NetworkBadge name={a.network} /> <code>{a.address}</code>
                  </div>
                ))}
              </>
            )}
          </section>
        )}
      </div>
    </aside>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="kv-row">
      <span>{k}</span>
      <code>{v}</code>
    </div>
  )
}
