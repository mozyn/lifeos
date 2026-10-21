/**
 * Private habits never reach the model (round-3 brief §1, ADR-63). The three prompt builders call
 * a private habit "private habit P1" (P2, …) with its kind and streak only, and every string of a
 * prompt passes `scrub` on its way out, so the habit's title or slug cannot ride along in a task
 * title, a `@slug`, a daily note or a log line. On the way back `relabel` turns the ids (and, with
 * a single private habit, "your private habit") into the real name again, so the owner's draft reads
 * normally; the web app curtains that name while Privacy mode is on.
 */
import { namesRegex } from '@lifeos/shared';
import type { HabitDto } from '../views.js';
import type { ChatMessage } from './provider.js';

export class PrivateHabits {
  private readonly list: { n: number; habit: HabitDto; re: RegExp }[];

  /** `habits`: every habit (archived ones too, a note may still name them); only private ones count. */
  constructor(habits: HabitDto[]) {
    const priv = habits.filter((h) => h.private).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.list = priv.map((habit, i) => ({ n: i + 1, habit, re: namesRegex([habit.title, habit.slug])! })).filter((x) => x.re);
  }

  get any(): boolean {
    return this.list.length > 0;
  }

  /** The real names this prompt hid (the UI curtains them in Privacy mode). */
  get names(): string[] {
    return this.list.map((x) => x.habit.title);
  }

  private find(h: HabitDto) {
    return this.list.find((x) => x.habit.path === h.path);
  }

  isPrivate(h: HabitDto): boolean {
    return !!this.find(h);
  }

  /** What a prompt calls a habit. */
  name(h: HabitDto): string {
    const x = this.find(h);
    return x ? `private habit P${x.n}` : h.title;
  }

  /** A habit in a list line: a private one carries only its kind and streak. */
  describe(h: HabitDto): string {
    return this.isPrivate(h) ? `${this.name(h)} (${h.kind}, streak ${h.streak} days)` : `${h.title} (${h.kind})`;
  }

  /** A habit as a draft's source: a private one is not named there either. */
  source(h: HabitDto): string {
    return this.isPrivate(h) ? 'a private habit' : h.path;
  }

  /** The one line a prompt adds when it mentions a private habit. */
  get rule(): string {
    return this.any ? 'Private habits appear only as an id (private habit P1); refer to them only that way, never guess what they are.' : '';
  }

  /** Every mention of a private habit's name or slug becomes its id. Longer names first. */
  scrub(text: string): string {
    let out = text;
    for (const x of [...this.list].sort((a, b) => b.habit.title.length - a.habit.title.length)) out = out.replace(x.re, `private habit P${x.n}`);
    return out;
  }

  messages(ms: ChatMessage[]): ChatMessage[] {
    return this.any ? ms.map((m) => ({ ...m, content: this.scrub(m.content) })) : ms;
  }

  /** The model's text with the ids turned back into names (an id that was not in the prompt stays as it is). */
  relabel(text: string): string {
    if (!this.any) return text;
    const byN = new Map(this.list.map((x) => [x.n, x.habit.title]));
    let out = text.replace(/\b(?:(?:a|the|your|his)\s+)?private[\s-]+habit\s+P(\d+)\b|\bP(\d+)\b/gi, (m, a: string | undefined, b: string | undefined) => byN.get(Number(a ?? b)) ?? m);
    if (this.list.length === 1) out = out.replace(/\b(?:(?:a|the|your|his)\s+)?private[\s-]+habit\b/gi, this.list[0].habit.title);
    return out;
  }
}
