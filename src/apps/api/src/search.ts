/**
 * Web search through SearXNG (spec §11, round-2 brief §8): "find and file".
 *
 * - One request per new query and category to `lifeos-searxng`, carrying only the typed text and
 *   the engines of that category (minus any the relevance guard has set aside); never anything
 *   personal. Answers are cached for 7 days per query and category.
 * - The relevance guard (shared/search.ts) drops results that share no word stem with the query
 *   and sets an engine aside for 24 hours when more than half of its results miss. Each engine's
 *   health (answers, misses, refusals such as a CAPTCHA, set aside until) is kept for Settings →
 *   Privacy.
 * - "Drop" hides a URL for that query for 30 days (SQLite only, never the vault).
 * - Islamic boosts the preferred domains (Settings → Advanced → Search) to the top; a local re-ranking.
 * - Shopping (round-3 brief §6, ADR-68): SearXNG's shopping engines (eBay; Geizhals, German) refuse
 *   this host, so the web engines are asked for the typed words on the big US shops only (one fixed
 *   `site:` filter, nothing personal); the guard still judges the answer by the typed words.
 */
import { boostPreferred, ENGINE_DROP_MS, hostOf, judgeResults, queryKey, type RawResult, type SearchCategory } from '@lifeos/shared';
import type { Ctx } from './context.js';
import { nowIso } from './db.js';
import { HttpError } from './http.js';

export const CACHE_DAYS = 7;
export const DROP_DAYS = 30;

/**
 * The engines of each category, as configured in docker/searxng/settings.yml (keep the two in
 * step). Each is an engine of that SearXNG category (SEARXNG_CATEGORY). Probed from this host on
 * 2026-10-20 (ADR-45): Bing answers with unrelated pages, DuckDuckGo, Google, Qwant and eBay
 * refuse (CAPTCHA, access denied), Startpage and Mojeek need a proof-of-work CAPTCHA, Vimeo times
 * out.
 */
export const CATEGORY_ENGINES: Record<SearchCategory, string[]> = {
  web: ['brave', 'yahoo', 'yep', 'wikipedia'],
  islamic: ['brave', 'yahoo', 'yep', 'wikipedia'],
  videos: ['youtube', 'dailymotion', 'brave.videos'],
  // eBay and Geizhals, SearXNG's shopping engines, refuse this host: shopping asks the web engines
  // for pages on the shops of SHOPPING_SITES (probed: scripts/search-shopping.mjs, ADR-68)
  shopping: ['brave', 'yahoo', 'yep'],
};

/**
 * The shops a Shopping search is limited to (round-3 brief §6, ADR-68): probed from this host on
 * 2026-10-20, the typed words with this filter came back 100 % relevant and all on a shop from
 * Yahoo and 89 % from Yep, against 10-29 % shop pages for the bare words.
 */
export const SHOPPING_SITES = ['amazon.com', 'walmart.com', 'target.com'];
/** SearXNG's shopping engines in this release, both "access denied" from this host (2026-10-20). */
export const SHOPPING_REFUSED = ['eBay', 'Geizhals'];

/** What a search sends for its words: Shopping adds the shop filter; every other category sends the words alone. */
export function sentQuery(cat: SearchCategory, query: string): string {
  return cat === 'shopping' ? `${query} (${SHOPPING_SITES.map((d) => `site:${d}`).join(' OR ')})` : query;
}

/** SearXNG's own category for each of ours (what the request asks for). */
export const SEARXNG_CATEGORY: Record<SearchCategory, string> = { web: 'general', islamic: 'general', videos: 'videos', shopping: 'general' };

export const ENGINE_LABELS: Record<string, string> = {
  brave: 'Brave',
  yahoo: 'Yahoo',
  yep: 'Yep',
  wikipedia: 'Wikipedia',
  youtube: 'YouTube',
  dailymotion: 'Dailymotion',
  'brave.videos': 'Brave Videos',
  bing: 'Bing',
};

export interface SearchResult {
  title: string;
  url: string;
  domain: string;
  content: string;
  engine: string | null;
  engines: string[];
  preferred?: boolean;
}

export interface EngineRow {
  engine: string;
  dropped_until: string | null;
  dropped_reason: string | null;
  last_at: string | null;
  last_total: number | null;
  last_failed: number | null;
  last_error: string | null;
  searches: number;
  results: number;
  failed: number;
}

const cacheKey = (cat: SearchCategory, q: string) => `v2|${cat}|${queryKey(q)}`;

