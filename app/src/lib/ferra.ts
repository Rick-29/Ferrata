// Typed bridge to the Tauri backend (src-tauri). One function per command, one listener per

// event. Types mirror the Rust structs; `unknown`-typed payloads are the backend crates' own

// JSON (ChainTx.extra, TxFeatures) that the UI shows but does not interpret.

import { invoke as tauriInvoke } from "@tauri-apps/api/core"

import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event"

import { mockInvoke, mockListen } from "./mock"

/** Real commands inside the Tauri window; the `public/mock` fixtures in a plain browser tab. */

const invoke = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  inTauri() ? tauriInvoke<T>(cmd, args) : mockInvoke<T>(cmd, args)

const listen = <T,>(
  event: string,
  cb: (e: { payload: T }) => void,
): Promise<UnlistenFn> =>
  inTauri() ? tauriListen<T>(event, cb) : mockListen<T>(event, cb)

// ----- shared -----

export type RiskBand = "Low" | "Medium" | "High" | "Critical"

export type TxKind = "account_created" | "faucet" | "cosigned" | "escape_start" | "escape_cancel" | "escape_exit" | "owner_rotation" | "anchor" | "flag" | "external" | "settings_changed" | "intent" | "intent_outcome" | "address_report"

export type FlagSource = "policy" | "reconciliation" | "review" | "integrity" | "model" | "behaviour" | "provenance" | "manual" | "report"

export type ChainFamily = "ferra" | "evm" | "bitcoin" | "solana" | "ton" | "sui" | "other"

export interface Network {
  family: ChainFamily

  name: string

  chain_id: number | null
}

export interface TokenInfo {
  address: string

  symbol: string

  decimals: number
}

export interface Flag {
  code: string

  severity: RiskBand

  source: FlagSource

  message: string

  at: number

  target: string

  data: Record<string, unknown>
}

export interface NodeRef {
  /** `network:address` */

  id: string

  network: string

  address: string
}

export interface AppError {
  code: "NO_CHAIN" | "NOT_FOUND" | "BAD_REQUEST" | "IO" | "CHAIN" | "OFFLINE" | "SERVICE" | "INTERNAL"

  message: string
}

export function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e
}

// ----- chain file -----

export interface ChainHeader {
  format: string

  format_version: number

  chain_id: number

  network: Network

  cosigner: string

  validator: string

  tokens: TokenInfo[]

  escape_delay_secs: number

  genesis_time: number
}

export interface ChainVerification {
  ok: boolean

  blocks_checked: number

  txs_checked: number

  first_bad_block: number | null

  reason: string | null

  head: string

  state_root: string
}

export interface ValidationStatus {
  validatable: number

  validated: number

  percent: number

  pending: number

  next: string[]
}

export interface FileInfo {
  name: string
  /** `testnet`, `mainnet` or `unknown`, from the networks the chain mirrors. */
  environment: string

  path: string | null

  chain_id: number

  network: string

  format_version: number

  blocks: number

  events: number

  validatable: number

  genesis_time: number

  first_event_at: number | null

  last_event_at: number | null

  cosigner: string

  validator: string

  tokens: TokenInfo[]

  escape_delay_secs: number

  opened_at: number

  wallets: string[]

  /** Node ids of the wallets: the roots of the manual-mode graph. */

  wallet_nodes: string[]

  networks: string[]
}

export interface ChainSummary {
  file: FileInfo

  header: ChainHeader

  verification: ChainVerification

  validation: ValidationStatus
}

export interface RecentFile {
  path: string

  name: string

  chain_id: number

  network: string

  blocks: number

  events: number

  verified_ok: boolean | null

  last_opened: number
}

export interface DemoChain {
  id: string

  name: string

  description: string

  path: string | null
}

export interface AppInfo {
  version: string

  fixtures_dir: string | null

  model: { name: string; [k: string]: unknown } | null

  model_error: string | null

  networks: Network[]

  demos: DemoChain[]

  data_dir: string
}

// ----- events -----

export interface DecodedAction {
  kind: "native_transfer" | "erc20_transfer" | "erc20_approve" | "typed_data" | "contract_call"

  [k: string]: unknown
}

/** The chain record (ChainTx) flattened together with the fields the backend derives. */

export interface EventView {
  version: number

  hash: string

  block_number: number

  timestamp: number

  kind: TxKind

  from: string

  to: string

  value: string

  data: string

  nonce: number

  user_op_hash: string

  action: DecodedAction

  risk_level: RiskBand | null

  reviewed_risk: RiskBand | null

  owner_signature: unknown

  cosignature: string | null

  extra: Record<string, unknown>

  flags: Flag[]

  network: Network

  features: Record<string, unknown> | null

  // derived

