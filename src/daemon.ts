import { EventEmitter } from "node:events";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureHome, expandHome, STATE_PATH } from "./paths.ts";
import { KINDS, type AgentState } from "./kinds.ts";
import { PtySession } from "./session.ts";
import { encodeKey } from "./keys.ts";
import { loadConfig, type Config } from "./config.ts";

export const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const KEY_GAP_MS = 40;

export interface WorkspaceRecord {
  name: string;
  root: string;
}

export interface AgentRecord {
  /** `<workspace>/<name>` */
  id: string;
  ws: string;
  name: string;
  kind: string;
  cwd: string;
  args: string[];
  sessionId?: string;
  /** Telegram forum topic (message_thread_id) for this agent. */
  topicId?: number;
  /** Restore on daemon start; false after an explicit stop. */
  wantRunning: boolean;
  createdAt: number;
}

export interface AgentInfo extends AgentRecord {
  state: AgentState;
  exitCode: number | null;
  lastOutputAt: number;
}

interface PersistedState {
  workspaces: WorkspaceRecord[];
  agents: AgentRecord[];
}

interface AgentSlot {
  rec: AgentRecord;
  session?: PtySession;
  exitCode: number | null;
}

export interface DaemonEvents {
  "agent-created": [rec: AgentRecord];
  "agent-removed": [rec: AgentRecord];
  "agent-state": [rec: AgentRecord, next: AgentState, prev: AgentState];
  "agent-exit": [rec: AgentRecord, code: number | null];
  /** A turn finished; see `SessionEvents.done`. */
  "agent-done": [rec: AgentRecord];
  "config-changed": [cfg: Config];
}

export class DaemonError extends Error {}

export class Daemon extends EventEmitter<DaemonEvents> {
  readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly agents = new Map<string, AgentSlot>();
  config: Config = loadConfig();

  load(): void {
    if (!existsSync(STATE_PATH)) return;
    const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as PersistedState;
    for (const ws of state.workspaces) this.workspaces.set(ws.name, ws);
    for (const rec of state.agents) this.agents.set(rec.id, { rec, exitCode: null });
  }

  save(): void {
    ensureHome();
    const state: PersistedState = {
      workspaces: [...this.workspaces.values()],
      agents: [...this.agents.values()].map((s) => s.rec),
    };
    writeFileSync(`${STATE_PATH}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${STATE_PATH}.tmp`, STATE_PATH);
  }

  /** Relaunch every agent that was running when the daemon last stopped. */
  restore(): void {
    for (const slot of this.agents.values()) {
      if (!slot.rec.wantRunning) continue;
      try {
        this.spawn(slot, true);
      } catch (err) {
        console.error(`restore ${slot.rec.id}: ${(err as Error).message}`);
      }
    }
  }

  reloadConfig(): void {
    this.config = loadConfig();
    this.emit("config-changed", this.config);
  }

  // ── workspaces ────────────────────────────────────────────────────────

  createWorkspace(name: string, root: string): WorkspaceRecord {
    if (!NAME_RE.test(name)) throw new DaemonError(`invalid workspace name "${name}" (use ${NAME_RE.source})`);
    if (this.workspaces.has(name)) throw new DaemonError(`workspace "${name}" already exists`);
    const dir = resolve(expandHome(root));
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new DaemonError(`not a directory: ${dir}`);
    const ws = { name, root: dir };
    this.workspaces.set(name, ws);
    this.save();
    return ws;
  }

  removeWorkspace(name: string, force: boolean): void {
    if (!this.workspaces.has(name)) throw new DaemonError(`no workspace "${name}"`);
    const members = [...this.agents.values()].filter((s) => s.rec.ws === name);
    if (members.length && !force) {
      throw new DaemonError(`workspace "${name}" has ${members.length} agent(s); remove them or use --force`);
    }
    for (const slot of members) this.removeAgent(slot.rec.id);
    this.workspaces.delete(name);
    this.save();
  }

  // ── agents ────────────────────────────────────────────────────────────

  createAgent(opts: { ws: string; name: string; kind: string; cwd?: string; args: string[] }): AgentInfo {
    const ws = this.workspaces.get(opts.ws);
    if (!ws) throw new DaemonError(`no workspace "${opts.ws}"`);
    if (!NAME_RE.test(opts.name)) throw new DaemonError(`invalid agent name "${opts.name}" (use ${NAME_RE.source})`);
    if (!KINDS[opts.kind]) throw new DaemonError(`unknown kind "${opts.kind}" (${Object.keys(KINDS).join(", ")})`);
    const id = `${ws.name}/${opts.name}`;
    if (this.agents.has(id)) throw new DaemonError(`agent "${id}" already exists`);
    const cwd = resolve(ws.root, expandHome(opts.cwd ?? "."));
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new DaemonError(`not a directory: ${cwd}`);
    const rec: AgentRecord = {
      id,
      ws: ws.name,
      name: opts.name,
      kind: opts.kind,
      cwd,
      args: opts.args,
      wantRunning: true,
      createdAt: Date.now(),
    };
    const slot: AgentSlot = { rec, exitCode: null };
    this.agents.set(id, slot);
    this.spawn(slot, false);
    this.save();
    this.emit("agent-created", rec);
    return this.info(slot);
  }

  /** Resolve `ws/name`, or a bare name that is unique across workspaces. */
  resolve(ref: string): AgentSlot {
    const exact = this.agents.get(ref);
    if (exact) return exact;
    const matches = [...this.agents.values()].filter((s) => s.rec.name === ref);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new DaemonError(`"${ref}" is ambiguous: ${matches.map((s) => s.rec.id).join(", ")}`);
    throw new DaemonError(`no agent "${ref}"`);
  }

