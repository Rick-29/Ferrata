// Manual mode: one canvas. The timeline is the chain's validatable events laid out by one of four
// deterministic layouts (`src/lib/timelineLayout.ts`): Spine (block order on a rail, inbound
// above, outbound below), Time (one lane per network), Risk (one lane per verdict; dragging a
// transfer to another lane records a manual verdict) and Free (drag anything anywhere). Each
// circle is grey until a validator (automatic or human) has judged it, then light red with a ring
// in the verdict's colour. Pressing + on an event hangs its counterparty below it; expanding that
// address hangs its own counterparties, and so on. Nothing already on the canvas moves until
// "Tidy".

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, useNodesState, useReactFlow, type Edge, type EdgeTypes, type Node, type NodeChange, type NodeTypes, type OnNodesChange } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { ferra, riskColor, type ChainSummary, type EventView, type GraphNode, type RiskBand, type ValidationSummary } from "@/lib/ferra";
import { edgeTouches, walletSeed, type GEdge, type GraphApi, type Order } from "@/lib/graphStore";
import { networkLegend } from "@/lib/networks";
import { LAYOUT_HINT, LAYOUT_LABEL, laneAt, layoutTimeline, orderEvents, type LayoutMode } from "@/lib/timelineLayout";
import { LaneOverlay, Overview } from "./TimelineDecor";
import { fmtAmount, fmtDay, shortAddr, shortNode } from "@/lib/format";
import { AddressNode, type AddressNodeType } from "./AddressNode";
import { EventNode, type EventNodeType } from "./EventNode";
import FloatingEdge from "./FloatingEdge";
import { Icon, NetworkBadge } from "./ui";
import NodePanel from "./NodePanel";
import EdgePanel from "./EdgePanel";
import EventPanel from "./EventPanel";

const nodeTypes: NodeTypes = { address: AddressNode, event: EventNode };
const edgeTypes: EdgeTypes = { floating: FloatingEdge };

/** Edge colours: the direction of money relative to the wallets under review. */
export const FLOW = {
  out: "#3B82F6", // leaving a wallet under review
  in: "#E3242B", // entering a wallet under review
  between: "#A855F7", // wallet to wallet
  other: "#8A8F9A", // neither end is a wallet under review
  untrusted: "#C026D3",
};

const HANG_Y = 300;
const LAYOUTS: LayoutMode[] = ["spine", "time", "risk", "free"];

export interface CanvasProps {
  chain: ChainSummary;
  graph: GraphApi;
  online: boolean;
  setOnline: (v: boolean) => void;
  /** A node id the report asked us to show. */
  focus: string | null;
  onFocused: () => void;
  /** Bumped by the App after a reload: the hanging graph is rebuilt. */
  refreshKey: number;
  theme: "dark" | "light";
  events: EventView[];
  summary: ValidationSummary | null;
  onManual: (hash: string, band: RiskBand, note?: string) => void;
}

/** Payer / payee of the dominant direction, plus the colour for the relationship. */
function flowOf(e: GEdge, isWallet: (id: string) => boolean) {
  const [payer, payee] = e.ab >= e.ba ? [e.a, e.b] : [e.b, e.a];
  const color = !e.trusted ? FLOW.untrusted : isWallet(payer) && isWallet(payee) ? FLOW.between : isWallet(payer) ? FLOW.out : isWallet(payee) ? FLOW.in : FLOW.other;
  return { payer, payee, color, bidirectional: e.ab > 0 && e.ba > 0 };
}

