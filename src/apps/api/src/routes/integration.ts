/**
 * The integration API (product brief 9 §1, ADR-85): what Hermes, the owner's agent, may do with the
 * integration token, and nothing more. Every route here takes `Authorization: Bearer <token>` and
 * only that (a passphrase session does not open them, and the token opens nothing else):
 *   GET  /api/integration/context?day=      the day for the AI jobs and chat (private habits as ids)
 *   GET  /api/integration/jobs              the AI jobs wanted now, each with its prompt and schema
 *   POST /api/integration/drafts            a reply to a job: a draft the owner approves in the app
 *   POST /api/integration/tasks             a task in today's daily note (the line is returned)
 *   POST /api/integration/notes             a note in Inbox/
 *   GET  /api/integration/reminders?since=  reminders and nudges to send on Telegram
 *   POST /api/integration/reminders/ack     those were sent
 *   GET  /api/integration/summary?range=    a day or a week as plain text
 * At most 60 calls a minute; a wrong token slows its sender down. Each call, refused or not, is in
 * the inbound log (Settings → Privacy → the connection log) as "Hermes".
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { formatReminder, formatTask, parseReminder } from '@lifeos/shared';
import type { Ctx } from '../context.js';
import { HttpError } from '../http.js';
import { contextFor, summaryText } from '../integration/context.js';
import type { AgentJobs } from '../integration/jobs.js';
import { type AgentOutbox, outboxDto } from '../integration/outbox.js';
import { cleanModel, type IntegrationTokens, type TokenRow } from '../integration/tokens.js';
import { PrivateHabits } from '../ai/private.js';
import { habitsView } from '../views.js';

export const INTEGRATION_PREFIX = '/api/integration/';

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d, 'not a date');
/** characters that would start a task field inside the words (a due date, a reminder, a priority…) */
const FIELD_MARKS = /[📅📆🗓⏳🛫➕✅❌⏰🔺⏫🔼🔽⏬🔁]️?/gu;

