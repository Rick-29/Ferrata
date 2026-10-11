// An edge that starts and ends on the rim of each circle, on the side facing the other node.
// The path runs payer -> payee so the animated dashes always move with the money; when money
// went both ways a second head is drawn at the start.

import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position, useInternalNode, type Edge, type EdgeProps } from "@xyflow/react";
import { nodeRadius, type GNode } from "@/lib/graphStore";
import { eventRadius } from "./EventNode";
import type { EventView } from "@/lib/ferra";

export type FloatingEdgeType = Edge<{ node?: GNode; label?: string; active: boolean; bidirectional: boolean; animate: boolean; color: string }, "floating">;

function center(node: { internals: { positionAbsolute: { x: number; y: number } }; measured?: { width?: number; height?: number } }, r: number) {
  // The node's DOM box is (2r + 40) wide with the circle centred at the top, so the circle's
  // centre is at (width / 2, r).
  const w = node.measured?.width ?? r * 2 + 40;
  return { x: node.internals.positionAbsolute.x + w / 2, y: node.internals.positionAbsolute.y + r };
}

export default function FloatingEdge({ id, source, target, data, style, markerEnd, markerStart, label, selected }: EdgeProps<FloatingEdgeType>) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t) return null;
  const radiusOf = (d: { node?: GNode; event?: EventView }) => (d.node ? nodeRadius(d.node) : d.event ? eventRadius(d.event) : 20);
  const rs = radiusOf(s.data as { node?: GNode; event?: EventView });
  const rt = radiusOf(t.data as { node?: GNode; event?: EventView });
  const cs = center(s, rs);
  const ct = center(t, rt);
  const dx = ct.x - cs.x;
  const dy = ct.y - cs.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / len;
  const uy = dy / len;
  const gap = 6;
  const headGap = data?.bidirectional ? 4 : 0;
  const sx = cs.x + ux * (rs + gap + headGap);
  const sy = cs.y + uy * (rs + gap + headGap);
  const tx = ct.x - ux * (rt + gap + 4);
  const ty = ct.y - uy * (rt + gap + 4);
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const sourcePosition = horizontal ? (dx >= 0 ? Position.Right : Position.Left) : dy >= 0 ? Position.Bottom : Position.Top;
  const targetPosition = horizontal ? (dx >= 0 ? Position.Left : Position.Right) : dy >= 0 ? Position.Top : Position.Bottom;
  const [path, lx, ly] = getBezierPath({ sourceX: sx, sourceY: sy, targetX: tx, targetY: ty, sourcePosition, targetPosition, curvature: 0.3 });
  const text = (label as string | undefined) ?? data?.label;
  const cls = ["flow-edge", data?.animate ? "flow-anim" : "", selected ? "flow-selected" : ""].filter(Boolean).join(" ");
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} markerStart={markerStart} className={cls} interactionWidth={18} />
      {text && (
        <EdgeLabelRenderer>
          <div className={`edge-label ${data?.active ? "active" : ""}`} style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`, borderColor: data?.color }}>
            {text}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
