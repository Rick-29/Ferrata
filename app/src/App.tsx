import { useCallback, useEffect, useState } from "react";
import { ferra, isAppError, type ChainSummary, type EventView, type Report, type RiskBand, type ServiceState, type ValidationSummary } from "@/lib/ferra";
import { useGraph } from "@/lib/graphStore";
import { Icon } from "@/components/ui";
import ChainCanvas from "@/components/ChainCanvas";
import OpenScreen from "@/screens/OpenScreen";
import ReportScreen from "@/screens/ReportScreen";

type Screen = "open" | "report" | "canvas";

function errText(e: unknown): string {
  return isAppError(e) ? e.message : String(e);
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("open");
  const [chain, setChain] = useState<ChainSummary | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);
  const [summary, setSummary] = useState<ValidationSummary | null>(null);
  const [service, setService] = useState<ServiceState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [focus, setFocus] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      return localStorage.getItem("ferra-theme") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("ferra-theme", theme);
    } catch {
      /* private window */
    }
  }, [theme]);
  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  const graph = useGraph();

  const afterOpen = useCallback(async (c: ChainSummary, reload: boolean) => {
    setChain(c);
    setReport(null);
    ferra.getReport().then(setReport).catch(() => {});
    ferra.listEvents().then(setEvents).catch(() => setEvents([]));
    ferra.validationStatus().then(setSummary).catch(() => setSummary(null));
    setReloadKey((k) => k + 1);
    if (reload) setRefreshKey((k) => k + 1);
    setScreen((s) => (s === "open" ? "report" : s));
  }, []);

  useEffect(() => {
    // The listeners work in the browser preview too (mock event bus).
    ferra
      .currentChain()
      .then((c) => c && afterOpen(c, false))
      .catch(() => {});
    ferra.serviceState().then(setService).catch(() => {});
    const offs = [
      ferra.onServiceStatus(setService),
      ferra.onProgress((p) => setProgress(p.total ? `${p.stage} · ${p.total} blocks` : p.stage)),
      // A file given on the command line opens before the UI listens: pick it up here.
      ferra.onChainOpened((c) => afterOpen(c, false)),
      // The validator streams one verdict at a time: patch that event in place, refresh counts.
      ferra.onVerdict((v) => {
        setEvents((list) => list.map((e) => (e.hash === v.event.hash ? v.event : e)));
        setSummary(v.summary);
      }),
      ferra.onValidationStatus((s) => {
        setSummary(s);
        if (!s.running) ferra.getReport().then(setReport).catch(() => {});
      }),
    ];
    return () => {
      offs.forEach((p) => p.then((u) => u()));
    };
  }, [afterOpen]);

  const run = async (label: string, f: () => Promise<ChainSummary>, reload = false) => {
    setBusy(label);
    setProgress(null);
    setError(null);
    try {
      const c = await f();
      await afterOpen(c, reload);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const connect = async (url: string, username?: string, password?: string) => {
    try {
      setService(await ferra.serviceConnect(url, username, password));
    } catch (e) {
      setError(errText(e));
    }
  };

  /// One pass of the service's worker (writes flags to the chain), then reload.
  const servicePass = async () => {
    try {
      setBusy("Validating on the service…");
      await ferra.serviceValidateNow(8);
      await run("Reloading…", () => ferra.reloadChain(), true);
    } catch (e) {
      setError(errText(e));
      setBusy(null);
    }
  };

  const validateStart = async () => {
    setError(null);
    try {
      await ferra.validateStart(online, 3);
    } catch (e) {
      setError(errText(e));
    }
  };
  const validateStop = () => void ferra.validateStop().catch((e) => setError(errText(e)));
  const manual = async (hash: string, band: RiskBand, note?: string) => {
    try {
      const ev = await ferra.manualVerdict(hash, band, note);
      setEvents((list) => list.map((e) => (e.hash === hash ? ev : e)));
      setSummary(await ferra.validationStatus());
      ferra.getReport().then(setReport).catch(() => {});
    } catch (e) {
      setError(errText(e));
    }
  };

  const showNode = (id: string) => {
    setFocus(id);
    setScreen("canvas");
  };

  const overlay = busy && (
    <div className="busy-overlay">
      <div className="busy-card">
        <span className="busy-spinner" />
        <strong>{busy}</strong>
        <small>{progress ?? "working…"}</small>
      </div>
    </div>
  );

  if (!chain || screen === "open") {
    return (
      <>
        <OpenScreen
          theme={theme}
          onToggleTheme={toggleTheme}
          busy={busy}
          error={error}
          service={service}
          onConnect={connect}
          onOpenPath={(p) => void run("Opening chain…", () => ferra.openChain(p))}
          onOpenDemo={(id) => void run("Opening demo…", () => ferra.openDemo(id))}
          onOpenService={(url) => void run("Fetching the chain from the service…", () => ferra.openFromService(url))}
        />
        {overlay}
      </>
    );
  }

  return (
    <div className="app-shell">
      <aside className="side-rail">
        <div className="brand-mark">S</div>
        <div className="rail-items">
          <button className="rail-button" title="Open another file" onClick={() => setScreen("open")}>
            <Icon name="file" />
          </button>
          <button className={`rail-button ${screen === "report" ? "active" : ""}`} title="Validation report" onClick={() => setScreen("report")}>
            <Icon name="report" />
          </button>
          <button className={`rail-button ${screen === "canvas" ? "active" : ""}`} title="Chain canvas" onClick={() => setScreen("canvas")}>
            <Icon name="graph" />
          </button>
        </div>
        <div className="avatar">AD</div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="file-identity">
            <span className="file-icon">
              <Icon name="file" size={16} />
            </span>
            <div>
              <strong>{chain.file.name}</strong>
              <span>
                Chain {chain.file.chain_id} · <b className={`env env-${chain.file.environment}`}>{chain.file.environment.toUpperCase()}</b> · {chain.file.events} events · {chain.file.wallets.length} wallet{chain.file.wallets.length === 1 ? "" : "s"} ·{" "}
                {chain.verification.ok ? "verified" : `tampered at block ${chain.verification.first_bad_block}`}
              </span>
            </div>
          </div>
          <nav className="mode-switch">
            <button className={screen === "report" ? "active" : ""} onClick={() => setScreen("report")}>
              Automatic
            </button>
            <button className={screen === "canvas" ? "active" : ""} onClick={() => setScreen("canvas")}>
              Canvas
            </button>
          </nav>
          <div className="top-actions">
            {error && (
              <span className="error-line" title={error} onClick={() => setError(null)}>
                {error}
              </span>
            )}
            <span className="connection" title={service?.client ? `logged in as ${service.client}` : service?.auth_error ?? ""}>
              <span style={{ background: service?.connected ? "#2eb67d" : "#6b7280", boxShadow: "none" }} />
              {service?.connected ? "Service" : "No service"}
            </span>
            {summary && (
              <span className="validate-pill" title={summary.last_error ?? ""}>
                <span className="bar">
                  <i style={{ width: `${summary.percent}%`, background: summary.halted ? "#E3242B" : summary.running ? "#F2B134" : "#2eb67d" }} />
                </span>
                <span className="muted">
                  {summary.validated}/{summary.validatable} validated{summary.running ? ` · ${summary.phase ?? "running"}` : ""}
                </span>
              </span>
            )}
            {summary?.running ? (
              <button className="secondary-button" onClick={validateStop}>
                <Icon name="close" size={14} /> Stop
              </button>
            ) : summary?.halted ? (
              <button className="secondary-button" disabled title={summary.halted} style={{ borderColor: "#E3242B", color: "#ff8a8f" }}>
                <Icon name="alert" size={14} /> Manual review needed · {summary.high.length}
              </button>
            ) : (
              <button className="primary-button" onClick={() => void validateStart()} disabled={!chain || (summary?.pending ?? 0) === 0} title="Judge every pending transfer, least suspicious first; stops after 3 High / Critical verdicts">
                <Icon name="shield" size={14} /> Validate automatically
              </button>
            )}
            <button className="secondary-button" onClick={toggleTheme} title="Switch between dark and light">
              <Icon name={theme === "dark" ? "sun" : "moon"} size={16} /> {theme === "dark" ? "Light" : "Dark"}
            </button>
            <button className="secondary-button" onClick={() => void run("Re-verifying…", () => ferra.reloadChain(), true)} disabled={!!busy} title="Re-read the file or the service and verify it again; the canvas is rebuilt">
              <Icon name="shield" size={16} /> Verify again
            </button>
          </div>
        </header>
        {screen === "report" ? (
          <ReportScreen report={report} service={service} onShowNode={showNode} onValidateNow={() => void validateStart()} onServicePass={() => void servicePass()} summary={summary} onReload={() => void run("Reloading…", () => ferra.reloadChain(), true)} reloadKey={reloadKey} />
        ) : (
          <ChainCanvas chain={chain} graph={graph} online={online} setOnline={setOnline} focus={focus} onFocused={() => setFocus(null)} refreshKey={refreshKey} theme={theme} events={events} summary={summary} onManual={(h, b, n) => void manual(h, b, n)} />
        )}
      </div>
      {overlay}
    </div>
  );
}
