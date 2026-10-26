import net from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { SOCKET_PATH } from "./paths.ts";
import { Daemon, DaemonError } from "./daemon.ts";
import type { AgentState } from "./kinds.ts";

/**
 * Wire protocol: newline-delimited JSON over a unix socket.
 * Request `{id, method, params}` → response `{id, result}` or `{id, error}`.
 * `attach` turns the connection into a stream of frames:
 *   server → client `{t:"o", d}` output, `{t:"x", code}` agent exited
 *   client → server `{t:"i", d}` input, `{t:"r", cols, rows}` resize
 */
export interface RpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export type Frame =
  | { t: "o"; d: string }
  | { t: "x"; code: number | null }
  | { t: "i"; d: string }
  | { t: "r"; cols: number; rows: number };

type Params = Record<string, unknown>;

function str(p: Params, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || !v) throw new DaemonError(`missing "${key}"`);
  return v;
}

function methods(daemon: Daemon, stopDaemon: () => void): Record<string, (p: Params) => unknown> {
  return {
    ping: () => ({ pid: process.pid }),
    "ws.list": () =>
      [...daemon.workspaces.values()].map((ws) => ({ ...ws, agents: daemon.list(ws.name) })),
    "ws.create": (p) => daemon.createWorkspace(str(p, "name"), str(p, "root")),
    "ws.remove": (p) => daemon.removeWorkspace(str(p, "name"), p.force === true),
    "agent.list": (p) => daemon.list(p.ws as string | undefined),
    "agent.create": (p) =>
      daemon.createAgent({
        ws: str(p, "ws"),
        name: str(p, "name"),
        kind: (p.kind as string | undefined) ?? "claude",
        cwd: p.cwd as string | undefined,
        args: (p.args as string[] | undefined) ?? [],
      }),
    "agent.get": (p) => daemon.info(daemon.resolve(str(p, "agent"))),
    "agent.prompt": async (p) => {
      const ref = str(p, "agent");
      await daemon.prompt(ref, str(p, "text"));
      if (!p.wait) return daemon.info(daemon.resolve(ref));
      const timeout = p.timeout as number | undefined;
      // Wait for the turn to start, then for it to settle.
      await daemon.wait(ref, ["working", "blocked"], 5000).catch(() => undefined);
      return daemon.wait(ref, ["idle", "blocked"], timeout);
    },
    "agent.keys": (p) => daemon.keys(str(p, "agent"), p.keys as string[]),
    "agent.read": (p) => daemon.read(str(p, "agent"), p.lines as number | undefined),
    "agent.wait": (p) =>
      daemon.wait(str(p, "agent"), (p.until as AgentState[] | undefined) ?? ["idle", "blocked"], p.timeout as number | undefined),
    "agent.stop": (p) => daemon.stop(str(p, "agent")),
    "agent.restart": (p) => daemon.restart(str(p, "agent")),
    "agent.remove": (p) => daemon.removeAgent(str(p, "agent")),
    "config.reload": () => daemon.reloadConfig(),
    "daemon.stop": () => {
      setTimeout(stopDaemon, 50);
      return { stopping: true };
    },
  };
}

function attach(daemon: Daemon, sock: net.Socket, p: Params, reqId: number): (frame: Frame) => void {
  const slot = daemon.resolve(str(p, "agent"));
  const session = daemon.running(slot);
  const send = (msg: unknown) => sock.write(`${JSON.stringify(msg)}\n`);
  send({ id: reqId, result: { agent: slot.rec.id } });
  if (typeof p.cols === "number" && typeof p.rows === "number") session.resize(p.cols, p.rows);
  send({ t: "o", d: `\x1b[H\x1b[2J${session.snapshot()}` });
  const onOutput = (d: string) => send({ t: "o", d });
  const onExit = (code: number | null) => {
    send({ t: "x", code });
    sock.end();
  };
  session.on("output", onOutput);
  session.once("exit", onExit);
  sock.once("close", () => {
    session.off("output", onOutput);
    session.off("exit", onExit);
  });
  return (frame) => {
    if (frame.t === "i") session.write(frame.d);
    else if (frame.t === "r") session.resize(frame.cols, frame.rows);
  };
}

export function startServer(daemon: Daemon, stopDaemon: () => void): net.Server {
  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  const table = methods(daemon, stopDaemon);
  const server = net.createServer((sock) => {
    let buffer = "";
    let streamHandler: ((frame: Frame) => void) | null = null;
    sock.setEncoding("utf8");
    sock.on("error", () => sock.destroy());
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        if (streamHandler) {
          streamHandler(JSON.parse(line) as Frame);
          continue;
        }
        const req = JSON.parse(line) as RpcRequest;
        const params = req.params ?? {};
        if (req.method === "attach") {
          try {
            streamHandler = attach(daemon, sock, params, req.id);
          } catch (err) {
            sock.end(`${JSON.stringify({ id: req.id, error: (err as Error).message })}\n`);
          }
          continue;
        }
        const fn = table[req.method];
        void (async () => {
          try {
            if (!fn) throw new DaemonError(`unknown method "${req.method}"`);
            const result = (await fn(params)) ?? null;
            sock.write(`${JSON.stringify({ id: req.id, result })}\n`);
          } catch (err) {
            sock.write(`${JSON.stringify({ id: req.id, error: (err as Error).message })}\n`);
          }
        })();
      }
    });
  });
  server.listen(SOCKET_PATH);
  return server;
}
