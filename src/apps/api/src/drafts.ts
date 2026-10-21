/**
 * Drafts (spec §9): everything the AI (or its deterministic fallback) proposes waits here for one
 * tap — Approve, Edit, Dismiss. Approve writes to the vault in §5 formats; nothing else does.
 */
import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';

export type DraftKind = 'morning_plan' | 'evening_review' | 'habit_nudge';
export type DraftStatus = 'generating' | 'pending' | 'approved' | 'dismissed' | 'superseded';

/**
 * Hermes writes the drafts (ADR-86): a plan or review waits as `generating` ("Waiting for Hermes")
 * with `via = 'hermes'`; a nudge shows the fixed sentence at once, marked as waiting. After the usual
 * 120 s the plain draft takes the plan's place, and Hermes's draft still replaces it, while nobody
 * has decided on it, when it comes.
 */
export const HERMES_WAITING = 'waiting for Hermes';
export const HERMES_LATE = "Hermes did not answer in 2 minutes; its draft takes this one's place when it comes";

export interface PlanPayload {
  headline: string;
  focus: { text: string; source_task_id: string | null; new: boolean }[];
  notes: string[];
}

export interface ReviewPayload {
  review: string;
  unsorted: { capture_file: string; suggestion: 'task' | 'note' | 'ignore'; text: string }[];
  tomorrow: { headline: string; focus: string[] };
}

export interface DraftRow {
  id: string;
  kind: DraftKind;
  date: string;
  ref: string | null;
  status: DraftStatus;
  payload: string;
  prompt: string | null;
  model: string | null;
  prompt_tokens: number | null;
  sources: string;
  generated_at: string;
  fallback: number;
  fallback_reason: string | null;
  decided_at: string | null;
  /** 'hermes': written (or awaited) through the integration API */
  via: string | null;
  /** the prompt's short ids last given to Hermes, as JSON */
  ids: string | null;
}

export function draftDto(r: DraftRow) {
  return {
    id: r.id,
    kind: r.kind,
    date: r.date,
    ref: r.ref,
    status: r.status,
    payload: JSON.parse(r.payload) as unknown,
    model: r.model,
    promptTokens: r.prompt_tokens,
    sources: JSON.parse(r.sources) as string[],
    generatedAt: r.generated_at,
    fallback: !!r.fallback,
    fallbackReason: r.fallback_reason,
    via: r.via === 'hermes' ? ('hermes' as const) : null,
  };
}
export type DraftDto = ReturnType<typeof draftDto>;

export class Drafts {
  constructor(
    private readonly db: DB,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  get(id: string): DraftRow | null {
    return (this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined) ?? null;
  }

  /** The newest draft of a kind for a date (and ref), in the given statuses. */
  latest(kind: DraftKind, date: string, statuses: DraftStatus[], ref: string | null = null): DraftRow | null {
    const marks = statuses.map(() => '?').join(',');
    const row = this.db
      .prepare(`SELECT * FROM drafts WHERE kind = ? AND date = ? AND status IN (${marks}) AND (ref IS ? OR ref = ?) ORDER BY generated_at DESC LIMIT 1`)
      .get(kind, date, ...statuses, ref, ref) as DraftRow | undefined;
    return row ?? null;
  }

  insert(d: { kind: DraftKind; date: string; ref?: string | null; payload: unknown; prompt?: string | null; model?: string | null; promptTokens?: number | null; sources: string[]; fallback: boolean; fallbackReason?: string | null; status?: DraftStatus; via?: string | null }): DraftRow {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO drafts (id, kind, date, ref, status, payload, prompt, model, prompt_tokens, sources, generated_at, fallback, fallback_reason, via)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, d.kind, d.date, d.ref ?? null, d.status ?? 'pending', JSON.stringify(d.payload), d.prompt ?? null, d.model ?? null, d.promptTokens ?? null, JSON.stringify(d.sources), this.clock().toISOString(), d.fallback ? 1 : 0, d.fallbackReason ?? null, d.via ?? null);
    return this.get(id)!;
  }

  update(id: string, patch: Partial<Pick<DraftRow, 'status' | 'payload' | 'prompt' | 'model' | 'prompt_tokens' | 'sources' | 'fallback' | 'fallback_reason' | 'generated_at' | 'via' | 'ids'>>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    this.db.prepare(`UPDATE drafts SET ${sets} WHERE id = ?`).run(...keys.map((k) => patch[k] as unknown), id);
  }

  /** `update` only while nobody has decided on the draft (generating or pending); false when someone has. */
  updateOpen(id: string, patch: Parameters<Drafts['update']>[1]): boolean {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return !!this.db.prepare("SELECT 1 FROM drafts WHERE id = ? AND status IN ('generating', 'pending')").get(id);
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    return this.db.prepare(`UPDATE drafts SET ${sets} WHERE id = ? AND status IN ('generating', 'pending')`).run(...keys.map((k) => patch[k] as unknown), id).changes > 0;
  }

  decide(id: string, status: 'approved' | 'dismissed'): void {
    this.db.prepare('UPDATE drafts SET status = ?, decided_at = ? WHERE id = ?').run(status, this.clock().toISOString(), id);
  }

  /** Older pending drafts of the same kind and date give way to a new one. */
  supersede(kind: DraftKind, date: string, ref: string | null, keep: string): void {
    this.db.prepare("UPDATE drafts SET status = 'superseded' WHERE kind = ? AND date = ? AND (ref IS ? OR ref = ?) AND status = 'pending' AND id != ?").run(kind, date, ref, ref, keep);
  }
}
