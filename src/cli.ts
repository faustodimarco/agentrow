#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { call, connect, ensureDaemon, isDaemonRunning, onLines, RpcError } from "./client.ts";
import { Daemon, type AgentInfo, type WorkspaceRecord } from "./daemon.ts";
import { startServer } from "./server.ts";
import { TelegramBot } from "./telegram/bot.ts";
import { TelegramApi } from "./telegram/api.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { ensureHome, LOG_PATH, PID_PATH, SOCKET_PATH } from "./paths.ts";
import { install, isInstalled, PLIST_PATH, uninstall } from "./launchd.ts";
import { KEY_NAMES } from "./keys.ts";
import { KINDS, type AgentState } from "./kinds.ts";

const HELP = `agentrow — persistent coding agents, reachable from your terminal and Telegram

Daemon
  agentrow start | stop | status     start/stop the background daemon
  agentrow install | uninstall       run the daemon via launchd (starts at login, restarts on crash)
  agentrow daemon                    run the daemon in the foreground
  agentrow logs [-f]                 show the daemon log

Workspaces
  agentrow ws                        list workspaces and their agents
  agentrow ws new <name> [path]      add a workspace folder (default: current directory)
  agentrow ws rm <name> [--force]    remove a workspace (--force also removes its agents)

Agents  (<agent> is ws/name, or just name when unique)
  agentrow new <ws>/<name> [--kind claude] [--cwd subdir] [-- agent args…]
  agentrow ls [ws]                   list agents and their state
  agentrow attach <agent>            open the agent's terminal (Ctrl+] detaches)
  agentrow prompt <agent> <text…> [--wait] [--timeout ms]
  agentrow read <agent> [--lines N]  print the agent's screen
  agentrow keys <agent> <key…>       send keys: ${KEY_NAMES.join(", ")}
  agentrow wait <agent> [--until state]… [--timeout ms]
  agentrow stop | restart | rm <agent>

Telegram
  agentrow telegram setup <bot-token>   connect a bot, then /pair in a forum group
  agentrow telegram status | off

Kinds: ${Object.keys(KINDS).join(", ")}
States: starting, working, blocked, idle, exited`;

const ICON: Record<AgentState, string> = {
  starting: "○",
  working: "◐",
  blocked: "●",
  idle: "◇",
  exited: "×",
};

function fail(msg: string): never {
  console.error(`agentrow: ${msg}`);
  process.exit(1);
}

function printAgents(agents: AgentInfo[], indent = ""): void {
  if (!agents.length) return console.log(`${indent}(no agents)`);
  const width = Math.max(...agents.map((a) => a.id.length));
  for (const a of agents) {
    console.log(`${indent}${ICON[a.state]} ${a.id.padEnd(width)}  ${a.kind.padEnd(8)} ${a.state.padEnd(8)} ${a.cwd}`);
  }
}

async function runDaemon(): Promise<void> {
  ensureHome();
  if (await isDaemonRunning()) fail("daemon already running");
  const daemon = new Daemon();
  daemon.load();
  const bot = new TelegramBot(daemon);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log("daemon stopping");
    bot.stop();
    daemon.shutdown();
    server.close();
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
    if (existsSync(PID_PATH)) unlinkSync(PID_PATH);
    setTimeout(() => process.exit(0), 500);
  };
  const server = startServer(daemon, stop);
  writeFileSync(PID_PATH, String(process.pid));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", () => undefined); // survive the launching terminal closing
  daemon.restore();
  bot.start();
  console.log(`daemon ${process.pid} listening on ${SOCKET_PATH}`);
}

