// Browser-only stand-in for the Tauri commands, fed by `public/mock/*.json` (written by
// `cargo test -- --ignored dump_mock` in src-tauri). Lets the UI run in the Figma preview and in a
// plain `pnpm dev` tab; anything not covered rejects with an OFFLINE error.

const cache = new Map<string, Promise<unknown>>()

async function load<T>(file: string): Promise<T> {
  if (!cache.has(file)) {
    cache.set(
      file,
      fetch(`/mock/${file}`).then((r) => {
        if (!r.ok)
          throw {
            code: "OFFLINE",
            message: `mock fixture ${file} missing (${r.status})`,
          }
        return r.json()
      }),
    )
  }
  return cache.get(file) as Promise<T>
}

let opened = false

// A tiny event bus standing in for Tauri's listen/emit.
const bus = new EventTarget()
export function mockListen<T>(event: string, cb: (e: { payload: T }) => void): Promise<() => void> {
  const h = (e: Event) => cb({ payload: (e as CustomEvent).detail as T })
  bus.addEventListener(event, h)
  return Promise.resolve(() => bus.removeEventListener(event, h))
}
function emit(event: string, payload: unknown) {
  bus.dispatchEvent(new CustomEvent(event, { detail: payload }))
}

// Local verdicts for the preview: hash -> flags.
const verdicts = new Map<string, Record<string, unknown>[]>()
let running = false
let stopFlag = false
let high: string[] = []
let halted: string | null = null
const BANDS = ["Low", "Medium", "High", "Critical"]

function merged(ev: Record<string, unknown>): Record<string, unknown> {
  const local = verdicts.get(ev.hash as string)
  if (!local || local.length === 0) return ev
  const flags = [...(ev.flags as Record<string, unknown>[]), ...local]
  const worst = flags.reduce<string | null>((w, f) => (BANDS.indexOf(f.severity as string) > BANDS.indexOf(w ?? "") ? (f.severity as string) : w), null)
  return { ...ev, flags, reviewed_risk: worst, effective_risk: worst ?? ev.risk_level, pending: false, disagreement: !!worst && !!ev.risk_level && worst !== ev.risk_level, flag_codes: Array.from(new Set(flags.map((f) => f.code as string))).sort() }
}

async function summary() {
  const events = (await load<Record<string, unknown>[]>("events.json")).map(merged)
  const v = events.filter((e) => e.validatable)
  const done = v.filter((e) => !e.pending)
  const by_band: Record<string, number> = {}
  for (const e of done) by_band[(e.effective_risk as string) ?? "Pending"] = (by_band[(e.effective_risk as string) ?? "Pending"] ?? 0) + 1
  return { validatable: v.length, validated: done.length, pending: v.length - done.length, percent: v.length ? (done.length * 100) / v.length : 100, by_band, running, checked_this_run: done.length, high, halted, last_error: null, phase: running ? "file only" : null, in_flight: {}, unchecked_online: 0, queued: running ? v.length - done.length : 0 }
}

async function simulateRun(haltAfter: number) {
  running = true
  stopFlag = false
  high = []
  halted = null
  emit("validation://status", await summary())
  const events = (await load<Record<string, unknown>[]>("events.json")).map(merged).filter((e) => e.validatable && e.pending)
  events.sort((a, b) => BANDS.indexOf((a.risk_level as string) ?? "") - BANDS.indexOf((b.risk_level as string) ?? "") || (a.amount_units as number) - (b.amount_units as number))
  for (const e of events) {
    if (stopFlag) break
    // Deterministic pseudo-verdict from the hash: mostly Low, a few Medium, rare High / Critical.
    const h = parseInt((e.hash as string).slice(-4), 16)
    const band = h % 23 === 0 ? "Critical" : h % 11 === 0 ? "High" : h % 5 === 0 ? "Medium" : "Low"
    verdicts.set(e.hash as string, [{ code: band === "Low" ? "VALIDATED" : "MODEL_RISK", severity: band, source: "model", message: band === "Low" ? "checked by the validator (preview)" : `preview model scores ${(0.5 + (h % 50) / 100).toFixed(2)}`, at: Date.now() / 1000, target: e.hash, data: {} }])
    if (band === "High" || band === "Critical") high.push(e.hash as string)
    if (high.length >= haltAfter) {
      halted = `${high.length} transfers came back High or Critical: automatic validation stopped, the rest needs a manual look on the canvas`
      stopFlag = true
    }
    emit("validation://verdict", { event: merged(e), summary: await summary() })
    await new Promise((r) => setTimeout(r, 10 + (h % 7) * 15))
  }
  running = false
  emit("validation://status", await summary())
}

