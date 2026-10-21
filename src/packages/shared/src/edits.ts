/**
 * Edits in place (round-2 brief §12, ADR-59): the line-level helpers behind "everything in Lists is
 * editable, deletable, archivable". Every function returns new text for the lines it was given and
 * leaves every other byte of a note as it was.
 */
import { frontmatterRange, insertLines, type RawLine, removeLines, replaceLine, setFrontmatterLine } from './markdown.js';
import { formatTask, parseTaskLine } from './task.js';

const indentOf = (text: string) => /^[ \t]*/.exec(text)![0].replace(/\t/g, '    ').length;

/**
 * The block a line heads: the line and the non-blank lines right under it indented deeper (a task
 * group's children, an event's detail bullets). Deleting or moving a line takes its block with it.
 */
export function blockOf(lines: RawLine[], i: number): { start: number; end: number } {
  const base = indentOf(lines[i].text);
  let j = i + 1;
  while (j < lines.length && lines[j].text.trim() !== '' && indentOf(lines[j].text) > base) j++;
  return { start: i, end: j };
}

/**
 * A task's `@slug`s and `#tag`s replaced. The words and the other fields stay in place; the slugs go
 * right after the words (before the first field: the Tasks plugin stops reading fields at an unknown
 * token, ADR-14) and the tags at the end.
 */
export function setTaskLabels(raw: string, labels: { slugs?: string[]; tags?: string[] }): string {
  const t = parseTaskLine(raw);
  if (!t) throw new Error('not a task line');
  const drop = t.tokens.filter((x) => (labels.slugs && x.kind === 'slug') || (labels.tags && x.kind === 'tag')).sort((a, b) => b.start - a.start);
  let line = raw;
  for (const x of drop) {
    let s = x.start;
    while (s > 0 && (line[s - 1] === ' ' || line[s - 1] === '\t')) s--;
    line = line.slice(0, s) + line.slice(x.end);
  }
  line = line.replace(/[ \t]+$/, '');
  if (labels.slugs?.length) {
    const p = parseTaskLine(line)!;
    const field = p.tokens.filter((x) => x.kind !== 'slug' && x.kind !== 'tag').sort((a, b) => a.start - b.start)[0];
    const at = field ? field.start : line.length;
    const head = line.slice(0, at).replace(/[ \t]+$/, '');
    const tail = line.slice(at);
    line = `${head} ${labels.slugs.map((s) => `@${s}`).join(' ')}${tail ? ` ${tail.replace(/^[ \t]+/, '')}` : ''}`;
  }
  if (labels.tags?.length) line += ` ${labels.tags.map((s) => `#${s}`).join(' ')}`;
  return line;
}

// ------------------------------------------------------------------ shopping and wishlist items

export interface ItemFields {
  text: string;
  price?: string | null;
  url?: string | null;
  tags?: string[];
}

/** A shopping or wishlist line from its parts (§5.8 shape), keeping the line's status and its ✅ date. */
export function formatItemLine(raw: string | null, f: ItemFields): string {
  const t = raw ? parseTaskLine(raw) : null;
  let text = f.text.replace(/\s+/g, ' ').trim();
  const price = f.price?.trim().replace(/^~/, '');
  if (price) text += ` ~${price.startsWith('$') ? price : `$${price}`}`;
  if (f.url?.trim()) text += ` [link](${f.url.trim().replace(/\s/g, '%20').replace(/\)/g, '%29')})`;
  return formatTask({ text, status: t?.status ?? 'open', done: t?.done ?? null, indent: t?.indent ?? '', tags: f.tags ?? [] });
}

// ------------------------------------------------------------------ events (§5.9)

/** "Dinner at Ali's — Midtown" → { text: "Dinner at Ali's", place: "Midtown" } (split at the first " — "). */
export function splitPlace(text: string): { text: string; place: string | null } {
  const i = text.indexOf(' — ');
  if (i < 0) return { text, place: null };
  return { text: text.slice(0, i), place: text.slice(i + 3) };
}

export function joinPlace(text: string, place: string | null | undefined): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const p = place?.replace(/\s+/g, ' ').trim();
  return p ? `${t} — ${p}` : t;
}

// ------------------------------------------------------------------ wiki-links (a note renamed or moved)

const WIKI = /(!?)\[\[([^\]|#]*)((?:#[^\]|]*)?)((?:\|[^\]]*)?)\]\]/g;

const bare = (p: string) => p.replace(/^\/+/, '').replace(/\.md$/i, '');
const base = (p: string) => bare(p).split('/').pop()!;

/**
 * Does a wiki-link target name this note? A path (`Inbox/foo`, `foo.md`, a trailing part of the path)
 * matches the note's path; a bare name matches when no other note has that name (Obsidian's rule).
 */
export function linkNames(target: string, file: string, uniqueName: boolean): boolean {
  const t = bare(target.trim()).toLowerCase();
  const f = bare(file).toLowerCase();
  if (!t) return false;
  if (t.includes('/')) return f === t || f.endsWith(`/${t}`);
  return uniqueName && base(f) === t;
}

/**
 * A line with every wiki-link that named `from` pointed at `to` instead: a link written as a bare
 * name gets the new bare name when it is unique, a path link gets the new path; heading and alias
 * are kept. Returns the line unchanged when nothing named it.
 */
export function retargetLinks(text: string, from: string, to: string, opts: { fromUnique: boolean; toUnique: boolean }): string {
  return text.replace(WIKI, (m, bang: string, target: string, heading: string, alias: string) => {
    if (!linkNames(target, from, opts.fromUnique)) return m;
    const pathLike = target.includes('/') || !opts.toUnique;
    const next = pathLike ? bare(to) : base(to);
    return `${bang}[[${next}${heading}${alias}]]`;
  });
}

// ------------------------------------------------------------------ frontmatter

/**
 * Set a frontmatter key to a one-line value, replacing a block value under it (`tags:` followed by
 * `  - a` lines); a note without frontmatter gets one.
 */
export function setFrontmatterValue(lines: RawLine[], key: string, value: string): RawLine[] {
  const fm = frontmatterRange(lines);
  if (!fm) return insertLines(lines, -1, ['---', `${key}: ${value}`, '---']);
  const re = new RegExp(`^${key.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*:`);
  for (let i = fm.start + 1; i < fm.end; i++) {
    if (!re.test(lines[i].text)) continue;
    let j = i + 1;
    while (j < fm.end && /^[ \t]+\S|^-\s/.test(lines[j].text)) j++;
    const out = j > i + 1 ? removeLines(lines, Array.from({ length: j - i - 1 }, (_, k) => i + 1 + k)) : lines;
    return replaceLine(out, i, [`${key}: ${value}`]);
  }
  return setFrontmatterLine(lines, key, value)!;
}

/** A YAML flow list for tags: `[a, b]`. */
export const tagList = (tags: string[]): string => `[${tags.map((t) => t.replace(/^#/, '').trim()).filter(Boolean).join(', ')}]`;
