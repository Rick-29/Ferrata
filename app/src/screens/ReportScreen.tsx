import { useEffect, useMemo, useState } from "react"
import { save } from "@tauri-apps/plugin-dialog"
import {
  ferra,
  riskColor,
  type AttentionRow,
  type BandSlice,
  type Report,
  type RiskBand,
  type ServiceState,
  type ValidationSummary,
} from "@/lib/ferra"
import {
  copy,
  fmtAmount,
  fmtDate,
  fmtDay,
  fmtDuration,
  kindLabel,
  relTime,
  shortAddr,
  shortNode,
} from "@/lib/format"
import { Icon, NetworkBadge, RiskChip } from "@/components/ui"

interface Props {
  report: Report | null
  service: ServiceState | null
  onShowNode: (id: string) => void
  onValidateNow: () => void
  onServicePass: () => void
  summary: ValidationSummary | null
  onReload: () => void
  reloadKey: number
}

const BANDS: RiskBand[] = ["Low", "Medium", "High", "Critical"]

function Bar({ slices, total }: { slices: BandSlice[]; total: number }) {
  return (
    <div className="distribution">
      {slices
        .filter((s) => s.count > 0)
        .map((s) => (
          <i
            key={s.band ?? "pending"}
            style={{
              flex: s.count / Math.max(1, total),
              background: riskColor(s.band),
            }}
            title={`${s.band ?? "pending"}: ${s.count}`}
          />
        ))}
    </div>
  )
}