async function attach(ref: string): Promise<void> {
  await ensureDaemon();
  const sock = await connect();
  const { stdin, stdout } = process;
  let attachedTo = "";
  const restore = (note: string) => {
    if (stdin.isTTY) stdin.setRawMode(false);
    // Undo modes the agent may have enabled: alt screen, mouse, bracketed paste; show cursor.
    stdout.write("\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\r\n");
    console.log(note);
    process.exit(0);
  };
  onLines(sock, (msg) => {
    if ("id" in msg) {
      if (typeof msg.error === "string") fail(msg.error);
      const result = msg.result;
      if (result && typeof result === "object" && "agent" in result && typeof result.agent === "string") attachedTo = result.agent;
      return;
    }
    if (msg.t === "o" && typeof msg.d === "string") stdout.write(msg.d);
    else if (msg.t === "x") restore(`[${attachedTo} exited]`);
  });
  sock.once("close", () => restore(`[detached from ${attachedTo}]`));
  sock.write(`${JSON.stringify({ id: 1, method: "attach", params: { agent: ref, cols: stdout.columns, rows: stdout.rows } })}\n`);
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.on("data", (d: string) => {
    if (d.includes("\x1d")) return sock.end(); // Ctrl+]
    sock.write(`${JSON.stringify({ t: "i", d })}\n`);
  });
  stdout.on("resize", () => sock.write(`${JSON.stringify({ t: "r", cols: stdout.columns, rows: stdout.rows })}\n`));
}

async function telegram(args: string[]): Promise<void> {
  const [sub, token] = args;
  const cfg = loadConfig();
  if (sub === "setup") {
    if (!token) fail("usage: agentrow telegram setup <bot-token>  (get one from @BotFather)");
    const me = await new TelegramApi(token).call<{ username: string }>("getMe").catch((e: Error) => fail(`invalid token: ${e.message}`));
    const pairCode = randomBytes(4).toString("hex");
    cfg.telegram = {
      token,
      allowedUserIds: cfg.telegram?.allowedUserIds ?? [],
      topicsChatId: cfg.telegram?.topicsChatId,
      pairCode,
    };
    saveConfig(cfg);
    await ensureDaemon();
    await call("config.reload");
    console.log(`Bot @${me.username} connected. To pair:
  1. Create a Telegram group and enable Topics (group settings → Topics).
  2. Add @${me.username} and make it admin with "Manage Topics".
  3. Send in the group:  /pair ${pairCode}`);
  } else if (sub === "status") {
    const t = cfg.telegram;
    if (!t) return console.log("telegram: not configured");
    console.log(`telegram: ${t.chatId ? `paired with chat ${t.chatId}` : `waiting for /pair ${t.pairCode}`}`);
    console.log(`allowed users: ${t.allowedUserIds.join(", ") || "(none)"}`);
  } else if (sub === "off") {
    delete cfg.telegram;
    saveConfig(cfg);
    if (await isDaemonRunning()) await call("config.reload");
    console.log("telegram: disabled");
  } else {
    fail("usage: agentrow telegram setup <token> | status | off");
  }
}

