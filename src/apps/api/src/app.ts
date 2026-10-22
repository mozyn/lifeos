import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { Auth } from './auth.js';
import { Planner } from './planner.js';
import { authRoutes } from './routes/auth.js';
import { eventRoutes } from './routes/events.js';
import { settingsRoutes } from './routes/settings.js';
import { todayRoutes } from './routes/today.js';
import { weekRoutes } from './routes/week.js';
import { calendarRoutes } from './routes/calendar.js';
import { Scheduler } from './scheduler.js';
import { Library, Nudges } from './nudges.js';
import { goalRoutes } from './routes/goals.js';
import { listRoutes } from './routes/lists.js';
import { searchRoutes } from './routes/search.js';
import { groupRoutes } from './routes/groups.js';
import { AiService } from './ai/service.js';
import { aiHosts } from './ai/endpoint.js';
import { aiRoutes } from './routes/ai.js';
import { habitsView } from './views.js';
import { HERMES_WAITING } from './drafts.js';
import { JOB_TIMEOUT_MS } from './ai/queue.js';
import { type Sender, TelegramSender } from './telegram.js';
import { type Config, exposedBind } from './config.js';
import { makeCtx, type Ctx } from './context.js';
import { getSetting, openDb, setSetting } from './db.js';
import { Egress, installSocketGuard, type EgressOptions } from './egress.js';
import { installErrors, installIdempotency } from './http.js';
import { systemRoutes } from './routes/system.js';
import { applySeed, setupNeeded, setupRoutes } from './setup.js';
import { BrowserPush } from './browser-push.js';
import { pushRoutes } from './routes/push.js';
import { taskRoutes } from './routes/tasks.js';
import { VaultOps } from './vault/ops.js';
import { EditOps } from './vault/edit-ops.js';
import { editRoutes } from './routes/edits.js';
import { Vault } from './vault/vault.js';
import { isEmptyFolder, seedStarter, vaultAccess, vaultAccessMessage } from './vault/starter.js';
import { RELEASE, VERSION } from './version.js';
import { IntegrationTokens } from './integration/tokens.js';
import { AgentOutbox, agentHolds, nudgeKey } from './integration/outbox.js';
import { AgentJobs } from './integration/jobs.js';
import { loadTemplate, renderPrompt } from './integration/prompt.js';
import { integrationRoutes } from './routes/integration.js';
import { hermesRoutes } from './routes/hermes.js';
import { dockerIdentity, fromName } from './integration/whoami.js';

export { RELEASE, VERSION } from './version.js';

export interface BuildOptions {
  /** an in-memory database (tests) */
  memoryDb?: boolean;
  /** start the file watcher (default: on outside tests) */
  watch?: boolean;
  now?: () => Date;
  egress?: EgressOptions;
  /** a fake Telegram (tests) */
  sender?: Sender;
  /** where the log goes (tests read it: no secret may appear in it) */
  logStream?: { write(msg: string): void };
  /** a fake push endpoint (tests) */
  pushFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** run the minute scheduler (default: on outside tests) */
  schedule?: boolean;
  /** the AI queue and jobs (default: on); tests point the provider at a mock */
  ai?: boolean;
}

export type App = FastifyInstance & { ctx: Ctx; planner: Planner; auth: Auth; scheduler: Scheduler; nudges: Nudges; ai: AiService; push: BrowserPush; tokens: IntegrationTokens; agent: AgentJobs; outbox: AgentOutbox };

