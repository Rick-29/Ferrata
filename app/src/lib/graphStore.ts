// The manual-mode graph: addresses as nodes, transfers bundled per direction as edges, grown one
// expansion at a time. New neighbours are placed in columns beside the expanded node (newest
// first, or by risk / amount); "Re-layout" runs a layered (dagre) layout over the whole graph so
// nothing overlaps and edges flow left to right. Dragged nodes keep their place until re-layout.

import { useCallback, useMemo, useReducer } from "react";
import dagre from "@dagrejs/dagre";
import { bandRank, worstBand } from "./format";
import type { Expansion, GraphEdge, GraphNode, RiskBand } from "./ferra";

export type Order = "time" | "risk" | "amount";

export interface GNode extends GraphNode {
  x: number;
  y: number;
  /** Discovered by expanding this node (null for a root). */
  parent: string | null;
  depth: number;
  /** Side of the parent it was placed on: +1 right, -1 left. */
  dir: 1 | -1;
  expanded: boolean;
  loading: boolean;
  cursor: string | null;
  exhausted: boolean;
  /** Dragged by the user: the incremental layout leaves it alone. */
  pinned: boolean;
  /** Newest transfer involving this node, for ordering. */
  latest: number;
  volume: number;
  error: string | null;
  source: string;
  /** 1-based index among the chain's wallets, for "Wallet 2" labels; 0 otherwise. */
  walletIndex: number;
}

export interface GEdge {
  id: string;
  /** The two endpoints, `a < b` lexically; direction lives on each transfer. */
  a: string;
  b: string;
  transfers: GraphEdge[];
  count: number;
  /** Transfers paying a -> b and b -> a. */
  ab: number;
  ba: number;
  totalsAB: Record<string, number>;
  totalsBA: Record<string, number>;
  worst: RiskBand | null;
  latest: number;
  earliest: number;
  trusted: boolean;
  onChain: boolean;
  scam: boolean;
}

export function edgeTouches(e: GEdge, id: string): boolean {
  return e.a === id || e.b === id;
}

export interface GraphState {
  nodes: Record<string, GNode>;
  edges: Record<string, GEdge>;
  /** Expansion order: who discovered whom. */
  log: { root: string; discovered: string[] }[];
  roots: string[];
  order: Order;
  /** Hanging off a timeline spine: neighbours stack downwards, wallets are the spine itself. */
  spine: boolean;
  version: number;
}

export const COL = 330;
export const ROW = 96;
/** Neighbours per column before the fan-out wraps into the next column outward. */
export const MAX_ROWS = 12;

export const emptyGraph: GraphState = { nodes: {}, edges: {}, log: [], roots: [], order: "time", spine: false, version: 0 };

/** Radius of a node's circle on the canvas: wallets largest, Ferra accounts next, others by volume. */
export function nodeRadius(n: GNode): number {
  if (n.is_wallet) return 36;
  if (n.is_account) return 28;
  return Math.min(24, 15 + Math.log10(1 + Math.max(0, n.volume)) * 3);
}

type Action =
  | { type: "reset"; roots: GraphNode[]; spine?: boolean }
  | { type: "addAt"; node: GraphNode; x: number; y: number }
  | { type: "loading"; id: string; loading: boolean; error?: string | null }
  | { type: "expansion"; id: string; result: Expansion; append: boolean }
  | { type: "move"; id: string; x: number; y: number; pinned?: boolean }
  | { type: "order"; order: Order }
  | { type: "relayout" }
  | { type: "patch"; id: string; patch: Partial<GraphNode> }
  | { type: "add"; node: GraphNode; near: string };

function toGNode(n: GraphNode, extra: Partial<GNode>): GNode {
  return { ...n, x: 0, y: 0, parent: null, depth: 0, dir: 1, expanded: false, loading: false, cursor: null, exhausted: false, pinned: false, latest: n.last_seen ?? 0, volume: 0, error: null, source: "", walletIndex: 0, ...extra };
}

function mergeNode(old: GNode | undefined, fresh: GraphNode): GraphNode {
  if (!old) return fresh;
  return {
    ...old,
    ...fresh,
    label: fresh.label ?? old.label,
    labels: fresh.labels.length ? fresh.labels : old.labels,
    info: fresh.info ?? old.info,
    worst_risk: worstBand(old.worst_risk, fresh.worst_risk),
    scam: old.scam || fresh.scam,
    tx_count: Math.max(old.tx_count, fresh.tx_count),
    sources: Array.from(new Set([...old.sources, ...fresh.sources])),
    aliases: fresh.aliases.length ? fresh.aliases : old.aliases,
  };
}

