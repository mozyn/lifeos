/**
 * Settings → Advanced → Address (round 8c, ADR-104): the app's own address, the one reminder
 * links, the Hermes prompt and the starter notes' guide link use.
 *   GET  /api/address        { url, source: env | owner | learned | null, at }
 *   PUT  /api/address        { url }: the owner's own; "" forgets it and learning starts again.
 *                            Refused while LIFEOS_PUBLIC_URL is set (it always wins).
 *   POST /api/address/learn  { address }: the signed-in page's own, when /api/auth/state asks for it
 *                            (an install from before this round, or only a loopback one known)
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cleanAddress, resolveAddress, setOwnerAddress } from '../address.js';
import type { Ctx } from '../context.js';
import { HttpError } from '../http.js';
import type { AddressLearner } from './auth.js';

export function addressRoutes(app: FastifyInstance, ctx: Ctx, learner: AddressLearner, changed: () => void): void {
  app.get('/api/address', async () => resolveAddress(ctx.config, ctx.db));

  app.put('/api/address', async (req) => {
    const b = z.object({ url: z.string().max(300) }).parse(req.body ?? {});
    if (ctx.config.publicUrl) throw new HttpError(409, 'address_env', 'LIFEOS_PUBLIC_URL sets the address on the server; change it there.');
    const raw = b.url.trim();
    const url = raw ? cleanAddress(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`) : null;
    if (raw && !url) throw new HttpError(400, 'bad_address', 'That is not a web address (example: https://nas.example.ts.net/lifeos).');
    setOwnerAddress(ctx.db, url, ctx.now());
    changed();
    return resolveAddress(ctx.config, ctx.db);
  });

  app.post('/api/address/learn', async (req) => {
    const b = z.object({ address: z.string().max(300) }).parse(req.body ?? {});
    learner.learn(b.address, req.headers.origin);
    return resolveAddress(ctx.config, ctx.db);
  });
}
