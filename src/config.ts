import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { CONFIG_PATH, ensureHome } from "./paths.ts";

export interface TelegramConfig {
  token: string;
  /** Forum supergroup that hosts one topic per agent. Set by `/pair`. */
  chatId?: number;
  /** Chat the agents' stored topic ids belong to; survives re-setup so re-pairing the same group keeps topics. */
  topicsChatId?: number;
  /** Telegram user ids allowed to control agents. */
  allowedUserIds: number[];
  /** One-time code for `/pair <code>`; cleared once paired. */
  pairCode?: string;
}

export interface Config {
  telegram?: TelegramConfig;
  /** Default PTY size for new agents. */
  cols: number;
  rows: number;
}

const DEFAULTS: Config = { cols: 120, rows: 40 };

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
  return { ...DEFAULTS, ...raw };
}

export function saveConfig(cfg: Config): void {
  ensureHome();
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);
}