export default function ReportScreen({
  report: initial,
  service,
  onShowNode,
  onValidateNow,
  onServicePass,
  summary,
  onReload,
  reloadKey,
}: Props) {
  const [report, setReport] = useState<Report | null>(initial)
  const [band, setBand] = useState<RiskBand | "all" | "pending">("all")
  const [network, setNetwork] = useState("all")
  const [showAll, setShowAll] = useState(false)
  const [byValue, setByValue] = useState(false)

  useEffect(() => {
    ferra
      .getReport()
      .then(setReport)
      .catch(() => {})
  }, [reloadKey])

  const rows = useMemo(() => {
    if (!report) return []
    return report.attention
      .filter((r) =>
        band === "all"
          ? true
          : band === "pending"
            ? r.risk === null
            : r.risk === band,
      )
      .filter((r) => network === "all" || r.network === network)
  }, [report, band, network])

  if (!report) return <div className="report-screen">Loading…</div>
  const v = summary ? { validatable: summary.validatable, validated: summary.validated, pending: summary.pending, percent: summary.percent } : report.validation
  const i = report.integrity
  const f = report.file
  const total = f.validatable
  const worker = report.worker ?? service?.validator ?? null
  const profile = report.profiles[0]
  const maxHour = profile ? Math.max(1, ...profile.profile.hour_histogram) : 1

  const exportAs = async (
    what: "report" | "events" | "dataset",
    format: "json" | "csv",
  ) => {
    const path = await save({
      // Windows rejects ":" and friends in file names (a service URL as the chain name).
      defaultPath: `${f.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "_")}-${what}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    })
    if (path) await ferra.exportFile(what, format, path)
  }

  const valueText = (s: BandSlice) =>
    s.value.map((a) => fmtAmount(a.units, a.symbol)).join(" · ") || "–"

  return (
    <div className="report-screen scroll-area">
      <div className="report-title">
        <div>
          <span className="eyebrow">AUTOMATIC ANALYSIS</span>
          <h1>Validation report</h1>
          <p>
            {f.events} events · generated {relTime(report.generated_at)} ·
            opened {relTime(f.opened_at)}
          </p>
        </div>
        <div className="report-actions">
          <button
            className="secondary-button"
            onClick={() => void exportAs("report", "json")}
          >
            Export report JSON
          </button>
          <button
            className="secondary-button"
            onClick={() => void exportAs("report", "csv")}
          >
            Attention CSV
          </button>
          <button
            className="secondary-button"
            onClick={() => void exportAs("dataset", "csv")}
          >
            Dataset CSV
          </button>
          <button className="secondary-button" onClick={onReload}>
            <Icon name="refresh" size={14} /> Reload file
          </button>
          {service?.connected && (
            <button className="secondary-button" onClick={onServicePass} title="One pass of the service's worker: writes flags into the chain">
              Service pass
            </button>
          )}
          <button
            className="primary-button"
            onClick={onValidateNow}
            disabled={summary?.running || (summary ? summary.pending === 0 : false)}
            title="Judge every pending transfer in the app, least suspicious first; stops after 3 High / Critical verdicts"
          >
            {summary?.running ? `Validating… ${Math.round(summary.percent)}%` : "Validate automatically"}
          </button>
        </div>
      </div>

      <section className="metadata-strip">
        <div>
          <span>FILE</span>
          <strong title={f.path ?? ""}>{f.name}</strong>
        </div>
        <div>
          <span>CHAIN</span>
          <strong>
            {f.network} · {f.chain_id}{" "}
            <b className={`env env-${f.environment}`}>{f.environment.toUpperCase()}</b>
          </strong>
        </div>
        <div>
          <span>BLOCKS / EVENTS</span>
          <strong>
            {f.blocks} / {f.events}
          </strong>
        </div>
        <div>
          <span>PERIOD</span>
          <strong>
            {fmtDay(f.first_event_at)} — {fmtDay(f.last_event_at)}
          </strong>
        </div>
        <div>
          <span>COSIGNER · VALIDATOR</span>
          <strong>
            <button className="hash-copy" onClick={() => void copy(f.cosigner)}>
              {f.cosigner.slice(0, 8)}
            </button>
            ·
            <button
              className="hash-copy"
              onClick={() => void copy(f.validator)}
            >
              {f.validator.slice(0, 8)}
            </button>
            <Icon name="copy" size={12} />
          </strong>
        </div>
      </section>

      <div className="report-grid">
        <section className="card integrity-card">
          <div className="card-label">
            <span>INTEGRITY</span>
            <Icon name="shield" />
          </div>
          <div className="verified-lock">
            <span
              style={
                i.ok ? undefined : { background: "#C026D318", color: "#C026D3" }
              }
            >
              <Icon name={i.ok ? "check" : "alert"} size={22} />
            </span>
            <div>
              <h2>{i.ok ? "Verified" : "Tampered"}</h2>
              <p>
                {i.ok
                  ? "Every block hash, signature and state root replays from genesis."
                  : `Block ${i.first_bad_block}: ${i.reason}`}
              </p>
            </div>
          </div>
          <div className="stat-pair">
            <div>
              <span>Blocks checked</span>
              <strong>{i.blocks_checked}</strong>
            </div>
            <div>
              <span>Events checked</span>
              <strong>{i.txs_checked}</strong>
            </div>
          </div>
          <div className="hash-row">
            <span>HEAD</span>
            <code>{shortAddr(i.head, 12, 6)}</code>
            <button className="icon-button" onClick={() => void copy(i.head)}>
              <Icon name="copy" size={12} />
            </button>
          </div>
          <div className="hash-row">
            <span>STATE ROOT</span>
            <code>{shortAddr(i.state_root, 12, 6)}</code>
            <button
              className="icon-button"
              onClick={() => void copy(i.state_root)}
            >
              <Icon name="copy" size={12} />
            </button>
          </div>
          {!i.ok && (
            <button
              className="secondary-button"
              style={{ marginTop: 12 }}
              onClick={() => onShowNode(f.wallet_nodes[0])}
            >
              Open the canvas
            </button>
          )}
        </section>

        <section className="card validation-card">
          <div className="card-label">
            <span>VALIDATION</span>
            {service?.connected ? (
              <span className="live-dot">LIVE</span>
            ) : (
              <span className="muted">OFFLINE</span>
            )}
          </div>
          <div className="validation-main">
            <div
              className="progress-ring"
              style={{
                background: `conic-gradient(${
                  v.percent >= 99.9 ? "#2eb67d" : "#f2b134"
                } ${v.percent}%, #30343a 0)`,
              }}
            >
              <span>
                {Math.round(v.percent)}
                <small>%</small>
              </span>
            </div>
            <div>
              <h2>
                {v.validated} of {v.validatable}
              </h2>
              <p>
                {v.validated === 0
                  ? "transfers judged by a validator so far. The file loaded fine: nothing has reviewed it yet."
                  : "transfers judged by a validator"}
              </p>
              <span
                className="clean-line"
                style={v.pending ? { color: "#f2b134" } : undefined}
              >
                <Icon name={v.pending ? "alert" : "check"} size={14} />
                {v.pending ? `${v.pending} waiting for a verdict` : "Every transfer has a verdict"}
              </span>
            </div>
          </div>
          {worker ? (
            <div className="worker-line">
              <span
                className="pulse"
                style={
                  worker.enabled
                    ? undefined
                    : { background: "#6b7280", boxShadow: "none" }
                }
              />
              <div>
                <strong>
                  Validation worker{" "}
                  {worker.enabled
                    ? `every ${worker.interval_secs}s`
                    : "(disabled)"}
                </strong>
                <span>
                  pass {worker.passes} · {worker.events_checked} checked ·{" "}
                  {worker.flags_written} flags written · {worker.retrying}{" "}
                  retrying
                  {worker.last_error ? ` · ${worker.last_error}` : ""}
                </span>
              </div>
              <span>
                {worker.last_pass_at ? relTime(worker.last_pass_at) : "–"}
              </span>
            </div>
          ) : (
            <div className="worker-line">
              <span
                className="pulse"
                style={{ background: "#6b7280", boxShadow: "none" }}
              />
              <div>
                <strong>No service</strong>
                <span>
                  Connect to the Swissquote service from the Open screen to run
                  the validation worker; the file alone gives this status.
                </span>
              </div>
            </div>
          )}
        </section>

        <section className="card distribution-card">
          <div className="card-label">
            <span>RISK DISTRIBUTION</span>
            <button onClick={() => setByValue(!byValue)}>
              {byValue ? "By value ⌄" : "By count ⌄"}
            </button>
          </div>
          <div className="big-number">
            {total} <span>validatable events</span>
          </div>
          <Bar slices={report.distribution.bands} total={total} />
          <div className="legend-row">
            {report.distribution.bands.map((s) => (
              <div key={s.band ?? "pending"}>
                <span style={{ background: riskColor(s.band) }} />
                <small>{s.band ?? "Pending"}</small>
                <strong title={valueText(s)}>
                  {byValue ? valueText(s) : s.count}
                </strong>
              </div>
            ))}
          </div>
          <div className="network-bars">
            {report.distribution.by_network.map((n) => (
              <div key={n.network}>
                <NetworkBadge name={n.network} />
                <span>
                  {n.network} · {n.count}
                </span>
                <Bar slices={n.bands} total={n.count} />
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="card attention-card">
        <div className="attention-head">
          <div>
            <span className="card-label">REQUIRES ATTENTION</span>
            <p>
              Sorted by reviewed risk, then transfer value. Click a row to open
              its counterparty on the canvas.
            </p>
          </div>
          <div className="filter-row">
            <select
              value={band}
              onChange={(e) => setBand(e.target.value as never)}
            >
              <option value="all">All bands</option>
              {BANDS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
              <option value="pending">Pending</option>
            </select>
            <select
              value={network}
              onChange={(e) => setNetwork(e.target.value)}
            >
              <option value="all">All networks</option>
              {f.networks.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="table-head">
          <span>RISK</span>
          <span>DATE / KIND</span>
          <span>NETWORK</span>
          <span>AMOUNT</span>
          <span>FINDINGS</span>
          <span>COUNTERPARTY</span>
          <span />
        </div>
        {(showAll ? rows : rows.slice(0, 25)).map((r: AttentionRow) => (
          <button
            className="attention-row"
            key={r.hash}
            onClick={() => r.counterparty && onShowNode(r.counterparty.id)}
            title={r.hash}
          >
            <RiskChip risk={r.risk} small trusted={r.trusted} />
            <span>
              <strong>{fmtDate(r.timestamp)}</strong>
              <small>
                {kindLabel(r.kind)} · block {r.block_number}
                {r.disagreement ? ` · policy said ${r.risk_level}` : ""}
              </small>
            </span>
            <NetworkBadge name={r.network} />
            <strong>
              {r.incoming ? "+" : "−"}
              {fmtAmount(r.amount_units, r.asset_symbol)}
            </strong>
            <span className="codes">
              {r.flag_codes.length ? (
                r.flag_codes.map((c) => <code key={c}>{c}</code>)
              ) : (
                <small>{r.pending ? "pending" : "–"}</small>
              )}
            </span>
            <span>
              {r.counterparty ? shortNode(r.counterparty.id) : "–"}
              {r.counterparty_reports ? (
                <small> · {r.counterparty_reports} reports</small>
              ) : null}
            </span>
            <Icon name="arrow" size={16} />
          </button>
        ))}
        {rows.length > 25 && (
          <button className="view-all" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show fewer" : `View all ${rows.length} events`}{" "}
            <Icon name="arrow" size={15} />
          </button>
        )}
      </section>

      <div className="report-grid" style={{ marginTop: 12 }}>
        <section className="card">
          <div className="card-label">
            <span>FLAG SUMMARY</span>
          </div>
          <div className="kv" style={{ marginTop: 12 }}>
            {report.flag_summary.map((c) => (
              <div className="kv-row" key={c.code}>
                <span>
                  <i
                    className="rel-dot"
                    style={{
                      background: riskColor(c.worst_severity),
                      display: "inline-block",
                      marginRight: 6,
                    }}
                  />
                  {c.code}
                </span>
                <code>
                  {c.count} · {(c.share * 100).toFixed(0)}%
                </code>
              </div>
            ))}
            {report.flag_summary.length === 0 && (
              <p className="muted">No flags on this chain yet.</p>
            )}
          </div>
        </section>

        {profile && (
          <section className="card">
            <div className="card-label">
              <span>WALLET PROFILE</span>
              <button
                className="icon-button"
                onClick={() => onShowNode(profile.node_id)}
                title="Open on the canvas"
              >
                <Icon name="graph" size={15} />
              </button>
            </div>
            <div className="big-number" style={{ textTransform: "capitalize" }}>
              {profile.profile.archetype}{" "}
              <span>
                · {profile.profile.activity} activity ·{" "}
                {fmtDuration(profile.profile.age_secs)} old
              </span>
            </div>
            <div className="stat-pair">
              <div>
                <span>Out / in</span>
                <strong>
                  {profile.profile.out_count} / {profile.profile.in_count}
                </strong>
              </div>
              <div>
                <span>Mean / p95 out</span>
                <strong>
                  {fmtAmount(profile.profile.mean_out)} /{" "}
                  {fmtAmount(profile.profile.p95_out)}
                </strong>
              </div>
              <div>
                <span>Cancel rate</span>
                <strong>
                  {(profile.profile.cancel_rate * 100).toFixed(0)}%
                </strong>
              </div>
              <div>
                <span>Settings changes</span>
                <strong>{profile.profile.settings_changes}</strong>
              </div>
            </div>
            <div className="hours">
              {profile.profile.hour_histogram.map((h, idx) => (
                <i
                  key={idx}
                  style={{ height: `${(h / maxHour) * 100}%` }}
                  title={`${idx}:00 UTC · ${h}`}
                />
              ))}
            </div>
            {profile.findings.map((fl) => (
              <div
                className="flag-card"
                key={fl.code + fl.target}
                style={{ borderLeftColor: riskColor(fl.severity) }}
              >
                <div>
                  <RiskChip risk={fl.severity} small />
                  <span>BEHAVIOUR</span>
                </div>
                <strong>{fl.code}</strong>
                <p>{fl.message}</p>
              </div>
            ))}
          </section>
        )}

        <section className="card">
          <div className="card-label">
            <span>REPORTED ADDRESSES · {report.reported.length}</span>
          </div>
          <div className="related" style={{ marginTop: 8 }}>
            {report.reported.map((r) => (
              <button key={r.node_id} onClick={() => onShowNode(r.node_id)}>
                <span
                  className="rel-dot"
                  style={{ background: riskColor("High") }}
                />
                <span>
                  <strong>
                    <NetworkBadge name={r.network} />{" "}
                    {shortAddr(r.address, 8, 6)}
                  </strong>
                  <small>
                    {r.count} report{r.count > 1 ? "s" : ""} ·{" "}
                    {r.categories.join(", ")} · {r.events.length} event
                    {r.events.length === 1 ? "" : "s"} on this chain
                  </small>
                </span>
                <Icon name="arrow" size={14} />
              </button>
            ))}
            {report.reported.length === 0 && (
              <p className="muted">No reported addresses.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
