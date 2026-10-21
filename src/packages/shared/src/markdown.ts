/**
 * The line model of a vault note (spec §5). A note is a list of raw lines, each with its own line
 * ending, so parse → serialize is byte-identical by construction: nothing is ever re-rendered from a
 * structure. Frontmatter, headings and fenced code are located on top of the lines; edits insert or
 * replace whole lines and leave every other byte alone.
 */

export type Eol = '' | '\n' | '\r\n' | '\r';

export interface RawLine {
  text: string;
  eol: Eol;
}

/** Split into lines, keeping each line's ending. "a\nb\n" → [a⏎, b⏎]; "a\nb" → [a⏎, b]; "" → []. */
export function splitLines(content: string): RawLine[] {
  const out: RawLine[] = [];
  let i = 0;
  const n = content.length;
  while (i < n) {
    let j = i;
    while (j < n && content[j] !== '\n' && content[j] !== '\r') j++;
    const text = content.slice(i, j);
    let eol: Eol = '';
    if (j < n) {
      if (content[j] === '\r' && content[j + 1] === '\n') eol = '\r\n';
      else eol = content[j] as '\n' | '\r';
    }
    out.push({ text, eol });
    i = j + eol.length;
  }
  return out;
}

export function joinLines(lines: RawLine[]): string {
  let s = '';
  for (const l of lines) s += l.text + l.eol;
  return s;
}

/** The ending new lines get: the file's most common one, LF when it has none. */
export function dominantEol(lines: RawLine[]): Exclude<Eol, ''> {
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (const l of lines) {
    if (l.eol === '\n') lf++;
    else if (l.eol === '\r\n') crlf++;
    else if (l.eol === '\r') cr++;
  }
  if (crlf > lf && crlf >= cr) return '\r\n';
  if (cr > lf && cr > crlf) return '\r';
  return '\n';
}

const BOM = '﻿';
/** A line's text for matching: without a leading byte-order mark. */
export const bare = (text: string): string => (text.startsWith(BOM) ? text.slice(1) : text);

export interface FrontmatterRange {
  /** index of the opening `---` (always 0) */
  start: number;
  /** index of the closing `---` or `...` */
  end: number;
}

/** YAML frontmatter: `---` on the first line, closed by `---` (or `...`) on a later line. */
export function frontmatterRange(lines: RawLine[]): FrontmatterRange | null {
  if (!lines.length || bare(lines[0].text).trimEnd() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].text.trimEnd();
    if (t === '---' || t === '...') return { start: 0, end: i };
  }
  return null;
}

export interface Heading {
  line: number;
  level: number;
  text: string;
}

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * Per line: is it inside a fenced code block or the frontmatter (true), or ordinary markdown? The
 * fence lines themselves count as code. Task and heading parsing skip code (the spec's own task
 * examples live in fences).
 */
export function codeMask(lines: RawLine[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  const fm = frontmatterRange(lines);
  if (fm) for (let i = fm.start; i <= fm.end; i++) mask[i] = true;
  let fence: string | null = null;
  for (let i = fm ? fm.end + 1 : 0; i < lines.length; i++) {
    const m = FENCE.exec(lines[i].text);
    if (fence) {
      mask[i] = true;
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && lines[i].text.trim() === m[1]) fence = null;
    } else if (m) {
      mask[i] = true;
      fence = m[1];
    }
  }
  return mask;
}

export function headings(lines: RawLine[], mask = codeMask(lines)): Heading[] {
  const out: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const m = HEADING.exec(bare(lines[i].text));
    if (m) out.push({ line: i, level: m[1].length, text: m[2] });
  }
  return out;
}

export interface Section {
  heading: Heading;
  /** first line after the heading */
  start: number;
  /** one past the last line of the section (the next heading of the same or a higher level, or EOF) */
  end: number;
}

/** The section under the first heading of `level` whose text equals `name` (case-insensitive). */
export function findSection(lines: RawLine[], name: string, level = 2, hs = headings(lines)): Section | null {
  const want = name.trim().toLowerCase();
  const idx = hs.findIndex((h) => h.level === level && h.text.trim().toLowerCase() === want);
  if (idx < 0) return null;
  const h = hs[idx];
  let end = lines.length;
  for (let k = idx + 1; k < hs.length; k++) {
    if (hs[k].level <= level) {
      end = hs[k].line;
      break;
    }
  }
  return { heading: h, start: h.line + 1, end };
}

/** Which H2 section (name) each line belongs to; '' before the first H2. */
export function sectionOfLines(lines: RawLine[], hs = headings(lines)): string[] {
  const out = new Array<string>(lines.length).fill('');
  let cur = '';
  let next = 0;
  for (let i = 0; i < lines.length; i++) {
    while (next < hs.length && hs[next].line === i) {
      if (hs[next].level <= 2) cur = hs[next].level === 2 ? hs[next].text.trim() : '';
      next++;
    }
    out[i] = cur;
  }
  return out;
}

/** The last non-blank line of a section (the heading itself when the section is empty). */
export function lastContentLine(lines: RawLine[], s: Section): number {
  for (let i = s.end - 1; i >= s.start; i--) if (lines[i].text.trim() !== '') return i;
  return s.heading.line;
}