  /** reviewed_risk ?? risk_level ?? null (grey) */

  effective_risk: RiskBand | null

  validatable: boolean

  pending: boolean

  /** false from the first tampered block onward */

  trusted: boolean

  amount_units: number

  asset_symbol: string

  asset_decimals: number

  incoming: boolean

  wallet: string

  counterparty: NodeRef | null

  counterparty_reports: number

  flag_codes: string[]

  disagreement: boolean
}

export interface AddressReport {
  network: string

  address: string

  category: string

  reason: string

  reporter: string

  at: number
}

export interface EventDetail {
  event: EventView

  related: EventView[]

  intents: EventView[]

  flag_events: EventView[]

  counterparty: GraphNode | null

  reports: AddressReport[]
}

// ----- automatic mode -----

export interface AssetTotal {
  symbol: string

  units: number
}

export interface BandSlice {
  /** null = pending */

  band: RiskBand | null

  count: number

  value: AssetTotal[]
}

export interface NetworkSlice {
  network: string

  count: number

  bands: BandSlice[]
}

export interface KindCount {
  kind: TxKind

  count: number
}

export interface Distribution {
  bands: BandSlice[]

  by_network: NetworkSlice[]

  by_kind: KindCount[]
}

export interface AttentionRow {
  hash: string

  block_number: number

  timestamp: number

  kind: TxKind

  network: string

  amount_units: number

  asset_symbol: string

  incoming: boolean

  counterparty: NodeRef | null

  counterparty_reports: number

  risk: RiskBand | null

  risk_level: RiskBand | null

  reviewed_risk: RiskBand | null

  flag_codes: string[]

  pending: boolean

  trusted: boolean

  disagreement: boolean
}

export interface FlagCount {
  code: string

  count: number

  events: number

  share: number

  worst_severity: RiskBand
}

export interface WalletSettings {
  per_tx_limit_pct: number

  step_up_above_pct: number

  allowlist: string[]

  [k: string]: unknown
}

export interface WalletProfile {
  address: string

  archetype: "new" | "holder" | "seller" | "buyer" | "trader" | "dormant"

  activity: "low" | "medium" | "high"

  age_secs: number

  events: number

  out_count: number

  in_count: number

  out_volume: number

  in_volume: number

  mean_out: number

  p95_out: number

  max_out: number

  holding_ratio: number

  out_per_day: number

  median_interval_secs: number | null

  hour_histogram: number[]

  distinct_recipients: number

  repeat_recipient_share: number

  intents: number

  submitted: number

  cancelled: number

  abandoned: number

  cancel_rate: number

  settings_changes: number

  last_active: number | null

  settings: WalletSettings
}

export interface ProfileCard {
  profile: WalletProfile

  node_id: string

  findings: Flag[]
}

export interface ReportedAddressView {
  network: string

  address: string

  count: number

  categories: string[]

  first_at: number

  last_at: number

  node_id: string

  events: string[]
}

export interface ValidatorStatus {
  enabled: boolean

  interval_secs: number

  batch: number

  passes: number

  events_checked: number

  flags_written: number

  last_pass_at: number | null

  last_error: string | null

  retrying: number

  validation: ValidationStatus
}

export interface ValidationPass {
  checked: number

  failed: number

  flags_written: number

  validation: ValidationStatus
}

export interface Report {
  file: FileInfo

  integrity: ChainVerification

  validation: ValidationStatus

  distribution: Distribution

  attention: AttentionRow[]

  flag_summary: FlagCount[]

  profiles: ProfileCard[]

  reported: ReportedAddressView[]

  worker: ValidatorStatus | null

  generated_at: number
}

export interface DatasetRow {
  tx_hash: string

  block_number: number

  features: Record<string, unknown>

  label: RiskBand | null

  label_codes: string[]
}

// ----- manual mode: the graph -----

export interface AccountInfo {
  network: Network

  address: string

  native_symbol: string

  native_decimals: number

  balance: string | null

  tokens: {
    symbol: string
    name: string | null
    address: string
    decimals: number
    amount: string
    usd_value: number | null
    verified: boolean | null
  }[]

  tx_count: number | null

  first_seen: number | null

  last_active: number | null

  name: string | null

  labels: string[]

  is_contract: boolean

  is_scam: boolean

  is_active: boolean

  extra: Record<string, unknown>
}

export interface GraphNode {
  id: string

  network: string

  address: string

  is_wallet: boolean

  is_account: boolean

  label: string | null

  labels: string[]

  reports: number

  report_categories: string[]

  sanctioned: boolean

  flagged: boolean

  scam: boolean

  worst_risk: RiskBand | null

  tx_count: number

  in_count: number

  out_count: number

  first_seen: number | null

  last_seen: number | null

