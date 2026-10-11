// Deterministic layouts for the timeline. No simulation: x comes from chain order or time, y from
// the lane the mode assigns, and a sweep-line pass pushes colliding events into sub-lanes that
// alternate above and below the lane. The same event always lands in the same place for the
// same data and mode, and nothing moves when verdicts arrive except in Risk mode, where the lane
// is the verdict.

import type { EventView, RiskBand } from "./ferra";

export type LayoutMode = "spine" | "time" | "risk" | "free";

export interface Lane {
  key: string;
  label: string;
  hint?: string;
  y: number;
  /** The band a drop on this lane means (Risk mode only). */
  band?: RiskBand;
  /** Drawn bold and dashed: the chain itself. */
  rail?: boolean;
}

export interface TimelineLayout {
  pos: Record<string, { x: number; y: number }>;
  lanes: Lane[];
  /** Horizontal extent of the layout in flow units. */
  width: number;
  /** Lane spacing, for the labels. */
  laneHeight: number;
  /** Time at the left and right edge (time modes), for the overview ticks. */
  t0: number;
  t1: number;
  timeBased: boolean;
}

export const LANE_H = 200;
const STEP = 72;
const SUB = 52;
const MIN_GAP = 46;
export const RISK_LANES: (RiskBand | "Pending")[] = ["Critical", "High", "Medium", "Pending", "Low"];

export const LAYOUT_LABEL: Record<LayoutMode, string> = { spine: "Spine", time: "Time", risk: "Risk", free: "Free" };
export const LAYOUT_HINT: Record<LayoutMode, string> = {
  spine: "The chain in block order on a rail; money coming in above it, money going out below it",
  time: "Strict time on the x axis, one lane per network",
  risk: "One lane per verdict, time on the x axis. Drag a transfer to another lane to change its verdict",
  free: "Nothing snaps: drag transfers and addresses anywhere to lay out relationships by hand",
};

/** Chain order with deterministic tie-breakers; never array order. */
export function orderEvents(events: EventView[]): EventView[] {
  return [...events].sort((a, b) => a.block_number - b.block_number || a.timestamp - b.timestamp || a.hash.localeCompare(b.hash));
}

function bandLabel(b: RiskBand | "Pending"): string {
  return b === "Pending" ? "Pending" : b;
}

/**
 * Sweep-line packing inside one lane: events sorted by x, each goes to the first sub-lane
 * (0, +1, -1, +2, -2 …) whose last occupant is far enough to the left.
 */
function pack(items: { hash: string; x: number; tie: string }[], laneY: number, pos: Record<string, { x: number; y: number }>) {
  items.sort((a, b) => a.x - b.x || a.tie.localeCompare(b.tie));
  const last: Record<number, number> = {};
  const order = [0, 1, -1, 2, -2, 3, -3];
  for (const it of items) {
    let sub = order[order.length - 1];
    for (const s of order) {
      if (last[s] === undefined || it.x - last[s] >= MIN_GAP) {
        sub = s;
        break;
      }
    }
    last[sub] = it.x;
    pos[it.hash] = { x: it.x, y: laneY + sub * SUB };
  }
}

function networkLaneOrder(events: EventView[], ferraName: string): string[] {
  const count = new Map<string, number>();
  for (const e of events) count.set(e.network.name, (count.get(e.network.name) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => (a[0] === ferraName ? -1 : b[0] === ferraName ? 1 : b[1] - a[1] || a[0].localeCompare(b[0]))).map(([n]) => n);
}

export function layoutTimeline(events: EventView[], mode: LayoutMode, ferraName: string): TimelineLayout {
  const ordered = orderEvents(events);
  const n = ordered.length;
  const pos: Record<string, { x: number; y: number }> = {};
  const t0 = n ? Math.min(...ordered.map((e) => e.timestamp)) : 0;
  const t1 = n ? Math.max(...ordered.map((e) => e.timestamp)) : 1;
  const width = Math.max(1600, n * STEP);
  const xByTime = (t: number) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * width : width / 2);

  if (mode === "spine" || mode === "free") {
    const lanes: Lane[] = [
      { key: "in", label: "Inbound", hint: "money arriving from other networks", y: -LANE_H },
      { key: "rail", label: "Ferra chain", hint: "block order, oldest on the left", y: 0, rail: true },
      { key: "out", label: "Outbound", hint: "money leaving to other networks", y: LANE_H },
    ];
    const groups: Record<string, { hash: string; x: number; tie: string }[]> = { in: [], rail: [], out: [] };
    ordered.forEach((e, i) => {
      const lane = e.network.name === ferraName ? "rail" : e.incoming ? "in" : "out";
      groups[lane].push({ hash: e.hash, x: i * STEP, tie: e.hash });
    });
    for (const l of lanes) pack(groups[l.key], l.y, pos);
    return { pos, lanes: mode === "free" ? [] : lanes, width: n * STEP, laneHeight: LANE_H, t0, t1, timeBased: false };
  }

  if (mode === "time") {
    const names = networkLaneOrder(ordered, ferraName);
    const lanes: Lane[] = names.map((name, i) => ({ key: name, label: name, y: i * LANE_H, rail: name === ferraName }));
    const groups = new Map<string, { hash: string; x: number; tie: string }[]>(names.map((k) => [k, []]));
    for (const e of ordered) groups.get(e.network.name)?.push({ hash: e.hash, x: xByTime(e.timestamp), tie: e.hash });
    for (const l of lanes) pack(groups.get(l.key) ?? [], l.y, pos);
    return { pos, lanes, width, laneHeight: LANE_H, t0, t1, timeBased: true };
  }

  // risk
  const lanes: Lane[] = RISK_LANES.map((b, i) => ({ key: b, label: bandLabel(b), y: i * LANE_H, band: b === "Pending" ? undefined : b }));
  const groups = new Map<string, { hash: string; x: number; tie: string }[]>(RISK_LANES.map((k) => [k, []]));
  for (const e of ordered) {
    const key: RiskBand | "Pending" = e.pending || !e.effective_risk ? "Pending" : e.effective_risk;
    groups.get(key)?.push({ hash: e.hash, x: xByTime(e.timestamp), tie: e.hash });
  }
  for (const l of lanes) pack(groups.get(l.key) ?? [], l.y, pos);
  return { pos, lanes, width, laneHeight: LANE_H, t0, t1, timeBased: true };
}

/** The lane nearest to a y coordinate, or null when the drop is nowhere near one. */
export function laneAt(lanes: Lane[], y: number, laneHeight: number): Lane | null {
  let best: Lane | null = null;
  let d = Infinity;
  for (const l of lanes) {
    const dd = Math.abs(l.y - y);
    if (dd < d) {
      d = dd;
      best = l;
    }
  }
  return d <= laneHeight / 2 ? best : null;
}
