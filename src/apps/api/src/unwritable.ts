/**
 * When the system refuses a write (round 8e, docs/vault-owner-brief.md, ADR-105). EACCES, EPERM or
 * EROFS from a write is never a 500: in the notes folder it is `vault_unwritable`, in LifeOS's own
 * files (the data volume, the passphrase's folder) `data_unwritable`. Both answer 507: the request
 * was fine and the server cannot store it (a 403 would read as "your credential may not do this"
 * to the web app and to Hermes). The message is one plain paragraph: who owns the folder, whom
 * LifeOS runs as, and the fix for the way it was started.
 */
import { accessSync, constants, lstatSync } from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';

export type RefusedCode = 'EACCES' | 'EPERM' | 'EROFS';
const REFUSED = new Set<string>(['EACCES', 'EPERM', 'EROFS']);
/** Calls that add or remove a folder's entries: the folder refuses them, not the entry. */
const ENTRY_CALLS = new Set(['mkdir', 'rmdir', 'rename', 'link', 'unlink', 'symlink']);

/**
 * How the API came to run as its user, as the image's entrypoint (docker/api-entry.sh) tells it in
 * LIFEOS_RUNAS: `folder` the notes folder's owner; `env` LIFEOS_UID/GID; `root-folder` 1000, the
 * folder belonging to root. Unset (`user`): compose's `user:` line started it as that user, and
 * the entrypoint changed nothing (this host's compose, or a shared compose from before round 8e).
 */
export type RunAs = 'folder' | 'env' | 'root-folder' | 'user';

export function runAsFromEnv(v = process.env.LIFEOS_RUNAS): RunAs {
  return v === 'folder' || v === 'env' || v === 'root-folder' ? v : 'user';
}

export interface Ids {
  uid: number;
  gid: number;
}

export interface Refusal {
  code: RefusedCode;
  /** the notes folder, or LifeOS's own files */
  area: 'vault' | 'data';
  /**
   * what refused, the nearest part of the path that exists: relative to the notes folder ('' is
   * the folder itself), or the container path of LifeOS's own folder
   */
  at: string;
  /** its owner (null: it could not be read) */
  owner: Ids | null;
  me: Ids;
  runAs: RunAs;
}

export interface Roots {
  /** the notes folder (/vault) */
  vault: string;
  /** LifeOS's own folders (/data, the passphrase's folder) */
  own: string[];
}

/** The notes folder and LifeOS's own folders: the data volume and the passphrase file's folder. */
export function rootsOf(c: { vault: string; data: string; authFile: string }): Roots {
  return { vault: c.vault, own: [c.data, dirname(c.authFile)] };
}

export interface UnwritableAnswer {
  status: 507;
  error: 'vault_unwritable' | 'data_unwritable';
  message: string;
}