function Inner({ chain, graph, online, setOnline, focus, onFocused, refreshKey, theme, events, summary, onManual }: CanvasProps) {
  const rf = useReactFlow();
  const ferraName = chain.file.network;
  const nativeCount = useMemo(() => events.filter((e) => e.validatable && e.network.name === ferraName).length, [events, ferraName]);
  const [ferraOnly, setFerraOnly] = useState(true);
  const [newestFirst, setNewestFirst] = useState(false);
  const [streamKey, setStreamKey] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [legend, setLegend] = useState(false);
  const [layout, setLayout] = useState<LayoutMode>("spine");
  // Bumped to snap a dragged transfer back to its lane (Risk mode, drop refused).
  const [snapNonce, setSnapNonce] = useState(0);
  const [dragging, setDragging] = useState(false);
  const { state } = graph;
  const inflight = useRef(new Set<string>());
  const seenRefresh = useRef(refreshKey);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [rfNodes, setRfNodes, applyRfChanges] = useNodesState<Node>([]);
  const [tlPos, setTlPos] = useState<Record<string, { x: number; y: number }>>({});

  useEffect(() => {
    if (nativeCount === 0) setFerraOnly(false);
  }, [nativeCount]);

  /** Fits the view to some nodes once React Flow has measured them. */
  const fitTo = useCallback(
    (ids: string[] | null, tries = 0) => {
      const all = rf.getNodes();
      const wanted = ids ? all.filter((n) => ids.includes(n.id)) : all;
      const ready = wanted.length > 0 && wanted.every((n) => Number.isFinite(n.measured?.width ?? NaN) && Number.isFinite(n.position.x) && Number.isFinite(n.position.y));
      if (!ready && tries < 20) {
        setTimeout(() => fitTo(ids, tries + 1), 60);
        return;
      }
      if (!ready) return;
      void rf.fitView({ nodes: ids ? wanted.map((n) => ({ id: n.id })) : undefined, padding: 0.22, maxZoom: 1, duration: 450 });
    },
    [rf],
  );

  // ----- the timeline -----
  const timeline = useMemo(() => orderEvents(events.filter((e) => e.validatable && (!ferraOnly || e.network.name === ferraName))), [events, ferraOnly, ferraName]);

  const tlLayout = useMemo(() => layoutTimeline(timeline, layout, ferraName), [timeline, layout, ferraName]);

  const posOfEvent = useCallback((hash: string) => tlPos[hash] ?? tlLayout.pos[hash], [tlPos, tlLayout]);

  /** Switch layout: hand-moved transfers go back to the grid, the hanging graph stays. */
  const chooseLayout = (m: LayoutMode) => {
    setLayout(m);
    setTlPos({});
  };
  /** Hand-moved transfers go back to the grid; hung addresses stay where they were put. */
  const tidy = () => {
    setTlPos({});
    setSnapNonce((k) => k + 1);
    setTimeout(() => fitTo(null), 80);
  };

  // ----- hanging graph -----
  const expand = useCallback(
    async (id: string, append = false) => {
      const n = stateRef.current.nodes[id];
      if (!n || inflight.current.has(id)) return;
      inflight.current.add(id);
      graph.setLoading(id, true);
      try {
        const res = await ferra.expandNode(id, { cursor: append ? n.cursor : null, online, limit: 16 });
        const fresh = res.nodes.filter((x) => !stateRef.current.nodes[x.id] && !x.is_wallet).map((x) => x.id);
        graph.applyExpansion(id, res, append);
        if (fresh.length > 0) fitTo([id, ...fresh]);
      } catch (e) {
        graph.setLoading(id, false, (e as { message?: string }).message ?? String(e));
      } finally {
        inflight.current.delete(id);
      }
    },
    [graph, online, fitTo],
  );

  // Spine mode: no wallet root nodes; (re)start on a new chain or a reload.
  useEffect(() => {
    const refreshed = seenRefresh.current !== refreshKey;
    if (state.spine && !refreshed && state.roots.join() === chain.file.wallet_nodes.join()) return;
    seenRefresh.current = refreshKey;
    graph.reset(chain.file.wallet_nodes.map((id, i) => walletSeed(id, chain.file.network, chain.file.wallets[i] ?? "")), true);
    setSelected(null);
    setSelectedEdge(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain.file.wallet_nodes, refreshKey]);

  /** Hangs an event's counterparty below the spine (or selects it when already there). */
  const attach = useCallback(
    async (hash: string, andExpand = false) => {
      const ev = events.find((e) => e.hash === hash);
      const cp = ev?.counterparty;
      if (!ev || !cp) return;
      if (!stateRef.current.nodes[cp.id]) {
        const p = posOfEvent(hash) ?? { x: 0, y: 0 };
        const seed: GraphNode = { ...walletSeed(cp.id, cp.network, cp.address), is_wallet: false, is_account: cp.network === ferraName };
        // Below the spine, under this event; further right if that spot is taken.
        const taken = Object.values(stateRef.current.nodes).filter((n) => Math.abs(n.y - (p.y + HANG_Y)) < 80).map((n) => n.x);
        let x = p.x;
        while (taken.some((t) => Math.abs(t - x) < 150)) x += 160;
        graph.addAt(seed, x, p.y + HANG_Y);
        await new Promise((r) => setTimeout(r, 0));
        if (andExpand) await expand(cp.id);
        else fitTo([`ev:${hash}`, cp.id]);
      }
      setSelected(cp.id);
      setSelectedEvent(null);
      setSelectedEdge(null);
    },
    [events, posOfEvent, ferraName, graph, expand, fitTo],
  );

  const exploreNode = useCallback(
    async (id: string) => {
      if (!stateRef.current.nodes[id]) {
        const ev = events.find((e) => e.counterparty?.id === id);
        if (ev) {
          await attach(ev.hash, true);
          return;
        }
        const [network, address] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
        graph.addAt({ ...walletSeed(id, network, address), is_wallet: false, is_account: network === ferraName }, 0, HANG_Y * 2);
        await new Promise((r) => setTimeout(r, 0));
        await expand(id);
      }
      setSelected(id);
      setSelectedEvent(null);
      setSelectedEdge(null);
      setTimeout(() => {
        const n = stateRef.current.nodes[id];
        if (n) rf.setCenter(n.x + 10, n.y, { zoom: 1, duration: 450 });
      }, 80);
    },
    [events, attach, graph, ferraName, expand, rf],
  );

  useEffect(() => {
    if (!focus) return;
    void exploreNode(focus).then(onFocused);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const selectEvent = (hash: string | null) => {
    setSelectedEvent(hash);
    setSelected(null);
    setSelectedEdge(null);
    if (hash) setTimeout(() => fitTo([`ev:${hash}`]), 30);
  };
  const selectNode = (id: string | null) => {
    setSelected(id);
    setSelectedEdge(null);
    setSelectedEvent(null);
  };

  // ----- nodes -----
  const selectedEv = selectedEvent ? events.find((e) => e.hash === selectedEvent) ?? null : null;
  const highlight = useMemo(() => {
    // Events and addresses related to the selection: same counterparty, neighbours.
    const s = new Set<string>();
    if (selectedEv) {
      s.add(`ev:${selectedEv.hash}`);
      for (const e of events) if (selectedEv.counterparty && e.counterparty?.id === selectedEv.counterparty.id) s.add(`ev:${e.hash}`);
      if (selectedEv.counterparty) s.add(selectedEv.counterparty.id);
    } else if (selected) {
      s.add(selected);
      for (const e of Object.values(state.edges)) if (edgeTouches(e, selected)) s.add(e.a === selected ? e.b : e.a);
      for (const e of events) if (e.counterparty?.id === selected) s.add(`ev:${e.hash}`);
    } else if (selectedEdge) {
      const e = state.edges[selectedEdge];
      if (e) {
        s.add(e.a);
        s.add(e.b);
      } else if (selectedEdge.startsWith("link:")) {
        const [, hash, id] = selectedEdge.split(":");
        s.add(`ev:${hash}`);
        s.add(id);
      }
    }
    return s;
  }, [selectedEv, selected, selectedEdge, events, state.edges]);
  const focused = highlight.size > 0;

  const tlNodes: Node[] = useMemo(() => {
    const n = timeline.length;
    const total = Math.min(6000, Math.max(800, n * 45));
    return timeline.map((e, i): EventNodeType => {
      const streamIndex = newestFirst ? n - 1 - i : i;
      return {
        id: `ev:${e.hash}`,
        type: "event",
        position: posOfEvent(e.hash),
        data: { event: e, index: i, streamKey, delayMs: n > 1 ? (streamIndex / (n - 1)) * total : 0, selected: selectedEvent === e.hash, dim: focused && !highlight.has(`ev:${e.hash}`), attached: !!e.counterparty && !!state.nodes[e.counterparty.id], onAttach: (h) => void attach(h, false) },
        draggable: true,
        selectable: true,
      };
    });
  }, [timeline, posOfEvent, newestFirst, selectedEvent, focused, highlight, state.nodes, attach, streamKey, snapNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const gNodes: Node[] = useMemo(
    () =>
      Object.values(state.nodes).map(
        (n): AddressNodeType => ({
          id: n.id,
          type: "address",
          position: { x: Number.isFinite(n.x) ? n.x : 0, y: Number.isFinite(n.y) ? n.y : 0 },
          data: { node: n, selected: n.id === selected, dim: focused && !highlight.has(n.id), onExpand: (id) => void expand(id) },
          draggable: true,
        }),
      ),
    [state.nodes, selected, focused, highlight, expand],
  );

  useEffect(() => {
    const wanted = [...tlNodes, ...gNodes];
    setRfNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return wanted.map((n) => {
        const p = byId.get(n.id);
        return p?.dragging ? { ...n, position: p.position, dragging: true } : { ...n, measured: p?.measured };
      });
    });
  }, [tlNodes, gNodes, setRfNodes]);

  // ----- edges -----
  const isWallet = useCallback((id: string) => state.roots.includes(id) || !!state.nodes[id]?.is_wallet, [state.roots, state.nodes]);
  const edgeCount = Object.keys(state.edges).length;

  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    const n = timeline.length;
    const total = Math.min(6000, Math.max(800, n * 45));
    // The spine.
    for (let i = 1; i < n; i++) {
      const a = timeline[i - 1];
      const b = timeline[i];
      const delay = n > 1 ? ((newestFirst ? n - 1 - i : i) / (n - 1)) * total : 0;
      out.push({ id: `tl:${a.hash}:${b.hash}`, source: `ev:${a.hash}`, target: `ev:${b.hash}`, type: layout === "free" ? "straight" : "default", style: { stroke: theme === "dark" ? "#4b505a" : "#9ca1ac", strokeWidth: 1.5, opacity: 0, animation: `${streamKey % 2 ? "ev-in-b" : "ev-in"} .4s ease-out ${delay}ms forwards` } });
    }
    // Event -> counterparty links, for every event whose counterparty hangs on the canvas.
    for (const e of timeline) {
      const cp = e.counterparty;
      if (!cp || !state.nodes[cp.id]) continue;
      const id = `link:${e.hash}:${cp.id}`;
      const active = !focused || highlight.has(`ev:${e.hash}`) || highlight.has(cp.id) || selectedEdge === id;
      const color = !e.trusted ? FLOW.untrusted : e.incoming ? FLOW.in : FLOW.out;
      out.push({
        id,
        source: e.incoming ? cp.id : `ev:${e.hash}`,
        target: e.incoming ? `ev:${e.hash}` : cp.id,
        type: "floating",
        selected: selectedEdge === id,
        data: { active, label: focused && active ? fmtAmount(e.amount_units, e.asset_symbol) : undefined, bidirectional: false, color, animate: active && (focused || edgeCount <= 120) },
        style: { stroke: color, strokeWidth: 2, opacity: active ? 0.95 : 0.12 },
        markerEnd: { type: "arrowclosed" as const, color, width: 12, height: 12 },
        zIndex: active ? 1 : 0,
      });
    }
    // Address <-> address.
    for (const e of Object.values(state.edges)) {
      const { payer, payee, color, bidirectional } = flowOf(e, isWallet);
      const active = !focused || edgeTouches(e, selected ?? "") || selectedEdge === e.id;
      const totals = Object.entries(e.ab >= e.ba ? e.totalsAB : e.totalsBA)
        .sort((p, q) => q[1] - p[1])
        .slice(0, 2)
        .map(([s, u]) => fmtAmount(u, s))
        .join(" · ");
      out.push({
        id: e.id,
        source: payer,
        target: payee,
        type: "floating",
        selected: e.id === selectedEdge,
        data: { active, label: focused && active ? `${e.count}× ${bidirectional ? "⇄" : "→"} ${totals}` : undefined, bidirectional, color, animate: active && (focused || edgeCount <= 120) },
        style: { stroke: color, strokeWidth: (e.onChain ? 2 : 1) + Math.min(4, Math.log2(e.count)), opacity: active ? 1 : 0.14 },
        markerEnd: { type: "arrowclosed" as const, color, width: 12, height: 12 },
        markerStart: bidirectional ? { type: "arrowclosed" as const, color, width: 12, height: 12, orient: "auto-start-reverse" } : undefined,
        zIndex: active ? 1 : 0,
      });
    }
    return out;
  }, [timeline, newestFirst, theme, state.nodes, state.edges, focused, highlight, selected, selectedEdge, isWallet, edgeCount, streamKey, layout]); // eslint-disable-line react-hooks/exhaustive-deps

  const onNodesChange: OnNodesChange = useCallback(
    (changes: NodeChange[]) => {
      applyRfChanges(changes);
      for (const c of changes) {
        if (c.type !== "position" || !c.position || c.dragging) continue;
        const { x, y } = c.position;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (c.id.startsWith("ev:")) {
          // In Risk mode the lane is the verdict: the drop is handled in onNodeDragStop.
          if (layout !== "risk") setTlPos((p) => ({ ...p, [c.id.slice(3)]: { x, y } }));
        } else graph.move(c.id, x, y, true);
      }
    },
    [applyRfChanges, graph, layout],
  );

  /** Risk mode: a transfer dropped on another lane gets that band as a manual verdict. */
  const onEventDrop = useCallback(
    (node: Node) => {
      setDragging(false);
      if (layout !== "risk" || !node.id.startsWith("ev:")) return;
      const hash = node.id.slice(3);
      const ev = events.find((e) => e.hash === hash);
      const lane = laneAt(tlLayout.lanes, node.position.y, tlLayout.laneHeight);
      const current = ev && !ev.pending ? ev.effective_risk : null;
      if (ev && lane?.band && lane.band !== current) onManual(hash, lane.band, `moved to ${lane.band} on the canvas`);
      // Either the verdict re-lays the node out, or it snaps back.
      setSnapNonce((k) => k + 1);
    },
    [layout, events, tlLayout, onManual],
  );

  useEffect(() => {
    setTimeout(() => fitTo(null), 120);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ferraOnly, streamKey, chain.file.name, layout]);

  const center = (id: string) => {
    const n = state.nodes[id];
    if (n) rf.setCenter(n.x + 10, n.y, { zoom: Math.min(Math.max(rf.getZoom(), 0.8), 1.2), duration: 400 });
  };

  // ----- search -----
  const q = search.trim().toLowerCase();
  const results = useMemo(() => {
    if (q.length < 2) return null;
    const onCanvas = Object.values(state.nodes)
      .filter((n) => n.id.toLowerCase().includes(q) || (n.label ?? "").toLowerCase().includes(q))
      .slice(0, 8);
    const seen = new Set(onCanvas.map((n) => n.id));
    const inChain = new Map<string, { id: string; count: number; worst: RiskBand | null }>();
    for (const e of events) {
      const c = e.counterparty;
      if (!c || seen.has(c.id) || !c.id.toLowerCase().includes(q)) continue;
      const cur = inChain.get(c.id) ?? { id: c.id, count: 0, worst: null };
      cur.count += 1;
      if (e.effective_risk && ["Low", "Medium", "High", "Critical"].indexOf(e.effective_risk) > ["Low", "Medium", "High", "Critical"].indexOf(cur.worst ?? "")) cur.worst = e.effective_risk;
      inChain.set(c.id, cur);
    }
    const byHash = events.filter((e) => e.validatable && e.hash.toLowerCase().includes(q)).slice(0, 6);
    return { onCanvas, inChain: Array.from(inChain.values()).slice(0, 8), byHash };
  }, [q, state.nodes, events]);

  const tampered = !chain.verification.ok;
  const networksSeen = useMemo(() => networkLegend([...chain.file.networks, ...Object.values(state.nodes).map((n) => n.network)]), [chain.file.networks, state.nodes]);
  const highEvents = (summary?.high ?? []).map((h) => events.find((e) => e.hash === h)).filter((e): e is EventView => !!e);
  const counts = { validated: timeline.filter((e) => !e.pending).length, high: timeline.filter((e) => e.effective_risk === "High" || e.effective_risk === "Critical").length };

  return (
    <div className="canvas-screen">
      <div className="canvas-wrap">
        {tampered && (
          <div className="tamper-banner">
            <Icon name="alert" />
            <div>
              <strong>Integrity verification failed at block {chain.verification.first_bad_block}</strong>
              <span>{chain.verification.reason}. Transfers after this block are drawn in magenta and cannot be trusted.</span>
            </div>
          </div>
        )}
        {!tampered && summary?.halted && (
          <div className="halt-banner">
            <Icon name="alert" />
            <div>
              <strong>Automatic validation stopped</strong>
              <span>{summary.halted}. Click a transfer, review it and give a manual verdict; the run can then continue.</span>
              <div className="chips">
                {highEvents.map((e) => (
                  <button key={e.hash} onClick={() => selectEvent(e.hash)}>
                    {e.effective_risk} · {fmtAmount(e.amount_units, e.asset_symbol)} · {fmtDay(e.timestamp)}
                  </button>
                ))}
              </div>
            </div>
            <span />
          </div>
        )}
        <div className="canvas-toolbar">
          <label className="search-box">
            <Icon name="search" size={16} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search address, label, event hash…" />
            {search && (
              <button className="icon-button" onClick={() => setSearch("")}>
                <Icon name="close" size={12} />
              </button>
            )}
            {results && (
              <div className="search-results">
                {results.onCanvas.length > 0 && <span>ON THE CANVAS</span>}
                {results.onCanvas.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => {
                      setSearch("");
                      void exploreNode(n.id);
                    }}
                  >
                    <NetworkBadge name={n.network} />
                    <span>
                      {n.label ?? shortAddr(n.address, 10, 6)}
                      <small>{n.id}</small>
                    </span>
                    <em>{n.tx_count} tx</em>
                  </button>
                ))}
                {results.inChain.length > 0 && <span>IN THE CHAIN · NOT ON THE CANVAS YET</span>}
                {results.inChain.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => {
                      setSearch("");
                      void exploreNode(r.id);
                    }}
                  >
                    <NetworkBadge name={r.id.slice(0, r.id.indexOf(":"))} />
                    <span>
                      {shortNode(r.id)}
                      <small>{r.id}</small>
                    </span>
                    <em>
                      {r.count} tx{r.worst ? ` · ${r.worst}` : ""}
                    </em>
                  </button>
                ))}
                {results.byHash.length > 0 && <span>EVENTS BY HASH</span>}
                {results.byHash.map((e) => (
                  <button
                    key={e.hash}
                    onClick={() => {
                      setSearch("");
                      if (e.network.name !== ferraName) setFerraOnly(false);
                      selectEvent(e.hash);
                    }}
                  >
                    <NetworkBadge name={e.network.name} />
                    <span>
                      {fmtAmount(e.amount_units, e.asset_symbol)} · {fmtDay(e.timestamp)}
                      <small>{e.hash}</small>
                    </span>
                    <em>{e.effective_risk ?? "pending"}</em>
                  </button>
                ))}
                {results.onCanvas.length + results.inChain.length + results.byHash.length === 0 && <span>NOTHING MATCHES</span>}
              </div>
            )}
          </label>
          {nativeCount > 0 && (
            <div className="tool-group" role="group" aria-label="Which transfers to show">
              <button className={ferraOnly ? "active" : ""} onClick={() => setFerraOnly(true)} title="Only transfers settled on the Ferra chain">
                Ferra only
              </button>
              <button className={!ferraOnly ? "active" : ""} onClick={() => setFerraOnly(false)} title="Transfers on every network the wallet touches">
                All networks
              </button>
            </div>
          )}
          <div className="tool-group" role="group" aria-label="Layout">
            {LAYOUTS.map((m) => (
              <button key={m} className={layout === m ? "active" : ""} onClick={() => chooseLayout(m)} title={LAYOUT_HINT[m]}>
                {LAYOUT_LABEL[m]}
              </button>
            ))}
            <button onClick={tidy} title="Put every transfer back on its lane">
              <Icon name="layout" size={13} /> Tidy
            </button>
          </div>
          <div className="tool-group" role="group" aria-label="Play order">
            <button
              className={!newestFirst ? "active" : ""}
              onClick={() => {
                setNewestFirst(false);
                setStreamKey((k) => k + 1);
              }}
              title="Play the transfers oldest first"
            >
              Oldest first
            </button>
            <button
              className={newestFirst ? "active" : ""}
              onClick={() => {
                setNewestFirst(true);
                setStreamKey((k) => k + 1);
              }}
              title="Play the transfers newest first"
            >
              Newest first
            </button>
            <button onClick={() => setStreamKey((k) => k + 1)} title="Play the transfers again">
              <Icon name="refresh" size={13} /> Replay
            </button>
          </div>
          <label className="tool-select" title="How the counterparties hang under an address you open">
            <span>Hang</span>
            <select value={state.order} onChange={(e) => graph.setOrder(e.target.value as Order)}>
              <option value="time">newest first</option>
              <option value="risk">riskiest first</option>
              <option value="amount">largest first</option>
            </select>
          </label>
          <button className="density-toggle" onClick={() => fitTo(null)} title="Fit everything on screen">
            <Icon name="fit" size={14} /> Fit
          </button>
          <button className={`tool-switch ${online ? "on" : ""}`} onClick={() => setOnline(!online)} title={online ? "Opening an address also asks its network's public indexer for history. Click to use the file only." : "Only what the file says. Click to also ask the public indexers."} aria-pressed={online}>
            <i />
            <Icon name="globe" size={13} /> Live lookups
          </button>
          <button className={`density-toggle ${legend ? "active" : ""}`} onClick={() => setLegend(!legend)} title="How to read the canvas">
            Legend
          </button>
        </div>
        {legend && (
          <div className="canvas-legend-box">
            <div className="legend-head">
              <strong>Reading the canvas</strong>
              <button className="icon-button" onClick={() => setLegend(false)} title="Hide">
                <Icon name="close" size={12} />
              </button>
            </div>
            <div className="legend-cols">
              <div className="legend-group">
                <span>Transfers</span>
                <div>
                  <i className="dot" style={{ background: "#6B7280" }} />
                  Not judged yet
                </div>
                <div>
                  <i className="dot" style={{ background: "#e8646f", boxShadow: "0 0 0 2px #2eb67d" }} />
                  Judged · the ring is the verdict
                </div>
                <div className="legend-rings">
                  {(["Low", "Medium", "High", "Critical"] as const).map((r) => (
                    <span key={r}>
                      <i className="ring" style={{ borderColor: riskColor(r) }} />
                      {r}
                    </span>
                  ))}
                </div>
                <div>
                  <i className="dot" style={{ background: riskColor(null, false) }} />
                  After a tampered block
                </div>
                <div>
                  <i className="dot diamond" />
                  Escape-hatch exit
                </div>
                <div>
                  <i className="ring dashed" />
                  The wallet's own policy disagreed
                </div>
                <p>Bigger circle, bigger amount. ↑ leaves the wallet, ↓ arrives.</p>
              </div>
              <div className="legend-group">
                <span>Addresses</span>
                {networksSeen.map((n) => (
                  <div key={n.key}>
                    <i className="dot" style={{ background: n.color }} />
                    {n.label}
                  </div>
                ))}
                <p>The ring around an address is the worst verdict seen with it.</p>
              </div>
              <div className="legend-group">
                <span>Lines</span>
                <div>
                  <i className="legend-line" style={{ background: FLOW.out }} />
                  Money leaving the wallet
                </div>
                <div>
                  <i className="legend-line" style={{ background: FLOW.in }} />
                  Money entering the wallet
                </div>
                <div>
                  <i className="legend-line" style={{ background: FLOW.between }} />
                  Between two wallets under review
                </div>
                <div>
                  <i className="legend-line" style={{ background: FLOW.other }} />
                  Between other addresses
                </div>
                <p>Dashes move with the money. Heads at both ends: it went both ways. Thicker: more transfers.</p>
              </div>
              <div className="legend-group">
                <span>Actions</span>
                <div>Click anything for details.</div>
                <div>Double-click a transfer to bring in its counterparty.</div>
                <div>Double-click an address to bring in who it dealt with.</div>
                <div>Drag to rearrange, scroll to zoom, drag the overview window to move sideways.</div>
                <div>Risk layout: drag a transfer to another lane to change its verdict.</div>
              </div>
            </div>
          </div>
        )}
        <div className="canvas-status">
          <span>
            <i />
            {timeline.length} transfers{ferraOnly ? " on the Ferra chain" : ""}
          </span>
          <span>
            {counts.validated} validated · {timeline.length - counts.validated} pending
          </span>
          <span>{counts.high} High or Critical</span>
          <span>{Object.keys(state.nodes).length} addresses hung</span>
          <span className="layout-hint">{LAYOUT_HINT[layout]}</span>
          {summary?.running && <span>validating · {summary.queued} queued</span>}
        </div>
        <ReactFlow
          nodes={rfNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onNodeClick={(_, n) => (n.id.startsWith("ev:") ? selectEvent(n.id.slice(3)) : selectNode(n.id))}
          onNodeDoubleClick={(_, n) => (n.id.startsWith("ev:") ? void attach(n.id.slice(3), true) : void expand(n.id))}
          onNodeDragStart={(_, n) => setDragging(n.id.startsWith("ev:"))}
          onNodeDragStop={(_, n) => onEventDrop(n)}
          onEdgeClick={(_, e) => {
            if (e.id.startsWith("tl:")) return;
            if (e.id.startsWith("link:")) {
              selectEvent(e.id.split(":")[1]);
              return;
            }
            setSelected(null);
            setSelectedEvent(null);
            setSelectedEdge(e.id);
          }}
          onPaneClick={() => {
            selectNode(null);
            setSelectedEvent(null);
          }}
          minZoom={0.05}
          maxZoom={3}
          nodesConnectable={false}
          elementsSelectable
          selectNodesOnDrag={false}
          nodeDragThreshold={2}
          colorMode={theme}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color={theme === "dark" ? "#262a31" : "#c9ccd3"} />
          <Controls showInteractive={false} position="bottom-right" />
          <LaneOverlay layout={tlLayout} theme={theme} dragging={dragging} />
          <Overview layout={tlLayout} events={timeline} theme={theme} />
        </ReactFlow>
      </div>
      {selected && state.nodes[selected] && (
        <NodePanel
          node={state.nodes[selected]}
          edges={graph.edgesOf(selected)}
          online={online}
          close={() => selectNode(null)}
          expand={() => void expand(selected)}
          loadOlder={() => void expand(selected, true)}
          select={(id) => {
            selectNode(id);
            center(id);
          }}
        />
      )}
      {!selected && selectedEdge && state.edges[selectedEdge] && (
        <EdgePanel
          edge={state.edges[selectedEdge]}
          nodes={state.nodes}
          close={() => setSelectedEdge(null)}
          select={(id) => {
            selectNode(id);
            center(id);
          }}
        />
      )}
      {!selected && !selectedEdge && selectedEv && <EventPanel event={selectedEv} close={() => setSelectedEvent(null)} selectEvent={selectEvent} exploreNode={(id) => void exploreNode(id)} onManual={onManual} />}
    </div>
  );
}

export default function ChainCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
