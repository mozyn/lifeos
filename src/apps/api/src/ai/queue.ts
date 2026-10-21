/**
 * The AI job queue (spec §9, §12: "a 60-line in-process queue replaces pg-boss"): one job at a
 * time (a local model server's slots may be shared with the owner's other tools), persisted in
 * SQLite so a restart resumes what was queued, a 120 s timeout per job, cancellation, and a log of durations.
 */
import { randomUUID } from 'node:crypto';
import type { DB } from '../db.js';

export type JobKind = 'morning_plan' | 'evening_review' | 'habit_nudge';

export interface JobRow {
  id: string;
  kind: JobKind;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  payload: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  draft_id: string | null;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

export interface JobOutcome {
  draftId?: string | null;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  /** the job finished but used the deterministic fallback; the reason is logged */
  fallback?: string | null;
  result?: unknown;
}

export type Handler = (payload: Record<string, unknown>, signal: AbortSignal, job: JobRow) => Promise<JobOutcome>;

export const JOB_TIMEOUT_MS = 120_000;

export class AiQueue {
  private handlers = new Map<JobKind, Handler>();
  private current: { id: string; ctrl: AbortController } | null = null;
  private waiters = new Map<string, ((row: JobRow) => void)[]>();
  private kicking = false;
  private stopped = false;

  constructor(private readonly db: DB) {}

  on(kind: JobKind, h: Handler): void {
    this.handlers.set(kind, h);
  }

  get(id: string): JobRow | null {
    return (this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined) ?? null;
  }

  enqueue(kind: JobKind, payload: Record<string, unknown>): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO jobs (id, kind, status, payload, created_at) VALUES (?, ?, 'queued', ?, ?)").run(id, kind, JSON.stringify(payload), new Date().toISOString());
    void this.kick();
    return id;
  }

  /** Resolves when the job ends (or after `timeoutMs` with its current row). */
  wait(id: string, timeoutMs = JOB_TIMEOUT_MS + 5000): Promise<JobRow> {
    const row = this.get(id);
    if (row && ['done', 'failed', 'cancelled'].includes(row.status)) return Promise.resolve(row);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(this.get(id)!), timeoutMs);
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), (r) => (clearTimeout(t), resolve(r))]);
    });
  }

  cancel(id: string): boolean {
    if (this.current?.id === id) {
      this.current.ctrl.abort(new Error('cancelled'));
      return true;
    }
    const r = this.db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'").run(new Date().toISOString(), id);
    if (r.changes) this.finish(id);
    return r.changes > 0;
  }

  /** On start: what was running when the process stopped runs again. */
  start(): void {
    this.stopped = false;
    this.db.prepare("UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'").run();
    void this.kick();
  }

  stop(): void {
    this.stopped = true;
    this.current?.ctrl.abort(new Error('shutting down'));
  }

  busy(): boolean {
    return !!this.current;
  }

  recent(n = 20): JobRow[] {
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(n) as JobRow[];
  }

  private finish(id: string): void {
    const row = this.get(id)!;
    for (const w of this.waiters.get(id) ?? []) w(row);
    this.waiters.delete(id);
  }

  private async kick(): Promise<void> {
    if (this.kicking || this.stopped) return;
    this.kicking = true;
    try {
      for (;;) {
        const job = this.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as JobRow | undefined;
        if (!job || this.stopped) break;
        const h = this.handlers.get(job.kind);
        const started = Date.now();
        this.db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
        const ctrl = new AbortController();
        this.current = { id: job.id, ctrl };
        const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(JOB_TIMEOUT_MS)]);
        try {
          if (!h) throw new Error(`no handler for ${job.kind}`);
          const out = await h(JSON.parse(job.payload) as Record<string, unknown>, signal, job);
          this.db
            .prepare("UPDATE jobs SET status = 'done', finished_at = ?, duration_ms = ?, draft_id = ?, model = ?, prompt_tokens = ?, completion_tokens = ?, error = ? WHERE id = ?")
            .run(new Date().toISOString(), Date.now() - started, out.draftId ?? null, out.model ?? null, out.promptTokens ?? null, out.completionTokens ?? null, out.fallback ? `fallback: ${out.fallback}` : null, job.id);
        } catch (e) {
          const cancelled = ctrl.signal.aborted;
          this.db.prepare('UPDATE jobs SET status = ?, finished_at = ?, duration_ms = ?, error = ? WHERE id = ?').run(cancelled ? 'cancelled' : 'failed', new Date().toISOString(), Date.now() - started, String((e as Error).message ?? e).slice(0, 300), job.id);
        } finally {
          this.current = null;
          this.finish(job.id);
        }
      }
    } finally {
      this.kicking = false;
    }
  }
}
