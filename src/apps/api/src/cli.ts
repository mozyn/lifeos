/**
 * Operator commands, run inside the API container (docker exec lifeos-api node apps/api/dist/cli.js …):
 *   send-test     one labelled Telegram test message to the reminder topic (spec §15 M3)
 *   reindex       rebuild the index from the vault (same as POST /api/index/rebuild)
 *   outbound [n]  the last n outbound calls (host, purpose, bytes; never bodies)
 *   vapid-keys    a new VAPID key pair as two env lines (for a .env.push of one's own, mode 600)
 *   push-key      where this install's browser-notification keys come from (env | stored | none)
 *                 and the public key; never the private one
 * Secrets stay in the container's environment; nothing here prints them.
 *
 * `docker exec` runs it as root when compose has no `user:` line (the shared compose, ADR-105): it
 * then runs itself again as the API's user (the owner the entrypoint gave /data), so a file it
 * writes (the database's journal) is never root's.
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { instantText } from '@lifeos/shared';
import { loadConfig } from './config.js';
import { resolveAddress } from './address.js';
import { getSetting, openDb } from './db.js';
import { Egress, installSocketGuard } from './egress.js';
import { TelegramSender } from './telegram.js';
import { generateVapidKeys, isVapidKeys } from './push.js';
import { BrowserPush } from './browser-push.js';
import { Vault } from './vault/vault.js';

if (process.getuid?.() === 0) {
  const data = process.env.LIFEOS_DATA || '/data';
  let id = { uid: 1000, gid: 1000 };
  try {
    const st = statSync(data);
    if (st.uid !== 0) id = { uid: st.uid, gid: st.gid || st.uid };
  } catch {
    /* no data folder: 1000, as the API would */
  }
  const r = spawnSync('setpriv', [`--reuid=${id.uid}`, `--regid=${id.gid}`, '--clear-groups', '--no-new-privs', process.execPath, ...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const [cmd, arg] = process.argv.slice(2);
// install.sh's key pair: printed for its mode-600 file, before any database is opened
if (cmd === 'vapid-keys') {
  const k = generateVapidKeys();
  console.log(`LIFEOS_VAPID_PUBLIC_KEY=${k.publicKey}\nLIFEOS_VAPID_PRIVATE_KEY=${k.privateKey}`);
  process.exit(0);
}
const config = loadConfig();
const db = openDb(join(config.data, 'lifeos.db'));
const egress = new Egress(db);
installSocketGuard(egress);

try {
  if (cmd === 'send-test') {
    const sender = new TelegramSender(egress, config.bot);
    if (!sender.configured) throw new Error('Telegram is not configured in this container.');
    // the owner's zone once the first-run step chose a place (ADR-77), else TZ
    const tz = getSetting<{ prayer?: { tz?: string } }>(db, 'app', {}).prayer?.tz || config.tz;
    const when = instantText(new Date(), { tz, year: true });
    // the app's address: LIFEOS_PUBLIC_URL, else the one the API learned or was given (ADR-104)
    const url = resolveAddress(config, db).url;
    const r = await sender.send(`🧪 LifeOS test message (${when}). This is a delivery check from the LifeOS build, not a reminder: reminders will arrive in this topic. You can ignore it.${url ? `\n${url}/today` : ''}`);
    console.log(`sent: message ${r.messageId ?? '?'} to the reminder topic`);
  } else if (cmd === 'reindex') {
    const r = await new Vault(config.vault, db).fullScan('cli');
    console.log(`indexed ${r.files} notes, ${r.tasks} tasks in ${r.ms} ms`);
  } else if (cmd === 'push-key') {
    // read only: the keys the API made on its first start, or .env.push's; nothing is made here
    const push = new BrowserPush(db, async () => new Response(null), config.vapid);
    const source = push.keySource === 'env' ? 'env' : isVapidKeys(getSetting<unknown>(db, 'vapid', null)) ? 'stored' : null;
    console.log(source ? `${source} ${push.keys().publicKey}` : 'none');
  } else if (cmd === 'outbound') {
    for (const r of db.prepare('SELECT at, host, purpose, method, bytes_out, bytes_in, status, refused FROM outbound_log ORDER BY id DESC LIMIT ?').all(Number(arg ?? 10))) console.log(JSON.stringify(r));
  } else {
    console.log('usage: cli.js send-test | reindex | outbound [n] | vapid-keys | push-key');
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  // let the outbound log's last write land
  await new Promise((r) => setTimeout(r, 300));
  db.close();
}
