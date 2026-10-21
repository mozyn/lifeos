/**
 * Operator commands, run inside the API container (docker exec lifeos-api node apps/api/dist/cli.js …):
 *   send-test     one labelled Telegram test message to the reminder topic (spec §15 M3)
 *   reindex       rebuild the index from the vault (same as POST /api/index/rebuild)
 *   outbound [n]  the last n outbound calls (host, purpose, bytes; never bodies)
 *   vapid-keys    a new VAPID key pair as two env lines (for a .env.push of one's own, mode 600)
 *   push-key      where this install's browser-notification keys come from (env | stored | none)
 *                 and the public key; never the private one
 * Secrets stay in the container's environment; nothing here prints them.
 */
import { join } from 'node:path';
import { instantText } from '@lifeos/shared';
import { loadConfig } from './config.js';
import { getSetting, openDb } from './db.js';
import { Egress, installSocketGuard } from './egress.js';
import { TelegramSender } from './telegram.js';
import { generateVapidKeys, isVapidKeys } from './push.js';
import { BrowserPush } from './browser-push.js';
import { Vault } from './vault/vault.js';

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
    const r = await sender.send(`🧪 LifeOS test message (${when}). This is a delivery check from the LifeOS build, not a reminder: reminders will arrive in this topic. You can ignore it.\n${config.publicUrl}/today`);
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