export async function buildApp(config: Config, opts: BuildOptions = {}): Promise<App> {
  const logger = opts.logStream ? { level: 'info', stream: opts.logStream } : config.mode === 'test' ? false : { level: 'info' };
  const app = Fastify({ logger, trustProxy: true, bodyLimit: 512 * 1024, disableRequestLogging: true }) as unknown as App;
  installErrors(app);
  // a request target is a path: an absolute-form one (GET http://host/api/… HTTP/1.1, possible for
  // a caller on the compose network) is refused before any hook decides on its path
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/') || req.url.startsWith('//')) return reply.code(400).send({ error: 'bad_target', message: 'The request target must be a path.' });
  });
  await app.register(cookie);
  app.get('/api/health', async () => {
    const vault = existsSync(config.vault);
    // writable: whether LifeOS may change the notes (LIFEOS_UID/GID, product brief 10 §1);
    // release: the image's LIFEOS_BUILD (a tag, a commit or dev, ADR-103)
    return { ok: true, version: VERSION, release: RELEASE, mode: config.mode, vault, writable: vault && vaultAccess(config.vault).writable };
  });
  if (!existsSync(config.vault)) {
    app.log.error(`vault not found at ${config.vault}`);
    return app;
  }

  const db = openDb(opts.memoryDb ? ':memory:' : join(config.data, 'lifeos.db'));
  const vault = new Vault(config.vault, db);
  const egress = new Egress(db, opts.egress);
  if (config.mode !== 'test') installSocketGuard(egress);
  // demo and e2e stacks only (never live): a request may carry `x-lifeos-clock` (ISO instant) so
  // screenshots and tests can stand in the morning or the evening at any real hour (ADR-21)
  const clock = new AsyncLocalStorage<number>();
  const fakeable = config.mode === 'demo' || config.mode === 'e2e';
  const now = opts.now ?? (() => new Date(Date.now() + (clock.getStore() ?? 0)));
  if (fakeable) {
    app.addHook('onRequest', (req, _reply, done) => {
      const h = req.headers['x-lifeos-clock'];
      const t = h ? Date.parse(String(h)) : NaN;
      if (Number.isFinite(t)) clock.run(t - Date.now(), done);
      else done();
    });
  }
  const ops = new VaultOps(vault, db);
  const ctx = makeCtx({ config, db, vault, ops, edits: new EditOps(vault, db, ops, now), egress, now });
  app.decorate('ctx', ctx);
  applySeed(ctx, (m) => app.log.info(m));
  await firstStart(app, ctx);
  // the model endpoint's host is allowed while AI is on, and only that host (ADR-75)
  egress.follow('ai', () => aiHosts(ctx));

  const scan = await vault.fullScan('startup');
  app.log.info(`index: ${scan.files} notes, ${scan.tasks} tasks in ${scan.ms} ms`);
  if (opts.watch ?? config.mode !== 'test') vault.watch();

  const auth = new Auth(config.authFile, db);
  const planner = new Planner(ctx);
  app.decorate('auth', auth);
  app.decorate('planner', planner);
  const sender = opts.sender ?? new TelegramSender(egress, config.bot);
  // browser notifications (ADR-80): the push purpose may reach exactly the subscribed devices' hosts
  const push = new BrowserPush(db, opts.pushFetch ?? ((url, init) => egress.fetch(url, { ...init, purpose: 'push' })), config.vapid, now);
  egress.follow('push', () => push.hosts());
  // the key pair exists from the first start, without .env.push (product brief 10 §1)
  if (push.ensureKeys() === 'generated') app.log.info("browser notifications: made this install's key pair (kept in /data; a .env.push, when present, is used instead)");
  app.decorate('push', push);
  const scheduler = new Scheduler(ctx, planner, sender, push);
  app.decorate('scheduler', scheduler);
  const nudges = new Nudges(ctx, planner.drafts, new Library(ctx));
  app.decorate('nudges', nudges);
  const ai = new AiService(ctx, planner, nudges);
  app.decorate('ai', ai);
  if (opts.ai === false) {
    planner.generator = null;
    nudges.encourager = null;
  }
  // Hermes, the owner's agent, through the integration API (product brief 9, ADR-85..87)
  const tokens = new IntegrationTokens(db);
  const outbox = new AgentOutbox(ctx, tokens);
  const agent = new AgentJobs(ctx, planner, nudges, ai, outbox);
  planner.agentDraft = (kind, date) => agent.request(kind, date);
  app.decorate('tokens', tokens);
  app.decorate('outbox', outbox);
  app.decorate('agent', agent);
  scheduler.hooks.push(() => void agent.sweep());
  /** A nudge for Hermes to send on Telegram, when a token exists (it waits up to 120 s for Hermes's own words). */
  const offerNudge = (d: { id: string; payload: string; fallback_reason: string | null }, habitPath: string, date: string, now: Date) => {
    const p = JSON.parse(d.payload) as Parameters<Nudges['text']>[0];
    const waiting = d.fallback_reason === HERMES_WAITING;
    outbox.offerNudge({ draftId: d.id, habitPath, date, title: p.habit.private ? 'A private habit' : p.habit.title, text: nudges.text(p) }, waiting ? new Date(now.getTime() + JOB_TIMEOUT_MS) : now);
  };
  // 20:00: a nudge for each habit due today and not logged yet, once per habit per day (§9 job 3)
  scheduler.hooks.push(async (now) => {
    const { date, time } = { date: ctx.today(), time: ctx.hm() };
    if (time < '20:00') return;
    const s = ctx.settings();
    const quiet = s.quietStart < s.quietEnd ? time >= s.quietStart && time < s.quietEnd : time >= s.quietStart || time < s.quietEnd;
    for (const h of habitsView(ctx, date).filter((x) => x.scheduledToday && !x.today)) {
      if (ctx.db.prepare('SELECT 1 FROM nudges WHERE habit = ? AND date = ?').get(h.path, date)) continue;
      const d = await nudges.create(h, date, 'evening');
      if (!quiet) offerNudge(d, h.path, date, now);
      if (quiet || !scheduler.enabled()) continue;
      // Hermes has it (fetched in the last 10 minutes, or sent: then the nudges table has it already)
      if (agentHolds(ctx.db, nudgeKey(h.path, date), now)) continue;
      try {
        await sender.send(nudges.text(JSON.parse(d.payload)));
        ctx.db.prepare('INSERT OR IGNORE INTO nudges (habit, date, kind, at) VALUES (?, ?, ?, ?)').run(h.path, date, 'evening', now.toISOString());
      } catch {
        /* retried at the next tick */
      }
    }
  });
  authRoutes(app, auth, () => setupNeeded(ctx), exposedBind(config.bind));
  installIdempotency(app, db);
  taskRoutes(app, ctx);
  systemRoutes(app, ctx);
  todayRoutes(app, ctx, planner, () => void agent.sweep());
  settingsRoutes(app, ctx);
  setupRoutes(app, ctx);
  weekRoutes(app, ctx);
  calendarRoutes(app, ctx);
  goalRoutes(app, ctx, nudges, sender, () => scheduler.enabled(), (d, habitPath) => offerNudge(d, habitPath, ctx.today(), ctx.now()));
  listRoutes(app, ctx);
  searchRoutes(app, ctx);
  groupRoutes(app, ctx);
  editRoutes(app, ctx);
  eventRoutes(app, ctx);
  pushRoutes(app, push);

  app.get('/api/reminders', async () => scheduler.overview(ctx.now()));
  app.post('/api/reminders/test', async (_req, reply) => {
    if (!scheduler.enabled()) return reply.code(409).send({ error: 'telegram_off', message: 'Telegram delivery is off or not configured.' });
    try {
      const r = await scheduler.sendTest();
      return { ok: true, messageId: r.messageId };
    } catch (e) {
      return reply.code(502).send({ error: 'telegram', message: (e as Error).message });
    }
  });
  if (opts.schedule ?? config.mode !== 'test') scheduler.start();
  if (opts.ai !== false) ai.start();

  aiRoutes(app, ctx, ai, planner);
  integrationRoutes(app, ctx, { tokens, agent, outbox });
  // the container and network a Hermes in Docker reaches: Docker's own names for them (ADR-93)
  let identity = fromName(config.name);
  if (config.mode !== 'test')
    void dockerIdentity().then((id) => {
      if (!id) return;
      identity = id;
      app.log.info(`hermes: this API is ${id.container} on the Docker network ${id.network}`);
    });
  hermesRoutes(app, ctx, { tokens, ai, scheduler, template: loadTemplate, prompt: (token, template) => renderPrompt(ctx, token, template, identity) });

  app.addHook('onClose', async () => {
    scheduler.stop();
    ai.stop();
    agent.stop();
    await vault.close();
    db.close();
  });
  return app;
}

