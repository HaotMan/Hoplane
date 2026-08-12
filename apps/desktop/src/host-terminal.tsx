import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { TerminalWindow } from "@phosphor-icons/react";
import "@xterm/xterm/css/xterm.css";
import { AppSelect } from "./app-select";
import { Breadcrumb, PageHeader } from "./page-chrome";
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

export function HostTerminalPage({ host, logins, onBack }: { host: Host; logins: HostLogin[]; onBack(): void }) {
  const screenRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const defaultLoginId = logins.find((login) => login.active)?.id ?? logins[0]?.id ?? "";
  const [loginId, setLoginId] = useState(defaultLoginId);
  const [connection, setConnection] = useState<TerminalConnection>("IDLE");
  const [errorText, setErrorText] = useState("");
  const [activeUsername, setActiveUsername] = useState("");

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
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const encoder = new TextEncoder();
    const dataListener = term.onData((data) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
    });
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    });
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
  }, []);

  const connect = useCallback((targetLoginId: string) => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit || !targetLoginId) return;
    wsRef.current?.close();
    setErrorText("");
    setConnection("CONNECTING");
    fit.fit();
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${window.location.host}/v1/hosts/${encodeURIComponent(host.id)}/terminal?loginId=${encodeURIComponent(targetLoginId)}&cols=${term.cols}&rows=${term.rows}`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        const control = JSON.parse(event.data) as { type: string; username?: string; exitCode?: number | null; message?: string };
        if (control.type === "ready") {
          setConnection("CONNECTED");
          setActiveUsername(control.username ?? "");
          term.focus();
        } else if (control.type === "exit") {
          setConnection("CLOSED");
          term.write(`\r\n\x1b[2m[会话已结束${control.exitCode != null ? ` · 退出码 ${control.exitCode}` : ""}]\x1b[0m\r\n`);
        } else if (control.type === "error") {
          setConnection("ERROR");
          setErrorText(control.message ?? "连接失败");
        }
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
  }, [host.id]);

  useEffect(() => {
    if (defaultLoginId) connect(defaultLoginId);
    // 仅在进入页面时自动连接一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function disconnect() {
    wsRef.current?.close();
    wsRef.current = null;
  }

  const busy = connection === "CONNECTING";
  const connected = connection === "CONNECTED";
  const selectedLogin = logins.find((login) => login.id === loginId);
  return <section className="terminal-page">
    <PageHeader breadcrumb={<Breadcrumb parentLabel="主机" current="终端" onBack={onBack} />} title={host.name}>
      <div className="header-actions">
        <span className={`monitor-state ${connected ? "live" : busy ? "connecting" : "idle"}`}><i />{CONNECTION_LABELS[connection]}</span>
        <button onClick={() => termRef.current?.clear()}>清屏</button>
      </div>
    </PageHeader>
    <div className="terminal-shell panel interactive-terminal">
      <div className="terminal-toolbar">
        <TerminalWindow size={18} aria-hidden="true" />
        <span>{connected && activeUsername ? `${activeUsername}@${host.hostname}:${host.port}` : `${host.hostname}:${host.port}`}</span>
        <div className="terminal-output-control interactive-terminal-controls">
          <div className="terminal-login-picker"><span>登录用户</span><AppSelect ariaLabel="终端登录用户" value={loginId} disabled={connected || busy || logins.length === 0} onChange={setLoginId} options={logins.length === 0 ? [{ value: "", label: "暂无可用用户" }] : logins.map((login) => ({ value: login.id, label: `${login.username}${login.active ? "（AI 当前）" : ""}` }))} /></div>
          {connected || busy
            ? <button className="danger-button" disabled={busy} onClick={disconnect}>{busy ? "连接中…" : "断开连接"}</button>
            : <button className="primary" disabled={!loginId} onClick={() => connect(loginId)}>{connection === "IDLE" ? "连接" : "重新连接"}</button>}
        </div>
      </div>
      {connection === "ERROR" && errorText && <div className="terminal-error-banner" role="alert">{errorText}</div>}
      <div className="interactive-terminal-screen" ref={screenRef} aria-label={`${host.name} 交互终端`} />
    </div>
    <p className="monitor-footnote">
      终端会话以 {selectedLogin?.username ?? "所选用户"} 身份直接连接远端，属于人工操作，不经过 AI 策略黑名单；会话的开始与结束会写入审计，命令与输出不会保存。切换此处的登录用户不会影响 AI 使用的身份。
    </p>
  </section>;
}
