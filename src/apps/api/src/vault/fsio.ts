/**
 * Atomic, concurrency-aware file writes into the vault (spec §5, ADR-15).
 *
 * Every write re-reads the file, applies a line-level transform to what is on disk *now*, writes a
 * temp file in the same directory and renames it over the note. The temp name matches the vault's
 * Syncthing ignore rule (`.pb-*.tmp`) and is a dotfile, so neither Syncthing nor Obsidian picks it
 * up half-written. The other writers (the ring pipeline, Obsidian via Syncthing) are handled so
 * neither side loses a change:
 *
 *  1. Replaced or rewritten under us (another temp+rename, a truncation, an in-place edit of bytes
 *     we read): detected before our rename by inode, size and prefix; the whole
 *     read-transform-write runs again on the new content (jittered retries).
 *  2. Appended to (a writer adding lines at the end): safe. We rename, then read the appended tail
 *     from the old inode, still held open, and splice it in right after our content, so it keeps
 *     its place and order. Late appends are picked up for a few milliseconds after the rename.
 *  3. Mode is preserved; the container runs as the vault owner (uid 1000), so ownership is too.
 *
 * Creation uses link(2) so it can never clobber a note someone else created a moment earlier.
 */
import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { joinLines, type RawLine, splitLines } from '@lifeos/shared';

export class WriteConflict extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface MutateResult {
  before: string | null;
  after: string;
  created: boolean;
  changed: boolean;
  retries: number;
  /** bytes another writer appended to the old file during the write and that were carried over */
  carried: number;
}

/** The transform: current lines (null = no such file) → new lines, or null to leave the file alone. */
export type Transform = (lines: RawLine[] | null) => RawLine[] | null;

export interface MutateOptions {
  /** directories are created for a new file */
  mkdirs?: boolean;
  /** test hook: runs after the pre-rename check, before the rename */
  beforeRename?: () => Promise<void> | void;
}

const MAX_ATTEMPTS = 12;
const tmpName = (abs: string) => join(dirname(abs), `.pb-lifeos-${process.pid}-${randomBytes(5).toString('hex')}.tmp`);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function writeTemp(path: string, data: string, mode: number): Promise<void> {
  const fh = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.chmod(path, mode).catch(() => undefined);
}

async function readRange(fh: fs.FileHandle, from: number, to: number): Promise<Buffer> {
  const b = Buffer.alloc(Math.max(0, to - from));
  let off = 0;
  while (off < b.length) {
    const { bytesRead } = await fh.read(b, off, b.length - off, from + off);
    if (!bytesRead) break;
    off += bytesRead;
  }
  return b.subarray(0, off);
}

export async function mutateFile(abs: string, transform: Transform, opts: MutateOptions = {}): Promise<MutateResult> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await pause(2 + Math.random() * 6 * attempt);
    let fh: fs.FileHandle | null = null;
    try {
      fh = await fs.open(abs, constants.O_RDONLY);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (!fh) {
      if (opts.mkdirs) await fs.mkdir(dirname(abs), { recursive: true });
      const next = transform(null);
      if (!next) return { before: null, after: '', created: false, changed: false, retries: attempt, carried: 0 };
      const data = joinLines(next);
      const tmp = tmpName(abs);
      await writeTemp(tmp, data, 0o664);
      try {
        await fs.link(tmp, abs); // fails if the note appeared meanwhile: then edit it instead
        return { before: null, after: data, created: true, changed: true, retries: attempt, carried: 0 };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw e;
      } finally {
        await fs.unlink(tmp).catch(() => undefined);
      }
    }
    let tmp: string | null = null;
    try {
      const st0 = await fh.stat({ bigint: true });
      const buf = await readRange(fh, 0, Number(st0.size));
      const before = buf.toString('utf8');
      const next = transform(splitLines(before));
      if (!next) return { before, after: before, created: false, changed: false, retries: attempt, carried: 0 };
      const data = joinLines(next);
      if (data === before) return { before, after: before, created: false, changed: false, retries: attempt, carried: 0 };
      tmp = tmpName(abs);
      await writeTemp(tmp, data, Number(st0.mode & 0o7777n));
      // what is at the path now: still our inode, and still starting with exactly what we read?
      let st1;
      try {
        st1 = await fs.stat(abs, { bigint: true });
      } catch {
        continue; // deleted under us
      }
      if (st1.ino !== st0.ino || st1.size < st0.size) continue;
      if (!(await readRange(fh, 0, buf.length)).equals(buf)) continue;
      await opts.beforeRename?.();
      await fs.rename(tmp, abs);
      tmp = null;
      // whatever was appended to the old inode is spliced in after our content
      let carried = 0;
      let seen = Number(st0.size);
      let after = data;
      for (let round = 0; round < 3; round++) {
        if (round) await pause(3);
        const st2 = await fh.stat({ bigint: true });
        if (Number(st2.size) <= seen) continue;
        const extra = (await readRange(fh, seen, Number(st2.size))).toString('utf8');
        seen = Number(st2.size);
        if (!extra) continue;
        carried += Buffer.byteLength(extra);
        after = await spliceAfter(abs, after, extra);
      }
      return { before, after, created: false, changed: true, retries: attempt, carried };
    } finally {
      if (tmp) await fs.unlink(tmp).catch(() => undefined);
      await fh.close();
    }
  }
  throw new WriteConflict(`${basename(abs)} kept changing while LifeOS tried to write it`);
}

/** Insert `extra` right after `ours` at the start of the file (anything appended since stays after it). */
async function spliceAfter(abs: string, ours: string, extra: string): Promise<string> {
  let result = ours + extra;
  await mutateFile(abs, (lines) => {
    if (!lines) return null;
    const cur = joinLines(lines);
    if (!cur.startsWith(ours)) {
      // someone rewrote the file since our rename: keep their content and add the tail at the end
      if (cur.includes(extra)) return null;
      result = cur + extra;
      return splitLines(result);
    }
    result = ours + extra + cur.slice(ours.length);
    return splitLines(result);
  });
  return result;
}

export async function readText(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
