/**
 * Hadith library (spec §5.10): `Resources/hadith-library/<book>.md`, written only by the host import
 * script, one entry per hadith:
 *
 *   ### Al-Kafi v2 · Book of Faith and Disbelief · Ch. 95 · #1523
 *   grade: sahih (per Majlisi)
 *   themes: patience, perseverance
 *   source: https://thaqalayn.net/…
 *   > Arabic text
 *   >
 *   > English translation
 *
 * The `themes:` line is the import's theme tags (ADR-16). Arabic and English are separated by an
 * empty quote line. Entries are rendered verbatim; nothing here rewrites their text.
 * `favorites.md` holds one `- <entry heading>` per pinned entry (Obsidian or LifeOS).
 */
import { type RawLine } from './markdown.js';

export const LIBRARY_DIR = 'Resources/hadith-library';
export const FAVORITES_PATH = `${LIBRARY_DIR}/favorites.md`;

export const THEMES = ['patience', 'repentance', 'self-control', 'gratitude', 'perseverance', 'hope', 'prayer'] as const;
export type Theme = (typeof THEMES)[number];
/** the themes the habit nudge draws from (spec §9 job 3) */
export const NUDGE_THEMES: Theme[] = ['patience', 'repentance', 'self-control', 'gratitude', 'perseverance'];

/** Theme keyword map over the English text (spec §16). Whole-word stems, case-insensitive. */
export const THEME_KEYWORDS: Record<Theme, RegExp> = {
  patience: /\b(patien(ce|t|tly)|forbear(ance|ing)?|endur(e|es|ed|ing|ance)|sabr)\b/i,
  repentance: /\b(repent(s|ed|ing|ance|ant)?|forgiv(e|es|en|eness|ing)|seek(s|ing)? forgiveness|tawba|contrit(e|ion)|regret(s|ted)?)\b/i,
  'self-control': /\b(self[- ]control|restrain(s|ed|t)?|anger|angry|desires?|passions?|lusts?|appetites?|temptations?|(control|master|struggle against|oppose)s? (his|your|one's|the) (self|soul|desires?|anger))\b/i,
  gratitude: /\b(grat(itude|eful)|thank(s|ful|fulness|ing)?|shukr|ingrat(itude|e))\b/i,
  perseverance: /\b(persever(e|es|ed|ing|ance)|steadfast(ness)?|persist(s|ed|ent|ence)?|constan(t|cy)|consistent(ly)?|striv(e|es|ing)|diligen(t|ce))\b/i,
  hope: /\b(hope(s|ful)?|despair(s|ed|ing)?|hopeless)\b/i,
  prayer: /\b(prayers?|pray(s|ed|ing)?|supplicat(e|es|ion|ions|ing)|salat|du['’]?a)\b/i,
};

export function themesOf(english: string): Theme[] {
  return THEMES.filter((t) => THEME_KEYWORDS[t].test(english));
}

export interface HadithEntry {
  id: string;
  /** vault path of the book file */
  file: string;
  /** line of the `###` heading */
  line: number;
  heading: string;
  book: string;
  /** the heading after the book: section, chapter, number */
  reference: string;
  grade: string | null;
  source: string | null;
  themes: string[];
  arabic: string;
  english: string;
}

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

export function hasArabic(s: string): boolean {
  return ARABIC.test(s);
}

/** Entries of one library file (stable ids: file slug + heading). */
export function parseLibrary(lines: RawLine[], file: string): HadithEntry[] {
  const out: HadithEntry[] = [];
  const slug = (file.split('/').pop() ?? file).replace(/\.md$/i, '');
  let i = 0;
  while (i < lines.length) {
    const h = /^###\s+(.+?)\s*$/.exec(lines[i].text);
    if (!h) {
      i++;
      continue;
    }
    const heading = h[1];
    const start = i;
    i++;
    let grade: string | null = null;
    let source: string | null = null;
    let themes: string[] = [];
    const quote: string[] = [];
    for (; i < lines.length && !/^#{1,3}\s/.test(lines[i].text); i++) {
      const t = lines[i].text;
      let m: RegExpExecArray | null;
      if (t.startsWith('>')) quote.push(t.replace(/^>\s?/, ''));
      else if ((m = /^grade:\s*(.*)$/i.exec(t))) grade = m[1].trim() || null;
      else if ((m = /^source:\s*(.*)$/i.exec(t))) source = m[1].trim() || null;
      else if ((m = /^themes:\s*(.*)$/i.exec(t))) themes = m[1].split(',').map((x) => x.trim()).filter(Boolean);
    }
    const { arabic, english } = splitQuote(quote);
    const parts = heading.split(/\s+·\s+/);
    out.push({
      id: `${slug}#${heading}`,
      file,
      line: start,
      heading,
      book: parts[0] ?? heading,
      reference: parts.slice(1).join(' · '),
      grade,
      source,
      themes,
      arabic,
      english,
    });
  }
  return out;
}

/** Split a blockquote into Arabic and English: at the first empty quote line, else by script. */
export function splitQuote(quote: string[]): { arabic: string; english: string } {
  const gap = quote.findIndex((q) => q.trim() === '');
  if (gap > 0) {
    const a = quote.slice(0, gap).join('\n').trim();
    const e = quote.slice(gap + 1).join('\n').trim();
    if (hasArabic(a) || !hasArabic(e)) return { arabic: a, english: e };
    return { arabic: e, english: a };
  }
  const ar = quote.filter((q) => hasArabic(q));
  const en = quote.filter((q) => !hasArabic(q) && q.trim() !== '');
  return { arabic: ar.join('\n').trim(), english: en.join('\n').trim() };
}

/** One entry as the import writes it (lines, without the trailing blank). */
export function formatEntry(e: { heading: string; grade: string | null; themes: string[]; source: string | null; arabic: string; english: string }): string[] {
  const q = (s: string) =>
    s
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l) => l.trim())
      .filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''))
      .map((l) => (l ? `> ${l}` : '>'));
  const lines = [`### ${e.heading.replace(/\s+/g, ' ').trim()}`];
  lines.push(`grade: ${e.grade?.trim() || 'not graded in the source'}`);
  if (e.themes.length) lines.push(`themes: ${e.themes.join(', ')}`);
  if (e.source) lines.push(`source: ${e.source}`);
  const ar = e.arabic.trim() ? q(e.arabic) : [];
  const en = e.english.trim() ? q(e.english) : [];
  lines.push(...ar);
  if (ar.length && en.length) lines.push('>');
  lines.push(...en);
  return lines;
}