  info: AccountInfo | null

  sources: ("chain" | "indexer")[]

  aliases: NodeRef[]
}

export interface GraphEdge {
  id: string

  from: string

  to: string

  network: string

  timestamp: number

  amount_units: number

  asset_symbol: string

  fee: number | null

  risk: RiskBand | null

  event_hash: string | null

  tx_id: string | null

  explorer_url: string | null

  flag_codes: string[]

  kind: "cosigned" | "external" | "escape_exit" | "faucet" | "observed" | string

  scam_flag: boolean

  trusted: boolean

  on_chain: boolean
}

export interface Expansion {
  root: GraphNode

  /** Neighbours not yet known to the caller (the root is not repeated here). */

  nodes: GraphNode[]

  /** Newest first. */

  edges: GraphEdge[]

  next_cursor: string | null

  exhausted: boolean

  source: string

  elapsed_ms: number

  notes: string[]
}

export interface Reason {
  code: string

  severity: RiskBand | null

  message: string

  events: string[]
}

export interface RiskFactor {
  code: string

  odds_multiplier: number

  contribution: number

  value: number

  message: string
}

export interface ProvenanceAssessment {
  network: Network

  counterparty: string

  events_checked: number

  score: number

  risk: RiskBand

  reasons: { code: string; points: number; message: string }[]

  verified: boolean

  counterparty_info: AccountInfo | null

  exposure: {
    hops: number | null
    path: string[]
    nodes_explored: number
    requests: number
    truncated: boolean
  } | null
}

export interface RiskPreview {
  schema_version: number

  network: Network

  counterparty: string

  amount: AmountSpec | null

  baseline_probability: number

  probability: number

  odds_vs_baseline: number

  band: RiskBand

  reasons: { code: string; points: number; message: string }[]

  factors: RiskFactor[]

  summary: string

  counterparty_info: AccountInfo | null

  provenance: ProvenanceAssessment | null

  features: Record<string, unknown>

  elapsed_ms: number

  notes: string[]
}

export interface AmountSpec {
  units: number

  asset_symbol: string

  decimals: number
}

export interface NodeInsight {
  node: GraphNode

  reports: AddressReport[]

  events: EventView[]

  flags: Flag[]

  /** Why the node is coloured the way it is, worst first. */

  reasons: Reason[]

  preview: RiskPreview | null

  preview_error: string | null

  elapsed_ms: number
}

export interface TransferReport {
  schema_version: number

  mode: string

  network: Network

  from: string

  to: string

  from_input: string

  to_input: string

  generated_at: number

  elapsed_ms: number

  from_info: AccountInfo | null

  to_info: AccountInfo | null

  transfers: TransferDetail[]

  sender_recent: unknown[]

  sender_events_scanned: number

  pages_fetched: number

  receiver_provenance: ProvenanceAssessment | null

  max_risk: number

  notes: string[]
}

export interface TransferDetail {
  event: Record<string, unknown>

  related: Record<string, unknown>[]

  funding: Record<string, unknown>[]

  funding_coverage: number

  risk: {
    heuristic_score: number

    band: RiskBand

    reasons: { code: string; points: number; message: string }[]

    model: {
      name: string
      score: number
      above_threshold: boolean
      top: [string, number][]
    } | null

    combined: number

    features: Record<string, unknown>
  } | null
}

// ----- service -----

export interface ServiceState {
  url: string | null

  connected: boolean

  last_error: string | null

  last_checked: number | null

  validator: ValidatorStatus | null

  chain: Record<string, unknown> | null
  /** Client id of the session used for writes, when the login worked. */
  client: string | null
  auth_error: string | null
}

export interface ValidationSummary {
  validatable: number
  validated: number
  pending: number
  percent: number
  by_band: Record<string, number>
  running: boolean
  checked_this_run: number
  /** Events judged High or Critical during this run. */
  high: string[]
  halted: string | null
  last_error: string | null
  phase: string | null
  /** Origin-network lookups in flight right now, per network (the per-chain buffers). */
  in_flight: Record<string, number>
  /** Events judged from the file alone because their origin network stayed out of reach. */
  unchecked_online: number
  /** Events still queued in this run. */
  queued: number
}

export interface VerdictEvent {
  event: EventView
  summary: ValidationSummary
}

export interface ProgressEvent {
  stage: string
  done: number
  total: number
}

// ----- commands -----