const TaskBody = z.object({
  text: z.string().trim().min(1).max(500),
  due: DAY.nullable().optional(),
  reminder: z.string().trim().max(40).nullable().optional(),
  goal: z.string().trim().max(120).nullable().optional(),
  tags: z.array(z.string().trim().regex(/^[^\s#@]+$/, 'one word, without # or @').refine((t) => !new RegExp(FIELD_MARKS.source, 'u').test(t), 'no task-field marks in a tag').max(60)).max(20).optional(),
  priority: z.enum(['highest', 'high', 'medium', 'low', 'lowest']).nullable().optional(),
});

interface Deps {
  tokens: IntegrationTokens;
  agent: AgentJobs;
  outbox: AgentOutbox;
}

export function integrationRoutes(app: FastifyInstance, ctx: Ctx, { tokens, agent, outbox }: Deps): void {
  const seen = new WeakMap<FastifyRequest, { row: TokenRow | null; started: number }>();
  const token = (req: FastifyRequest) => seen.get(req)!.row!;

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith(INTEGRATION_PREFIX)) return;
    seen.set(req, { row: null, started: Date.now() });
    reply.header('Cache-Control', 'no-store');
    // the token first: wrong ones slow their sender down, never the token itself
    const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization ?? ''));
    const row = tokens.check(m?.[1]);
    if (!row) {
      const wait = tokens.refusedFor(req.ip);
      if (wait) return reply.code(429).header('Retry-After', String(wait)).send({ error: 'rate_limited', message: 'Too many calls without a valid token. Wait and try again.' });
      tokens.failed(req.ip);
      return reply.code(401).send({ error: 'token', message: 'Send the integration token from LifeOS (Settings → Hermes) as "Authorization: Bearer <token>". A revoked or replaced token no longer works.' });
    }
    seen.get(req)!.row = row;
    const limited = tokens.limited(row);
    if (limited) return reply.code(429).header('Retry-After', String(limited)).send({ error: 'rate_limited', message: `At most 60 calls a minute. Try again in ${limited} s.` });
    // on the stack's clock, like the status that reads it (a demo or e2e stack may run on another day, ADR-21)
    tokens.touch(row, cleanModel(req.headers['x-hermes-model']), ctx.now());
  });

  // the inbound log: who, what, how much went out; never the body or the query string
  const log = ctx.db.prepare('INSERT INTO inbound_log (at, who, method, path, status, bytes_in, bytes_out, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const prune = ctx.db.prepare('DELETE FROM inbound_log WHERE id <= (SELECT max(id) - 5000 FROM inbound_log)');
  app.addHook('onResponse', async (req, reply) => {
    const s = seen.get(req);
    if (!s) return;
    try {
      log.run(new Date().toISOString(), s.row ? 'Hermes' : 'no valid token', req.method, req.url.split('?')[0].slice(0, 120), reply.statusCode, Number(req.headers['content-length'] ?? 0) || 0, Number(reply.getHeader('content-length') ?? 0) || 0, Date.now() - s.started);
      prune.run();
    } catch {
      /* the log must never break a call */
    }
  });

  app.get('/api/integration/context', async (req) => {
    const q = z.object({ day: DAY.optional() }).parse(req.query);
    return contextFor(ctx, q.day ?? ctx.today());
  });

  app.get('/api/integration/jobs', async () => {
    const r = await agent.list();
    return {
      now: ctx.now().toISOString(),
      day: ctx.today(),
      writes_drafts: r.writes,
      note: r.note,
      jobs: r.jobs,
      reply: 'For each job: send its messages to your model, asking for one JSON object that matches its schema, then POST /api/integration/drafts with {"job": "<id>", "payload": <that object>, "model": "<your model name>"}. The owner approves the draft in LifeOS; never apply anything yourself.',
    };
  });

  app.post('/api/integration/drafts', async (req) => {
    const b = z
      .object({
        job: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:[0-9a-f]{8})?$/, 'the job id from GET /api/integration/jobs').optional(),
        kind: z.enum(['morning_plan', 'evening_review', 'habit_nudge']).optional(),
        payload: z.unknown().refine((v) => v !== undefined && v !== null, 'the draft itself is missing'),
        model: z.string().max(200).optional(),
      })
      .parse(req.body ?? {});
    const row = token(req);
    const model = cleanModel(b.model) ?? cleanModel(req.headers['x-hermes-model']) ?? row.last_model;
    if (b.model && cleanModel(b.model)) tokens.touch(row, cleanModel(b.model), ctx.now());
    const d = await agent.accept({ job: b.job, kind: b.kind, payload: b.payload, model });
    return { ok: true, draft: d, message: 'Saved as a draft. The owner approves, edits or dismisses it in LifeOS.' };
  });

  app.post('/api/integration/tasks', async (req) => {
    const b = TaskBody.parse(req.body ?? {});
    const today = ctx.today();
    const text = b.text.replace(FIELD_MARKS, ' ').replace(/\s+/g, ' ').trim();
    if (!text) throw new HttpError(400, 'empty', 'Write what the task is.');
    let reminder: string | null = null;
    let due = b.due ?? null;
    if (b.reminder) {
      const spec = parseReminder(b.reminder);
      if (!spec) throw new HttpError(400, 'bad_reminder', 'A reminder is "YYYY-MM-DD HH:MM", "HH:MM" (on the due day, else today) or a prayer with minutes, like "maghrib+30".');
      reminder = formatReminder(spec);
      if (spec.kind === 'at' && spec.date && !due) due = spec.date;
      if (!due) due = today;
    }
    const slugs: string[] = [];
    if (b.goal) {
      const goals = (ctx.db.prepare("SELECT path, title FROM files WHERE kind = 'goal'").all() as { path: string; title: string }[]).map((g) => ({ slug: g.path.split('/').pop()!.replace(/\.md$/, ''), title: g.title }));
      const want = b.goal.replace(/^@/, '').toLowerCase();
      const g = goals.find((x) => x.slug.toLowerCase() === want) ?? goals.find((x) => x.title.toLowerCase() === want);
      if (!g) throw new HttpError(400, 'no_goal', new PrivateHabits(habitsView(ctx, today, true)).scrub(`There is no goal "${b.goal}". Goals: ${goals.map((x) => x.slug).slice(0, 20).join(', ') || 'none yet'}.`));
      slugs.push(g.slug);
    }
    const line = formatTask({ text, due, reminder, priority: b.priority ?? null, slugs, tags: b.tags ?? [] });
    const path = await ctx.ops.addTaskToday(today, line);
    const row = ctx.db.prepare('SELECT id FROM tasks WHERE path = ? AND raw = ? ORDER BY line DESC LIMIT 1').get(path, line) as { id: string } | undefined;
    return { ok: true, path, line, ...(row ? { id: row.id, link: `${ctx.config.publicUrl}/t/${row.id}` } : {}) };
  });

  app.post('/api/integration/notes', async (req) => {
    const b = z.object({ title: z.string().trim().max(120).optional(), text: z.string().max(20000).default('') }).parse(req.body ?? {});
    const first = b.text.split('\n')[0].trim();
    const title = (b.title || first).slice(0, 120).trim();
    if (!title) throw new HttpError(400, 'empty', 'Give the note a title or some text.');
    const body = b.title ? b.text : b.text.split('\n').slice(1).join('\n');
    const path = await ctx.ops.createNote(title, body, ctx.today(), ['note', 'from-hermes']);
    return { ok: true, path };
  });

  app.get('/api/integration/reminders', async (req) => {
    const q = z.object({ since: z.string().max(40).optional() }).parse(req.query);
    const now = ctx.now();
    const since = q.since ? new Date(q.since) : new Date(now.getTime() - 15 * 60_000);
    if (Number.isNaN(since.getTime())) throw new HttpError(400, 'bad_since', 'since is an ISO time, for example 2026-10-20T14:00:00Z (use next_since from the last answer).');
    outbox.collect(now);
    tokens.touchReminders(token(req), now);
    const s = ctx.settings();
    return {
      now: now.toISOString(),
      next_since: now.toISOString(),
      quiet_hours: { start: s.quietStart, end: s.quietEnd, timezone: ctx.tz() },
      reminders: outbox.list(since, now).map(outboxDto),
      note: 'Send each text exactly as written (it may hold a verbatim hadith with its reference: never reword, shorten or add to it), then POST /api/integration/reminders/ack with their ids. Ask again with since = next_since.',
    };
  });

  app.post('/api/integration/reminders/ack', async (req) => {
    const b = z.object({ ids: z.array(z.string().regex(/^r_[0-9a-f]{12}$/)).min(1).max(100) }).parse(req.body ?? {});
    return { ok: true, acked: outbox.ack(b.ids, ctx.now()) };
  });

  app.get('/api/integration/summary', async (req) => {
    const q = z.object({ range: z.enum(['day', 'week']).default('day') }).parse(req.query);
    return { range: q.range, text: summaryText(ctx, q.range) };
  });
}
