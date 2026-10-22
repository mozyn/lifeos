/**
 * HTTP plumbing: error mapping (a vault conflict is a visible 409, never a silent overwrite; a
 * write the system refuses is a plain 507, ADR-105) and idempotency keys for writes (the PWA
 * outbox replays with the same key; the second delivery gets the first answer and writes nothing).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { type DB, nowIso } from './db.js';
import { refusalOf, type Roots, unwritableAnswer } from './unwritable.js';
import { WriteConflict } from './vault/fsio.js';
import { Conflict, Forbidden, NotFound } from './vault/ops.js';
import { PathError } from './vault/paths.js';
import { LineNotFound } from './vault/vault.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** `roots`: the notes folder and LifeOS's own folders, where a refused write is named (ADR-105). */
export function installErrors(app: FastifyInstance, roots: Roots | null = null): void {
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof LineNotFound) return reply.code(409).send({ error: 'line_changed', message: err.message, path: err.path });
    if (err instanceof WriteConflict || err instanceof Conflict) return reply.code(409).send({ error: 'conflict', message: (err as Error).message });
    if (err instanceof Forbidden) return reply.code(403).send({ error: 'forbidden', message: err.message });
    if (err instanceof NotFound) return reply.code(404).send({ error: 'not_found', message: err.message });
    if (err instanceof PathError) return reply.code(400).send({ error: 'bad_path', message: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'invalid', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
    const e = err as { statusCode?: number; message?: string; validation?: unknown };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: 'request', message: e.message });
    // EACCES, EPERM, EROFS in the notes folder or LifeOS's own: who owns it, whom LifeOS runs as, the fix
    const refused = roots ? refusalOf(err, roots) : null;
    if (refused) {
      const a = unwritableAnswer(refused);
      reply.log.warn(`${a.error}: ${e.message}`);
      return reply.code(a.status).send({ error: a.error, message: a.message });
    }
    reply.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong on the server.' });
  });
}

/** Idempotency for mutating requests with an `Idempotency-Key` header (kept 7 days). */
export function installIdempotency(app: FastifyInstance, db: DB): void {
  const get = db.prepare('SELECT status, body FROM idempotency WHERE key = ?');
  const put = db.prepare('INSERT OR IGNORE INTO idempotency (key, status, body, created_at) VALUES (?, ?, ?, ?)');
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const key = idemKey(req);
    if (!key) return;
    const row = get.get(key) as { status: number; body: string } | undefined;
    if (row) {
      reply.header('Idempotent-Replay', 'true');
      return reply.code(row.status).type('application/json').send(row.body);
    }
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method === 'GET' || req.method === 'HEAD') return payload;
    const key = idemKey(req);
    if (!key || reply.getHeader('Idempotent-Replay')) return payload;
    // a conflict is final too: replaying the same write must not succeed later on changed content.
    // Nothing else that failed is kept: a retry after a 401, a 429 or a refused body must run again
    const kept = (reply.statusCode >= 200 && reply.statusCode < 300) || reply.statusCode === 409;
    if (kept && typeof payload === 'string') put.run(key, reply.statusCode, payload, nowIso());
    return payload;
  });
  const prune = setInterval(() => db.prepare("DELETE FROM idempotency WHERE created_at < datetime('now', '-7 days')").run(), 3600_000);
  prune.unref();
  app.addHook('onClose', async () => clearInterval(prune));
}

/** Answers never kept for a replay: a new integration token is shown once and stored only as a hash (ADR-85). */
const NOT_REPLAYED = new Set(['/api/hermes/token']);

function idemKey(req: FastifyRequest): string | null {
  if (NOT_REPLAYED.has(req.routeOptions.url ?? '') || NOT_REPLAYED.has(req.url.split('?')[0])) return null;
  const k = req.headers['idempotency-key'];
  const v = Array.isArray(k) ? k[0] : k;
  if (!v || v.length > 100 || !/^[\w.:-]+$/.test(v)) return null;
  return `${req.method} ${req.routeOptions.url ?? req.url} ${v}`;
}
