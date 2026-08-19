import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ArrowClockwise, MagnifyingGlass, TerminalWindow, X } from "@phosphor-icons/react";
import "@xterm/xterm/css/xterm.css";
import { api } from "./api";
import { AppSelect } from "./app-select";
import { groupHosts } from "./host-list";
import type { Host, HostLogin } from "./types";

type TerminalConnection = "IDLE" | "CONNECTING" | "CONNECTED" | "CLOSED" | "ERROR";

const CONNECTION_LABELS: Record<TerminalConnection, string> = {
  IDLE: "未连接", CONNECTING: "正在连接", CONNECTED: "已连接", CLOSED: "已断开", ERROR: "连接失败"
};

/* 与监控页一致：终端区域在浅色主题下也保持深色。 */
const TERMINAL_THEME: ITheme = {
  background: "#080a09", foreground: "#c9d1ca", cursor: "#68df92", cursorAccent: "#080a09",
  selectionBackground: "#2e4736"
};

export interface TerminalOpenRequest { id: number; hostId: string }
interface TerminalTab { id: string; hostId: string; hostName: string }

export function TerminalWorkspace({ active, openRequest, notify }: {
  active: boolean;
  openRequest: TerminalOpenRequest | null;
  notify(kind: "ok" | "error", text: string): void;
}) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [logins, setLogins] = useState<HostLogin[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const tabsRef = useRef<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [connections, setConnections] = useState<Record<string, TerminalConnection>>({});
  const handledRequestId = useRef(0);
  const tabSequence = useRef(0);

  const load = useCallback(async () => {
    try {
      const [nextHosts, nextLogins] = await Promise.all([api<Host[]>("/v1/hosts"), api<HostLogin[]>("/v1/host-logins")]);
      setHosts(nextHosts);
      setLogins(nextLogins);
      setLoaded(true);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "无法加载终端主机列表");
    }
  }, [notify]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const openHost = useCallback((host: Host) => {
    if (!host.enabled) {
      notify("error", `${host.name} 已停用，无法打开终端`);
      return;
    }
    const existing = tabsRef.current.find((tab) => tab.hostId === host.id);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const tab: TerminalTab = { id: `terminal-${Date.now()}-${tabSequence.current++}`, hostId: host.id, hostName: host.name };
    const next = [...tabsRef.current, tab];
    tabsRef.current = next;
    setTabs(next);
    setActiveTabId(tab.id);
  }, [notify]);

  useEffect(() => {
    if (!openRequest || openRequest.id === handledRequestId.current || !loaded) return;
    handledRequestId.current = openRequest.id;
    const host = hosts.find((candidate) => candidate.id === openRequest.hostId);
    if (host) openHost(host);
    else notify("error", "要打开的主机已不存在");
  }, [hosts, loaded, notify, openHost, openRequest]);

  function closeTab(tabId: string) {
    const index = tabsRef.current.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;
    const next = tabsRef.current.filter((tab) => tab.id !== tabId);
    tabsRef.current = next;
    setTabs(next);
    setConnections((current) => {
      const updated = { ...current };
      delete updated[tabId];
      return updated;
    });
    if (activeTabId === tabId) setActiveTabId(next[index]?.id ?? next[index - 1]?.id ?? null);
  }

  const updateConnection = useCallback((tabId: string, connection: TerminalConnection) => {
    setConnections((current) => current[tabId] === connection ? current : { ...current, [tabId]: connection });
  }, []);

  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const filteredHosts = hosts.filter((host) => !normalizedQuery || [host.name, host.hostname, host.groupName ?? "", ...host.tags].join(" ").toLocaleLowerCase("zh-CN").includes(normalizedQuery));
  const groups = groupHosts(filteredHosts);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const connectedCount = Object.values(connections).filter((connection) => connection === "CONNECTED").length;

  return <section className="terminal-workspace" aria-label="终端工作区">
    <div className="terminal-workspace-shell">
      <aside className="terminal-host-sidebar">
        <header><div><strong>SSH 主机</strong><small>{hosts.length} 台主机 · {connectedCount} 个活动会话</small></div><button className="terminal-sidebar-refresh" title="刷新主机列表" aria-label="刷新主机列表" onClick={() => void load()}><ArrowClockwise size={16} /></button></header>
        <label className="terminal-host-search"><MagnifyingGlass size={16} aria-hidden="true" /><span className="sr-only">搜索终端主机</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索主机" /></label>
        <div className="terminal-host-list">
          {groups.map((group) => <div className="terminal-host-group" key={group.key}>
            <div className="terminal-host-group-title"><span>{group.name}</span><em>{group.hosts.length}</em></div>
            {group.hosts.map((host) => {
              const selected = activeTab?.hostId === host.id;
              const opened = tabs.some((tab) => tab.hostId === host.id);
              return <button key={host.id} className={selected ? "selected" : ""} disabled={!host.enabled} title={host.enabled ? `打开 ${host.name} 终端` : `${host.name} 已停用`} onClick={() => openHost(host)}>
                <i className={`terminal-host-state ${host.status === "CONNECTED" ? "connected" : ""}`} />
                <span><strong>{host.name}</strong><small>{host.hostname}:{host.port}</small></span>
                {opened && <em className="terminal-host-opened" aria-label="终端已打开" />}
              </button>;
            })}
          </div>)}
          {loaded && filteredHosts.length === 0 && <div className="terminal-sidebar-empty">没有符合条件的主机</div>}
        </div>
      </aside>
      <div className="terminal-workbench">
        <div className="terminal-tab-strip" role="tablist" aria-label="已打开的终端">
          {tabs.map((tab) => {
            const selected = tab.id === activeTabId;
            const connection = connections[tab.id] ?? "IDLE";
            return <div key={tab.id} className={`terminal-tab ${selected ? "selected" : ""}`}>
              <button role="tab" aria-selected={selected} title={tab.hostName} onClick={() => setActiveTabId(tab.id)}><i className={`terminal-tab-state ${connection.toLocaleLowerCase()}`} /><TerminalWindow size={15} aria-hidden="true" /><span>{tab.hostName}</span></button>
              <button className="terminal-tab-close" title={`关闭 ${tab.hostName} 终端`} aria-label={`关闭 ${tab.hostName} 终端`} onClick={() => closeTab(tab.id)}><X size={13} /></button>
            </div>;
          })}
          {tabs.length === 0 && <span className="terminal-tabs-placeholder">从左侧选择主机以打开终端</span>}
        </div>
        <div className="terminal-session-stack">
          {tabs.length === 0 && <div className="terminal-workspace-empty"><TerminalWindow size={42} weight="thin" aria-hidden="true" /><strong>打开一个 SSH 终端</strong><span>可以同时打开多台主机，使用上方标签快速切换，会话与屏幕内容都会保留。</span></div>}
          {tabs.map((tab) => {
            const host = hosts.find((candidate) => candidate.id === tab.hostId);
            if (!host) return <div key={tab.id} className="terminal-workspace-empty" hidden={tab.id !== activeTabId}><strong>{tab.hostName} 已不存在</strong><span>关闭此标签后从主机列表选择其他主机。</span></div>;
            return <TerminalSession key={tab.id} tabId={tab.id} host={host} logins={logins.filter((login) => login.hostId === host.id)} active={active && tab.id === activeTabId} onConnectionChange={updateConnection} />;
          })}
        </div>
      </div>
    </div>
  </section>;
}

