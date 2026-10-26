import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { Daemon, type AgentInfo, type AgentRecord } from "../daemon.ts";
import { dialogOptions, KINDS, type AgentState } from "../kinds.ts";
import { saveConfig, type TelegramConfig } from "../config.ts";
import { expandHome } from "../paths.ts";
import { lastClaudeReply } from "../claude.ts";
import { TelegramApi, type InlineButton, type TgCallbackQuery, type TgMessage, type TgUpdate } from "./api.ts";

/** Telegram rejects messages over 4096 chars after entity parsing; leave room for markup. */
const MAX_TEXT = 3800;

const STATE_ICON: Record<AgentState, string> = {
  starting: "⚪",
  working: "🟡",
  blocked: "🔴",
  idle: "🟢",
  exited: "⚫",
};

const CONTROL_HELP = `<b>agentrow</b> — control topic

<b>Workspaces</b>
/ws — list workspaces and their agents
/ws_new &lt;name&gt; &lt;path&gt; — add a workspace folder
/ws_rm &lt;name&gt; [force] — remove a workspace
/ls [path] — browse folders (default ~)

<b>Agents</b>
/new &lt;ws&gt; &lt;name&gt; [kind] [args…] — start an agent (kinds: ${Object.keys(KINDS).join(", ")})
/agents [ws] — list agents with state and topic links
/stop &lt;agent&gt; · /restart &lt;agent&gt; · /rm &lt;agent&gt;

Each agent gets its own topic: write there to prompt it.`;

const AGENT_HELP = `<b>Agent topic</b>
Any text — prompt the agent
/read [lines] — show the screen
/status — state of this agent
/esc · /enter · /ctrlc — send a key
/keys &lt;key…&gt; — send keys (esc, enter, tab, shift+tab, up, down, ctrl+c, 1, y…)
/stop · /restart — stop or restart the agent`;

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function pre(text: string): string {
  const body = text.length > MAX_TEXT ? `…${text.slice(-MAX_TEXT)}` : text;
  return `<pre>${esc(body || "(empty screen)")}</pre>`;
}

