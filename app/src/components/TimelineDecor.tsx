// Decorations around the timeline: the lanes (lines in flow space, labels pinned to the left
// edge of the screen) and the overview strip (a histogram of the whole timeline with a window
// showing where the viewport is; drag the window to move sideways).

import { useCallback, useMemo, useRef } from "react";
import { ViewportPortal, useReactFlow, useStore, useViewport } from "@xyflow/react";
import { riskColor, type EventView, type RiskBand } from "@/lib/ferra";
import type { Lane, TimelineLayout } from "@/lib/timelineLayout";

const BANDS: RiskBand[] = ["Low", "Medium", "High", "Critical"];

export function LaneOverlay({ layout, theme, dragging }: { layout: TimelineLayout; theme: "dark" | "light"; dragging: boolean }) {
  const vp = useViewport();
  const line = theme === "dark" ? "#2a2e36" : "#d7dae0";
  const rail = theme === "dark" ? "#555a66" : "#9ca1ac";
  const x0 = -400;
  const x1 = layout.width + 400;
  if (layout.lanes.length === 0) return null;
  return (
    <>
      <ViewportPortal>
        <svg className="lane-lines" style={{ position: "absolute", left: x0, top: 0, width: x1 - x0, height: 1, overflow: "visible", pointerEvents: "none" }}>
          {layout.lanes.map((l) => (
            <g key={l.key}>
              {l.band && dragging && <rect x={0} y={l.y - layout.laneHeight / 2} width={x1 - x0} height={layout.laneHeight} fill={riskColor(l.band)} opacity={0.05} />}
              <line x1={0} x2={x1 - x0} y1={l.y} y2={l.y} stroke={l.rail ? rail : line} strokeWidth={l.rail ? 3 : 1} strokeDasharray={l.rail ? "10 8" : undefined} />
            </g>
          ))}
        </svg>
      </ViewportPortal>
      <div className="lane-labels" aria-hidden>
        {layout.lanes.map((l) => (
          <div key={l.key} className={`lane-label ${l.rail ? "rail" : ""}`} style={{ top: l.y * vp.zoom + vp.y, borderColor: l.band ? riskColor(l.band) : undefined }} title={l.hint}>
            {l.band && <i style={{ background: riskColor(l.band) }} />}
            <span>{l.label}</span>
            {l.hint && <small>{l.hint}</small>}
          </div>
        ))}
      </div>
    </>
  );
}

function monthTicks(t0: number, t1: number): { t: number; label: string }[] {
  if (!(t1 > t0)) return [];
  const out: { t: number; label: string }[] = [];
  const d = new Date(t0 * 1000);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const span = t1 - t0;
  const step = span > 3 * 365 * 86400 ? 12 : span > 400 * 86400 ? 3 : 1;
  while (d.getTime() / 1000 < t1 && out.length < 40) {
    out.push({ t: d.getTime() / 1000, label: d.toLocaleDateString(undefined, { month: "short", year: step === 12 ? "numeric" : undefined, timeZone: "UTC" }) });
    d.setUTCMonth(d.getUTCMonth() + step);
  }
  return out;
}

/** Histogram of the timeline plus the viewport window. Width 280 px, 56 buckets. */
export function Overview({ layout, events, theme }: { layout: TimelineLayout; events: EventView[]; theme: "dark" | "light" }) {
  const rf = useReactFlow();
  const vp = useViewport();
  const screenW = useStore((s) => s.width);
  const ref = useRef<HTMLDivElement>(null);
  const W = 280;
  const H = 44;
  const buckets = 56;
  const left = Math.min(0, ...Object.values(layout.pos).map((p) => p.x));
  const span = Math.max(1, layout.width - left);

  const bars = useMemo(() => {
    const count = new Array<number>(buckets).fill(0);
    const worst = new Array<number>(buckets).fill(-1);
    for (const e of events) {
      const p = layout.pos[e.hash];
      if (!p) continue;
      const b = Math.min(buckets - 1, Math.max(0, Math.floor(((p.x - left) / span) * buckets)));
      count[b] += 1;
      const r = e.pending || !e.effective_risk ? -1 : BANDS.indexOf(e.effective_risk);
      if (r > worst[b]) worst[b] = r;
    }
    const max = Math.max(1, ...count);
    return count.map((c, i) => ({ h: (c / max) * H, color: worst[i] >= 0 ? riskColor(BANDS[worst[i]]) : theme === "dark" ? "#3a3f48" : "#c9ccd3" }));
  }, [events, layout.pos, left, span, theme]);

  // Viewport in flow x → overview px.
  const flowLeft = -vp.x / vp.zoom;
  const flowRight = flowLeft + screenW / vp.zoom;
  const winL = Math.max(0, Math.min(W, ((flowLeft - left) / span) * W));
  const winR = Math.max(0, Math.min(W, ((flowRight - left) / span) * W));
  const ticks = useMemo(() => (layout.timeBased ? monthTicks(layout.t0, layout.t1) : []), [layout.timeBased, layout.t0, layout.t1]);

  const moveTo = useCallback(
    (clientX: number) => {
      const box = ref.current?.getBoundingClientRect();
      if (!box) return;
      const frac = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
      const centerFlow = left + frac * span;
      rf.setViewport({ x: -(centerFlow * vp.zoom) + screenW / 2, y: vp.y, zoom: vp.zoom });
    },
    [rf, left, span, vp.zoom, vp.y, screenW],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    moveTo(e.clientX);
    const move = (ev: PointerEvent) => moveTo(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="overview nodrag nopan" title="The whole timeline. Drag the window to move sideways.">
      <span className="overview-title">Overview</span>
      <div className="overview-strip" ref={ref} onPointerDown={onPointerDown} style={{ width: W, height: H }}>
        {bars.map((b, i) => (
          <i key={i} style={{ left: (i / buckets) * W, width: W / buckets - 1, height: Math.max(2, b.h), background: b.color }} />
        ))}
        <b style={{ left: winL, width: Math.max(6, winR - winL) }} />
      </div>
      {ticks.length > 0 && (
        <div className="overview-ticks" style={{ width: W }}>
          {ticks.map((t) => (
            <span key={t.t} style={{ left: ((t.t - layout.t0) / Math.max(1, layout.t1 - layout.t0)) * W }}>
              {t.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export type { Lane };
