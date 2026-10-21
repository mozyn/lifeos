/**
 * Live updates: one server-sent event stream tells the app when vault notes changed (the ring
 * pipeline, Obsidian, LifeOS itself), so Today refreshes without polling.
 */
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';

export function eventRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`event: hello\ndata: {}\n\n`);
    const off = ctx.vault.onChange((paths, reason) => {
      reply.raw.write(`event: vault\ndata: ${JSON.stringify({ paths, reason })}\n\n`);
    });
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      off();
    });
    reply.hijack();
  });
}