export class Search {
  constructor(private readonly ctx: Ctx) {
    // answers cached before the relevance guard (one key per query, Bing's garbage included) go
    ctx.db.prepare("DELETE FROM search_cache WHERE query NOT LIKE 'v2|%'").run();
  }

  private now(): number {
    return this.ctx.now().getTime();
  }

  /** Engines set aside now (their drop has not run out). */
  dropped(): Set<string> {
    const rows = this.ctx.db.prepare('SELECT engine FROM search_engines WHERE dropped_until IS NOT NULL AND dropped_until > ?').all(new Date(this.now()).toISOString()) as { engine: string }[];
    return new Set(rows.map((r) => r.engine));
  }

  /** The engines a search in this category asks for: all of its engines but those set aside (all of them if every one is). */
  enginesFor(cat: SearchCategory): string[] {
    const off = this.dropped();
    const on = CATEGORY_ENGINES[cat].filter((e) => !off.has(e));
    return on.length ? on : CATEGORY_ENGINES[cat];
  }

  hiddenUrls(q: string): Set<string> {
    const since = new Date(this.now() - DROP_DAYS * 86400_000).toISOString();
    return new Set((this.ctx.db.prepare('SELECT url FROM search_drops WHERE query = ? AND at > ?').all(queryKey(q), since) as { url: string }[]).map((r) => r.url));
  }

  drop(q: string, url: string): void {
    this.ctx.db.prepare('INSERT INTO search_drops (query, url, at) VALUES (?, ?, ?) ON CONFLICT(query, url) DO UPDATE SET at = excluded.at').run(queryKey(q), url, new Date(this.now()).toISOString());
  }

  undrop(q: string, url: string): void {
    this.ctx.db.prepare('DELETE FROM search_drops WHERE query = ? AND url = ?').run(queryKey(q), url);
  }

  /** What the user sees: drops hidden, the preferred domains first for Islamic. */
  private present(q: string, cat: SearchCategory, results: SearchResult[]): SearchResult[] {
    const hidden = this.hiddenUrls(q);
    const visible = results.filter((r) => !hidden.has(r.url));
    return cat === 'islamic' ? boostPreferred(visible, this.ctx.settings().searchDomains) : visible;
  }

