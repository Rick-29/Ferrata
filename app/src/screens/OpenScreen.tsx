import { useEffect, useState } from "react"

import { open } from "@tauri-apps/plugin-dialog"

import { getCurrentWebview } from "@tauri-apps/api/webview"

import {
  ferra,
  inTauri,
  type AppInfo,
  type RecentFile,
  type ServiceState,
} from "@/lib/ferra"

import { relTime } from "@/lib/format"

import { Icon } from "@/components/ui"

interface Props {
  theme: "dark" | "light"
  onToggleTheme: () => void
  busy: string | null

  error: string | null

  onOpenPath: (path: string) => void

  onOpenDemo: (id: "testnet" | "testnet-validated" | "mainnet") => void

  onOpenService: (url: string) => void

  service: ServiceState | null

  onConnect: (url: string, username?: string, password?: string) => void
}

export default function OpenScreen({
  theme,
  onToggleTheme,
  busy,
  error,
  onOpenPath,
  onOpenDemo,
  onOpenService,
  service,
  onConnect,
}: Props) {
  const [info, setInfo] = useState<AppInfo | null>(null)

  const [recent, setRecent] = useState<RecentFile[]>([])

  const [url, setUrl] = useState(service?.url ?? "http://localhost:8787")
  const [username, setUsername] = useState("alice")
  const [password, setPassword] = useState("demo")
  const [pathText, setPathText] = useState("")

  const tauri = inTauri()

  useEffect(() => {
    ferra
      .appInfo()
      .then(setInfo)
      .catch(() => {})

    ferra
      .listRecent()
      .then(setRecent)
      .catch(() => {})

    if (!tauri) return

    let unlisten: (() => void) | undefined

    getCurrentWebview()

      .onDragDropEvent((e) => {
        if (e.payload.type === "drop" && e.payload.paths[0])
          onOpenPath(e.payload.paths[0])
      })

      .then((u) => (unlisten = u))

      .catch(() => {})

    return () => unlisten?.()
  }, [tauri, onOpenPath])

  const [dialogError, setDialogError] = useState<string | null>(null)
  const browse = async () => {
    if (!tauri) {
      setDialogError("The file dialog needs the desktop window (pnpm tauri dev). Use the sample below in preview mode.")
      return
    }
    try {
      await browseReal()
    } catch (e) {
      setDialogError(`File dialog failed: ${(e as { message?: string }).message ?? String(e)}`)
    }
  }
  const browseReal = async () => {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: "Ferra chain",
          extensions: ["jsonl", "ndjson", "chain", "json"],
        },
      ],
    })

    if (typeof picked === "string") onOpenPath(picked)
  }

  return (
    <div className="open-screen">
      <div className="open-header">
        <div className="wordmark">
          <span>S</span> SWISSQUOTE
        </div>
        <button className="secondary-button" onClick={onToggleTheme} style={{ marginLeft: "auto", marginRight: 14 }}>
          <Icon name={theme === "dark" ? "sun" : "moon"} size={16} /> {theme === "dark" ? "Light theme" : "Dark theme"}
        </button>
        <div className="connection">
          <span
            style={{ background: service?.connected ? "#2eb67d" : "#6b7280" }}
          />
          {service?.connected
            ? `Service connected · ${service.url}`
            : "Service not connected"}
        </div>
      </div>
      <main className="open-content">
        <div className="eyebrow">FERRA VISUALIZER</div>
        <h1>
          Investigate the chain.
          <br />
          <span>See what deserves attention.</span>
        </h1>
        <p className="open-lead">
          Verify a wallet’s complete history, review every risk decision, and
          follow the money from address to address, as far as it goes.
        </p>
        {!tauri && (
          <p className="error-line">
            Preview mode: this tab runs outside the desktop window on fixtures
            dumped from the Rust pipeline. Run `pnpm tauri dev` for the real
            thing.
          </p>
        )}
        {error && <p className="error-line">{error}</p>}
        {dialogError && <p className="error-line">{dialogError}</p>}
        <button className="drop-zone" onClick={browse} disabled={!!busy}>
          <span className="upload-icon">
            <Icon name="upload" size={24} />
          </span>
          <strong>{busy ? busy : "Drop a Ferra chain file here"}</strong>
          <span>or click to browse · .jsonl / .ndjson</span>
        </button>
        <div className="samples">
          <span>Explore a sample</span>
          {(info?.demos ?? []).map((d) => (
            <button
              key={d.id}
              onClick={() => onOpenDemo(d.id as never)}
              disabled={!d.path || !!busy}
              title={d.description}
            >
              <span className="multi-network">
                <i />
                <i />
                <i />
              </span>
              <span>
                <strong>{d.name}</strong>
                <small>
                  {d.path ? d.description : "not bundled with this build"}
                </small>
              </span>
              <Icon name="chevron" size={14} />
            </button>
          ))}
        </div>
        <div className="service-row">
          <span>Swissquote service</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:8787"
          />
          <button className="secondary-button" onClick={() => onConnect(url, username, password)}>
            Connect
          </button>
          <button
            className="secondary-button"
            onClick={() => onOpenService(url)}
            disabled={!!busy}
          >
            Open its chain
          </button>
        </div>
        <div className="service-row">
          <span>Service login</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username (fixtures/accounts.json)" />
          <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" type="password" />
          <span className="muted">needed for "Validate now"</span>
        </div>
        <div className="service-row">
          <span>Or a file path</span>
          <input value={pathText} onChange={(e) => setPathText(e.target.value)} placeholder="D:\\path\\to\\ferra-chain.jsonl" />
          <button className="secondary-button" onClick={() => pathText.trim() && onOpenPath(pathText.trim())} disabled={!!busy}>
            Open path
          </button>
          <span />
        </div>
        {service?.last_error && (
          <p className="muted">Service: {service.last_error}</p>
        )}
        {recent.length > 0 && (
          <div className="recent-block">
            <div className="section-heading">
              <span>Recent files</span>
              <small>LAST OPENED</small>
            </div>
            {recent.map((r) => (
              <button
                className="recent-row"
                key={r.path}
                onClick={() => onOpenPath(r.path)}
                disabled={!!busy}
                title={r.path}
              >
                <span
                  className="status-check"
                  style={
                    r.verified_ok === false
                      ? { color: "#C026D3", background: "#C026D318" }
                      : undefined
                  }
                >
                  <Icon
                    name={r.verified_ok === false ? "alert" : "check"}
                    size={13}
                  />
                </span>
                <span>
                  <strong>{r.name}</strong>
                  <small>
                    chain {r.chain_id} · {r.network} · {r.blocks} blocks ·{" "}
                    {r.events} events
                  </small>
                </span>
                <span>{relTime(r.last_opened)}</span>
                <Icon name="chevron" size={14} />
              </button>
            ))}
          </div>
        )}
      </main>
      <div className="open-footer">
        <span>
          {info
            ? `v${info.version} · model ${info.model?.name ?? "none"} · ${info.networks.length} connectors`
            : ""}
        </span>
        <strong>{info?.fixtures_dir ?? ""}</strong>
      </div>
    </div>
  )
}
