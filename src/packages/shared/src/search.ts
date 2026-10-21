/**
 * Web search relevance (round-2 brief §8): what the API keeps from SearXNG's answer.
 *
 * - A result is kept when its title and snippet share at least one word stem with the query
 *   (a light English stemmer; transliterations such as "hawza"/"hawzah" match by prefix).
 * - An engine whose results mostly miss (more than half of at least four) is judged off-topic for
 *   this host: the API drops it for 24 hours and leaves out what only it returned.
 * - The Islamic category boosts a user-editable list of preferred domains to the top (a local
 *   re-ranking: nothing but the query text leaves the box).
 */

export type SearchCategory = 'web' | 'videos' | 'shopping' | 'islamic';
export const SEARCH_CATEGORIES: SearchCategory[] = ['web', 'videos', 'shopping', 'islamic'];

export const DEFAULT_PREFERRED_DOMAINS = ['al-islam.org', 'thaqalayn.net', 'sistani.org', 'imam-us.org', 'iiknet.org'];

/** An engine judged off-topic is left out of searches for this long. */
export const ENGINE_DROP_MS = 24 * 3600_000;
/** An engine is judged only on this many results or more. */
export const ENGINE_JUDGE_MIN = 4;

const STOPWORDS = new Set(
  'a an the and or but of to in on at by for with from into onto about as is are was were be been being it its this that these those what which who whom how why when where i me my we our you your he she they them their his her not no do does did can could will would should shall may might must vs via'.split(
    ' ',
  ),
);

const SUFFIXES = ['ational', 'ations', 'ation', 'ments', 'ment', 'nesses', 'ness', 'ings', 'ing', 'ies', 'ied', 'ers', 'er', 'es', 'ed', 'ly', 's'];

/** A light English stem: the common inflection and derivation endings off a word of four letters or more. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length < 4 || /\d/.test(w)) return w;
  for (const suf of SUFFIXES) {
    if (suf === 's' && w.endsWith('ss')) break;
    if (w.endsWith(suf) && w.length - suf.length >= 3) {
      w = w.slice(0, -suf.length);
      if (suf === 'ies' || suf === 'ied') w += 'y';
      break;
    }
  }
  return w;
}

/** The words of a text as stems: lower case, accents folded, stopwords and one-letter words out. */
export function stems(text: string): Set<string> {
  const out = new Set<string>();
  const folded = text
    .normalize('NFKD')
    .replace(/[̀-ͯʼʻ‘’'ʿʾ]/g, '')
    .toLowerCase();
  for (const m of folded.matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}

function matches(a: string, b: string): boolean {
  if (a === b) return true;
  // transliteration and stemming leftovers: "hawza"/"hawzah", "classe"/"class"
  if (a.length >= 4 && b.length >= 4) return a.startsWith(b) || b.startsWith(a);
  return false;
}

/** Does a result share a stem with the query? A query with no content words keeps everything. */
export function isRelevant(query: Set<string> | string, title: string, snippet: string): boolean {
  const q = typeof query === 'string' ? stems(query) : query;
  if (!q.size) return true;
  const r = stems(`${title} ${snippet}`);
  for (const a of q) for (const b of r) if (matches(a, b)) return true;
  return false;
}

export interface RawResult {
  title: string;
  url: string;
  content: string;
  engine: string | null;
  engines: string[];
}

export interface EngineVerdict {
  engine: string;
  total: number;
  failed: number;
  /** more than half of at least ENGINE_JUDGE_MIN results shared no stem with the query */
  offTopic: boolean;
}

export interface Judged<T extends RawResult> {
  kept: T[];
  /** results dropped: no stem in common, or only from an off-topic engine */
  dropped: number;
  verdicts: EngineVerdict[];
}

/** Keep the relevant results and judge each engine on this answer. */
export function judgeResults<T extends RawResult>(query: string, results: T[]): Judged<T> {
  const q = stems(query);
  const per = new Map<string, { total: number; failed: number }>();
  const ok = results.map((r) => isRelevant(q, r.title, r.content));
  results.forEach((r, i) => {
    const names = r.engines.length ? r.engines : r.engine ? [r.engine] : [];
    for (const e of names) {
      const v = per.get(e) ?? { total: 0, failed: 0 };
      v.total++;
      if (!ok[i]) v.failed++;
      per.set(e, v);
    }
  });
  const verdicts: EngineVerdict[] = [...per].map(([engine, v]) => ({ engine, ...v, offTopic: q.size > 0 && v.total >= ENGINE_JUDGE_MIN && v.failed * 2 > v.total }));
  const off = new Set(verdicts.filter((v) => v.offTopic).map((v) => v.engine));
  const kept = results.filter((r, i) => {
    if (!ok[i]) return false;
    const names = r.engines.length ? r.engines : r.engine ? [r.engine] : [];
    // a result only an off-topic engine returned goes with it; one another engine agreed on stays
    return names.length === 0 || names.some((e) => !off.has(e));
  });
  return { kept, dropped: results.length - kept.length, verdicts };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** A domain as typed in Settings (`https://www.al-islam.org/x` → `al-islam.org`), or null. */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
  const h = hostOf(s);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) ? h : null;
}

/** Is the URL on one of the domains (the domain itself or a subdomain)? */
export function onDomain(url: string, domains: string[]): boolean {
  const h = hostOf(url);
  return !!h && domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Preferred domains first (in their own order), everything else after, otherwise as ranked. */
export function boostPreferred<T extends { url: string }>(results: T[], domains: string[]): (T & { preferred: boolean })[] {
  const marked = results.map((r) => ({ ...r, preferred: onDomain(r.url, domains) }));
  return [...marked.filter((r) => r.preferred), ...marked.filter((r) => !r.preferred)];
}

/** The cache and drop-list key of a query: trimmed, spaces collapsed, lower case. */
export function queryKey(q: string): string {
  return q.replace(/\s+/g, ' ').trim().toLowerCase();
}
