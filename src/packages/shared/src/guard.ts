/**
 * The hadith guard (spec §9 job 3, ADR-6, ADR-17). The model picks one of three library entries and
 * writes a short encouragement in its own words. Its output is rejected — and the fixed fallback
 * sentence is shown beneath the verbatim entry instead — when any rule fails:
 *
 *  schema           pick is 1..candidates, encouragement 1–60 words (≤ 480 characters)
 *  non-latin        any Arabic-script (or other RTL) character: the model must not write scripture
 *  attribution      "the Prophet said", "Imam … said", "Allah says" and their kin (the spec's list)
 *  religious-term   any reference to God, prophets, imams, scripture, verses, narrations or
 *                   honorifics: a paraphrase can be shorter than seven words ("Allah is with the
 *                   patient"), so the encouragement stays secular and the entry speaks for itself
 *  quotation        a quoted passage of three or more words
 *  library-7gram    more than 6 consecutive words found in any library entry (the spec's rule)
 *  candidate-5gram  5 consecutive words found in one of the three entries shown (closer paraphrase)
 *
 * Text is compared after normalization (NFKC, lower case, accents and Arabic diacritics removed,
 * zero-width characters dropped, punctuation folded to spaces), so case, punctuation and spacing
 * tricks do not slip a copied passage through.
 */

export const FALLBACK_ENCOURAGEMENT = 'A slip is a data point, not a verdict. Tomorrow is a scheduled day.';
export const MAX_WORDS = 60;
export const MAX_CHARS = 480;

const ZERO_WIDTH = /[­​-‏‪-‮⁠-⁤﻿]/g;
const ARABIC_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

