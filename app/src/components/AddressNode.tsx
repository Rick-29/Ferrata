import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { riskColor } from "@/lib/ferra";
import { nodeRadius, type GNode } from "@/lib/graphStore";
import { networkStyle } from "@/lib/networks";
import { shortAddr } from "@/lib/format";

export type AddressNodeType = Node<{ node: GNode; selected: boolean; dim: boolean; onExpand: (id: string) => void }, "address">;

/** Fill = network, ring = risk verdict (grey: none yet, magenta: untrusted). */
export const AddressNode = memo(function AddressNode({ data }: NodeProps<AddressNodeType>) {
  const n = data.node;
  const r = nodeRadius(n);
  const net = networkStyle(n.network);
  const ring = riskColor(n.worst_risk);
  const size = r * 2;
  const title = n.is_wallet ? `Wallet ${n.walletIndex || ""} under review`.replace("  ", " ") : n.is_account ? "Ferra account" : (n.label ?? net.label);
  return (
    <div className={`addr-node ${data.selected ? "selected" : ""} ${data.dim ? "dim" : ""} ${n.is_wallet ? "wallet" : ""} ${n.is_account ? "ferra" : ""}`} style={{ "--net": net.color, "--ring": ring, width: size + 40 } as React.CSSProperties}>
      <Handle type="target" position={Position.Left} className="addr-handle" />
      <Handle type="source" position={Position.Right} className="addr-handle" />
      <div className="addr-bubble" style={{ width: size, height: size }} title={`${n.id}\nfill: ${net.label} · ring: ${n.worst_risk ?? "no verdict"}`}>
        <span className="addr-net-tag">{n.network.slice(0, 3).toUpperCase()}</span>
        {n.loading ? <span className="addr-spinner" /> : null}
        {n.sanctioned || n.scam ? <span className="addr-mark">!</span> : n.reports > 0 ? <span className="addr-mark reports">{n.reports}</span> : null}
        {!n.expanded && !n.loading ? (
          <button
            className="addr-expand nodrag"
            title="Expand: load the addresses this one interacted with"
            onClick={(e) => {
              e.stopPropagation();
              data.onExpand(n.id);
            }}
          >
            +
          </button>
        ) : null}
      </div>
      <div className="addr-label">
        <strong>{title}</strong>
        <small>{[shortAddr(n.address, 6, 4), n.tx_count ? `${n.tx_count} tx` : ""].filter(Boolean).join(" · ")}</small>
      </div>
    </div>
  );
});
