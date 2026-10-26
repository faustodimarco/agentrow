import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const HOME = process.env.AGENTROW_HOME ?? join(homedir(), ".agentrow");
export const SOCKET_PATH = join(HOME, "agentrow.sock");
export const STATE_PATH = join(HOME, "state.json");
export const CONFIG_PATH = join(HOME, "config.json");
export const LOG_PATH = join(HOME, "daemon.log");
export const PID_PATH = join(HOME, "daemon.pid");

export function ensureHome(): void {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export const DEFAULT_SHELL = process.env.SHELL ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");

/** Command line that runs the daemon in the foreground (works for `bun src/cli.ts` and compiled binaries). */
export function daemonArgv(): string[] {
  return Bun.main.endsWith(".ts") ? [process.execPath, Bun.main, "daemon"] : [process.execPath, "daemon"];
}
