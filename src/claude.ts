import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code stores transcripts at ~/.claude/projects/<cwd with non-alnum → '-'>/<session>.jsonl,
 * keyed by the resolved cwd (macOS /tmp → /private/tmp).
 */
export function claudeTranscriptPath(cwd: string, sessionId: string): string {
  const real = existsSync(cwd) ? realpathSync(cwd) : cwd;
  return join(homedir(), ".claude", "projects", real.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
}

interface ContentBlock {
  type: string;
  text?: string;
}

interface TranscriptEntry {
  type?: string;
  message?: { role?: string; content?: string | ContentBlock[] };
}

/**
 * Text the assistant produced since the last human prompt, or `null` when the
 * transcript is missing or has no reply yet. Tool results are recorded as
 * `user` entries too, so only string content / text blocks count as prompts.
 */
export function lastClaudeReply(cwd: string, sessionId: string): string | null {
  const path = claudeTranscriptPath(cwd, sessionId);
  if (!existsSync(path)) return null;
  let texts: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue; // a partially written trailing line
    }
    const content = entry.message?.content;
    if (entry.type === "user") {
      const isPrompt = typeof content === "string" || (Array.isArray(content) && content.some((b) => b.type === "text"));
      if (isPrompt) texts = [];
    } else if (entry.type === "assistant" && Array.isArray(content)) {
      for (const block of content) if (block.type === "text" && block.text) texts.push(block.text);
    }
  }
  return texts.length ? texts.join("\n\n") : null;
}