/** `favorites.md`: `- <entry heading>` lines (also `- [[file#heading]]`); returns the headings. */
export function parseFavorites(lines: RawLine[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const m = /^[-*]\s+(.+?)\s*$/.exec(l.text);
    if (!m) continue;
    let v = m[1];
    const w = /^\[\[[^\]#|]*#([^\]|]+)(?:\|[^\]]*)?\]\]/.exec(v);
    if (w) v = w[1];
    v = v.replace(/\s+[—–]\s+.*$/, '').trim();
    if (v) out.push(v);
  }
  return out;
}

export const FAVORITES_TEMPLATE = (date: string) => `---
date: ${date}
tags: [hadith-library, favorites]
status: active
---
# Favorites

Pinned entries (one heading per line). LifeOS prefers these for the daily pick.

`;

// ------------------------------------------------------------------ deterministic selector (§9 job 3)

/** mulberry32 over a string hash: the same day and habit give the same picks. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rnd: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface SelectOptions {
  /** heading → shown date; entries shown within `noRepeatDays` are skipped */
  shown: Map<string, string>;
  today: string;
  seed: string;
  favorites: string[];
  /** themes to prefer (default: the nudge themes) */
  themes?: string[];
  count?: number;
  noRepeatDays?: number;
}

/**
 * Candidates for the nudge (spec §9 job 3): favorites first, then entries tagged with the nudge
 * themes (more matching themes first), random among the top matches with a seeded generator, no
 * entry shown in the last 30 days. Entries without English text are never candidates.
 */
export function selectCandidates(entries: HadithEntry[], o: SelectOptions): HadithEntry[] {
  const count = o.count ?? 3;
  const days = o.noRepeatDays ?? 30;
  const cutoff = Date.parse(`${o.today}T00:00:00Z`) - days * 86400000;
  const fresh = entries.filter((e) => {
    if (!e.english.trim()) return false;
    const last = o.shown.get(e.id);
    return !last || Date.parse(`${last}T00:00:00Z`) <= cutoff;
  });
  const rnd = seededRandom(o.seed);
  const fav = new Set(o.favorites.map((f) => f.trim()));
  const picked: HadithEntry[] = [];
  const take = (xs: HadithEntry[]) => {
    for (const x of xs) {
      if (picked.length >= count) return;
      if (!picked.includes(x)) picked.push(x);
    }
  };
  take(shuffle(fresh.filter((e) => fav.has(e.heading)), rnd));
  const want = o.themes ?? NUDGE_THEMES;
  const score = (e: HadithEntry) => e.themes.filter((t) => want.includes(t)).length;
  const themed = fresh.filter((e) => !fav.has(e.heading) && score(e) > 0);
  const byScore = new Map<number, HadithEntry[]>();
  for (const e of themed) byScore.set(score(e), [...(byScore.get(score(e)) ?? []), e]);
  for (const s of [...byScore.keys()].sort((a, b) => b - a)) take(shuffle(byScore.get(s)!, rnd));
  return picked;
}
