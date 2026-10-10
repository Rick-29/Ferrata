// The right-hand panel for an event on the timeline: identity, parties, the two verdicts, the
// flags, the related events, and the way into the graph.

import { useEffect, useState } from "react";
import type { RiskBand } from "@/lib/ferra";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ferra, riskColor, type EventDetail, type EventView } from "@/lib/ferra";
import { copy, fmtAmount, fmtDate, kindLabel, relTime, shortAddr, shortNode } from "@/lib/format";
import { Icon, NetworkBadge, RiskChip } from "./ui";

interface Props {
  event: EventView;
  close: () => void;
  selectEvent: (hash: string) => void;
  exploreNode: (id: string) => void;
  onManual: (hash: string, band: RiskBand, note?: string) => void;
}

export default function EventPanel({ event: e, close, selectEvent, exploreNode, onManual }: Props) {
  const [note, setNote] = useState("");
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setErr(null);
    ferra
      .getEvent(e.hash)
      .then((d) => alive && setDetail(d))
      .catch((x) => alive && setErr((x as { message?: string }).message ?? String(x)));
    return () => {
      alive = false;
    };
  }, [e.hash]);
  const explorer = (e.extra?.external as { explorer_url?: string } | undefined)?.explorer_url;
  const top = e.flags.flatMap((f) => ((f.data?.top as [string, number][] | undefined) ?? []).slice(0, 5));
  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <div>
          <span>EVENT · BLOCK {e.block_number}</span>
          <strong>
            <NetworkBadge name={e.network.name} /> {kindLabel(e.kind)}
          </strong>
        </div>
        <button className="icon-button" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <div className="detail-scroll">
        <section className="event-hero">
          <div className="event-badges">
            <RiskChip risk={e.effective_risk} trusted={e.trusted} />
            {e.pending && <span className="tag">no verdict yet</span>}
            {!e.trusted && <span className="tag critical">AFTER TAMPERED BLOCK</span>}
            {e.counterparty_reports > 0 && <span className="tag high">{e.counterparty_reports} report(s) on counterparty</span>}
          </div>
          <h2>
            {e.incoming ? "+" : "−"}
            {fmtAmount(e.amount_units, e.asset_symbol)}
          </h2>
          <p>
            {fmtDate(e.timestamp)} · {relTime(e.timestamp)}
          </p>
          <button className="hash-copy" onClick={() => void copy(e.hash)} title="Copy the event hash">
            {shortAddr(e.hash, 12, 8)} <Icon name="copy" size={13} />
          </button>
          <div className="panel-actions">
            {e.counterparty && (
              <button className="primary-button" onClick={() => exploreNode(e.counterparty!.id)}>
                <Icon name="graph" size={14} /> Show counterparty on the canvas
              </button>
            )}
            {explorer && (
              <button className="secondary-button" onClick={() => void openUrl(explorer)}>
                <Icon name="link" size={14} /> Explorer
              </button>
            )}
          </div>
        </section>
        <section className="detail-section">
          <div className="section-label">PARTIES</div>
          <div className="party-flow">
            <div>
              <span>{e.incoming ? "FROM · COUNTERPARTY" : "FROM · WALLET"}</span>
              <strong>{e.incoming ? (e.counterparty ? shortNode(e.counterparty.id) : shortAddr(e.from)) : shortAddr(e.wallet)}</strong>
            </div>
            <Icon name="arrow" size={18} />
            <div>
              <span>{e.incoming ? "TO · WALLET" : "TO · COUNTERPARTY"}</span>
              <strong>{e.incoming ? shortAddr(e.wallet) : e.counterparty ? shortNode(e.counterparty.id) : shortAddr(e.to)}</strong>
            </div>
          </div>
          {detail?.counterparty && (
            <div className="counterparty-card">
              <div>
                <span className="cp-monogram">{detail.counterparty.network.slice(0, 2).toUpperCase()}</span>
                <div>
                  <strong>{detail.counterparty.label ?? shortAddr(detail.counterparty.address, 8, 6)}</strong>
                  <span>
                    {detail.counterparty.tx_count} tx on this chain{detail.counterparty.reports ? ` · ${detail.counterparty.reports} reports` : ""}
                    {detail.counterparty.sanctioned ? " · SANCTIONED" : ""}
                  </span>
                </div>
              </div>
              <button onClick={() => exploreNode(detail.counterparty!.id)}>Open in graph</button>
            </div>
          )}
        </section>
        <section className="detail-section">
          <div className="section-label">VERDICTS</div>
          <div className="verdicts">
            <div>
              <span>Wallet policy</span>
              <RiskChip risk={e.risk_level} />
              <small>at signing</small>
            </div>
            <div className="arrow-change">→</div>
            <div>
              <span>Validators</span>
              <RiskChip risk={e.reviewed_risk} />
              <small>{e.reviewed_risk ? "after review" : "not reviewed yet"}</small>
            </div>
          </div>
        </section>
        <section className="detail-section">
          <div className="section-label">MANUAL VERDICT</div>
          <p className="muted">{e.pending ? "No automatic verdict yet. Your verdict counts as validation." : "Overrides the automatic verdict for this event."}</p>
          <input className="note-input" value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Reason (optional)" />
          <div className="verdict-buttons">
            {(["Low", "Medium", "High", "Critical"] as RiskBand[]).map((b) => (
              <button key={b} style={{ "--risk": riskColor(b) } as React.CSSProperties} onClick={() => onManual(e.hash, b, note)}>
                {b}
              </button>
            ))}
          </div>
        </section>
        <section className="detail-section">
          <div className="section-label">FLAGS · {e.flags.length}</div>
          {e.flags.length === 0 && <p className="muted">{e.pending ? "No validator has judged this event yet." : "Nothing raised on this event."}</p>}
          {e.flags.map((f, i) => (
            <div key={f.code + i} className="flag-card" style={{ borderLeftColor: riskColor(f.severity) }}>
              <div>
                <RiskChip risk={f.severity} small />
                <span>{f.source.toUpperCase()}</span>
              </div>
              <strong>{f.code}</strong>
              <p>{f.message}</p>
            </div>
          ))}
          {top.length > 0 && (
            <>
              <div className="section-label" style={{ marginTop: 10 }}>
                MODEL CONTRIBUTIONS
              </div>
              {top.map(([name, c], i) => (
                <div key={name + i} className="contribution">
                  <span>
                    <i style={{ width: `${Math.min(100, Math.abs(c) * 100)}%` }} />
                    {name}
                  </span>
                  <em>{c >= 0 ? "+" : ""}{c.toFixed(2)}</em>
                </div>
              ))}
            </>
          )}
        </section>
        <section className="detail-section related">
          <div className="section-label">SAME COUNTERPARTY · {detail?.related.length ?? "…"}</div>
          {err && <p className="muted">{err}</p>}
          {detail?.related.slice(0, 40).map((r) => (
            <button key={r.hash} onClick={() => selectEvent(r.hash)}>
              <span className="rel-dot" style={{ background: riskColor(r.effective_risk, r.trusted) }} />
              <span>
                <strong>
                  {r.incoming ? "+" : "−"}
                  {fmtAmount(r.amount_units, r.asset_symbol)}
                </strong>
                <small>
                  {fmtDate(r.timestamp)} · {kindLabel(r.kind)} · block {r.block_number}
                </small>
              </span>
              <RiskChip risk={r.effective_risk} small trusted={r.trusted} />
            </button>
          ))}
          {detail && detail.intents.length > 0 && (
            <>
              <div className="section-label" style={{ marginTop: 12 }}>
                INTENTS BEFORE IT · {detail.intents.length}
              </div>
              {detail.intents.map((it) => (
                <div key={it.hash} className="kv-row">
                  <span>{kindLabel(it.kind)}</span>
                  <code>{String((it.extra?.outcome as { outcome?: string } | undefined)?.outcome ?? (it.extra?.intent as { id?: string } | undefined)?.id ?? "")}</code>
                </div>
              ))}
            </>
          )}
        </section>
      </div>
    </aside>
  );
}