export class TelegramBot {
  private api: TelegramApi | null = null;
  private abort: AbortController | null = null;
  private offset = 0;
  /** Serializes outgoing notifications so they arrive in event order. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly daemon: Daemon) {
    daemon.on("config-changed", () => this.restart());
    daemon.on("agent-created", (rec) => this.enqueue(() => this.ensureTopic(rec)));
    daemon.on("agent-removed", (rec) => this.enqueue(() => this.closeTopic(rec)));
    daemon.on("agent-state", (rec, next) => {
      if (next === "blocked") this.enqueue(() => this.onBlocked(rec));
    });
    daemon.on("agent-done", (rec) => this.enqueue(() => this.onDone(rec)));
    daemon.on("agent-exit", (rec, code) => this.enqueue(() => this.onExit(rec, code)));
  }

  private get cfg(): TelegramConfig | undefined {
    return this.daemon.config.telegram;
  }

  start(): void {
    const token = this.cfg?.token;
    if (!token) return;
    this.api = new TelegramApi(token);
    this.abort = new AbortController();
    void this.pollLoop(this.abort.signal);
    if (this.cfg?.chatId) this.enqueue(() => this.ensureAllTopics());
    console.log(`telegram: polling${this.cfg?.chatId ? ` (chat ${this.cfg.chatId})` : " (waiting for /pair)"}`);
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
    this.api = null;
  }

  private restart(): void {
    this.stop();
    this.start();
  }

  private enqueue(fn: () => Promise<unknown>): void {
    this.queue = this.queue.then(fn).catch((err: Error) => console.error(`telegram: ${err.message}`));
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.api) {
      try {
        const updates = await this.api.call<TgUpdate[]>(
          "getUpdates",
          { offset: this.offset, timeout: 30, allowed_updates: ["message", "callback_query"] },
          signal,
        );
        for (const u of updates) {
          this.offset = u.update_id + 1;
          try {
            if (u.message) await this.onMessage(u.message);
            else if (u.callback_query) await this.onCallback(u.callback_query);
          } catch (err) {
            console.error(`telegram: update ${u.update_id}: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        console.error(`telegram: poll failed: ${(err as Error).message}`);
        await Bun.sleep(5000);
      }
    }
  }

  // ── sending ───────────────────────────────────────────────────────────

  private async send(html: string, topicId?: number, buttons?: InlineButton[][]): Promise<void> {
    const chatId = this.cfg?.chatId;
    if (!this.api || !chatId) return;
    await this.api.call("sendMessage", {
      chat_id: chatId,
      message_thread_id: topicId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: buttons?.length ? { inline_keyboard: buttons } : undefined,
    });
  }

  private reply(msg: TgMessage, html: string, buttons?: InlineButton[][]): Promise<void> {
    return this.send(html, msg.is_topic_message ? msg.message_thread_id : undefined, buttons);
  }

  private topicLink(rec: AgentRecord): string {
    const chatId = this.cfg?.chatId;
    if (!chatId || !rec.topicId) return esc(rec.id);
    return `<a href="https://t.me/c/${String(chatId).replace(/^-100/, "")}/${rec.topicId}">${esc(rec.id)}</a>`;
  }

  private agentLine(a: AgentInfo): string {
    return `${STATE_ICON[a.state]} ${this.topicLink(a)} · ${esc(a.kind)} · ${a.state}`;
  }

  // ── topics ────────────────────────────────────────────────────────────

  private async ensureTopic(rec: AgentRecord): Promise<void> {
    if (!this.api || !this.cfg?.chatId || rec.topicId) return;
    const topic = await this.api.call<{ message_thread_id: number }>("createForumTopic", {
      chat_id: this.cfg.chatId,
      name: rec.id,
    });
    this.daemon.setTopic(rec.id, topic.message_thread_id);
    await this.send(
      `🐑 <b>${esc(rec.id)}</b> · ${esc(KINDS[rec.kind]?.label ?? rec.kind)}\n<code>${esc(rec.cwd)}</code>\n\n${AGENT_HELP}`,
      topic.message_thread_id,
    );
  }

  private async ensureAllTopics(): Promise<void> {
    for (const a of this.daemon.list()) await this.ensureTopic(a);
  }

  private async closeTopic(rec: AgentRecord): Promise<void> {
    if (!this.api || !this.cfg?.chatId || !rec.topicId) return;
    await this.send(`🗑 <b>${esc(rec.id)}</b> removed`, rec.topicId);
    await this.api.call("closeForumTopic", { chat_id: this.cfg.chatId, message_thread_id: rec.topicId });
  }

  // ── notifications ─────────────────────────────────────────────────────

  private async onBlocked(rec: AgentRecord): Promise<void> {
    if (!rec.topicId) return;
    const screen = this.daemon.read(rec.id);
    const options: InlineButton[][] = dialogOptions(screen).map((o) => [
      { text: o.label.slice(0, 60), callback_data: `n|${rec.id}|${o.delta}` },
    ]);
    options.push([{ text: "Esc", callback_data: `k|${rec.id}|esc` }, { text: "Enter", callback_data: `k|${rec.id}|enter` }]);
    await this.send(`🔴 <b>${esc(rec.id)}</b> needs you\n${pre(screen.split("\n").slice(-25).join("\n"))}`, rec.topicId, options);
  }

  private async onDone(rec: AgentRecord): Promise<void> {
    if (!rec.topicId) return;
    const reply = rec.kind === "claude" && rec.sessionId ? lastClaudeReply(rec.cwd, rec.sessionId) : null;
    const body = reply ? esc(reply.length > MAX_TEXT ? `${reply.slice(0, MAX_TEXT)}…` : reply) : pre(this.daemon.read(rec.id, 40));
    await this.send(`✅ <b>${esc(rec.id)}</b> done\n\n${body}`, rec.topicId);
  }

  private async onExit(rec: AgentRecord, code: number | null): Promise<void> {
    if (!rec.topicId) return;
    const text = rec.wantRunning ? `⚫ <b>${esc(rec.id)}</b> exited (code ${code ?? "?"})` : `⏹ <b>${esc(rec.id)}</b> stopped`;
    await this.send(text, rec.topicId, [[{ text: "Restart", callback_data: `r|${rec.id}` }]]);
  }

  // ── incoming ──────────────────────────────────────────────────────────

  private authorized(chatId: number, userId: number | undefined): boolean {
    const cfg = this.cfg;
    return !!cfg && cfg.chatId === chatId && userId !== undefined && cfg.allowedUserIds.includes(userId);
  }

  private async onMessage(msg: TgMessage): Promise<void> {
    const text = msg.text?.trim();
    if (!text) return;
    const [rawCmd = "", ...args] = text.split(/\s+/);
    const cmd = rawCmd.startsWith("/") ? rawCmd.replace(/@\w+$/, "").toLowerCase() : "";

    if (cmd === "/pair") return this.pair(msg, args[0]);
    if (!this.authorized(msg.chat.id, msg.from?.id)) return;

    if (msg.is_topic_message && msg.message_thread_id) {
      const slot = this.daemon.byTopic(msg.message_thread_id);
      if (slot) return this.agentCommand(msg, slot.rec.id, cmd, args, text);
    }
    return this.controlCommand(msg, cmd, args);
  }

  private async pair(msg: TgMessage, code: string | undefined): Promise<void> {
    const cfg = this.cfg;
    if (!cfg?.pairCode || code !== cfg.pairCode || !msg.from || !this.api) return;
    if (!msg.chat.is_forum) {
      await this.api.call("sendMessage", {
        chat_id: msg.chat.id,
        text: "This chat is not a forum. Create a group, enable Topics in its settings, add me as admin with “Manage Topics”, then send /pair again.",
      });
      return;
    }
    if (cfg.topicsChatId !== msg.chat.id) {
      // Topic ids are per chat: a different group needs fresh topics.
      for (const a of this.daemon.list()) this.daemon.setTopic(a.id, undefined);
      cfg.topicsChatId = msg.chat.id;
    }
    cfg.chatId = msg.chat.id;
    cfg.allowedUserIds = [...new Set([...cfg.allowedUserIds, msg.from.id])];
    delete cfg.pairCode;
    saveConfig(this.daemon.config);
    console.log(`telegram: paired with chat ${cfg.chatId}, user ${msg.from.id}`);
    await this.send(`✅ Paired. This group now controls agentrow.\n\n${CONTROL_HELP}`);
    await this.ensureAllTopics();
  }

  private async controlCommand(msg: TgMessage, cmd: string, args: string[]): Promise<void> {
    const d = this.daemon;
    try {
      switch (cmd) {
        case "/ws": {
          const workspaces = [...d.workspaces.values()];
          if (!workspaces.length) return this.reply(msg, "No workspaces yet. Add one with /ws_new &lt;name&gt; &lt;path&gt;");
          const blocks = workspaces.map((ws) => {
            const agents = d.list(ws.name);
            const lines = agents.length ? agents.map((a) => `  ${this.agentLine(a)}`).join("\n") : "  (no agents)";
            return `📁 <b>${esc(ws.name)}</b> <code>${esc(ws.root)}</code>\n${lines}`;
          });
          return this.reply(msg, blocks.join("\n\n"));
        }
        case "/ws_new": {
          const [name, path] = args;
          if (!name || !path) return this.reply(msg, "Usage: /ws_new &lt;name&gt; &lt;path&gt;");
          const ws = d.createWorkspace(name, path);
          return this.reply(msg, `📁 Workspace <b>${esc(ws.name)}</b> → <code>${esc(ws.root)}</code>\nStart an agent: /new ${esc(ws.name)} &lt;name&gt; claude`);
        }
        case "/ws_rm": {
          const [name, force] = args;
          if (!name) return this.reply(msg, "Usage: /ws_rm &lt;name&gt; [force]");
          d.removeWorkspace(name, force === "force");
          return this.reply(msg, `🗑 Workspace <b>${esc(name)}</b> removed`);
        }
        case "/ls": {
          const dir = resolve(expandHome(args[0] ?? "~"));
          const dirs = readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith("."))
            .map((e) => e.name)
            .sort();
          const shown = dir.startsWith(homedir()) ? `~${dir.slice(homedir().length)}` : dir;
          const list = dirs.slice(0, 80).map((n) => `📂 ${esc(n)}`).join("\n");
          return this.reply(msg, `<code>${esc(shown)}</code>\n${list || "(no folders)"}${dirs.length > 80 ? `\n… ${dirs.length - 80} more` : ""}`);
        }
        case "/new": {
          const [ws, name, kind = "claude", ...rest] = args;
          if (!ws || !name) return this.reply(msg, "Usage: /new &lt;ws&gt; &lt;name&gt; [kind] [args…]");
          const a = d.createAgent({ ws, name, kind, args: rest });
          return this.reply(msg, `🐑 Starting <b>${esc(a.id)}</b> (${esc(a.kind)}) — its topic is being created.`);
        }
        case "/agents": {
          const agents = d.list(args[0]);
          return this.reply(msg, agents.length ? agents.map((a) => this.agentLine(a)).join("\n") : "No agents. Start one with /new");
        }
        case "/stop":
        case "/restart":
        case "/rm": {
          const ref = args[0];
          if (!ref) return this.reply(msg, `Usage: ${cmd} &lt;agent&gt;`);
          if (cmd === "/stop") d.stop(ref);
          else if (cmd === "/restart") await d.restart(ref);
          else d.removeAgent(ref);
          return this.reply(msg, `👍 ${cmd.slice(1)} ${esc(ref)}`);
        }
        default:
          return this.reply(msg, CONTROL_HELP);
      }
    } catch (err) {
      return this.reply(msg, `⚠️ ${esc((err as Error).message)}`);
    }
  }

  private async agentCommand(msg: TgMessage, id: string, cmd: string, args: string[], text: string): Promise<void> {
    const d = this.daemon;
    try {
      switch (cmd) {
        case "":
          await d.prompt(id, text);
          await this.react(msg);
          return;
        case "/read":
        case "/screen":
          return this.reply(msg, pre(d.read(id, Number(args[0]) || undefined)));
        case "/status": {
          const a = d.info(d.resolve(id));
          return this.reply(msg, `${this.agentLine(a)}\n<code>${esc(a.cwd)}</code>`);
        }
        case "/esc":
        case "/enter":
          await d.keys(id, [cmd.slice(1)]);
          return this.react(msg);
        case "/ctrlc":
          await d.keys(id, ["ctrl+c"]);
          return this.react(msg);
        case "/keys":
          if (!args.length) return this.reply(msg, "Usage: /keys &lt;key…&gt;");
          await d.keys(id, args);
          return this.react(msg);
        case "/stop":
          d.stop(id);
          return;
        case "/restart":
          await d.restart(id);
          return this.reply(msg, `🔄 restarted <b>${esc(id)}</b>`);
        case "/help":
          return this.reply(msg, AGENT_HELP);
        default:
          // Unknown slash commands go to the agent: Claude/Codex have their own (/compact, /model…).
          await d.prompt(id, text);
          return this.react(msg);
      }
    } catch (err) {
      return this.reply(msg, `⚠️ ${esc((err as Error).message)}`);
    }
  }

  /** Acknowledge quietly with a reaction instead of a message. */
  private async react(msg: TgMessage): Promise<void> {
    await this.api
      ?.call("setMessageReaction", {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        reaction: [{ type: "emoji", emoji: "👀" }],
      })
      .catch(() => undefined);
  }

  private async onCallback(q: TgCallbackQuery): Promise<void> {
    if (!this.api) return;
    const msg = q.message;
    if (!msg || !this.authorized(msg.chat.id, q.from.id)) {
      await this.api.call("answerCallbackQuery", { callback_query_id: q.id, text: "Not authorized" });
      return;
    }
    const [action, id = "", key = ""] = (q.data ?? "").split("|");
    let note = "";
    try {
      if (action === "k") {
        await this.daemon.keys(id, [key]);
        note = `sent ${key}`;
      } else if (action === "n") {
        // Pick a menu option: move the highlight by `delta` rows, then confirm.
        const delta = Number(key);
        await this.daemon.keys(id, [...Array<string>(Math.abs(delta)).fill(delta > 0 ? "down" : "up"), "enter"]);
        note = "selected";
      } else if (action === "r") {
        await this.daemon.restart(id);
        note = "restarted";
      }
    } catch (err) {
      note = (err as Error).message.slice(0, 190);
    }
    await this.api.call("answerCallbackQuery", { callback_query_id: q.id, text: note });
    // One-shot buttons: drop them so stale dialogs can't be answered twice.
    await this.api
      .call("editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } })
      .catch(() => undefined);
  }
}
