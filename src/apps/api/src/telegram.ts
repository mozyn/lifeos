/**
 * Reminder delivery (spec §8, ADR-4): Telegram Bot API `sendMessage` to the owner's chat (and its
 * reminder topic, when one is set), through the egress wrapper (purpose `telegram`). The bot token
 * only ever sits in the request path; it is never logged, returned or stored, and errors are redacted.
 */
import type { Config } from './config.js';
import type { Egress } from './egress.js';

export interface Sender {
  readonly configured: boolean;
  send(text: string): Promise<{ messageId: number | null }>;
}

export class TelegramError extends Error {}

export class TelegramSender implements Sender {
  constructor(
    private readonly egress: Egress,
    private readonly bot: Config['bot'],
  ) {}

  get configured(): boolean {
    return !!this.bot.token && !!this.bot.chatId;
  }

  async send(text: string): Promise<{ messageId: number | null }> {
    if (!this.bot.token) throw new TelegramError('Telegram is not configured on this server.');
    const body: Record<string, unknown> = { chat_id: this.bot.chatId, text, link_preview_options: { is_disabled: true } };
    if (this.bot.threadId) body.message_thread_id = Number(this.bot.threadId);
    let res: Response;
    try {
      res = await this.egress.fetch(`https://api.telegram.org/bot${this.bot.token}/sendMessage`, {
        purpose: 'telegram',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new TelegramError(`Telegram unreachable (${redact((e as Error).message)})`);
    }
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: { message_id?: number } };
    if (!res.ok || !j.ok) throw new TelegramError(`Telegram refused the message (${res.status}${j.description ? `: ${redact(j.description)}` : ''})`);
    return { messageId: j.result?.message_id ?? null };
  }
}

function redact(s: string): string {
  return s.replace(/bot\d+:[\w-]+/g, 'bot[redacted]').slice(0, 200);
}
