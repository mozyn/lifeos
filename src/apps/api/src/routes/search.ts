/**
 * Web search, "find and file" (spec §11, round-2 brief §8): the search itself (search.ts), Drop
 * (a URL hidden for that query for 30 days) and its undo, and the engines' health for Settings →
 * Privacy. Filing a result uses the ordinary list writes (links, wishlist, shopping, notes).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SEARCH_CATEGORIES, type SearchCategory } from '@lifeos/shared';
import type { Ctx } from '../context.js';
import { Search, SHOPPING_REFUSED, SHOPPING_SITES } from '../search.js';

const Cat = z.enum(SEARCH_CATEGORIES as [SearchCategory, ...SearchCategory[]]);

export function searchRoutes(app: FastifyInstance, ctx: Ctx): Search {
  const search = new Search(ctx);

  app.get('/api/search', async (req) => {
    const q = z.object({ q: z.string().min(1).max(200), cat: Cat.default('web') }).parse(req.query);
    return search.search(q.q, q.cat);
  });

  app.post('/api/search/drop', async (req) => {
    const b = z.object({ q: z.string().min(1).max(200), url: z.string().url().max(2000), undo: z.boolean().optional() }).parse(req.body);
    if (b.undo) search.undrop(b.q, b.url);
    else search.drop(b.q, b.url);
    return { ok: true };
  });

  // shopping (round-3 brief §6): the shops it is limited to, and SearXNG's shopping engines that refuse this host
  app.get('/api/search/engines', async () => ({ engines: search.health(), domains: ctx.settings().searchDomains, enabled: ctx.settings().search, shopping: { sites: SHOPPING_SITES, refused: SHOPPING_REFUSED } }));

  // the E2E and demo stacks only (never live): put a known answer in the cache, so the sheet's
  // flows are tested without depending on what the engines say that day
  if (ctx.config.mode === 'e2e' || ctx.config.mode === 'demo') {
    app.post('/api/test/search-seed', async (req) => {
      const b = z.object({ q: z.string().min(1).max(200), cat: Cat.default('web'), results: z.array(z.object({ title: z.string(), url: z.string().url(), content: z.string().default(''), engine: z.string() })).max(20) }).parse(req.body);
      search.seed(b.q, b.cat, b.results.map((r) => ({ ...r, engines: [r.engine] })));
      return { ok: true };
    });
  }

  return search;
}
