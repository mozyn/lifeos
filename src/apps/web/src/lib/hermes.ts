/**
 * Settings → Hermes's words for its status (product brief 9 §3, ADR-88), pure so they are tested.
 */
import { instantText } from '@lifeos/shared';

/** GET /api/hermes */
export interface ConnectionStatus {
  state: 'none' | 'waiting' | 'connected';
  token: { createdAt: string; lastUsedAt: string | null; lastModel: string | null; lastRemindersAt: string | null } | null;
  draftsBy: string;
  sendsReminders: boolean;
  ownBot: boolean;
}

/** "just now", "4 min ago", "3 h ago", else the day and time. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return instantText(iso);
}

/** Not connected / Waiting for Hermes to call / Connected · last call … · its model */
export function statusText(c: ConnectionStatus, now = Date.now()): string {
  if (c.state === 'none' || !c.token) return 'Not connected';
  if (c.state === 'waiting' || !c.token.lastUsedAt) return 'Waiting for Hermes to call';
  return `Connected · last call ${ago(c.token.lastUsedAt, now)}${c.token.lastModel ? ` · ${c.token.lastModel}` : ''}`;
}

/** Settings → Reminders → Telegram: who sends reminders there. */
export function telegramText(c: ConnectionStatus | null, ownBot: boolean): string {
  if (!c) return '…';
  if (c.sendsReminders) return 'Hermes sends them';
  if (c.state !== 'none') return 'Hermes, once it is set up';
  return ownBot ? 'LifeOS’s own bot (Advanced)' : 'Connect Hermes, below';
}
