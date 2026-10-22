import { promises as fs } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import { RELEASE, VERSION } from '../version.js';

export function systemRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/system/index', async () => {
    const kinds = ctx.db.prepare('SELECT kind, count(*) n FROM files GROUP BY kind ORDER BY kind').all();
    const tasks = ctx.db.prepare("SELECT count(*) total, sum(status = 'open') open FROM tasks").get();
    const runs = ctx.db.prepare('SELECT at, ms, files, tasks, reason FROM index_runs ORDER BY id DESC LIMIT 5').all();
    return { lastScan: ctx.vault.lastScan, kinds, tasks, runs };
  });

  /**
   * Settings → About (round-4 brief §4): the version and the release (ADR-103: About tells the
   * person when the page they hold is another release), and the day LifeOS was set up: when the
   * first-run screen wrote the passphrase file (its modification time; the file is never rewritten,
   * and is only replaced by deleting it to set a new passphrase). Metadata only: the file is not read.
   */
  app.get('/api/system/about', async () => {
    const setupAt = await fs
      .stat(ctx.config.authFile)
      .then((st) => st.mtime.toISOString())
      .catch(() => null);
    // the spec link shows only where the notes have it (the owner's vault, not a friend's, ADR-78)
    const spec = !!ctx.db.prepare('SELECT 1 FROM files WHERE path = ?').get('Projects/lifeos/lifeos-master-plan.md');
    return { version: VERSION, release: RELEASE, mode: ctx.config.mode, setupAt, spec };
  });

  app.post('/api/index/rebuild', async () => {
    const r = await ctx.vault.fullScan('rebuild');
    return { ok: true, ...r };
  });
}