/** Words of a text, normalized for comparison. */
export function normalizeWords(s: string): string[] {
  let t = s.normalize('NFKC').replace(ZERO_WIDTH, '').toLowerCase();
  t = t.replace(ARABIC_MARKS, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
  t = t.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  t = t.replace(/['’‘ʼʻ`´]/g, '');
  return t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** 32-bit FNV-1a */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function ngramHashes(words: string[], n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + n <= words.length; i++) out.push(fnv(words.slice(i, i + n).join(' ')));
  return out;
}

/** The library's 7-word sequences, hashed (built once per library load). */
export function buildCorpus(texts: Iterable<string>, n = 7): Set<number> {
  const set = new Set<number>();
  for (const t of texts) for (const h of ngramHashes(normalizeWords(t), n)) set.add(h);
  return set;
}

export interface GuardInput {
  pick: unknown;
  encouragement: unknown;
  /** the three entries offered to the model, in order */
  candidates: { english: string; arabic: string }[];
  /** buildCorpus() over every library entry (English and Arabic) */
  corpus: Set<number>;
}

export type GuardResult = { ok: true; pick: number; encouragement: string } | { ok: false; rule: string; detail: string };

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

const ATTRIBUTION: RegExp[] = [
  /\b(the )?(holy )?prophet( \w+){0,4} (said|says|say|saying|told|tells|taught|teaches|narrated|reported|stated)\b/,
  /\bimam( \w+){0,5} (said|says|say|saying|told|tells|taught|teaches|narrated|reported|stated)\b/,
  /\b(allah|god|the lord|lord)( \w+){0,3} (says|said|say|saying|tells|told|declares|declared|promises|promised|commands|commanded|reveals|revealed|states|stated)\b/,
  /\b(it is|it was|it has been) (narrated|reported|related|transmitted)\b/,
  /\b(hadith|quran|koran|scripture|verse|surah) (says|said|tells|teaches|states)\b/,
  /\b(muhammad|mohammed|ali|fatima|fatimah|hasan|husayn|hussain|husain|sajjad|baqir|sadiq|kazim|rida|reza|jawad|hadi|askari|mahdi|zaynab|zainab|jafar)( \w+){0,3} (said|says|taught|teaches|told|narrated|reported)\b/,
];

const RELIGIOUS = new Set([
  'allah', 'god', 'gods', 'lord', 'almighty', 'divine', 'holy', 'prophet', 'prophets', 'prophetic', 'messenger', 'apostle',
  'imam', 'imams', 'quran', 'quranic', 'koran', 'hadith', 'hadiths', 'ahadith', 'ayah', 'ayat', 'verse', 'verses', 'surah', 'sura',
  'scripture', 'scriptures', 'revelation', 'revealed', 'narrated', 'narrator', 'narration', 'narrations', 'pbuh', 'sallallahu',
  'alayhi', 'alaihi', 'alayhis', 'alayha', 'subhanahu', 'wataala', 'salawat', 'ahlulbayt', 'infallible', 'infallibles',
]);
const RELIGIOUS_PHRASES = [/\bpeace be upon\b/, /\bupon (him|her|them) be peace\b/, /\bahl (al |ul )?bayt\b/, /\bcommander of the faithful\b/, /\bamir al muminin\b/];
const HONORIFIC = /\(\s*(a\.?\s?s\.?|s\.?\s?a\.?\s?w\.?\s?a?\.?|p\.?\s?b\.?\s?u\.?\s?h\.?|a\.?\s?j\.?|r\.?\s?a\.?|s\.?\s?a\.?|swt|saw|sawa)\s*\)|ﷺ|﷽/i;
const QUOTED = /["“”«»„‟]([^"“”«»„‟]*)["“”«»„‟]/g;

export function countWords(s: string): number {
  return (s.trim().match(/\S+/g) ?? []).length;
}

export function guardEncouragement(input: GuardInput): GuardResult {
  const { pick, encouragement, candidates, corpus } = input;
  if (typeof pick !== 'number' || !Number.isInteger(pick) || pick < 1 || pick > Math.max(1, candidates.length) || pick > 3) {
    return { ok: false, rule: 'schema', detail: 'pick must be 1, 2 or 3 and name one of the offered entries' };
  }
  if (typeof encouragement !== 'string') return { ok: false, rule: 'schema', detail: 'encouragement must be text' };
  const text = encouragement.replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim();
  const words = countWords(text);
  if (!text || words > MAX_WORDS || text.length > MAX_CHARS) return { ok: false, rule: 'schema', detail: `encouragement must be 1–${MAX_WORDS} words` };
  if (RTL.test(encouragement)) return { ok: false, rule: 'non-latin', detail: 'Arabic or other right-to-left script' };
  const norm = normalizeWords(text);
  const joined = ` ${norm.join(' ')} `;
  for (const re of ATTRIBUTION) if (re.test(joined)) return { ok: false, rule: 'attribution', detail: 'attributes words to God, a prophet, an imam or scripture' };
  const hit = norm.find((w) => RELIGIOUS.has(w));
  if (hit) return { ok: false, rule: 'religious-term', detail: `mentions "${hit}"` };
  if (RELIGIOUS_PHRASES.some((re) => re.test(joined)) || HONORIFIC.test(encouragement)) return { ok: false, rule: 'religious-term', detail: 'honorific or religious phrase' };
  for (const q of encouragement.matchAll(QUOTED)) {
    if (countWords(q[1]) >= 3) return { ok: false, rule: 'quotation', detail: 'quotes a passage' };
  }
  if (ngramHashes(norm, 7).some((h) => corpus.has(h))) return { ok: false, rule: 'library-7gram', detail: 'more than 6 consecutive words from a library entry' };
  const near = new Set<number>();
  for (const c of candidates) for (const h of ngramHashes(normalizeWords(`${c.english}\n${c.arabic}`), 5)) near.add(h);
  if (ngramHashes(norm, 5).some((h) => near.has(h))) return { ok: false, rule: 'candidate-5gram', detail: 'repeats five or more words of the entry shown' };
  return { ok: true, pick, encouragement: text };
}

/**
 * For the plan and review drafts (not scripture-adjacent, but the same rule holds: the model never
 * attributes words to God, a prophet, an imam or scripture). Only the attribution rule applies here,
 * since task titles legitimately mention the Qur'an or prayers.
 */
export function hasAttribution(text: string): boolean {
  const joined = ` ${normalizeWords(text).join(' ')} `;
  return ATTRIBUTION.some((re) => re.test(joined)) || HONORIFIC.test(text);
}