/**
 * The notes folder at start (product brief 10 §1): one log line naming the fix when LifeOS cannot
 * write it as its owner, and the starter notes in an empty folder when this database has never
 * indexed a note (ADR-91). A failure here is logged; the app starts either way.
 */
async function firstStart(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { config, db } = ctx;
  try {
    const empty = isEmptyFolder(config.vault);
    const access = vaultAccess(config.vault);
    const problem = vaultAccessMessage(access, empty);
    if (problem && !access.writable) app.log.error(problem);
    else if (problem) app.log.warn(problem);
    const seen = getSetting<unknown>(db, 'starter', null) !== null || !!db.prepare('SELECT 1 FROM index_runs WHERE files > 0 LIMIT 1').get();
    if (!config.starter || !empty || !access.writable || seen || !existsSync(config.starterVault)) return;
    const today = ctx.today();
    const notes = await seedStarter(config.starterVault, config.vault, today, `${config.publicUrl}/guide.html`);
    setSetting(db, 'starter', { at: ctx.now().toISOString(), date: today, notes });
    app.log.info(`starter notes: the notes folder was empty, so ${notes} starter notes were put in it, dated ${today}`);
  } catch (e) {
    app.log.error(`notes folder: could not check it or fill it with the starter notes: ${(e as Error).message}`);
  }
}
