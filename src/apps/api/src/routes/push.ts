import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BrowserPush } from '../browser-push.js';
import { HttpError } from '../http.js';

/** A device's id in the list: not its endpoint (that is a credential for pushing to it). */
const deviceId = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex').slice(0, 12);

/** Settings → Reminders → Browser notifications (product brief 8 §6, ADR-80). */
export function pushRoutes(app: FastifyInstance, push: BrowserPush): void {
  app.get('/api/push', async () => ({
    publicKey: push.keys().publicKey,
    devices: push.devices().map((d) => ({ id: deviceId(d.endpoint), host: d.host.replace(/:443$/, ''), label: d.label, createdAt: d.created_at, lastOkAt: d.last_ok_at, lastError: d.last_error })),
  }));

  app.post('/api/push/subscribe', async (req) => {
    const b = z.object({ subscription: z.unknown(), label: z.string().max(60).default('') }).parse(req.body);
    try {
      const d = push.subscribe(b.subscription, b.label);
      return { ok: true, id: deviceId(d.endpoint) };
    } catch {
      throw new HttpError(400, 'bad_subscription', 'This browser sent a subscription LifeOS cannot use.');
    }
  });

  app.post('/api/push/unsubscribe', async (req) => {
    const b = z.object({ endpoint: z.string().max(2048).optional(), id: z.string().max(20).optional() }).parse(req.body);
    const endpoint = b.endpoint ?? push.devices().find((d) => deviceId(d.endpoint) === b.id)?.endpoint;
    return { ok: endpoint ? push.unsubscribe(endpoint) : false };
  });

  app.post('/api/push/test', async (req) => {
    const b = z.object({ endpoint: z.string().max(2048).optional() }).parse(req.body ?? {});
    if (!push.devices().some((d) => !b.endpoint || d.endpoint === b.endpoint)) throw new HttpError(409, 'no_device', 'Turn on browser notifications on this device first.');
    const r = await push.send({ title: '🧪 LifeOS test notification', body: 'Reminders will arrive like this. You can ignore it.', url: 'today', tag: 'lifeos-test' }, { endpoint: b.endpoint, ttlSec: 600 });
    return { ok: r.sent > 0, ...r };
  });
}
