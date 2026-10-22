/**
 * Habit nudges and encouragement (spec §9 job 3, ADR-6, ADR-17). On a slip, and at 20:00 for a
 * habit not logged, three candidate library entries are chosen by the deterministic selector
 * (favorites first, then the nudge themes, no repeats within 30 days). The model (M6) picks one and
 * writes encouragement in its own words, which must pass the guard; otherwise — and whenever the
 * model is off or down — the fixed fallback sentence is used. The entry itself is always shown
 * verbatim from the library, never from the model.
 */
import { FALLBACK_ENCOURAGEMENT, FAVORITES_PATH, type HadithEntry, isRelevant, parseFavorites, redactNames, selectCandidates, splitLines } from '@lifeos/shared';
import type { Ctx } from './context.js';
import { type DraftRow, type Drafts, HERMES_WAITING } from './drafts.js';
import { type HabitDto, privateHabitNames } from './views.js';
import { aiActive, hermesDrafts, offReason } from './ai/endpoint.js';

export interface LibraryEntry {
  id: string;
  path: string;
  heading: string;
  book: string;
  reference: string;
  grade: string | null;
  source: string | null;
  themes: string[];
  arabic: string;
  english: string;
}

export interface NudgePayload {
  habit: { path: string; title: string; kind: string; slug: string; private?: boolean };
  reason: 'slip' | 'evening';
  candidates: string[];
  pick: number;
  entry: LibraryEntry | null;
  encouragement: string;
  encouragementBy: 'model' | 'fallback';
  guard: { ok: boolean; rule?: string; detail?: string } | null;
}

/** Ask the model (M6) for { pick, encouragement }; returns null when it is off, down or invalid. */
export type Encourager = (habit: HabitDto, candidates: LibraryEntry[], signal?: AbortSignal) => Promise<{ pick: number; encouragement: string; guard: NudgePayload['guard']; model: string | null; promptTokens: number | null; prompt: string | null } | null>;

export class Library {
  constructor(private readonly ctx: Ctx) {}

  entries(): LibraryEntry[] {
    return (this.ctx.db.prepare('SELECT id, path, heading, book, reference, grade, source, themes, arabic, english FROM hadith').all() as (Omit<LibraryEntry, 'themes'> & { themes: string })[]).map((r) => ({ ...r, themes: JSON.parse(r.themes) as string[] }));
  }

  get(id: string): LibraryEntry | null {
    const r = this.ctx.db.prepare('SELECT id, path, heading, book, reference, grade, source, themes, arabic, english FROM hadith WHERE id = ?').get(id) as (Omit<LibraryEntry, 'themes'> & { themes: string }) | undefined;
    return r ? { ...r, themes: JSON.parse(r.themes) as string[] } : null;
  }

  async favorites(): Promise<string[]> {
    const t = await this.ctx.vault.read(FAVORITES_PATH).catch(() => null);
    return t ? parseFavorites(splitLines(t)) : [];
  }

  shownMap(): Map<string, string> {
    const m = new Map<string, string>();
    for (const r of this.ctx.db.prepare('SELECT entry_id, max(date) d FROM hadith_shown GROUP BY entry_id').all() as { entry_id: string; d: string }[]) m.set(r.entry_id, r.d);
    return m;
  }

  markShown(id: string, date: string, context: string): void {
    this.ctx.db.prepare('INSERT OR IGNORE INTO hadith_shown (entry_id, date, context) VALUES (?, ?, ?)').run(id, date, context);
  }

  async candidates(seed: string, date: string, themes?: string[]): Promise<LibraryEntry[]> {
    const all = this.entries();
    const picked = selectCandidates(all as unknown as HadithEntry[], { shown: this.shownMap(), today: date, seed, favorites: await this.favorites(), themes, count: 3 });
    return picked as unknown as LibraryEntry[];
  }

  /** The daily pick (§5.10): favorites preferred, one per day, stable through the day. */
  async daily(date: string): Promise<LibraryEntry | null> {
    const row = this.ctx.db.prepare("SELECT entry_id FROM hadith_shown WHERE date = ? AND context = 'daily'").get(date) as { entry_id: string } | undefined;
    if (row) {
      const e = this.get(row.entry_id);
      if (e) return e;
    }
    const [first] = await this.candidates(`${date}:daily`, date, ['patience', 'repentance', 'self-control', 'gratitude', 'perseverance', 'hope', 'prayer']);
    if (!first) return null;
    this.markShown(first.id, date, 'daily');
    return first;
  }
}

