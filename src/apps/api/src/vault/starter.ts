/**
 * The starter notes (product brief 10 §1, ADR-91): on the first start, an empty notes folder is
 * filled from the starter vault that ships in the API image, dated today, so a NAS install needs
 * no installer. A folder with anything of its own in it is never touched, and a database that has
 * ever indexed a note never seeds again (a share that is not mounted yet looks empty too).
 *
 * The date tokens are scripts/demo-dates.mjs's (the demo vault and install.sh used it; a test keeps
 * the two in step): {{D:±n}} today ± n days, {{MON:±n}} Monday of this week + n, {{MONDAY_DAY:±n}}
 * a weekly-note day bullet ("Mon 10-19"), {{WEEK}} / {{WEEK:±n}} ISO week keys, {{YYYY}} {{MM}},
 * {{MONTH1}} the first of next month, {{README_URL}} the guide. Obsidian's own {{date:…}} stay.
 */
import { accessSync, constants, promises as fs, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { addDays, isoWeekKey, mondayOf, weekday } from '@lifeos/shared';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A starter note's text (or file name) with its date tokens for `today` (YYYY-MM-DD). */
export function starterText(s: string, today: string, readmeUrl: string): string {
  const monday = mondayOf(today);
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const month1 = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return s
    .replace(/\{\{D:([+-]\d+)\}\}/g, (_, n: string) => addDays(today, Number(n)))
    .replace(/\{\{MON:([+-]\d+)\}\}/g, (_, n: string) => addDays(monday, Number(n)))
    .replace(/\{\{MONDAY_DAY:([+-]\d+)\}\}/g, (_, n: string) => {
      const d = addDays(monday, Number(n));
      return `${DAYS[weekday(d)]} ${d.slice(5)}`;
    })
    .replace(/\{\{WEEK\}\}/g, isoWeekKey(monday))
    .replace(/\{\{WEEK:([+-]\d+)\}\}/g, (_, n: string) => isoWeekKey(addDays(monday, 7 * Number(n))))
    .replace(/\{\{YYYY\}\}/g, today.slice(0, 4))
    .replace(/\{\{MM\}\}/g, today.slice(5, 7))
    .replace(/\{\{MONTH1\}\}/g, month1)
    .replace(/\{\{README_URL\}\}/g, readmeUrl);
}

/**
 * What a NAS, a file manager or a fresh file system leaves in a folder nobody has used: still
 * empty. A Syncthing marker (.stfolder) or an Obsidian vault (.obsidian) is someone's notes
 * folder, so it is not on this list.
 */
const LITTER = new Set(['.DS_Store', '._.DS_Store', 'Thumbs.db', 'desktop.ini', '@eaDir', '#recycle', 'lost+found']);

export function isEmptyFolder(dir: string): boolean {
  return readdirSync(dir).every((name) => LITTER.has(name));
}

/**
 * Copies the starter vault into `to` with today's dates (names and contents of the .md files;
 * anything else as it is). Files are created exclusively: one that appeared meanwhile is kept and
 * skipped. Returns the number of notes written.
 */
export async function seedStarter(from: string, to: string, today: string, readmeUrl: string): Promise<number> {
  let notes = 0;
  const walk = async (src: string, dest: string) => {
    await fs.mkdir(dest, { recursive: true });
    for (const name of readdirSync(src).sort()) {
      const s = join(src, name);
      const d = join(dest, starterText(name, today, readmeUrl));
      if (statSync(s).isDirectory()) {
        await walk(s, d);
        continue;
      }
      const body = name.endsWith('.md') ? starterText(await fs.readFile(s, 'utf8'), today, readmeUrl) : await fs.readFile(s);
      try {
        await fs.writeFile(d, body, { flag: 'wx' });
        if (name.endsWith('.md')) notes++;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
  };
  await walk(from, to);
  return notes;
}

export interface VaultAccess {
  writable: boolean;
  /** the folder's owner, as the container sees it */
  owner: { uid: number; gid: number };
  /** who the API runs as (compose LIFEOS_UID / LIFEOS_GID) */
  me: { uid: number; gid: number };
}

export function vaultAccess(dir: string): VaultAccess {
  const st = statSync(dir);
  let writable = true;
  try {
    // access(2) answers for this process's user, the one that writes; a folder needs w and x
    accessSync(dir, constants.W_OK | constants.X_OK);
  } catch {
    writable = false;
  }
  return { writable, owner: { uid: st.uid, gid: st.gid }, me: { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 } };
}

/**
 * The start-up log line about the notes folder when something is off, naming the fix (product
 * brief 10 §1); null when LifeOS can write it as the folder's owner.
 */
export function vaultAccessMessage(a: VaultAccess, empty: boolean): string | null {
  const me = `${a.me.uid}:${a.me.gid}`;
  const owner = `${a.owner.uid}:${a.owner.gid}`;
  const nas = "ZimaOS: usually 1000:1000; TrueNAS: the apps user 568:568, or the dataset's owner; Unraid: 99:100";
  if (!a.writable) {
    const missing = a.owner.uid === 0 && empty ? ' It is empty and belongs to root: if LIFEOS_VAULT_HOST names a folder that did not exist, Docker made this one; check the path.' : '';
    return `notes folder: /vault (LIFEOS_VAULT_HOST) is not writable by ${me}, the user LifeOS runs as, so it cannot change your notes. Fix: set LIFEOS_UID and LIFEOS_GID in .env to the folder's owner (it belongs to ${owner}; ${nas}) and redeploy, or let ${me} write to it.${missing}`;
  }
  if (a.owner.uid !== a.me.uid && a.owner.uid !== 0)
    return `notes folder: it belongs to ${owner} but LifeOS writes as ${me}, so new notes will belong to ${me}. To keep them the owner's, set LIFEOS_UID=${a.owner.uid} and LIFEOS_GID=${a.owner.gid} in .env and redeploy.`;
  return null;
}