export const ferra = {
  // chain file

  openChain: (path: string) => invoke<ChainSummary>("open_chain", { path }),

  openDemo: (id: "testnet" | "testnet-validated" | "mainnet") =>
    invoke<ChainSummary>("open_demo", { id }),

  openFromService: (url: string) =>
    invoke<ChainSummary>("open_from_service", { url }),

  reloadChain: () => invoke<ChainSummary>("reload_chain"),

  closeChain: () => invoke<void>("close_chain"),

  currentChain: () => invoke<ChainSummary | null>("current_chain"),

  listRecent: () => invoke<RecentFile[]>("list_recent"),

  forgetRecent: (path: string) =>
    invoke<RecentFile[]>("forget_recent", { path }),

  appInfo: () => invoke<AppInfo>("app_info"),

  // events

  listEvents: () => invoke<EventView[]>("list_events"),

  getEvent: (hash: string) => invoke<EventDetail>("get_event", { hash }),

  // automatic mode

  getReport: () => invoke<Report>("get_report"),

  getProfile: (address?: string) =>
    invoke<ProfileCard>("get_profile", { address: address ?? null }),

  getDataset: () => invoke<DatasetRow[]>("get_dataset"),

  exportFile: (
    what: "report" | "events" | "dataset",
    format: "json" | "csv",
    path: string,
  ) => invoke<string>("export_file", { what, format, path }),

  // manual mode

  expandNode: (
    id: string,
    opts: { cursor?: string | null; limit?: number; online?: boolean } = {},
  ) =>
    invoke<Expansion>("expand_node", {
      id,
      cursor: opts.cursor ?? null,
      limit: opts.limit ?? 30,
      online: opts.online ?? true,
    }),

  nodeInsight: (id: string, online = true) =>
    invoke<NodeInsight>("node_insight", { id, online }),

  // online (public indexers through the embedded connectors)

  eventReport: (hash: string) =>
    invoke<TransferReport>("event_report", { hash }),

  provenanceCheck: (hash: string) =>
    invoke<ProvenanceAssessment>("provenance_check", { hash }),

  riskPreview: (network: string, counterparty: string, amount?: AmountSpec) =>
    invoke<RiskPreview>("risk_preview", {
      network,
      counterparty,
      amount: amount ?? null,
    }),

  // in-app validator
  validateStart: (online = true, haltAfter = 3) => invoke<void>("validate_start", { online, haltAfter }),
  validateStop: () => invoke<void>("validate_stop"),
  validationStatus: () => invoke<ValidationSummary>("validation_status"),
  manualVerdict: (hash: string, band: RiskBand, note?: string) => invoke<EventView>("manual_verdict", { verdict: { hash, band, note: note ?? null } }),
  onVerdict: (cb: (v: VerdictEvent) => void): Promise<UnlistenFn> => listen<VerdictEvent>("validation://verdict", (e) => cb(e.payload)),
  onValidationStatus: (cb: (s: ValidationSummary) => void): Promise<UnlistenFn> => listen<ValidationSummary>("validation://status", (e) => cb(e.payload)),

  // Swissquote service

  serviceConnect: (url: string, username?: string, password?: string) =>
    invoke<ServiceState>("service_connect", { url, username: username ?? null, password: password ?? null }),

  serviceDisconnect: () => invoke<ServiceState>("service_disconnect"),

  serviceState: () => invoke<ServiceState>("service_state"),

  serviceValidateNow: (batch = 8) =>
    invoke<ValidationPass>("service_validate_now", { batch }),

  // events pushed by the backend

  onChainOpened: (cb: (s: ChainSummary) => void): Promise<UnlistenFn> =>
    listen<ChainSummary>("chain://opened", (e) => cb(e.payload)),
  onProgress: (cb: (p: ProgressEvent) => void): Promise<UnlistenFn> =>
    listen<ProgressEvent>("chain://progress", (e) => cb(e.payload)),

  onChainClosed: (cb: () => void): Promise<UnlistenFn> =>
    listen("chain://closed", () => cb()),

  onServiceStatus: (cb: (s: ServiceState) => void): Promise<UnlistenFn> =>
    listen<ServiceState>("service://status", (e) => cb(e.payload)),
}

/** The node id for an address on a network, the way the backend keys its graph. */

export function nodeId(network: string, address: string): string {
  const n = network.trim().toLowerCase()

  const a = address.trim()

  return `${n}:${
    a.startsWith("0x") || a.startsWith("0X") ? a.toLowerCase() : a
  }`
}

export const RISK_COLOR: Record<RiskBand | "pending" | "tampered", string> = {
  Low: "#2EB67D",

  Medium: "#F2B134",

  High: "#F26B1D",

  Critical: "#E3242B",

  pending: "#6B7280",

  tampered: "#C026D3",
}

export function riskColor(band: RiskBand | null, trusted = true): string {
  if (!trusted) return RISK_COLOR.tampered

  return band ? RISK_COLOR[band] : RISK_COLOR.pending
}

/** True when the page runs inside the Tauri window (vs. the plain Vite / Figma preview). */

export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}
