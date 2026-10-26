import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { claudeTranscriptPath } from "./claude.ts";

export type AgentState = "starting" | "working" | "blocked" | "idle" | "exited";

export interface LaunchInfo {
  /** Executable plus arguments; run through the user's login shell. */
  argv: string[];
  /** Kind-specific data to persist (e.g. Claude session id). */
  sessionId?: string;
}

export interface KindDef {
  /** Human label. */
  label: string;
  /**
   * Build the launch command. `resume` is true when the daemon restores an
   * agent after a restart or the user asked for `restart`.
   */
  launch(opts: { args: string[]; sessionId?: string; cwd: string; resume: boolean }): LaunchInfo;
  /**
   * Classify the bottom of the screen. Returning `null` falls back to the
   * generic heuristics (output activity + y/n prompt patterns).
   */
  detect?(screen: string): Exclude<AgentState, "starting" | "exited"> | null;
}

const GENERIC_BLOCKED = /\(y\/n\)|\[y\/n\]|\[Y\/n\]|\[y\/N\]|Do you want to proceed\?|Press enter to continue/i;

export interface DialogOption {
  label: string;
  /** Rows below (+) or above (−) the highlighted option. */
  delta: number;
}

/**
 * Options of the selection menu at the bottom of the screen ("❯ 1. Yes",
 * "› Yes, proceed", "❯ No, exit"), located relative to the highlighted row so
 * they can be picked with arrow keys whether or not they are numbered.
 */
export function dialogOptions(screen: string): DialogOption[] {
  const lines = screen.split("\n").slice(-25);
  const cursor = lines.findLastIndex((l) => /^\s*[❯›]\s+\S/.test(l));
  if (cursor < 0) return [];
  const labelCol = lines[cursor]!.search(/[^\s❯›]/);
  const isOption = (l: string | undefined) => !!l?.trim() && l.search(/[^\s❯›]/) === labelCol;
  let start = cursor;
  while (isOption(lines[start - 1])) start--;
  let end = cursor;
  while (isOption(lines[end + 1])) end++;
  const options: DialogOption[] = [];
  for (let i = start; i <= end; i++) options.push({ label: lines[i]!.slice(labelCol).trim(), delta: i - cursor });
  return options;
}

const DIALOG_HINT = /Esc to cancel|Enter to confirm|Do you want to|Would you like to|Allow command|Do you trust/i;

/** A menu with at least two choices plus dialog wording: the agent is waiting on the user. */
function dialogVisible(screen: string): boolean {
  return DIALOG_HINT.test(screen) && dialogOptions(screen).length >= 2;
}

const claude: KindDef = {
  label: "Claude Code",
  launch({ args, sessionId, cwd, resume }) {
    // A pinned session id lets restarts resume the exact conversation and
    // lets us read the transcript for clean Telegram replies.
    const id = sessionId ?? randomUUID();
    const canResume = resume && sessionId !== undefined && existsSync(claudeTranscriptPath(cwd, id));
    const sessionArgs = canResume ? ["--resume", id] : ["--session-id", id];
    return { argv: ["claude", ...sessionArgs, ...args], sessionId: id };
  },
  detect(screen) {
    if (dialogVisible(screen)) return "blocked";
    if (/esc to interrupt/i.test(screen)) return "working";
    return "idle";
  },
};

const codex: KindDef = {
  label: "Codex",
  launch({ args, resume }) {
    return { argv: resume ? ["codex", "resume", "--last", ...args] : ["codex", ...args] };
  },
  detect(screen) {
    if (dialogVisible(screen)) return "blocked";
    if (/esc to interrupt/i.test(screen)) return "working";
    return "idle";
  },
};

function simple(label: string, bin: string): KindDef {
  return {
    label,
    launch: ({ args }) => ({ argv: [bin, ...args] }),
    detect(screen) {
      if (dialogVisible(screen)) return "blocked";
      if (/esc to interrupt/i.test(screen)) return "working";
      return null;
    },
  };
}

export const KINDS: Record<string, KindDef> = {
  claude,
  codex,
  gemini: simple("Gemini CLI", "gemini"),
  opencode: simple("opencode", "opencode"),
  cursor: simple("Cursor Agent", "cursor-agent"),
  amp: simple("Amp", "amp"),
  omp: simple("omp", "omp"),
  shell: {
    label: "Shell",
    launch: ({ args }) => ({ argv: args.length ? args : [process.env.SHELL ?? "/bin/zsh", "-l"] }),
  },
};

/**
 * Activity fallback: output in the last `ACTIVITY_MS` counts as working.
 * Only used when the kind has no opinion.
 */
export const ACTIVITY_MS = 1500;

export function genericDetect(screen: string, lastOutputAt: number, now: number): Exclude<AgentState, "starting" | "exited"> {
  if (GENERIC_BLOCKED.test(screen.split("\n").slice(-4).join("\n"))) return "blocked";
  return now - lastOutputAt < ACTIVITY_MS ? "working" : "idle";
}
