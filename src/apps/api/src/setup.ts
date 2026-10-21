/**
 * The first run after the passphrase (product brief 8 §1, ADR-76): where the owner is (a place
 * from the app's offline city list, or coordinates and a time zone), the prayer-time method, the
 * Hijri adjustment, whether the one online comparison with Aladhan is allowed (off unless chosen),
 * and the Obsidian vault's name for links (optional). Stored in the SQLite settings, never in the
 * vault; nothing here is sent anywhere.
 *
 * `LIFEOS_SETUP_SEED` (JSON, the same fields) answers the step without the screen, once, while it
 * has not been answered: the install that predates the step seeds its owner's values this way, so
 * nothing changes for it; the demo and bench stacks use it for a fixed synthetic place.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PRAYER_METHODS } from '@lifeos/shared';
import { type AppSettings, type Ctx, validZone } from './context.js';
import { getSetting, setSetting } from './db.js';
import { HttpError } from './http.js';

const Zone = z.string().min(1).max(64).refine(validZone, 'not a time zone the server knows');

/** One answer to the step; every field is optional on its own, the place is required to finish. */
export const SetupBody = z.object({
  place: z.string().trim().max(120).nullable().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  tz: Zone.optional(),
  method: z.enum(PRAYER_METHODS).optional(),
  hijriOffset: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
  prayerCheck: z.boolean().optional(),
  vaultName: z.string().trim().max(100).optional(),
  ownerName: z.string().trim().max(40).optional(),
});
export type SetupAnswer = z.infer<typeof SetupBody>;

/** The answer merged into the stored settings (only the keys it names change). */
export function mergeSetup(cur: AppSettings, stored: Partial<AppSettings>, b: SetupAnswer): Partial<AppSettings> {
  const next: Partial<AppSettings> = { ...stored };
  if (b.lat !== undefined || b.lon !== undefined || b.tz !== undefined || b.method !== undefined) {
    next.prayer = { ...cur.prayer, ...(stored.prayer ?? {}), ...(b.lat !== undefined ? { lat: b.lat } : {}), ...(b.lon !== undefined ? { lon: b.lon } : {}), ...(b.tz !== undefined ? { tz: b.tz } : {}), ...(b.method !== undefined ? { method: b.method } : {}) };
  }
  if (b.place !== undefined) next.place = b.place || null;
  if (b.hijriOffset !== undefined) next.hijriOffset = b.hijriOffset;
  if (b.prayerCheck !== undefined) next.prayerCheck = b.prayerCheck;
  if (b.vaultName !== undefined) next.vaultName = b.vaultName;
  if (b.ownerName !== undefined) next.ownerName = b.ownerName;
  return next;
}

/** A place has been chosen: coordinates and a zone are stored (not the placeholder). */
function hasPlace(stored: Partial<AppSettings>): boolean {
  return typeof stored.prayer?.lat === 'number' && typeof stored.prayer?.lon === 'number' && typeof stored.prayer?.tz === 'string';
}

export function setupNeeded(ctx: Ctx): boolean {
  return !ctx.settings().setupAt;
}

/** Save an answer and finish the step. Throws when no place is known after it. */
export function finishSetup(ctx: Ctx, b: SetupAnswer, at = ctx.now()): void {
  const stored = getSetting<Partial<AppSettings>>(ctx.db, 'app', {});
  const next = mergeSetup(ctx.settings(), stored, b);
  if (!hasPlace(next)) throw new HttpError(400, 'no_place', 'Choose a city, or enter coordinates and a time zone.');
  setSetting(ctx.db, 'app', { ...next, setupAt: at.toISOString() });
}

/** At startup: LIFEOS_SETUP_SEED answers the step once, while it is unanswered. */
export function applySeed(ctx: Ctx, log: (msg: string) => void): boolean {
  if (!ctx.config.setupSeed || !setupNeeded(ctx)) return false;
  let parsed: SetupAnswer;
  try {
    parsed = SetupBody.parse(JSON.parse(ctx.config.setupSeed));
  } catch (e) {
    log(`LIFEOS_SETUP_SEED ignored: ${(e as Error).message.slice(0, 200)}`);
    return false;
  }
  try {
    finishSetup(ctx, parsed);
  } catch (e) {
    log(`LIFEOS_SETUP_SEED ignored: ${(e as Error).message}`);
    return false;
  }
  log('first-run settings applied from LIFEOS_SETUP_SEED');
  return true;
}

export function setupRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/setup', async () => {
    const s = ctx.settings();
    return { needed: setupNeeded(ctx), place: s.place, prayer: s.prayer, hijriOffset: s.hijriOffset, prayerCheck: s.prayerCheck, vaultName: s.vaultName, serverZone: ctx.config.tz };
  });

  /** The step's last screen: everything chosen, and the step is done (it is not shown again). */
  app.post('/api/setup', async (req) => {
    if (!setupNeeded(ctx)) throw new HttpError(409, 'already_set', 'LifeOS is already set up: change these in Settings.');
    finishSetup(ctx, SetupBody.parse(req.body ?? {}));
    return { ok: true };
  });
}
