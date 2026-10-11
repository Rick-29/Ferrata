import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { riskColor, type EventView } from "@/lib/ferra";
import { networkStyle } from "@/lib/networks";
import { fmtAmount, fmtDay, shortNode } from "@/lib/format";

export type EventNodeType = Node<{ event: EventView; index: number; streamKey: number; delayMs: number; selected: boolean; dim: boolean; attached: boolean; onAttach: (hash: string) => void }, "event">;

export function eventRadius(e: EventView): number {
  return Math.min(22, 11 + Math.log10(1 + Math.max(0, e.amount_units)) * 3);
}

/** One validatable event on the timeline: fill = verdict colour, tag = network, size = amount. */
export const EventNode = memo(function EventNode({ data }: NodeProps<EventNodeType>) {
  const e = data.event;
  const r = eventRadius(e);
  const color = riskColor(e.effective_risk, e.trusted);
  const net = networkStyle(e.network.name);
  const diamond = e.kind === "escape_exit";
  return (
    <div key={data.streamKey} className={`ev-node ${data.selected ? "selected" : ""} ${data.dim ? "dim" : ""} ${diamond ? "diamond" : ""} ${e.pending ? "pending" : "validated"}`} style={{ "--risk": color, "--net": net.color, animationDelay: `${data.delayMs}ms` } as React.CSSProperties}>
      <Handle type="target" position={Position.Left} className="addr-handle" />
      <Handle type="source" position={Position.Right} className="addr-handle" />
      <div className="ev-bubble" style={{ width: r * 2, height: r * 2 }} title={`${e.hash}\n${e.kind} · ${e.network.name} · ${e.effective_risk ?? "no verdict"}`}>
        <span className="ev-tag">{e.incoming ? "↓" : "↑"}</span>
        {e.disagreement && <span className="ev-ring" style={{ borderColor: riskColor(e.risk_level) }} />}
        {e.counterparty && !data.attached && (
          <button
            className="addr-expand nodrag"
            title="Show the counterparty on the canvas"
            onClick={(ev) => {
              ev.stopPropagation();
              data.onAttach(e.hash);
            }}
          >
            +
          </button>
        )}
      </div>
      <div className="ev-label">
        <strong>
          {e.incoming ? "+" : "−"}
          {fmtAmount(e.amount_units, e.asset_symbol)}
        </strong>
        <small>
          {fmtDay(e.timestamp)} · {e.counterparty ? shortNode(e.counterparty.id) : e.kind.replace("_", " ")}
        </small>
      </div>
    </div>
  );
});
