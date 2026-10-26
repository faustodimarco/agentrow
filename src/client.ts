import net from "node:net";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { daemonArgv, ensureHome, LOG_PATH, SOCKET_PATH } from "./paths.ts";
import { isInstalled, startService } from "./service.ts";
import type { RpcRequest } from "./server.ts";

export class RpcError extends Error {}

export function connect(): Promise<net.Socket> {
  const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
  const sock = net.connect(SOCKET_PATH);
  sock.once("connect", () => resolve(sock));
  sock.once("error", reject);
  return promise;
}

/** Read newline-delimited JSON messages from a socket. */
export function onLines(sock: net.Socket, handler: (msg: Record<string, unknown>) => void): void {
  let buffer = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line) handler(JSON.parse(line) as Record<string, unknown>);
    }
  });
}

export async function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const sock = await connect();
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  onLines(sock, (msg) => {
    sock.end();
    if (typeof msg.error === "string") reject(new RpcError(msg.error));
    else resolve(msg.result as T);
  });
  sock.once("close", () => reject(new RpcError("daemon closed the connection")));
  const req: RpcRequest = { id: 1, method, params };
  sock.write(`${JSON.stringify(req)}\n`);
  return promise;
}

export async function isDaemonRunning(): Promise<boolean> {
  try {
    await call("ping");
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the daemon if it is not running: through launchd/systemd when installed
 * (so it stays supervised), otherwise as a detached process that outlives this terminal.
 */
export async function ensureDaemon(): Promise<void> {
  if (await isDaemonRunning()) return;
  ensureHome();
  if (isInstalled()) {
    startService();
  } else {
    const log = openSync(LOG_PATH, "a");
    const [cmd, ...args] = daemonArgv();
    spawn(cmd!, args, { detached: true, stdio: ["ignore", log, log] }).unref();
  }
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(100);
    if (await isDaemonRunning()) return;
  }
  throw new RpcError(`daemon did not start; see ${LOG_PATH}`);
}
