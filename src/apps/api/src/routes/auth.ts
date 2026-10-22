import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth, AuthError, COOKIE, SESSION_DAYS } from '../auth.js';

/** Open without a session. */
const PUBLIC = new Set(['/api/health', '/api/auth/state', '/api/auth/setup', '/api/auth/login']);

function setSession(req: FastifyRequest, reply: FastifyReply, token: string): void {
  const https = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
  reply.setCookie(COOKIE, token, { path: '/lifeos', httpOnly: true, sameSite: 'strict', secure: https, maxAge: SESSION_DAYS * 86400 });
}

/** The app's address as the page that sets the passphrase or signs in reports it (ADR-104). */
export interface AddressLearner {
  /** `offered`: the page's own origin and base path; `origin`: the request's Origin header */
  learn(offered: unknown, origin: string | undefined): void;
  /** the signed-in page should report its address (none known yet, or only a loopback one) */
  wanted(): boolean;
}

const AuthBody = z.object({ passphrase: z.string(), address: z.string().max(300).optional() });

/**
 * `exposed`: the port is published beyond this machine (LIFEOS_BIND=0.0.0.0); a page opened over
 * plain http then shows the https banner once (product brief 10 §2).
 */
export function authRoutes(app: FastifyInstance, auth: Auth, setupNeeded: () => boolean = () => false, exposed = false, address: AddressLearner | null = null): void {
  // every route needs a session (deny by default) but the public ones; writes also need the app's
  // own header and a same-site origin
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    // the integration API has its own credential, the token, and takes nothing else (ADR-85)
    if (PUBLIC.has(path) || path.startsWith('/api/integration/')) return;
    if (!auth.check(req.cookies?.[COOKIE])) return reply.code(401).send({ error: 'auth', message: 'Sign in to continue.' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers['x-lifeos'] !== '1') return reply.code(403).send({ error: 'csrf', message: 'Missing the LifeOS request header.' });
      const origin = req.headers.origin;
      if (origin) {
        let ok = false;
        try {
          const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(':')[0];
          ok = new URL(origin).hostname === host;
        } catch {
          ok = false;
        }
        if (!ok) return reply.code(403).send({ error: 'csrf', message: 'Cross-site request refused.' });
      }
    }
  });

  // signed in: whether the first-run step (where you are, ADR-76) still has to be answered
  app.get('/api/auth/state', async (req) => {
    const signedIn = auth.check(req.cookies?.[COOKIE]);
    return { setup: auth.needsSetup(), signedIn, exposed, ...(signedIn ? { firstRun: setupNeeded(), address: !!address?.wanted() } : {}) };
  });

  app.post('/api/auth/setup', async (req, reply) => {
    const { passphrase, address: offered } = AuthBody.parse(req.body);
    try {
      await auth.setup(passphrase);
    } catch (e) {
      if (e instanceof AuthError) return reply.code(e.status).send({ error: e.code, message: e.message });
      throw e;
    }
    const s = auth.createSession();
    setSession(req, reply, s.token);
    address?.learn(offered, req.headers.origin);
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { passphrase, address: offered } = AuthBody.parse(req.body);
    try {
      const s = await auth.login(passphrase, req.ip);
      setSession(req, reply, s.token);
      address?.learn(offered, req.headers.origin);
      return { ok: true };
    } catch (e) {
      if (e instanceof AuthError) {
        if (e.retryAfter) reply.header('Retry-After', String(e.retryAfter));
        return reply.code(e.status).send({ error: e.code, message: e.message });
      }
      throw e;
    }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    auth.revoke(req.cookies?.[COOKIE]);
    reply.clearCookie(COOKIE, { path: '/lifeos' });
    return { ok: true };
  });
}
