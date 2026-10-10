// The right-hand panel for a selected edge: who paid whom, how often, how much, and every
// transfer behind it newest first.

import { openUrl } from "@tauri-apps/plugin-opener";
import { riskColor } from "@/lib/ferra";
import type { GEdge, GNode } from "@/lib/graphStore";
import { copy, fmtAmount, fmtDate, relTime, shortAddr, shortNode } from "@/lib/format";
import { Icon, NetworkBadge, RiskChip } from "./ui";

interface Props {
  edge: GEdge;
  nodes: Record<string, GNode>;
  close: () => void;
  select: (id: string) => void;
}

function nameOf(n: GNode | undefined, id: string): string {
  if (!n) return shortNode(id);
  if (n.is_wallet) return `Wallet ${n.walletIndex || ""}`.trim();
  return n.label ?? shortAddr(n.address, 6, 4);
}

function totals(t: Record<string, number>): string {
  return (
    Object.entries(t)
      .sort((a, b) => b[1] - a[1])
      .map(([s, u]) => fmtAmount(u, s))
      .join(" · ") || "–"
  );
}

export default function EdgePanel({ edge, nodes, close, select }: Props) {
  const a = nodes[edge.a];
  const b = nodes[edge.b];
  const both = edge.ab > 0 && edge.ba > 0;
  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <div>
          <span>TRANSFERS BETWEEN</span>
          <strong>
            {nameOf(a, edge.a)} {both ? "⇄" : edge.ab > 0 ? "→" : "←"} {nameOf(b, edge.b)}
          </strong>
        </div>
        <button className="icon-button" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <div className="detail-scroll">
        <section className="event-hero">
          <div className="event-badges">
            <RiskChip risk={edge.worst} trusted={edge.trusted} />
            <span className="tag">{edge.count} transfer{edge.count === 1 ? "" : "s"}</span>
            {edge.onChain ? <span className="tag">on the Ferra chain</span> : <span className="tag">indexer only</span>}
            {edge.scam && <span className="tag critical">SCAM FLAG</span>}
          </div>
          <p className="muted">
            {fmtDate(edge.earliest)} → {fmtDate(edge.latest)} · last {relTime(edge.latest)}
          </p>
          <div className="party-flow" style={{ marginTop: 10 }}>
            <button className="party-button" onClick={() => select(edge.a)}>
              <span>{a?.is_wallet ? "WALLET UNDER REVIEW" : "ADDRESS"}</span>
              <strong>
                <NetworkBadge name={a?.network ?? ""} /> {nameOf(a, edge.a)}
              </strong>
            </button>
            <Icon name="arrow" size={18} />
            <button className="party-button" onClick={() => select(edge.b)}>
              <span>{b?.is_wallet ? "WALLET UNDER REVIEW" : "ADDRESS"}</span>
              <strong>
                <NetworkBadge name={b?.network ?? ""} /> {nameOf(b, edge.b)}
              </strong>
            </button>
          </div>
        </section>
        <section className="detail-section">
          <div className="section-label">DIRECTIONS</div>
          <div className="kv">
            <div className="kv-row">
              <span>
                {nameOf(a, edge.a)} → {nameOf(b, edge.b)}
              </span>
              <code>
                {edge.ab} tx · {totals(edge.totalsAB)}
              </code>
            </div>
            <div className="kv-row">
              <span>
                {nameOf(b, edge.b)} → {nameOf(a, edge.a)}
              </span>
              <code>
                {edge.ba} tx · {totals(edge.totalsBA)}
              </code>
            </div>
          </div>
        </section>
        <section className="detail-section related">
          <div className="section-label">EVERY TRANSFER · NEWEST FIRST</div>
          {edge.transfers.map((t) => (
            <button key={t.id} onClick={() => (t.explorer_url ? void openUrl(t.explorer_url) : t.event_hash ? void copy(t.event_hash) : undefined)} title={t.explorer_url ? "Open in the explorer" : t.event_hash ? "Copy the event hash" : undefined}>
              <span className="rel-dot" style={{ background: t.trusted ? riskColor(t.risk) : riskColor(null, false) }} />
              <span>
                <strong>
                  {nameOf(nodes[t.from], t.from)} → {nameOf(nodes[t.to], t.to)} · {fmtAmount(t.amount_units, t.asset_symbol)}
                </strong>
                <small>
                  {fmtDate(t.timestamp)} ({relTime(t.timestamp)}) · {t.network} · {t.kind === "observed" ? "indexer" : t.kind.replace("_", " ")}
                  {t.fee ? ` · fee ${fmtAmount(t.fee)}` : ""}
                  {t.flag_codes.length ? ` · ${t.flag_codes.join(", ")}` : ""}
                  {t.tx_id ? ` · ${shortAddr(t.tx_id, 8, 6)}` : t.event_hash ? ` · ${shortAddr(t.event_hash, 8, 6)}` : ""}
                </small>
              </span>
              <RiskChip risk={t.risk} small trusted={t.trusted} />
            </button>
          ))}
        </section>
      </div>
    </aside>
  );
}