function edgeKey(x: string, y: string): [string, string, string] {
  const [a, b] = x < y ? [x, y] : [y, x];
  return [`${a}<=>${b}`, a, b];
}

function addTransfer(edges: Record<string, GEdge>, t: GraphEdge): void {
  const [key, a, b] = edgeKey(t.from, t.to);
  const e = edges[key] ?? { id: key, a, b, transfers: [], count: 0, ab: 0, ba: 0, totalsAB: {}, totalsBA: {}, worst: null, latest: 0, earliest: Infinity, trusted: true, onChain: false, scam: false };
  if (e.transfers.some((x) => x.id === t.id)) {
    edges[key] = e;
    return;
  }
  e.transfers.push(t);
  e.transfers.sort((p, q) => q.timestamp - p.timestamp);
  e.count = e.transfers.length;
  if (t.from === a) {
    e.ab += 1;
    e.totalsAB[t.asset_symbol] = (e.totalsAB[t.asset_symbol] ?? 0) + t.amount_units;
  } else {
    e.ba += 1;
    e.totalsBA[t.asset_symbol] = (e.totalsBA[t.asset_symbol] ?? 0) + t.amount_units;
  }
  e.worst = worstBand(e.worst, t.risk);
  e.latest = Math.max(e.latest, t.timestamp);
  e.earliest = Math.min(e.earliest, t.timestamp);
  e.trusted = e.trusted && t.trusted;
  e.onChain = e.onChain || t.on_chain;
  e.scam = e.scam || t.scam_flag;
  edges[key] = e;
}

function sortKey(order: Order, n: GNode): number {
  switch (order) {
    case "risk":
      return bandRank(n.worst_risk) * 1e12 + n.latest;
    case "amount":
      return n.volume * 1e6 + n.latest / 1e9;
    default:
      return n.latest;
  }
}

/** Spine mode: `ids` go in rows below (or above) `root`, spread sideways, wrapping outward. */
function placeRows(nodes: Record<string, GNode>, root: GNode, ids: string[], order: Order): void {
  const toPlace = ids.filter((id) => nodes[id] && !nodes[id].pinned);
  if (toPlace.length === 0) return;
  toPlace.sort((a, b) => sortKey(order, nodes[b]) - sortKey(order, nodes[a]));
  const d: 1 | -1 = root.dir;
  const STEP_X = 160;
  const ROW_Y = 190;
  const perRow = 8;
  const rows = Math.ceil(toPlace.length / perRow);
  for (let r = 0; r < rows; r++) {
    const chunk = toPlace.slice(r * perRow, (r + 1) * perRow);
    const y = root.y + d * (ROW_Y + r * ROW_Y * 0.8);
    const taken = Object.values(nodes)
      .filter((n) => !toPlace.includes(n.id) && Math.abs(n.y - y) < ROW_Y * 0.4)
      .map((n) => n.x);
    const isFree = (x: number) => taken.every((t) => Math.abs(t - x) >= STEP_X * 0.9);
    let x = root.x - ((chunk.length - 1) * STEP_X) / 2;
    for (const id of chunk) {
      let tries = 0;
      while (!isFree(x) && tries < 500) {
        x += STEP_X;
        tries++;
      }
      nodes[id] = { ...nodes[id], x, y, dir: d };
      taken.push(x);
      x += STEP_X;
    }
  }
}

/** Places `ids` in columns beside `root`, skipping y slots already taken in that column. */
function placeColumn(nodes: Record<string, GNode>, root: GNode, ids: string[], order: Order): void {
  const toPlace = ids.filter((id) => nodes[id] && !nodes[id].pinned);
  if (toPlace.length === 0) return;
  toPlace.sort((a, b) => sortKey(order, nodes[b]) - sortKey(order, nodes[a]));
  const parent = root.parent ? nodes[root.parent] : null;
  const dir: 1 | -1 = parent ? (root.x >= parent.x ? 1 : -1) : root.dir;
  const left: string[] = [];
  const right: string[] = [];
  for (const id of toPlace) {
    // Roots split: money sources on the left, destinations on the right.
    if (!parent && nodes[id].dir === -1) left.push(id);
    else right.push(id);
  }
  const place = (group: string[], d: 1 | -1) => {
    if (group.length === 0) return;
    const columns = Math.ceil(group.length / MAX_ROWS);
    for (let c = 0; c < columns; c++) {
      const chunk = group.slice(c * MAX_ROWS, (c + 1) * MAX_ROWS);
      const x = root.x + d * (COL + c * COL * 0.72);
      const taken = Object.values(nodes)
        .filter((n) => !group.includes(n.id) && Math.abs(n.x - x) < COL * 0.36)
        .map((n) => n.y);
      const isFree = (y: number) => taken.every((t) => Math.abs(t - y) >= ROW * 0.9);
      let y = root.y - ((chunk.length - 1) * ROW) / 2;
      for (const id of chunk) {
        let tries = 0;
        while (!isFree(y) && tries < 500) {
          y += ROW;
          tries++;
        }
        nodes[id] = { ...nodes[id], x, y, dir: d };
        taken.push(y);
        y += ROW;
      }
    }
  };
  place(right, dir);
  place(left, (-dir) as 1 | -1);
}

