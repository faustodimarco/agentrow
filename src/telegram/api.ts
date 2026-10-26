export interface TgUser {
  id: number;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
  is_forum?: boolean;
}

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TgUser;
  chat: TgChat;
  text?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/** Minimal Bot API client; waits out 429s using `retry_after`. */
export class TelegramApi {
  private readonly base: string;

  constructor(token: string) {
    this.base = `${process.env.AGENTROW_TELEGRAM_API ?? "https://api.telegram.org"}/bot${token}`;
  }

  async call<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      const data = (await res.json()) as TgResponse<T>;
      if (data.ok) return data.result as T;
      const retryAfter = data.parameters?.retry_after;
      if (data.error_code === 429 && retryAfter !== undefined && attempt < 5) {
        await Bun.sleep(retryAfter * 1000);
        continue;
      }
      throw new TelegramError(`${method}: ${data.description ?? res.statusText}`, data.error_code ?? res.status);
    }
  }
}
