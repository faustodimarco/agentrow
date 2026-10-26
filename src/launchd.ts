import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { daemonArgv, ensureHome, HOME, LOG_PATH } from "./paths.ts";

export const LABEL = "dev.agentrow.daemon";
export const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function xml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function launchctl(...args: string[]): { ok: boolean; out: string } {
  const res = Bun.spawnSync(["launchctl", ...args], { stderr: "pipe", stdout: "pipe" });
  return { ok: res.exitCode === 0, out: `${res.stdout.toString()}${res.stderr.toString()}`.trim() };
}

const domain = `gui/${process.getuid?.() ?? 501}`;

export function isInstalled(): boolean {
  return existsSync(PLIST_PATH);
}

/**
 * Install a LaunchAgent: the daemon starts at login, restarts if it crashes,
 * and stays down after an explicit `agentrow stop` (clean exit).
 * PATH is captured now because launchd starts jobs with a minimal one.
 */
export function install(): void {
  ensureHome();
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: homedir(),
    SHELL: process.env.SHELL ?? "/bin/zsh",
    AGENTROW_HOME: HOME,
    LANG: process.env.LANG ?? "en_US.UTF-8",
  };
  const args = daemonArgv().map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${k}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  writeFileSync(
    PLIST_PATH,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(homedir())}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(LOG_PATH)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(LOG_PATH)}</string>
</dict>
</plist>
`,
  );
  launchctl("bootout", `${domain}/${LABEL}`);
  const res = launchctl("bootstrap", domain, PLIST_PATH);
  if (!res.ok) throw new Error(`launchctl bootstrap failed: ${res.out}`);
}

export function uninstall(): void {
  launchctl("bootout", `${domain}/${LABEL}`);
  if (existsSync(PLIST_PATH)) unlinkSync(PLIST_PATH);
}

/** Start (or restart) the installed job. */
export function kickstart(): void {
  const res = launchctl("kickstart", `${domain}/${LABEL}`);
  if (!res.ok) throw new Error(`launchctl kickstart failed: ${res.out}`);
}
