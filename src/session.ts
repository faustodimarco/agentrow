import { EventEmitter } from "node:events";
import xtermHeadless, { type Terminal as HeadlessTerminal } from "@xterm/headless";
import serializeAddon from "@xterm/addon-serialize";
import { genericDetect, type AgentState, type KindDef } from "./kinds.ts";

const { Terminal } = xtermHeadless;
const { SerializeAddon } = serializeAddon;

const DETECT_INTERVAL_MS = 400;
/** A new classification must hold this long before it becomes the state. */
const STABLE_MS = 800;
/** Delay between a pasted prompt and its Enter, so TUIs see them separately. */
const SUBMIT_DELAY_MS = 150;

export interface SessionOptions {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  kind: KindDef;
}

export interface SessionEvents {
  output: [data: string];
  state: [next: AgentState, prev: AgentState];
  /**
   * A turn finished (working → idle). Activity-only detection (plain shells)
   * reports this only after a prompt from agentrow, so log noise isn't a "turn".
   */
  done: [];
  exit: [code: number | null];
}

/**
 * One agent process on a PTY, mirrored into a headless xterm so the screen
 * can be read, serialized for attach, and classified into a lifecycle state.
 */
export class PtySession extends EventEmitter<SessionEvents> {
  state: AgentState = "starting";
  readonly startedAt = Date.now();
  lastOutputAt = 0;
  private readonly proc: Bun.Subprocess;
  private readonly term: HeadlessTerminal;
  private readonly serializer = new SerializeAddon();
  private readonly decoder = new TextDecoder();
  private readonly kind: KindDef;
  private readonly timer: Timer;
  private pending: { state: AgentState; since: number } | null = null;
  /** A prompt was submitted since the last idle. */
  private prompted = false;
  /** The current working state came from the kind's detector, not raw output activity. */
  private workingRecognized = false;

  constructor(opts: SessionOptions) {
    super();
    this.kind = opts.kind;
    this.term = new Terminal({ cols: opts.cols, rows: opts.rows, scrollback: 5000, allowProposedApi: true });
    this.term.loadAddon(this.serializer);
    const shell = process.env.SHELL ?? "/bin/zsh";
    const command = `exec ${opts.argv.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" ")}`;
    this.proc = Bun.spawn([shell, "-lc", command], {
      cwd: opts.cwd,
      env: opts.env,
      terminal: {
        cols: opts.cols,
        rows: opts.rows,
        data: (_t, bytes) => {
          const text = this.decoder.decode(bytes, { stream: true });
          this.lastOutputAt = Date.now();
          this.term.write(text);
          this.emit("output", text);
        },
      },
    });
    this.timer = setInterval(() => this.detect(), DETECT_INTERVAL_MS);
    void this.proc.exited.then((code) => {
      clearInterval(this.timer);
      const prev = this.state;
      this.state = "exited";
      this.emit("state", "exited", prev);
      this.emit("exit", code);
    });
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  write(data: string): void {
    if (this.state !== "exited") this.proc.terminal?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (cols < 2 || rows < 2 || (cols === this.term.cols && rows === this.term.rows)) return;
    this.term.resize(cols, rows);
    this.proc.terminal?.resize(cols, rows);
  }

  /** Submit a prompt: paste the text (bracketed when the app asked for it), then Enter. */
  async prompt(text: string): Promise<void> {
    this.prompted = true;
    this.write(this.term.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text);
    await Bun.sleep(SUBMIT_DELAY_MS);
    this.write("\r");
  }

  /**
   * Plain text of the last `lines` non-blank-terminated rows (default: the
   * viewport), with soft-wrapped rows joined. Counting starts at the last
   * non-blank row so a short shell output isn't hidden by empty rows below it.
   */
  screen(lines = this.term.rows): string {
    const buf = this.term.buffer.active;
    let end = buf.baseY + this.term.rows;
    while (end > buf.baseY && !buf.getLine(end - 1)?.translateToString(true).trim()) end--;
    const out: string[] = [];
    for (let y = Math.max(0, end - lines); y < end; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && out.length) out[out.length - 1] += text;
      else out.push(text);
    }
    return out.join("\n");
  }

  /** Escape sequences that redraw the current screen on a fresh terminal. */
  snapshot(): string {
    return this.serializer.serialize({ scrollback: 0 });
  }

  kill(): void {
    if (this.state === "exited") return;
    this.proc.kill("SIGHUP");
    const hard = setTimeout(() => this.proc.kill("SIGKILL"), 3000);
    void this.proc.exited.then(() => clearTimeout(hard));
  }

  private detect(): void {
    const now = Date.now();
    // Stay "starting" until the program has drawn something.
    if (this.lastOutputAt === 0) return;
    const screen = this.screen();
    const recognized = this.kind.detect?.(screen) ?? null;
    const next = recognized ?? genericDetect(screen, this.lastOutputAt, now);
    if (next === this.state) {
      this.pending = null;
      return;
    }
    if (this.pending?.state !== next) {
      this.pending = { state: next, since: now };
      return;
    }
    if (now - this.pending.since < STABLE_MS) return;
    const prev = this.state;
    this.state = next;
    this.pending = null;
    if (next === "working") this.workingRecognized = recognized !== null;
    this.emit("state", next, prev);
    if (next === "idle" && prev === "working") {
      if (this.workingRecognized || this.prompted) this.emit("done");
      this.prompted = false;
    }
  }
}