/** Layered layout of the whole graph, left to right. Nodes are inserted in the current order so
 * dagre's crossing minimisation starts from newest-first (or risk / amount). */
function relayoutAll(state: GraphState): GraphState {
  const g = new dagre.graphlib.Graph({ multigraph: false });
  g.setGraph({ rankdir: "LR", ranksep: COL * 0.55, nodesep: ROW * 0.45, edgesep: 20, ranker: "network-simplex" });
  g.setDefaultEdgeLabel(() => ({}));
  const ordered = Object.values(state.nodes).sort((a, b) => sortKey(state.order, b) - sortKey(state.order, a));
  for (const n of ordered) {
    const r = nodeRadius(n);
    g.setNode(n.id, { width: r * 2 + 40, height: r * 2 + 44 });
  }
  for (const e of Object.values(state.edges)) {
    if (e.a === e.b || !state.nodes[e.a] || !state.nodes[e.b]) continue;
    // Point the layout edge along the dominant direction of money.
    const [from, to] = e.ab >= e.ba ? [e.a, e.b] : [e.b, e.a];
    if (!g.hasEdge(to, from)) g.setEdge(from, to);
  }
  dagre.layout(g);
  const nodes = { ...state.nodes };
  for (const id of Object.keys(nodes)) {
    const p = g.node(id);
    if (p) nodes[id] = { ...nodes[id], x: p.x, y: p.y, pinned: false };
  }
  return { ...state, nodes, version: state.version + 1 };
}

