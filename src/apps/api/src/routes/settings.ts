import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { METHOD_LABELS, METHOD_SHORT, normalizeDomain } from '@lifeos/shared';
import type { AppSettings, Ctx } from '../context.js';
import { getSetting, setSetting } from '../db.js';
import { HttpError } from '../http.js';
import { verifyPrayerTimes } from '../prayer-verify.js';
import { mergeSetup, SetupBody } from '../setup.js';

const HM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export function settingsRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/settings', async () => ({ settings: ctx.settings(), methods: METHOD_LABELS, methodNames: METHOD_SHORT, server: { telegram: ctx.config.telegram && !!ctx.config.bot.token && !!ctx.config.bot.chatId, ai: ctx.config.ai, mode: ctx.config.mode, zone: ctx.config.tz } }));

  app.put('/api/settings', async (req) => {
    const b = z
      .object({
        // the place and the method (ADR-76): the same fields as the first-run step
        ...SetupBody.shape,
        prayer: SetupBody.pick({ lat: true, lon: true, tz: true, method: true }).optional(),
        telegram: z.boolean().optional(),
        quietStart: HM.optional(),
        quietEnd: HM.optional(),
        search: z.boolean().optional(),
        searchDomains: z.array(z.string().max(200)).max(40).optional(),
        ai: z.boolean().optional(),
      })
      .parse(req.body);
    const cur = ctx.settings();
    const stored = getSetting<Partial<AppSettings>>(ctx.db, 'app', {});
    const { prayer, telegram, quietStart, quietEnd, search, searchDomains, ai, ...answer } = b;
    const next: Partial<AppSettings> = mergeSetup(cur, stored, { ...answer, ...(prayer ?? {}) });
    for (const [k, v] of Object.entries({ telegram, quietStart, quietEnd, search, ai })) if (v !== undefined) (next as Record<string, unknown>)[k] = v;
    if (searchDomains) {
      const domains = searchDomains.map((d) => normalizeDomain(d));
      if (domains.some((d) => !d)) throw new HttpError(400, 'bad_domain', 'One of those is not a web domain (example: al-islam.org).');
      next.searchDomains = [...new Set(domains as string[])];
    }
    setSetting(ctx.db, 'app', next);
    return { settings: ctx.settings() };
  });

  /** Spec §10: the one user-triggered online check, through the egress wrapper, logged. */
  app.post('/api/prayer/verify', async (req) => {
    const b = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.body ?? {});
    // opt-in (ADR-76): rounded coordinates leave the box only when the owner allowed this check
    if (!ctx.settings().prayerCheck) throw new HttpError(403, 'check_off', 'The online check is off. Turn on "Allow the online check" first.');
    return verifyPrayerTimes(ctx.egress, b.date ?? ctx.today(), ctx.settings().prayer);
  });

  app.get('/api/privacy/outbound', async () => ({
    rows: ctx.db.prepare('SELECT at, host, purpose, method, bytes_out, bytes_in, status, ok, ms, refused FROM outbound_log ORDER BY id DESC LIMIT 200').all(),
  }));

  /**
   * Settings → Privacy → the connection log (product brief 9 §1, ADR-85): every call this server
   * made (out) and every call made to the integration API (in, as "Hermes"), newest first.
   */
  app.get('/api/privacy/log', async () => {
    const out = (ctx.db.prepare('SELECT at, host, purpose, method, bytes_out, bytes_in, status, refused FROM outbound_log ORDER BY id DESC LIMIT 200').all() as { at: string; host: string; purpose: string; method: string; bytes_out: number; bytes_in: number; status: number | null; refused: number }[]).map((r) => ({
      dir: 'out' as const,
      at: r.at,
      who: r.host,
      what: r.purpose,
      method: r.method,
      status: r.refused ? 'refused' : r.status,
      sent: r.bytes_out,
      received: r.bytes_in,
    }));
    // in: what the caller sent and what LifeOS answered with (what left the notes)
    const inbound = (ctx.db.prepare('SELECT at, who, method, path, status, bytes_in, bytes_out FROM inbound_log ORDER BY id DESC LIMIT 200').all() as { at: string; who: string; method: string; path: string; status: number; bytes_in: number; bytes_out: number }[]).map((r) => ({
      dir: 'in' as const,
      at: r.at,
      who: r.who,
      what: r.path.replace(/^\/api\//, ''),
      method: r.method,
      status: r.status,
      sent: r.bytes_out,
      received: r.bytes_in,
    }));
    return { rows: [...out, ...inbound].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 200) };
  });
}