/**
 * Insert `texts` as new lines after line `after` (-1 = at the top). New lines take the file's
 * dominant ending; when inserting after a last line that had no ending, that line gets one (its
 * text is untouched) and the new last line keeps the file's "no final newline" shape.
 */
export function insertLines(lines: RawLine[], after: number, texts: string[]): RawLine[] {
  if (!texts.length) return lines;
  const eol = dominantEol(lines);
  const out = lines.slice();
  const add: RawLine[] = texts.map((t) => ({ text: t, eol }));
  const at = after + 1;
  if (at >= out.length && out.length && out[out.length - 1].eol === '') {
    out[out.length - 1] = { ...out[out.length - 1], eol };
    add[add.length - 1] = { ...add[add.length - 1], eol: '' };
  }
  out.splice(at, 0, ...add);
  return out;
}

/** Replace line `index` with one or more lines, keeping its ending on the last of them. */
export function replaceLine(lines: RawLine[], index: number, texts: string[]): RawLine[] {
  const out = lines.slice();
  const eol = out[index].eol;
  const inner = dominantEol(lines);
  const repl: RawLine[] = texts.map((t, k) => ({ text: t, eol: k === texts.length - 1 ? eol : inner }));
  out.splice(index, 1, ...repl);
  return out;
}

export function removeLines(lines: RawLine[], indexes: number[]): RawLine[] {
  const drop = new Set(indexes);
  const out = lines.filter((_, i) => !drop.has(i));
  // removing the last line must not leave the new last line with a dangling ending it never had
  if (drop.has(lines.length - 1) && out.length && lines[lines.length - 1].eol === '') out[out.length - 1] = { ...out[out.length - 1], eol: '' };
  return out;
}

/** Where a new section goes: before `## Evening digest` when present (bridge-owned, last), else at the end. */
export function newSectionAnchor(lines: RawLine[], beforeNames: string[] = ['Evening digest'], hs = headings(lines)): number {
  const want = beforeNames.map((n) => n.toLowerCase());
  const h = hs.find((x) => x.level === 2 && want.includes(x.text.trim().toLowerCase()));
  if (!h) return lines.length;
  return h.line;
}

/**
 * Add a `## name` section holding `texts`, before the given H2 (or at the end). Keeps one blank line
 * between sections in the shape the daily template uses.
 */
export function addSection(lines: RawLine[], name: string, texts: string[], beforeNames?: string[]): RawLine[] {
  const at = newSectionAnchor(lines, beforeNames);
  const block = [`## ${name}`, ...texts];
  if (at >= lines.length) {
    // at the end: one blank line before the heading unless the file already ends with one
    const lastBlank = lines.length > 0 && lines[lines.length - 1].text.trim() === '';
    const pre = lines.length === 0 || lastBlank ? [] : [''];
    return insertLines(lines, lines.length - 1, [...pre, ...block]);
  }
  // before a heading: the block, then a blank line, keeping whatever blank line preceded the heading
  const prevBlank = at > 0 && lines[at - 1].text.trim() === '';
  return insertLines(lines, at - 1, prevBlank ? [...block, ''] : ['', ...block, '']);
}

/** Frontmatter as key → raw value text (single-line scalars and inline lists). Read-only use. */
export function frontmatterScalars(lines: RawLine[]): Record<string, string> {
  const fm = frontmatterRange(lines);
  const out: Record<string, string> = {};
  if (!fm) return out;
  for (let i = fm.start + 1; i < fm.end; i++) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(lines[i].text);
    if (m) out[m[1]] = stripComment(m[2]);
  }
  return out;
}

function stripComment(v: string): string {
  // `status: active        # active | paused | done` (spec §5.3) → "active"
  if (v.startsWith('"') || v.startsWith("'")) {
    const q = v[0];
    const end = v.indexOf(q, 1);
    return end > 0 ? v.slice(1, end) : v;
  }
  const hash = v.search(/\s#/);
  return (hash >= 0 ? v.slice(0, hash) : v).trim();
}

/** Remove one frontmatter key's line (when it is a single line); every other line stays. */
export function removeFrontmatterLine(lines: RawLine[], key: string): RawLine[] {
  const fm = frontmatterRange(lines);
  if (!fm) return lines;
  const re = new RegExp(`^${key.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*:`);
  for (let i = fm.start + 1; i < fm.end; i++) if (re.test(lines[i].text)) return removeLines(lines, [i]);
  return lines;
}

/**
 * Set one frontmatter key by editing or inserting exactly one line (the `lifeos:` key on ring
 * captures, spec §5). Every other frontmatter line stays byte-identical. Returns null when the note
 * has no frontmatter.
 */
export function setFrontmatterLine(lines: RawLine[], key: string, value: string): RawLine[] | null {
  const fm = frontmatterRange(lines);
  if (!fm) return null;
  const re = new RegExp(`^${key.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*:`);
  for (let i = fm.start + 1; i < fm.end; i++) {
    if (re.test(lines[i].text)) return replaceLine(lines, i, [`${key}: ${value}`]);
  }
  return insertLines(lines, fm.end - 1, [`${key}: ${value}`]);
}
