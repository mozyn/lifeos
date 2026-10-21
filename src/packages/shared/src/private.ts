/**
 * Private habit names (round-3 brief §1, ADR-63). A private habit's name is matched as its words in
 * order with any spacing or punctuation between them, so the title ("No late-night scrolling"), its
 * slug ("no-late-night-scrolling", `@no-late-night-scrolling`, `[[no-late-night-scrolling]]`) and a
 * lower-case mention in a note are all the same name. The API's prompt builder replaces every such
 * name with an id before anything reaches the model; the web app replaces it with a generic label
 * while Privacy mode is on.
 */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The words of a name or slug (letters and digits; everything else separates). */
export function nameWords(name: string): string[] {
  return name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** One regex source for a name: its words in order, anything but letters and digits between them. */
function namePattern(name: string): string | null {
  const w = nameWords(name);
  return w.length ? w.map(esc).join('[^\\p{L}\\p{N}]+') : null;
}

/**
 * A global, case-insensitive regex matching any of the names as whole words (longest first, so a
 * longer name wins over a shorter one it contains); null when there is nothing to match.
 */
export function namesRegex(names: string[]): RegExp | null {
  const pats = [...new Set(names.map(namePattern).filter((p): p is string => !!p))].sort((a, b) => b.length - a.length);
  if (!pats.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${pats.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
}

/** Every mention of the names replaced by `label`. */
export function redactNames(text: string, names: string[], label: string): string {
  const re = namesRegex(names);
  return re ? text.replace(re, label) : text;
}

/** The text cut into plain parts and mentions of the names (for a UI that renders mentions apart). */
export function splitNames(text: string, names: string[]): { text: string; name: boolean }[] {
  const re = namesRegex(names);
  if (!re) return [{ text, name: false }];
  const out: { text: string; name: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) out.push({ text: text.slice(at, m.index), name: false });
    out.push({ text: m[0], name: true });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), name: false });
  return out;
}