  byTopic(topicId: number): AgentSlot | undefined {
    return [...this.agents.values()].find((s) => s.rec.topicId === topicId);
  }

  list(ws?: string): AgentInfo[] {
    return [...this.agents.values()].filter((s) => !ws || s.rec.ws === ws).map((s) => this.info(s));
  }

  info(slot: AgentSlot): AgentInfo {
    return {
      ...slot.rec,
      state: slot.session?.state ?? "exited",
      exitCode: slot.exitCode,
      lastOutputAt: slot.session?.lastOutputAt ?? 0,
    };
  }

  setTopic(id: string, topicId: number | undefined): void {
    const slot = this.agents.get(id);
    if (!slot) return;
    slot.rec.topicId = topicId;
    this.save();
  }

  running(slot: AgentSlot): PtySession {
    const s = slot.session;
    if (!s || s.state === "exited") throw new DaemonError(`agent "${slot.rec.id}" is not running (restart it)`);
    return s;
  }

  async prompt(ref: string, text: string): Promise<void> {
    const slot = this.resolve(ref);
    const session = this.running(slot);
    if (session.state === "blocked") {
      throw new DaemonError(`agent "${slot.rec.id}" is blocked on a dialog; answer it with keys`);
    }
    await session.prompt(text);
  }

  /** Send keys one at a time; TUIs like Ink misparse several keys arriving in one read. */
  async keys(ref: string, keys: string[]): Promise<void> {
    const session = this.running(this.resolve(ref));
    const encoded = keys.map(encodeKey); // validate all before sending any
    for (const [i, k] of encoded.entries()) {
      if (i) await Bun.sleep(KEY_GAP_MS);
      session.write(k);
    }
  }

  read(ref: string, lines?: number): string {
    const slot = this.resolve(ref);
    if (!slot.session) throw new DaemonError(`agent "${slot.rec.id}" has no screen yet`);
    return slot.session.screen(lines);
  }

  /** Resolve once the agent is in one of `states`; immediately if it already is. */
  wait(ref: string, states: AgentState[], timeoutMs?: number): Promise<AgentInfo> {
    const slot = this.resolve(ref);
    const current = slot.session?.state ?? "exited";
    if (states.includes(current)) return Promise.resolve(this.info(slot));
    const { promise, resolve, reject } = Promise.withResolvers<AgentInfo>();
    const onState = (rec: AgentRecord, next: AgentState) => {
      if (rec.id !== slot.rec.id) return;
      if (states.includes(next)) {
        cleanup();
        resolve(this.info(slot));
      } else if (next === "exited") {
        cleanup();
        reject(new DaemonError(`agent "${rec.id}" exited`));
      }
    };
    const timer = timeoutMs ? setTimeout(() => (cleanup(), reject(new DaemonError("timeout"))), timeoutMs) : undefined;
    const cleanup = () => {
      clearTimeout(timer);
      this.off("agent-state", onState);
    };
    this.on("agent-state", onState);
    return promise;
  }

  stop(ref: string): AgentInfo {
    const slot = this.resolve(ref);
    slot.rec.wantRunning = false;
    slot.session?.kill();
    this.save();
    return this.info(slot);
  }

  async restart(ref: string): Promise<AgentInfo> {
    const slot = this.resolve(ref);
    const old = slot.session;
    if (old && old.state !== "exited") {
      const exited = Promise.withResolvers<void>();
      old.once("exit", () => exited.resolve());
      old.kill();
      await exited.promise;
    }
    slot.rec.wantRunning = true;
    this.spawn(slot, true);
    this.save();
    return this.info(slot);
  }

  removeAgent(ref: string): AgentRecord {
    const slot = this.resolve(ref);
    slot.session?.removeAllListeners();
    slot.session?.kill();
    this.agents.delete(slot.rec.id);
    this.save();
    this.emit("agent-removed", slot.rec);
    return slot.rec;
  }

  /** Kill every session (daemon shutdown). Records keep `wantRunning` for restore. */
  shutdown(): void {
    this.save();
    for (const slot of this.agents.values()) slot.session?.kill();
  }

  private spawn(slot: AgentSlot, resume: boolean): void {
    const rec = slot.rec;
    const kind = KINDS[rec.kind];
    if (!kind) throw new DaemonError(`unknown kind "${rec.kind}"`);
    const launch = kind.launch({ args: rec.args, sessionId: rec.sessionId, cwd: rec.cwd, resume });
    rec.sessionId = launch.sessionId;
    const session = new PtySession({
      argv: launch.argv,
      cwd: rec.cwd,
      env: {
        ...(process.env as Record<string, string>),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        AGENTROW_AGENT: rec.id,
      },
      cols: this.config.cols,
      rows: this.config.rows,
      kind,
    });
    slot.session = session;
    slot.exitCode = null;
    session.on("state", (next, prev) => {
      if (slot.session !== session) return;
      console.log(`${rec.id}: ${prev} → ${next}`);
      this.emit("agent-state", rec, next, prev);
    });
    session.on("done", () => {
      if (slot.session === session) this.emit("agent-done", rec);
    });
    session.on("exit", (code) => {
      if (slot.session !== session) return;
      slot.exitCode = code;
      this.emit("agent-exit", rec, code);
    });
    console.log(`started ${rec.id}: ${launch.argv.join(" ")} (cwd ${rec.cwd})`);
  }
}