export class Nudges {
  encourager: Encourager | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly drafts: Drafts,
    readonly library: Library,
  ) {}

  latest(habitPath: string, date: string): DraftRow | null {
    return this.drafts.latest('habit_nudge', date, ['pending', 'approved'], habitPath);
  }

  /** A nudge for a habit today (once per habit per day; a slip after an evening nudge replaces it). */
  async create(habit: HabitDto, date: string, reason: 'slip' | 'evening', signal?: AbortSignal): Promise<DraftRow> {
    const existing = this.latest(habit.path, date);
    if (existing && (reason === 'evening' || (JSON.parse(existing.payload) as NudgePayload).reason === 'slip')) return existing;
    const themes = habit.kind === 'quit' ? ['self-control', 'repentance', 'patience', 'perseverance', 'gratitude'] : ['perseverance', 'patience', 'gratitude', 'repentance', 'self-control'];
    const candidates = await this.library.candidates(`${date}:${habit.slug}`, date, themes);
    let pick = 1;
    let encouragement = FALLBACK_ENCOURAGEMENT;
    let by: NudgePayload['encouragementBy'] = 'fallback';
    let guard: NudgePayload['guard'] = null;
    let meta: { model: string | null; promptTokens: number | null; prompt: string | null } = { model: null, promptTokens: null, prompt: null };
    let fallbackReason: string | null = aiActive(this.ctx) ? 'model unavailable' : offReason(this.ctx);
    // Hermes writes the encouragement (ADR-86): the fixed sentence now, Hermes's words through the
    // same guard when it answers the job
    const viaHermes = hermesDrafts(this.ctx) && candidates.length > 0;
    if (viaHermes) fallbackReason = HERMES_WAITING;
    else if (candidates.length && this.encourager && aiActive(this.ctx)) {
      const r = await this.encourager(habit, candidates, signal).catch(() => null);
      if (r) {
        meta = { model: r.model, promptTokens: r.promptTokens, prompt: r.prompt };
        guard = r.guard;
        pick = Math.min(Math.max(1, r.pick), candidates.length);
        if (r.guard?.ok) {
          encouragement = r.encouragement;
          by = 'model';
          fallbackReason = null;
        } else fallbackReason = `guard rejected the encouragement (${r.guard?.rule ?? 'invalid'})`;
      }
    }
    const entry = candidates[pick - 1] ?? null;
    if (entry) this.library.markShown(entry.id, date, `nudge:${habit.slug}`);
    const payload: NudgePayload = {
      habit: { path: habit.path, title: habit.title, kind: habit.kind, slug: habit.slug, private: habit.private },
      reason,
      candidates: candidates.map((c) => c.id),
      pick,
      entry,
      encouragement,
      encouragementBy: by,
      guard,
    };
    const d = this.drafts.insert({
      kind: 'habit_nudge',
      date,
      ref: habit.path,
      payload,
      sources: [habit.path, ...candidates.map((c) => `${c.path} (${c.heading})`)],
      fallback: by === 'fallback',
      fallbackReason,
      model: meta.model,
      promptTokens: meta.promptTokens,
      prompt: meta.prompt,
      via: viaHermes ? 'hermes' : null,
    });
    this.drafts.supersede('habit_nudge', date, habit.path, d.id);
    return d;
  }

  /**
   * Telegram text for a nudge (verbatim English entry, its reference, the encouragement labelled).
   * A private habit (round-2 brief §6) is never named: the message says "a private habit", the name
   * the reply was relabelled with for the app (ADR-63) is "this habit" again, and an encouragement
   * that still shares a word with the habit's name is replaced by the fixed sentence.
   */
  text(p: NudgePayload): string {
    const priv = !!p.habit.private;
    const name = priv ? 'A private habit' : p.habit.title;
    // the encouragement names no private habit at all: not this one ("this habit"), and not another
    // one the reply's ids were relabelled to (a model, or Hermes, that saw "private habit P2")
    const own = priv ? redactNames(p.encouragement, [p.habit.title, p.habit.slug], 'this habit') : p.encouragement;
    const said = redactNames(own, privateHabitNames(this.ctx), 'a private habit');
    const lines = [`🌱 ${name}: ${p.reason === 'slip' ? 'a slip was logged today' : 'not logged yet today'}`];
    if (p.entry) {
      lines.push('', p.entry.english.length > 1200 ? `${p.entry.english.slice(0, 1200)}…` : p.entry.english, `${p.entry.heading}${p.entry.grade ? ` (grading: ${p.entry.grade})` : ''}`);
    }
    const words = priv && isRelevant(p.habit.title, said, '');
    lines.push('', `From LifeOS: ${words ? FALLBACK_ENCOURAGEMENT : said}`);
    // the Habits link while the app's address is known (ADR-104)
    const url = this.ctx.publicUrl();
    if (url) lines.push(`${url}/habits`);
    return lines.join('\n');
  }
}
