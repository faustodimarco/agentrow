import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_SHELL, daemonArgv, ensureHome, HOME, LOG_PATH } from "./paths.ts";

/**
 * Supervised background service: the daemon starts at login, restarts if it
 * crashes, and stays down after an explicit `agentrow stop` (clean exit).
 * macOS uses a launchd LaunchAgent, Linux (incl. WSL) a systemd user unit.
 * PATH is captured at install time because both start jobs with a minimal one.
 */
interface ServiceManager {
  name: string;
  file: string;
  write(argv: string[], env: Record<string, string>): void;
  load(): void;
  unload(): void;
  start(): void;
}

function run(cmd: string[]): { ok: boolean; out: string } {
  const res = Bun.spawnSync(cmd, { stderr: "pipe", stdout: "pipe" });
  return { ok: res.exitCode === 0, out: `${res.stdout.toString()}${res.stderr.toString()}`.trim() };
}

function must(cmd: string[]): void {
  const res = run(cmd);
  if (!res.ok) throw new Error(`${cmd.join(" ")} failed: ${res.out}`);
}

function xml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const LABEL = "dev.agentrow.daemon";
const launchdDomain = `gui/${process.getuid?.() ?? 501}`;

const launchd: ServiceManager = {
  name: "launchd",
  file: join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`),
  write(argv, env) {
    const args = argv.map((a) => `    <string>${xml(a)}</string>`).join("\n");
    const envXml = Object.entries(env)
      .map(([k, v]) => `    <key>${k}</key>\n    <string>${xml(v)}</string>`)
      .join("\n");
    writeFileSync(
      this.file,
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
  },
  load() {
    run(["launchctl", "bootout", `${launchdDomain}/${LABEL}`]);
    must(["launchctl", "bootstrap", launchdDomain, this.file]);
  },
  unload() {
    run(["launchctl", "bootout", `${launchdDomain}/${LABEL}`]);
  },
  start() {
    must(["launchctl", "kickstart", `${launchdDomain}/${LABEL}`]);
  },
};

/** systemd unit values: double-quoted, with `\`, `"` and `%` escaped. */
function unitQuote(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

const systemd: ServiceManager = {
  name: "systemd",
  file: join(homedir(), ".config", "systemd", "user", "agentrow.service"),
  write(argv, env) {
    const envLines = Object.entries(env)
      .map(([k, v]) => `Environment=${unitQuote(`${k}=${v}`)}`)
      .join("\n");
    writeFileSync(
      this.file,
      `[Unit]
Description=agentrow daemon

[Service]
ExecStart=${argv.map(unitQuote).join(" ")}
${envLines}
WorkingDirectory=${homedir()}
Restart=on-failure
RestartSec=3
StandardOutput=append:${LOG_PATH}
StandardError=append:${LOG_PATH}

[Install]
WantedBy=default.target
`,
    );
  },
  load() {
    must(["systemctl", "--user", "daemon-reload"]);
    must(["systemctl", "--user", "enable", "--now", "agentrow.service"]);
  },
  unload() {
    run(["systemctl", "--user", "disable", "--now", "agentrow.service"]);
  },
  start() {
    must(["systemctl", "--user", "start", "agentrow.service"]);
  },
};

const manager: ServiceManager | null =
  process.platform === "darwin" ? launchd : process.platform === "linux" ? systemd : null;

export const SERVICE_NAME = manager?.name ?? "none";

export function isInstalled(): boolean {
  return !!manager && existsSync(manager.file);
}

export function install(): string {
  if (!manager) throw new Error(`no service manager support on ${process.platform}; use \`agentrow start\``);
  if (manager === systemd && !run(["systemctl", "--user", "show-environment"]).ok) {
    throw new Error("systemd user session not available (on WSL enable systemd in /etc/wsl.conf); use `agentrow start`");
  }
  ensureHome();
  mkdirSync(dirname(manager.file), { recursive: true });
  manager.write(daemonArgv(), {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: homedir(),
    SHELL: DEFAULT_SHELL,
    AGENTROW_HOME: HOME,
    LANG: process.env.LANG ?? "en_US.UTF-8",
  });
  manager.load();
  return manager.file;
}

export function uninstall(): void {
  if (!manager) return;
  manager.unload();
  if (existsSync(manager.file)) unlinkSync(manager.file);
}

/** Start the installed service. */
export function startService(): void {
  manager?.start();
}