function TerminalSession({ tabId, host, logins, active, onConnectionChange }: {
  tabId: string;
  host: Host;
  logins: HostLogin[];
  active: boolean;
  onConnectionChange(tabId: string, connection: TerminalConnection): void;
}) {
  const screenRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const defaultLoginId = logins.find((login) => login.active)?.id ?? logins[0]?.id ?? "";
  const [loginId, setLoginId] = useState(defaultLoginId);
  const [connection, setConnection] = useState<TerminalConnection>("IDLE");
  const [errorText, setErrorText] = useState("");
  const [activeUsername, setActiveUsername] = useState("");

  useEffect(() => onConnectionChange(tabId, connection), [connection, onConnectionChange, tabId]);

  const fitTerminal = useCallback(() => {
    const screen = screenRef.current;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!screen || !term || !fit || screen.clientWidth === 0 || screen.clientHeight === 0) return;
    try { fit.fit(); } catch { return; }
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }, []);

  useEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;
    const term = new Terminal({
      cursorBlink: true,
      scrollback: 5000,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "PingFang SC", monospace',
      theme: TERMINAL_THEME
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(screen);
    try { term.loadAddon(new WebglAddon()); } catch { /* WebGL unavailable: xterm falls back to DOM renderer. */ }
    termRef.current = term;
    fitRef.current = fit;
    fitTerminal();

    const encoder = new TextEncoder();
    const dataListener = term.onData((data) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
    });
    const resizeObserver = new ResizeObserver(fitTerminal);
    resizeObserver.observe(screen);

    return () => {
      dataListener.dispose();
      resizeObserver.disconnect();
      wsRef.current?.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [fitTerminal]);

  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      fitTerminal();
      termRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, fitTerminal]);

  const connect = useCallback((targetLoginId: string) => {
    const term = termRef.current;
    if (!term || !targetLoginId) return;
    wsRef.current?.close();
    setErrorText("");
    setActiveUsername("");
    setConnection("CONNECTING");
    fitTerminal();
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${window.location.host}/v1/hosts/${encodeURIComponent(host.id)}/terminal?loginId=${encodeURIComponent(targetLoginId)}&cols=${term.cols}&rows=${term.rows}`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const control = JSON.parse(event.data) as { type: string; username?: string; exitCode?: number | null; message?: string };
          if (control.type === "ready") {
            setConnection("CONNECTED");
            setActiveUsername(control.username ?? "");
            if (active) term.focus();
          } else if (control.type === "exit") {
            setConnection("CLOSED");
            term.write(`\r\n\x1b[2m[会话已结束${control.exitCode != null ? ` · 退出码 ${control.exitCode}` : ""}]\x1b[0m\r\n`);
          } else if (control.type === "error") {
            setConnection("ERROR");
            setErrorText(control.message ?? "连接失败");
          }
        } catch { /* Unknown text frames are ignored. */ }
        return;
      }
      term.write(new Uint8Array(event.data as ArrayBuffer));
    };
    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      setConnection((current) => current === "ERROR" || current === "CLOSED" ? current : "CLOSED");
    };
    ws.onerror = () => {
      setConnection("ERROR");
      setErrorText((current) => current || "无法连接 Hoplane Core，请确认服务正常运行");
    };
  }, [active, fitTerminal, host.id]);

  useEffect(() => {
    if (defaultLoginId) connect(defaultLoginId);
    // 每个标签仅在创建时自动连接一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function disconnect() {
    const ws = wsRef.current;
    if (!ws) return;
    setConnection("CLOSED");
    ws.close();
  }

  const busy = connection === "CONNECTING";
  const connected = connection === "CONNECTED";
  const selectedLogin = logins.find((login) => login.id === loginId);
  return <div className="terminal-session" hidden={!active}>
    <div className="terminal-shell interactive-terminal">
      <div className="terminal-toolbar">
        <TerminalWindow size={18} aria-hidden="true" />
        <div className="terminal-session-address"><span>{connected && activeUsername ? `${activeUsername}@${host.hostname}:${host.port}` : `${host.hostname}:${host.port}`}</span><span className={`monitor-state ${connected ? "live" : busy ? "connecting" : "idle"}`}><i />{CONNECTION_LABELS[connection]}</span></div>
        <div className="terminal-output-control interactive-terminal-controls">
          <div className="terminal-login-picker"><span>登录用户</span><AppSelect ariaLabel={`${host.name} 终端登录用户`} value={loginId} disabled={connected || busy || logins.length === 0} onChange={setLoginId} options={logins.length === 0 ? [{ value: "", label: "暂无可用用户" }] : logins.map((login) => ({ value: login.id, label: `${login.username}${login.active ? "（AI 当前）" : ""}` }))} /></div>
          <button onClick={() => termRef.current?.clear()}>清屏</button>
          {connected || busy
            ? <button className="danger-button" disabled={busy} onClick={disconnect}>{busy ? "连接中…" : "断开"}</button>
            : <button className="primary" disabled={!loginId} onClick={() => connect(loginId)}>{connection === "IDLE" ? "连接" : "重新连接"}</button>}
        </div>
      </div>
      {connection === "ERROR" && errorText && <div className="terminal-error-banner" role="alert">{errorText}</div>}
      <div className="interactive-terminal-screen" ref={screenRef} aria-label={`${host.name} 交互终端`} />
      <div className="terminal-session-footnote">人工会话 · {selectedLogin?.username ?? "所选用户"} · 不经过 AI 策略 · 输入与输出不保存</div>
    </div>
  </div>;
}