export async function mockInvoke<T>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  switch (cmd) {
    case "app_info":
      return {
        version: "mock",
        fixtures_dir: null,
        model: { name: "mock" },
        model_error: null,
        networks: [],
        demos: [
          {
            id: "mainnet",
            name: "Demo mainnet (preview)",
            description: "Fixtures dumped from the Rust pipeline",
            path: "mock",
          },
        ],
        data_dir: "",
      } as T
    case "list_recent":
      return [] as T
    case "current_chain":
      return (opened ? await load("summary.json") : null) as T
    case "open_demo":
    case "open_chain":
    case "reload_chain":
    case "open_from_service":
      opened = true
      return load("summary.json")
    case "get_report":
      return load("report.json")
    case "list_events":
      return (await load<Record<string, unknown>[]>("events.json")).map(merged) as T
    case "validate_start":
      if (!running) void simulateRun(Number(args.haltAfter ?? 3))
      return undefined as T
    case "validate_stop":
      stopFlag = true
      return undefined as T
    case "validation_status":
      return (await summary()) as T
    case "manual_verdict": {
      const v = args.verdict as { hash: string; band: string; note?: string | null }
      verdicts.set(v.hash, [{ code: "MANUAL_REVIEW", severity: v.band, source: "manual", message: v.note || `reviewed by hand: ${v.band}`, at: Date.now() / 1000, target: v.hash, data: {} }])
      high = high.filter((h) => h !== v.hash)
      if (halted && high.length === 0) halted = null
      const events = await load<Record<string, unknown>[]>("events.json")
      const ev = merged(events.find((e) => e.hash === v.hash) as Record<string, unknown>)
      emit("validation://verdict", { event: ev, summary: await summary() })
      return ev as T
    }
    case "get_event": {
      const events = (await load<Record<string, unknown>[]>("events.json")).map(merged)
      const ev = events.find((e) => e.hash === args.hash)
      if (!ev) throw { code: "NOT_FOUND", message: `event ${String(args.hash)}` }
      const cp = ev.counterparty as { id: string } | null
      const related = cp ? events.filter((e) => e.hash !== ev.hash && (e.counterparty as { id: string } | null)?.id === cp.id) : []
      return { event: ev, related, intents: [], flag_events: [], counterparty: null, reports: [] } as T
    }
    case "expand_node": {
      const all = await load<Record<string, unknown>>("expand.json")
      const id = String(args.id)
      const key = `${id}|${args.cursor ? String(args.cursor) : ""}`
      if (all[key]) return all[key] as T
      const [network, address] = [
        id.slice(0, id.indexOf(":")),
        id.slice(id.indexOf(":") + 1),
      ]
      return {
        root: {
          id,
          network,
          address,
          is_wallet: false,
          is_account: false,
          label: null,
          labels: [],
          reports: 0,
          report_categories: [],
          sanctioned: false,
          flagged: false,
          scam: false,
          worst_risk: null,
          tx_count: 0,
          in_count: 0,
          out_count: 0,
          first_seen: null,
          last_seen: null,
          info: null,
          sources: [],
          aliases: [],
        },
        nodes: [],
        edges: [],
        next_cursor: null,
        exhausted: true,
        source: "mock (no fixture for this address)",
        elapsed_ms: 0,
        notes: ["preview mode: only pre-dumped addresses expand"],
      } as T
    }
    case "node_insight": {
      const all = await load<Record<string, unknown>>("insight.json")
      const id = String(args.id)
      if (all[id]) return all[id] as T
      throw {
        code: "OFFLINE",
        message: "preview mode: no insight fixture for this address",
      }
    }
    case "service_state":
      return {
        url: null,
        connected: false,
        last_error: null,
        last_checked: null,
        validator: null,
        chain: null,
        client: null,
        auth_error: null,
      } as T
    case "service_connect":
      return {
        url: String(args.url),
        connected: false,
        last_error: "preview mode: no service",
        last_checked: null,
        validator: null,
        chain: null,
        client: null,
        auth_error: null,
      } as T
    case "close_chain":
      opened = false
      return undefined as T
    default:
      throw {
        code: "OFFLINE",
        message: `preview mode: ${cmd} needs the desktop app`,
      }
  }
}
