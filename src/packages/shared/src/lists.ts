/**
 * Lists, links, notes, goals, projects, reminders and ring captures (spec §5.3–5.8).
 */
import { findSection, lastContentLine, type RawLine, removeLines, insertLines, addSection } from './markdown.js';
import { parseTaskLine } from './task.js';

export const LINKS_PATH = 'Resources/links.md';
export const SHOPPING_PATH = 'Areas/Lists/shopping.md';
export const WISHLIST_PATH = 'Areas/Lists/wishlist.md';
export const REMINDERS_PATH = 'Areas/Reminders.md';
export const GOALS_DIR = 'Areas/Goals';
export const PROJECTS_DIR = 'Projects';
export const INBOX_DIR = 'Inbox';
export const RING_DIR = 'Inbox/Ring';

// ------------------------------------------------------------------ links (§5.7)

export interface LinkLine {
  title: string;
  url: string;
  tags: string[];
  note: string | null;
  saved: string | null;
}

/** `- [Title](https://url) #tag — optional note (saved 2026-10-19)` */
export function parseLinkLine(text: string): LinkLine | null {
  const m = /^[-*] \[((?:[^\]\\]|\\.)+)\]\((\S+?)\)(.*)$/.exec(text.trim());
  if (!m) return null;
  let rest = m[3];
  let saved: string | null = null;
  const s = /\s*\(saved (\d{4}-\d{2}-\d{2})\)\s*$/.exec(rest);
  if (s) {
    saved = s[1];
    rest = rest.slice(0, s.index);
  }
  let note: string | null = null;
  const dash = rest.search(/\s[—–]\s/);
  if (dash >= 0) {
    note = rest.slice(dash).replace(/^\s[—–]\s/, '').trim() || null;
    rest = rest.slice(0, dash);
  }
  const tags = [...rest.matchAll(/(?<=^|\s)#([^\s#]+)/g)].map((x) => x[1]).filter((t) => !/^\d+$/.test(t));
  return { title: m[1].replace(/\\(.)/g, '$1'), url: m[2], tags, note, saved };
}

export function formatLinkLine(l: LinkLine): string {
  const title = l.title.replace(/\s+/g, ' ').trim().replace(/([[\]\\])/g, '\\$1');
  let s = `- [${title}](${l.url.replace(/\s/g, '%20').replace(/\)/g, '%29')})`;
  for (const t of l.tags) s += ` #${t}`;
  if (l.note?.trim()) s += ` — ${l.note.trim().replace(/\s+/g, ' ')}`;
  if (l.saved) s += ` (saved ${l.saved})`;
  return s;
}

export const LINKS_TEMPLATE = (date: string) => `---
date: ${date}
tags: [links]
status: active
---
# Links

`;

// ------------------------------------------------------------------ shopping and wishlist (§5.8)

export interface ItemExtras {
  url: string | null;
  price: string | null;
}

/** `Pixel Watch band [link](https://…) ~$45 #gift` → the link and the price */
export function itemExtras(raw: string): ItemExtras {
  const link = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/.exec(raw);
  const price = /(?<=^|\s)~?\$\s?(\d+(?:[.,]\d{1,2})?)/.exec(raw);
  return { url: link?.[1] ?? null, price: price ? `$${price[1]}` : null };
}

export const listTemplate = (kind: 'shopping' | 'wishlist', date: string) => `---
date: ${date}
tags: [list, ${kind}]
status: active
---
# ${kind === 'shopping' ? 'Shopping' : 'Wishlist'}

## Items
`;

/**
 * "Clear bought" (§5.8): the `[x]` lines of `## Items` move to `## Bought` at the bottom (created
 * when missing). Returns the moved line texts too, so the caller can verify them by hash first.
 */
export function clearBoughtLines(lines: RawLine[]): { lines: RawLine[]; moved: { line: number; text: string }[] } {
  const items = findSection(lines, 'Items');
  if (!items) return { lines, moved: [] };
  const moved: { line: number; text: string }[] = [];
  for (let i = items.start; i < items.end; i++) {
    const t = parseTaskLine(lines[i].text);
    if (t && t.status === 'done' && t.indent === '') moved.push({ line: i, text: lines[i].text });
  }
  if (!moved.length) return { lines, moved };
  let out = removeLines(lines, moved.map((m) => m.line));
  const bought = findSection(out, 'Bought');
  if (bought) out = insertLines(out, lastContentLine(out, bought), moved.map((m) => m.text));
  else out = addSection(out, 'Bought', moved.map((m) => m.text), []);
  return { lines: out, moved };
}

// ------------------------------------------------------------------ notes, goals, projects (§5.3, §5.4, §5.7)

export function noteTemplate(title: string, date: string, body: string, tags: string[] = ['note']): string {
  const b = body.replace(/\r\n?/g, '\n').trimEnd();
  return `---
date: ${date}
tags: [${tags.join(', ')}]
status: active
---
# ${title.replace(/\s+/g, ' ').trim()}
${b ? `\n${b}\n` : ''}`;
}

export function goalTemplate(g: { title: string; date: string; target: string | null; why: string | null }): string {
  return `---
date: ${g.date}
tags: [goal]
status: active
${g.target ? `target: ${g.target}\n` : ''}${g.why ? `why: ${yamlScalar(g.why)}\n` : ''}---
# ${g.title.replace(/\s+/g, ' ').trim()}

## Tasks
`;
}

/** A YAML-safe single-line scalar (quoted when it needs to be). */
export function yamlScalar(s: string): string {
  const v = s.replace(/\s+/g, ' ').trim();
  if (/^[\w][\w .,'’()!?&/-]*$/.test(v) && !/:\s|\s#|^(true|false|null|yes|no|~)$/i.test(v)) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export const reminderNoteTemplate = (date: string) => `---
date: ${date}
tags: [reminders]
status: active
---
# Reminders

## Tasks
`;

// ------------------------------------------------------------------ ring captures (§5, §6 evening)

export interface CaptureInfo {
  title: string;
  transcript: string;
  organized: string;
}

/** The capture's transcript (blockquote under `## Original transcript`) and its organized text. */
export function readCapture(lines: RawLine[], fallbackTitle: string): CaptureInfo {
  const tr = findSection(lines, 'Original transcript');
  const org = findSection(lines, 'Organized');
  const transcript = tr
    ? lines
        .slice(tr.start, tr.end)
        .map((l) => l.text)
        .filter((t) => t.startsWith('>'))
        .map((t) => t.replace(/^>\s?/, ''))
        .join('\n')
        .trim()
    : '';
  const organized = org
    ? lines
        .slice(org.start, org.end)
        .map((l) => l.text)
        .join('\n')
        .trim()
    : '';
  return { title: fallbackTitle, transcript, organized };
}

export type CaptureDecision = 'ignored' | 'task' | 'note';

/** A shopping or wishlist item's words, without its link, price, tags and fields (for display). */
export function itemLabel(raw: string): string {
  const t = parseTaskLine(raw);
  const d = t ? t.description : raw;
  return d
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/(^|\s)~?\$\s?\d+(?:[.,]\d{1,2})?/g, ' ')
    .replace(/(^|\s)[#@][^\s#@]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