function reduce(state: GraphState, a: Action): GraphState {
  switch (a.type) {
    case "reset": {
      const nodes: Record<string, GNode> = {};
      a.roots.forEach((r, i) => {
        nodes[r.id] = toGNode(r, { x: 0, y: i * ROW * 4, source: "chain", walletIndex: i + 1 });
      });
      // In spine mode the wallets are remembered (to filter them out of expansions) but not drawn.
      return { ...emptyGraph, order: state.order, spine: a.spine ?? false, nodes: a.spine ? {} : nodes, roots: a.roots.map((r) => r.id), version: state.version + 1 };
    }
    case "addAt": {
      if (state.nodes[a.node.id]) return state;
      const nodes = { ...state.nodes, [a.node.id]: toGNode(a.node, { x: a.x, y: a.y, dir: 1, source: "chain", parent: null, depth: 0 }) };
      return { ...state, nodes, version: state.version + 1 };
    }
    case "loading": {
      const n = state.nodes[a.id];
      if (!n) return state;
      return { ...state, nodes: { ...state.nodes, [a.id]: { ...n, loading: a.loading, error: a.error === undefined ? n.error : a.error } }, version: state.version + 1 };
    }
    case "move": {
      const n = state.nodes[a.id];
      if (!n) return state;
      return { ...state, nodes: { ...state.nodes, [a.id]: { ...n, x: a.x, y: a.y, pinned: a.pinned ?? n.pinned } }, version: state.version + 1 };
    }
    case "patch": {
      const n = state.nodes[a.id];
      if (!n) return state;
      return { ...state, nodes: { ...state.nodes, [a.id]: { ...n, ...a.patch } }, version: state.version + 1 };
    }
    case "add": {
      if (state.nodes[a.node.id]) return state;
      const near = state.nodes[a.near] ?? Object.values(state.nodes)[0];
      const nodes = { ...state.nodes, [a.node.id]: toGNode(a.node, { parent: near?.id ?? null, depth: (near?.depth ?? 0) + 1, dir: 1, source: "chain" }) };
      if (near) placeColumn(nodes, near, [a.node.id], state.order);
      const log = [...state.log, { root: near?.id ?? a.node.id, discovered: [a.node.id] }];
      return { ...state, nodes, log, version: state.version + 1 };
    }
    case "order":
      return relayoutAll({ ...state, order: a.order });
    case "relayout":
      return relayoutAll(state);
    case "expansion": {
      const nodes = { ...state.nodes };
      const edges = { ...state.edges };
      const r = a.result;
      const existingRoot = nodes[a.id];
      const rootId = r.root.id;
      // The backend may resolve an alias to the wallet: keep whichever node we have.
      const rootNode = nodes[rootId] ?? existingRoot;
      const root: GNode = { ...toGNode(mergeNode(rootNode, r.root), rootNode ?? {}), expanded: true, loading: false, error: null, cursor: r.next_cursor, exhausted: r.exhausted, source: r.source };
      nodes[rootId] = root;
      if (existingRoot && existingRoot.id !== rootId) delete nodes[existingRoot.id];

      const discovered: string[] = [];
      for (const n of r.nodes) {
        if (n.id === rootId) continue;
        // On the spine canvas the wallet is the timeline itself, not a node.
        if (state.spine && (n.is_wallet || state.roots.includes(n.id))) continue;
        if (nodes[n.id]) {
          nodes[n.id] = { ...nodes[n.id], ...mergeNode(nodes[n.id], n) } as GNode;
        } else {
          const walletIndex = state.roots.indexOf(n.id) + 1;
          nodes[n.id] = toGNode(n, { parent: rootId, depth: root.depth + 1, dir: 1, source: n.sources.join("+"), walletIndex });
          discovered.push(n.id);
        }
      }
      for (const t of r.edges) {
        if (!nodes[t.from] || !nodes[t.to]) continue;
        addTransfer(edges, t);
      }
      // Per-node ordering keys from the edges we now hold.
      for (const id of [rootId, ...discovered, ...r.nodes.map((n) => n.id)]) {
        const n = nodes[id];
        if (!n) continue;
        let latest = n.last_seen ?? 0;
        let volume = 0;
        let dir: 1 | -1 = n.dir;
        for (const e of Object.values(edges)) {
          if (!edgeTouches(e, id)) continue;
          latest = Math.max(latest, e.latest);
          volume += [...Object.values(e.totalsAB), ...Object.values(e.totalsBA)].reduce((s, v) => s + v, 0);
          if (n.parent === rootId && discovered.includes(id)) {
            // Money mostly came from it: place it on the left of the expanded node.
            const paysRoot = (e.a === id ? e.ab : e.ba) >= (e.a === id ? e.ba : e.ab);
            dir = paysRoot ? -1 : 1;
          }
        }
        nodes[id] = { ...n, latest, volume, dir };
      }
      const log = state.log.some((l) => l.root === rootId) ? state.log.map((l) => (l.root === rootId ? { ...l, discovered: [...l.discovered, ...discovered] } : l)) : [...state.log, { root: rootId, discovered }];
      const next = { ...state, nodes, edges, log, version: state.version + 1 };
      if (next.spine) placeRows(next.nodes, next.nodes[rootId], discovered, next.order);
      else placeColumn(next.nodes, next.nodes[rootId], discovered, next.order);
      return next;
    }
    default:
      return state;
  }
}

export function useGraph(initial: GraphState = emptyGraph) {
  const [state, dispatch] = useReducer(reduce, initial);
  const api = useMemo(
    () => ({
      reset: (roots: GraphNode[], spine = false) => dispatch({ type: "reset", roots, spine }),
      addAt: (node: GraphNode, x: number, y: number) => dispatch({ type: "addAt", node, x, y }),
      setLoading: (id: string, loading: boolean, error: string | null = null) => dispatch({ type: "loading", id, loading, error }),
      applyExpansion: (id: string, result: Expansion, append: boolean) => dispatch({ type: "expansion", id, result, append }),
      move: (id: string, x: number, y: number, pinned = true) => dispatch({ type: "move", id, x, y, pinned }),
      setOrder: (order: Order) => dispatch({ type: "order", order }),
      relayout: () => dispatch({ type: "relayout" }),
      patch: (id: string, patch: Partial<GraphNode>) => dispatch({ type: "patch", id, patch }),
      add: (node: GraphNode, near: string) => dispatch({ type: "add", node, near }),
    }),
    [],
  );
  const edgesOf = useCallback((id: string) => Object.values(state.edges).filter((e) => edgeTouches(e, id)), [state.edges]);
  return { state, ...api, edgesOf };
}

export type GraphApi = ReturnType<typeof useGraph>;

/** A bare wallet node, the seed of the graph before its first expansion. */
export function walletSeed(id: string, network: string, address: string): GraphNode {
  return { id, network, address, is_wallet: true, is_account: true, label: null, labels: [], reports: 0, report_categories: [], sanctioned: false, flagged: false, scam: false, worst_risk: null, tx_count: 0, in_count: 0, out_count: 0, first_seen: null, last_seen: null, info: null, sources: ["chain"], aliases: [] };
}
