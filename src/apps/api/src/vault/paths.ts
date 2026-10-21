/**
 * Vault paths: every path the API reads or writes is vault-relative POSIX, `.md`, outside `Work/`
 * and outside dot-folders (`.obsidian/`, `.trash/`, `.stfolder/`, `.stversions/`). Spec §3, §5.
 */
import { posix, resolve, sep } from 'node:path';

export class PathError extends Error {
  constructor(message: string) {
    super(message);
  }
}

const FORBIDDEN_TOP = new Set(['work']);

/** Is this vault-relative path one LifeOS may read? (files and directories) */
export function isReadable(rel: string): boolean {
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length) return true;
  if (FORBIDDEN_TOP.has(parts[0].toLowerCase())) return false;
  return !parts.some((p) => p.startsWith('.'));
}

/** Normalize a vault-relative path and refuse anything outside the readable vault. */
export function safeRel(rel: string): string {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new PathError('invalid path');
  const norm = posix.normalize(rel.replace(/\\/g, '/')).replace(/^\/+/, '');
  if (norm.startsWith('..') || norm.split('/').includes('..')) throw new PathError('path escapes the vault');
  if (!norm.toLowerCase().endsWith('.md')) throw new PathError('only markdown notes');
  if (!isReadable(norm)) throw new PathError('path is outside what LifeOS may touch');
  return norm;
}

export function absPath(root: string, rel: string): string {
  const abs = resolve(root, safeRel(rel));
  const base = resolve(root);
  if (abs !== base && !abs.startsWith(base + sep)) throw new PathError('path escapes the vault');
  return abs;
}

export type FileKind =
  | 'daily'
  | 'weekly'
  | 'goal'
  | 'habit'
  | 'project'
  | 'reminders'
  | 'shopping'
  | 'wishlist'
  | 'links'
  | 'hadith'
  | 'favorites'
  | 'capture'
  | 'template'
  | 'lifeos'
  | 'archive'
  | 'archived-habit'
  | 'note';

export function classify(rel: string): FileKind {
  const p = rel;
  if (/^Daily Notes\/\d{4}-\d{2}-\d{2}\.md$/.test(p)) return 'daily';
  if (/^Weekly Notes\/\d{4}-W\d{2}\.md$/.test(p)) return 'weekly';
  if (/^Areas\/Goals\/[^/]+\.md$/.test(p)) return 'goal';
  if (/^Areas\/Habits\/[^/]+\.md$/.test(p)) return 'habit';
  // an archived habit keeps its log readable (Settings → Advanced → Data → Archived)
  if (/^Archive\/Habits\/[^/]+\.md$/.test(p)) return 'archived-habit';
  if (p === 'Areas/Reminders.md') return 'reminders';
  if (p === 'Areas/Lists/shopping.md') return 'shopping';
  if (p === 'Areas/Lists/wishlist.md') return 'wishlist';
  if (p === 'Resources/links.md') return 'links';
  if (p === 'Resources/hadith-library/favorites.md') return 'favorites';
  if (/^Resources\/hadith-library\/[^/]+\.md$/.test(p)) return 'hadith';
  if (/^Inbox\/Ring\//.test(p)) return 'capture';
  if (/^Templates\//.test(p)) return 'template';
  // the LifeOS project folder holds the spec and the build log, not personal tasks
  if (/^Projects\/lifeos\//.test(p)) return 'lifeos';
  if (/^Projects\/[^/]+\.md$/.test(p)) return 'project';
  if (/^Archive\//.test(p)) return 'archive';
  return 'note';
}

/** Kinds whose `- [ ]` lines are not personal tasks (templates, the spec's examples, the library). */
export const NO_TASK_KINDS: FileKind[] = ['template', 'lifeos', 'hadith', 'favorites'];

/** Kinds that are notes in Lists → Notes (spec §5.7: Inbox, Resources, Projects, Areas). */
export function isListedNote(rel: string, kind: FileKind): boolean {
  // LifeOS's own list files, goals and habits have their own tabs
  if (['template', 'lifeos', 'hadith', 'favorites', 'daily', 'weekly', 'shopping', 'wishlist', 'links', 'reminders', 'goal', 'habit'].includes(kind)) return false;
  return /^(Inbox|Resources|Projects|Areas)\//.test(rel);
}