async function main(argv: string[]): Promise<void> {
  const dash = argv.indexOf("--");
  const passthrough = dash >= 0 ? argv.slice(dash + 1) : [];
  const { values: flags, positionals } = parseArgs({
    args: dash >= 0 ? argv.slice(0, dash) : argv,
    allowPositionals: true,
    options: {
      kind: { type: "string", short: "k" },
      cwd: { type: "string" },
      lines: { type: "string", short: "n" },
      wait: { type: "boolean", short: "w" },
      timeout: { type: "string" },
      until: { type: "string", multiple: true },
      force: { type: "boolean" },
      follow: { type: "boolean", short: "f" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  const timeout = flags.timeout ? Number(flags.timeout) : undefined;
  const need = (v: string | undefined, usage: string): string => v ?? fail(`usage: agentrow ${usage}`);

  if (!cmd || flags.help || cmd === "help") return console.log(HELP);

  switch (cmd) {
    case "daemon":
      return runDaemon();
    case "start":
      await ensureDaemon();
      return console.log("daemon running");
    case "stop":
      if (!(await isDaemonRunning())) return console.log("daemon not running");
      await call("daemon.stop");
      return console.log("daemon stopped");
    case "status": {
      if (!(await isDaemonRunning())) return console.log(`daemon: not running${isInstalled() ? " (launchd job installed)" : ""}`);
      const { pid } = await call<{ pid: number }>("ping");
      const agents = await call<AgentInfo[]>("agent.list");
      console.log(`daemon: running (pid ${pid})${isInstalled() ? " via launchd" : ""}`);
      return printAgents(agents);
    }
    case "install":
      if (await isDaemonRunning()) await call("daemon.stop"), await Bun.sleep(800);
      install();
      await ensureDaemon();
      return console.log(`installed ${PLIST_PATH}; daemon starts at login and restarts on crash`);
    case "uninstall":
      uninstall();
      return console.log("launchd job removed (daemon stopped)");
    case "logs": {
      const proc = Bun.spawn(["tail", ...(flags.follow ? ["-f"] : []), "-n", "100", LOG_PATH], { stdout: "inherit", stderr: "inherit" });
      await proc.exited;
      return;
    }
    case "telegram":
      return telegram(rest);
  }

  await ensureDaemon();
  switch (cmd) {
    case "ws": {
      const [sub, name, path] = rest;
      if (!sub || sub === "ls") {
        const list = await call<(WorkspaceRecord & { agents: AgentInfo[] })[]>("ws.list");
        if (!list.length) return console.log("no workspaces — add one with: agentrow ws new <name> [path]");
        for (const ws of list) {
          console.log(`${ws.name}  ${ws.root}`);
          printAgents(ws.agents, "  ");
        }
        return;
      }
      if (sub === "new") {
        const ws = await call<WorkspaceRecord>("ws.create", { name: need(name, "ws new <name> [path]"), root: path ?? process.cwd() });
        return console.log(`workspace ${ws.name} → ${ws.root}`);
      }
      if (sub === "rm") {
        await call("ws.remove", { name: need(name, "ws rm <name>"), force: flags.force });
        return console.log(`workspace ${name} removed`);
      }
      return fail(`unknown: ws ${sub}`);
    }
    case "new": {
      const target = need(rest[0], "new <ws>/<name> [--kind claude] [-- args]");
      const [ws, name] = target.split("/");
      if (!ws || !name) fail("agent must be given as <ws>/<name>");
      const a = await call<AgentInfo>("agent.create", { ws, name, kind: flags.kind ?? "claude", cwd: flags.cwd, args: passthrough });
      return console.log(`started ${a.id} (${a.kind}) in ${a.cwd}`);
    }
    case "ls":
      return printAgents(await call<AgentInfo[]>("agent.list", { ws: rest[0] }));
    case "attach":
      return attach(need(rest[0], "attach <agent>"));
    case "prompt": {
      const [ref, ...words] = rest;
      const text = [...words, ...passthrough].join(" ");
      if (!ref || !text) fail("usage: agentrow prompt <agent> <text…>");
      const a = await call<AgentInfo>("agent.prompt", { agent: ref, text, wait: flags.wait, timeout });
      return console.log(flags.wait ? a.state : "sent");
    }
    case "read":
      return console.log(await call<string>("agent.read", { agent: need(rest[0], "read <agent>"), lines: flags.lines ? Number(flags.lines) : undefined }));
    case "keys": {
      const [ref, ...keys] = rest;
      if (!ref || !keys.length) fail("usage: agentrow keys <agent> <key…>");
      await call("agent.keys", { agent: ref, keys });
      return;
    }
    case "wait": {
      const a = await call<AgentInfo>("agent.wait", { agent: need(rest[0], "wait <agent>"), until: flags.until, timeout });
      return console.log(a.state);
    }
    case "stop":
    case "restart":
    case "rm": {
      const method = { stop: "agent.stop", restart: "agent.restart", rm: "agent.remove" }[cmd];
      await call(method, { agent: need(rest[0], `${cmd} <agent>`) });
      return console.log(`${cmd}: ${rest[0]}`);
    }
    default:
      fail(`unknown command "${cmd}" (agentrow help)`);
  }
}

main(process.argv.slice(2)).catch((err: Error) => fail(err instanceof RpcError ? err.message : (err.stack ?? err.message)));
