#!/usr/bin/env node
// The portable README as a page the app serves at /lifeos/guide.html (product brief 10 §2, ADR-94),
// so the https banner, the starter notes' link and "see the README" lead somewhere on any device.
// Run in the image build:  node docker/guide.mjs portable/README.md apps/web/dist/guide.html
// The Markdown the README uses, and only that: ATX headings (with GitHub's anchors, so
// guide.html#https-on-a-nas works), paragraphs, nested - and 1. lists, ``` fences, `code`,
// **bold**, *italic*, [links](url) and bare https:// addresses. The README is our own text; every
// character of it is escaped all the same.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export function slug(text) {
  const plain = text.replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_]/g, '');
  return plain
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Inline Markdown to HTML: code and links are set aside first, so nothing inside them is touched. */
export function inline(text) {
  const kept = [];
  const keep = (html) => `\u0000${kept.push(html) - 1}\u0000`;
  let s = text.replace(/`([^`]+)`/g, (_, code) => keep(`<code>${esc(code)}</code>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => keep(`<a href="${esc(href)}">${inline(label)}</a>`));
  s = esc(s);
  s = s.replace(/\bhttps?:\/\/[^\s<)\u0000]*[^\s<).,;:!?\u0000]/g, (url) => keep(`<a href="${url}">${url}</a>`));
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
}

const ITEM = /^(\s*)([-*]|\d+\.)\s+/;
const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const indentOf = (l) => l.match(/^\s*/)[0].length;
const blank = (l) => l.trim() === '';

/** Block Markdown to HTML. `ids` collects the anchors given so far (a repeated heading gets -1, -2). */
export function blocks(lines, ids = new Map()) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    if (FENCE.test(line)) {
      const code = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) code.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const base = slug(h[2]);
      const n = ids.get(base) ?? 0;
      ids.set(base, n + 1);
      const id = n ? `${base}-${n}` : base;
      out.push(`<h${h[1].length} id="${esc(id)}">${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    const m = ITEM.exec(line);
    if (m && indentOf(line) === 0) {
      const ordered = /\d/.test(m[2]);
      const items = [];
      while (i < lines.length) {
        const im = ITEM.exec(lines[i]);
        if (!im || indentOf(lines[i]) !== 0 || /\d/.test(im[2]) !== ordered) break;
        const width = im[0].length;
        const body = [lines[i].slice(width)];
        for (i++; i < lines.length; i++) {
          const l = lines[i];
          if (blank(l)) {
            // a blank line belongs to the item when the item goes on after it
            const next = lines.slice(i + 1).find((x) => !blank(x));
            if (next !== undefined && indentOf(next) >= width) body.push('');
            else break;
          } else if (indentOf(l) >= width) body.push(l.slice(width));
          // a nested item or a lazy line indented less than the text: still this item's
          else if (indentOf(l) > 0) body.push(l.trimStart());
          else break;
        }
        items.push(body);
        while (i < lines.length && blank(lines[i]) && (() => {
          const next = lines.slice(i + 1).find((x) => !blank(x));
          return next !== undefined && ITEM.test(next) && indentOf(next) === 0;
        })()) i++;
      }
      const lis = items.map((body) => {
        const html = blocks(body, ids);
        // a one-paragraph item stays tight, as GitHub shows it
        const tight = html.match(/^<p>([\s\S]*)<\/p>$/);
        return `<li>${tight && !tight[1].includes('<p>') ? tight[1] : html}</li>`;
      });
      out.push(ordered ? `<ol>\n${lis.join('\n')}\n</ol>` : `<ul>\n${lis.join('\n')}\n</ul>`);
      continue;
    }
    const para = [];
    while (i < lines.length && !blank(lines[i]) && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !(ITEM.test(lines[i]) && indentOf(lines[i]) === 0)) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join('\n'))}</p>`);
  }
  return out.join('\n');
}

export function render(md) {
  return blocks(md.replace(/\r\n?/g, '\n').split('\n'));
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1d2a2a; --muted: #5b6b6b; --bg: #f7fbfb; --card: #ffffff; --line: #d9e4e3; --link: #0b6b65; --code: #eef4f3; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6efee; --muted: #9fb0af; --bg: #0f1716; --card: #16201f; --line: #2a3a39; --link: #6fd3c8; --code: #1d2928; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 44rem; margin: 0 auto; padding: 24px 20px 64px; }
nav a { display: inline-block; min-height: 44px; line-height: 44px; }
h1 { font-size: 1.9rem; line-height: 1.2; margin: 8px 0 16px; }
h2 { font-size: 1.35rem; margin: 40px 0 12px; padding-top: 16px; border-top: 1px solid var(--line); }
h3 { font-size: 1.1rem; margin: 28px 0 8px; }
h2, h3 { scroll-margin-top: 16px; }
:target { background: var(--code); border-radius: 8px; }
a { color: var(--link); }
p, li { overflow-wrap: anywhere; }
ul, ol { padding-left: 1.4em; }
li + li { margin-top: 6px; }
code { font: 0.92em/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--code); padding: 1px 5px; border-radius: 6px; }
pre { background: var(--code); padding: 12px 14px; border-radius: 10px; overflow-x: auto; }
pre code { padding: 0; background: none; }
`;

/** The whole page: the README with a way back to the app. */
export function page(md) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>LifeOS guide</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<nav><a href="./">← Back to LifeOS</a></nav>
${render(md)}
</main>
</body>
</html>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    console.error('usage: guide.mjs <README.md> <guide.html>');
    process.exit(2);
  }
  writeFileSync(to, page(readFileSync(from, 'utf8')));
}
