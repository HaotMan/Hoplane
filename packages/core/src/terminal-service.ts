import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { asAppError } from "../../shared/src/index.js";
import type { SSHConnectionManager, ShellSession } from "../../ssh-core/src/connection-manager.js";
import type { HoplaneDatabase } from "./database.js";

const TERMINAL_PATH = /^\/v1\/hosts\/([0-9a-f-]+)\/terminal$/u;
const SEND_BUFFER_PAUSE_BYTES = 4 * 1024 * 1024;
const SEND_BUFFER_RESUME_BYTES = 512 * 1024;

interface TerminalGatewayOptions {
  database: HoplaneDatabase;
  ssh: SSHConnectionManager;
  isSameOriginUiRequest(request: IncomingMessage): boolean;
}

export interface TerminalGateway {
  disconnectAll(): void;
  closeAll(): void;
}

/**
 * Interactive terminal gateway for the desktop UI (Xshell-style sessions).
 *
 * Protocol on /v1/hosts/:id/terminal?loginId=...&cols=..&rows=..:
 * - binary frames carry raw terminal bytes in both directions
 * - text frames carry JSON control messages: client sends {type:"resize",cols,rows},
 *   server sends {type:"ready"|"exit"|"error",...}
 *
 * Sessions are human operations: they bypass the AI policy engine by design and
 * only the session start/end is recorded in the audit log. Output never touches
 * the database or the host monitor.
 */
export function attachTerminalGateway(server: Server, options: TerminalGatewayOptions): TerminalGateway {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = url.pathname.match(TERMINAL_PATH);
    if (!match) {
      socket.destroy();
      return;
    }
    if (!options.isSameOriginUiRequest(request)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => void runSession(ws, match[1]!, url.searchParams));
  });

  async function runSession(ws: WebSocket, hostId: string, params: URLSearchParams): Promise<void> {
    const loginId = params.get("loginId") ?? "";
    const cols = clampInt(params.get("cols"), 2, 500, 80);
    const rows = clampInt(params.get("rows"), 2, 300, 24);
    const host = options.database.getHost(hostId);
    const auditId = randomUUID();
    const startedAt = Date.now();
    let finalized = false;

    const finalize = (status: "SUCCEEDED" | "FAILED", errorCode?: string, errorMessage?: string) => {
      if (finalized) return;
      finalized = true;
      options.database.updateAudit(auditId, {
        status,
        durationMs: Date.now() - startedAt,
        errorCode: errorCode ?? null,
        errorMessage: errorMessage ?? null,
        finished: true
      });
    };

    options.database.createAudit({
      id: auditId,
      clientType: "UI",
      clientId: "desktop-terminal",
      hostId,
      hostNameSnapshot: host?.name,
      operationType: "TERMINAL_SESSION",
      requestSummary: "交互终端会话"
    });

    let session: ShellSession;
    try {
      session = await options.ssh.openShellSession(hostId, loginId, { cols, rows });
    } catch (error) {
      const appError = asAppError(error);
      finalize("FAILED", appError.code, appError.message);
      sendControl(ws, { type: "error", code: appError.code, message: appError.message });
      ws.close(1011, appError.code.slice(0, 100));
      return;
    }

    options.database.updateAudit(auditId, { status: "EXECUTING" });

    let paused = false;
    const forward = (chunk: Buffer) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(chunk, { binary: true });
      if (!paused && ws.bufferedAmount > SEND_BUFFER_PAUSE_BYTES) {
        paused = true;
        session.stream.pause();
        const resume = setInterval(() => {
          if (ws.readyState !== ws.OPEN || ws.bufferedAmount < SEND_BUFFER_RESUME_BYTES) {
            clearInterval(resume);
            paused = false;
            session.stream.resume();
          }
        }, 50);
      }
    };
    session.stream.on("data", forward);
    session.stream.stderr.on("data", forward);

    session.stream.on("close", (code: number | null) => {
      finalize("SUCCEEDED");
      if (typeof code === "number") options.database.updateAudit(auditId, { exitCode: code });
      sendControl(ws, { type: "exit", exitCode: typeof code === "number" ? code : null });
      ws.close(1000, "session-ended");
    });
    session.stream.on("error", (error: Error) => {
      const appError = asAppError(error);
      finalize("FAILED", appError.code, appError.message);
      sendControl(ws, { type: "error", code: appError.code, message: appError.message });
      ws.close(1011, appError.code.slice(0, 100));
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        session.stream.write(data as Buffer);
        return;
      }
      try {
        const control = JSON.parse(String(data)) as { type?: string; cols?: number; rows?: number };
        if (control.type === "resize") {
          session.setWindow(clampInt(String(control.rows ?? ""), 2, 300, rows), clampInt(String(control.cols ?? ""), 2, 500, cols));
        }
      } catch {
        /* Malformed control frames are ignored. */
      }
    });
    ws.on("close", () => {
      finalize("SUCCEEDED");
      session.close();
    });
    ws.on("error", () => {
      finalize("SUCCEEDED");
      session.close();
    });
    sendControl(ws, { type: "ready", username: session.username });
    session.initialize();
  }

  return {
    disconnectAll() {
      for (const client of wss.clients) client.terminate();
    },
    closeAll() {
      for (const client of wss.clients) client.terminate();
      wss.close();
    }
  };
}

function sendControl(ws: WebSocket, message: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
    try { ws.send(JSON.stringify(message)); } catch { /* Socket already closing. */ }
  }
}

function clampInt(value: string | null, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