  async search(raw: string, cat: SearchCategory): Promise<{ query: string; category: SearchCategory; cached: boolean; results: SearchResult[]; filtered: number; engines: string[] }> {
    if (!this.ctx.settings().search) throw new HttpError(403, 'search_off', 'Web search is turned off in Settings → Privacy.');
    const query = raw.replace(/\s+/g, ' ').trim();
    const key = cacheKey(cat, query);
    const hit = this.ctx.db.prepare('SELECT results, at FROM search_cache WHERE query = ?').get(key) as { results: string; at: string } | undefined;
    if (hit && this.now() - Date.parse(hit.at) < CACHE_DAYS * 86400_000) {
      const cached = JSON.parse(hit.results) as { results: SearchResult[]; filtered: number; engines: string[] };
      return { query, category: cat, cached: true, results: this.present(query, cat, cached.results), filtered: cached.filtered, engines: cached.engines };
    }
    const engines = this.enginesFor(cat);
    // exactly the typed text (with Shopping's fixed shop filter) and the engines of the category: no
    // location, names or anything else
    const url = `${this.ctx.config.searxngUrl}/search?q=${encodeURIComponent(sentQuery(cat, query))}&format=json&safesearch=1&engines=${encodeURIComponent(engines.join(','))}`;
    let res: Response;
    try {
      res = await this.ctx.egress.fetch(url, { purpose: 'search', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new HttpError(502, 'search_down', 'Search is not reachable right now.');
    }
    if (!res.ok) throw new HttpError(502, 'search_failed', `Search answered ${res.status}.`);
    const body = (await res.json()) as { results?: { title?: string; url?: string; content?: string; engine?: string; engines?: string[] }[]; unresponsive_engines?: [string, string][] };
    const raws: RawResult[] = (body.results ?? [])
      .filter((r) => r.url && /^https?:\/\//.test(r.url))
      .map((r) => ({ title: String(r.title ?? r.url).slice(0, 200), url: String(r.url), content: String(r.content ?? '').slice(0, 300), engine: r.engine ?? null, engines: Array.isArray(r.engines) ? r.engines.map(String) : r.engine ? [r.engine] : [] }));
    const judged = judgeResults(query, raws);
    this.record(judged.verdicts, body.unresponsive_engines ?? [], engines);
    const results: SearchResult[] = judged.kept.slice(0, 20).map((r) => ({ ...r, domain: hostOf(r.url) }));
    const stored = { results, filtered: judged.dropped, engines };
    // an empty answer (engines refusing for a while) is not kept: the next try asks again
    if (results.length) this.ctx.db.prepare('INSERT INTO search_cache (query, results, at) VALUES (?, ?, ?) ON CONFLICT(query) DO UPDATE SET results = excluded.results, at = excluded.at').run(key, JSON.stringify(stored), new Date(this.now()).toISOString());
    this.ctx.db.prepare('DELETE FROM search_cache WHERE at < ?').run(new Date(this.now() - CACHE_DAYS * 86400_000).toISOString());
    this.ctx.db.prepare('DELETE FROM search_drops WHERE at < ?').run(new Date(this.now() - DROP_DAYS * 86400_000).toISOString());
    return { query, category: cat, cached: false, results: this.present(query, cat, results), filtered: judged.dropped, engines };
  }

  /** Tests and demos: a known answer in the cache (E2E and demo stacks only, routes/search.ts). */
  seed(q: string, cat: SearchCategory, results: RawResult[]): void {
    const stored = { results: results.map((r) => ({ ...r, domain: hostOf(r.url) })), filtered: 0, engines: CATEGORY_ENGINES[cat] };
    this.ctx.db.prepare('INSERT INTO search_cache (query, results, at) VALUES (?, ?, ?) ON CONFLICT(query) DO UPDATE SET results = excluded.results, at = excluded.at').run(cacheKey(cat, q), JSON.stringify(stored), new Date(this.now()).toISOString());
  }

  /** Engine health after one answer: counts, refusals, and the 24 h drop for an off-topic engine. */
  private record(verdicts: ReturnType<typeof judgeResults>['verdicts'], unresponsive: [string, string][], asked: string[]): void {
    const at = new Date(this.now()).toISOString();
    const upsert = this.ctx.db.prepare(
      `INSERT INTO search_engines (engine, last_at, last_total, last_failed, last_error, searches, results, failed) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(engine) DO UPDATE SET last_at = excluded.last_at, last_total = excluded.last_total, last_failed = excluded.last_failed, last_error = excluded.last_error,
         searches = searches + 1, results = results + excluded.results, failed = failed + excluded.failed`,
    );
    const errors = new Map(unresponsive.map(([e, why]) => [e, String(why).slice(0, 80)]));
    for (const e of asked) {
      const v = verdicts.find((x) => x.engine === e);
      upsert.run(e, at, v?.total ?? 0, v?.failed ?? 0, errors.get(e) ?? null, v?.total ?? 0, v?.failed ?? 0);
    }
    for (const v of verdicts.filter((x) => x.offTopic)) {
      this.ctx.db
        .prepare('UPDATE search_engines SET dropped_until = ?, dropped_reason = ? WHERE engine = ?')
        .run(new Date(this.now() + ENGINE_DROP_MS).toISOString(), `${v.failed} of ${v.total} results shared no word with the search`, v.engine);
    }
  }

  /** Settings → Advanced → Search: every configured engine and how it has been answering. */
  health(): { engine: string; label: string; categories: SearchCategory[]; status: 'ok' | 'dropped' | 'refusing' | 'unused'; until: string | null; reason: string | null; lastAt: string | null; lastTotal: number | null; lastFailed: number | null; searches: number; results: number; failed: number }[] {
    const rows = new Map((this.ctx.db.prepare('SELECT * FROM search_engines').all() as EngineRow[]).map((r) => [r.engine, r]));
    const names = [...new Set(Object.values(CATEGORY_ENGINES).flat())];
    const now = new Date(this.now()).toISOString();
    return names.map((engine) => {
      const r = rows.get(engine);
      const dropped = !!r?.dropped_until && r.dropped_until > now;
      return {
        engine,
        label: ENGINE_LABELS[engine] ?? engine,
        categories: (Object.keys(CATEGORY_ENGINES) as SearchCategory[]).filter((c) => CATEGORY_ENGINES[c].includes(engine)),
        status: !r ? 'unused' : dropped ? 'dropped' : r.last_error ? 'refusing' : 'ok',
        until: dropped ? r!.dropped_until : null,
        reason: dropped ? r!.dropped_reason : (r?.last_error ?? null),
        lastAt: r?.last_at ?? null,
        lastTotal: r?.last_total ?? null,
        lastFailed: r?.last_failed ?? null,
        searches: r?.searches ?? 0,
        results: r?.results ?? 0,
        failed: r?.failed ?? 0,
      };
    });
  }
}