function inside(root: string, p: string): boolean {
  const r = relative(root, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** The path, or the nearest folder above it that exists (a refused mkdir or new file is not there), with its owner. */
function nearest(root: string, p: string): { path: string; owner: Ids | null } {
  let cur = p;
  for (;;) {
    try {
      const st = lstatSync(cur);
      return { path: cur, owner: { uid: st.uid, gid: st.gid } };
    } catch {
      if (cur === root || !inside(root, cur)) return { path: root, owner: null };
      cur = dirname(cur);
    }
  }
}

/** Whether this process may add and remove a folder's entries (access(2) answers for this user). */
function canWrite(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether this process may write the folder a path is in (the nearest one that exists). */
function folderWritable(p: string): boolean {
  let dir = dirname(p);
  while (!canWrite(dir)) {
    try {
      lstatSync(dir);
      return false;
    } catch {
      if (dir === dirname(dir)) return false;
      dir = dirname(dir);
    }
  }
  return true;
}

/**
 * The refusal an error is, when it is one: EACCES, EPERM or EROFS on a path in the notes folder or
 * in LifeOS's own folders. Anything else (another error, another path) is null.
 */
export function refusalOf(err: unknown, roots: Roots, me: Ids = { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 }, runAs: RunAs = runAsFromEnv()): Refusal | null {
  const e = err as NodeJS.ErrnoException & { dest?: string };
  if (!e || typeof e !== 'object' || !REFUSED.has(String(e.code))) return null;
  // a rename or link names two paths: the one in a folder LifeOS may not write, else the destination
  const paths = [e.dest, e.path].filter((x): x is string => typeof x === 'string');
  const p = paths.length > 1 ? (paths.find((x) => !folderWritable(x)) ?? paths[0]) : paths[0];
  if (!p) return null;
  const code = e.code as RefusedCode;
  // what refuses: the folder whose entries a call changes; the file itself for an open
  const from = (root: string) => (ENTRY_CALLS.has(String(e.syscall)) && p !== root ? dirname(p) : p);
  if (inside(roots.vault, p)) {
    const n = nearest(roots.vault, from(roots.vault));
    // a part named only when it is what differs: another owner than the folder's, or a folder
    // that refuses where the notes folder itself would not (whose own entries are writable)
    const top = nearest(roots.vault, roots.vault).owner;
    const like = !!top && !!n.owner && top.uid === n.owner.uid && top.gid === n.owner.gid && !canWrite(roots.vault);
    return { code, area: 'vault', at: like ? '' : relative(roots.vault, n.path), owner: n.owner, me, runAs };
  }
  const own = roots.own.find((r) => inside(r, p));
  if (!own) return null;
  const n = nearest(own, from(own));
  return { code, area: 'data', at: n.path, owner: n.owner, me, runAs };
}

const who = (o: Ids) => (o.uid === 0 ? 'root' : `user ${o.uid}`);

/** The answer for a refusal: 507 with one plain message naming the owner, LifeOS's user and the fix. */
export function unwritableAnswer(r: Refusal): UnwritableAnswer {
  return { status: 507, error: r.area === 'vault' ? 'vault_unwritable' : 'data_unwritable', message: r.area === 'vault' ? vaultMessage(r) : dataMessage(r) };
}

function vaultMessage(r: Refusal): string {
  const head = "LifeOS can't save to your notes folder:";
  const { me, owner: o } = r;
  if (r.code === 'EROFS') return `${head} it is mounted read-only. Fix: let LifeOS write it (no :ro after the notes folder in compose.yaml; on a NAS, a share or dataset that allows writing), then restart LifeOS.`;
  const subject = r.at ? `"${r.at}" in it` : 'it';
  if (!o) return `${head} the system refused (${r.code}). Fix: let user ${me.uid}, the user LifeOS runs as, write it, then try again.`;
  if (o.uid === me.uid)
    return `${head} ${subject} belongs to user ${me.uid}, the user LifeOS runs as, but does not allow writing. Fix: let its owner write it (on the server: chmod -R u+rwX on your notes folder, or the share's permissions), then try again.`;
  const said = `${head} ${subject} belongs to ${who(o)}, LifeOS runs as ${me.uid}.`;
  if (o.uid === 0)
    return `${said} Fix: on the server, give your notes folder to the user whose notes they are (for example chown -R ${me.uid}:${me.gid}), then restart LifeOS.${r.at ? '' : ' If LIFEOS_VAULT_HOST names a folder that did not exist, Docker made this empty one: check the path.'}`;
  if (r.runAs === 'user') return `${said} Fix: set LIFEOS_UID=${o.uid} and LIFEOS_GID=${o.gid} in .env (or put ${o.uid}:${o.gid} on compose.yaml's user: line), then redeploy.`;
  if (r.runAs === 'env') return `${said} Fix: set LIFEOS_UID=${o.uid} and LIFEOS_GID=${o.gid} in .env, or remove both (LifeOS then runs as the folder's owner), then redeploy.`;
  // LifeOS runs as the folder's owner (or 1000, the folder being root's): a part of it belongs to
  // someone else, or the folder changed hands after LifeOS started
  if (!r.at) return `${said} Fix: restart LifeOS: it runs as the folder's owner, which it reads when it starts.`;
  return `${said} Fix: on the server, give "${r.at}" to user ${me.uid} like the rest (for example chown -R ${me.uid}:${me.gid} on your notes folder), then try again.`;
}

function dataMessage(r: Refusal): string {
  const head = `LifeOS can't save its own files in ${r.at}:`;
  const { me, owner: o } = r;
  if (r.code === 'EROFS') return `${head} it is mounted read-only. Fix: let LifeOS write it, then restart LifeOS.`;
  if (o && o.uid === me.uid) return `${head} it belongs to user ${me.uid}, the user LifeOS runs as, but does not allow writing. Fix: let its owner write it, then restart LifeOS.`;
  const said = `${head} ${o ? `it belongs to ${who(o)}` : `the system refused (${r.code})`}, LifeOS runs as ${me.uid}.`;
  // started as root, LifeOS makes its own folders its user's before it drops to that user
  if (r.runAs !== 'user') return `${said} Fix: restart LifeOS (it makes its own folders its user's when it starts); if that does not help, give the folder to user ${me.uid} on the server.`;
  return `${said} Fix: on the server, give the folder to user ${me.uid} (for example chown -R ${me.uid}:${me.gid}), then restart LifeOS.`;
}

/** The plain message for an error, when it is a refusal (a bulk edit lists each item's failure). */
export function refusedText(err: unknown, roots: Roots): string | null {
  const r = refusalOf(err, roots);
  return r ? unwritableAnswer(r).message : null;
}
