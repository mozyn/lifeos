/**
 * SQLite (ADR-2): the vault index (rebuildable from the vault at any time, ADR-1) plus the app's own
 * state (settings, sessions, drafts, jobs, reminder deliveries, outbound log, search cache, the
 * integration token's hash, the inbound log and what Hermes is offered to deliver).
 * `POST /api/index/rebuild` drops only the index tables.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

export const INDEX_TABLES = ['files', 'tasks', 'events', 'habit_logs', 'daily_entries', 'links', 'hadith', 'notes_fts'];

const INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  mtime REAL NOT NULL,
  size INTEGER NOT NULL,
  sha TEXT NOT NULL,
  title TEXT NOT NULL,
  date TEXT,
  status TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  fm TEXT NOT NULL DEFAULT '{}',
  preview TEXT NOT NULL DEFAULT '',
  lifeos TEXT,
  indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_kind ON files(kind);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  raw TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  due TEXT,
  due_inferred INTEGER NOT NULL DEFAULT 0,
  reminder TEXT,
  priority TEXT,
  recur TEXT,
  done TEXT,
  slugs TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  capture TEXT,
  section TEXT NOT NULL DEFAULT '',
  readonly INTEGER NOT NULL DEFAULT 0,
  list TEXT NOT NULL DEFAULT 'tasks',
  file_kind TEXT NOT NULL,
  parent_id TEXT,
  due_inherited INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS tasks_path ON tasks(path);
CREATE INDEX IF NOT EXISTS tasks_due ON tasks(due);
CREATE INDEX IF NOT EXISTS tasks_done ON tasks(done);
CREATE INDEX IF NOT EXISTS tasks_capture ON tasks(capture);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  raw TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_date ON events(date);
CREATE TABLE IF NOT EXISTS habit_logs (
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  date TEXT NOT NULL,
  value TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS habit_logs_path ON habit_logs(path);
CREATE TABLE IF NOT EXISTS daily_entries (
  path TEXT NOT NULL,
  date TEXT NOT NULL,
  line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS daily_entries_date ON daily_entries(date, kind);
CREATE TABLE IF NOT EXISTS links (
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  saved TEXT
);
CREATE TABLE IF NOT EXISTS hadith (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  heading TEXT NOT NULL,
  book TEXT NOT NULL,
  reference TEXT NOT NULL,
  grade TEXT,
  source TEXT,
  themes TEXT NOT NULL DEFAULT '[]',
  arabic TEXT NOT NULL,
  english TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(path UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
`;

const STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  date TEXT NOT NULL,
  ref TEXT,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  prompt TEXT,
  model TEXT,
  prompt_tokens INTEGER,
  sources TEXT NOT NULL DEFAULT '[]',
  generated_at TEXT NOT NULL,
  fallback INTEGER NOT NULL DEFAULT 0,
  fallback_reason TEXT,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS drafts_kind_date ON drafts(kind, date, status);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  error TEXT,
  draft_id TEXT,
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);
CREATE TABLE IF NOT EXISTS deliveries (
  key TEXT PRIMARY KEY,
  task_id TEXT,
  path TEXT NOT NULL,
  fire_at TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  sent_at TEXT,
  error TEXT,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'task'
);
CREATE INDEX IF NOT EXISTS deliveries_status ON deliveries(status);
CREATE TABLE IF NOT EXISTS outbound_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  host TEXT NOT NULL,
  purpose TEXT NOT NULL,
  method TEXT NOT NULL,
  bytes_out INTEGER NOT NULL,
  bytes_in INTEGER NOT NULL,
  status INTEGER,
  ok INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  refused INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS search_cache (query TEXT PRIMARY KEY, results TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS search_drops (query TEXT NOT NULL, url TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (query, url));
CREATE TABLE IF NOT EXISTS search_engines (
  engine TEXT PRIMARY KEY,
  dropped_until TEXT,
  dropped_reason TEXT,
  last_at TEXT,
  last_total INTEGER,
  last_failed INTEGER,
  last_error TEXT,
  searches INTEGER NOT NULL DEFAULT 0,
  results INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hadith_shown (entry_id TEXT NOT NULL, date TEXT NOT NULL, context TEXT NOT NULL, PRIMARY KEY (entry_id, date, context));
CREATE TABLE IF NOT EXISTS created_files (path TEXT PRIMARY KEY, sha TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nudges (habit TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (habit, date));
CREATE TABLE IF NOT EXISTS deleted_lines (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  idx INTEGER NOT NULL,
  lines TEXT NOT NULL,
  before_text TEXT,
  after_text TEXT,
  section TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  at TEXT NOT NULL,
  restored_at TEXT
);
CREATE INDEX IF NOT EXISTS deleted_lines_at ON deleted_lines(at);
CREATE TABLE IF NOT EXISTS archive_log (
  path TEXT PRIMARY KEY,
  original TEXT NOT NULL,
  prev_status TEXT,
  kind TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS index_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, ms INTEGER NOT NULL, files INTEGER NOT NULL, tasks INTEGER NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS integration_tokens (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  last_model TEXT,
  last_reminders_at TEXT
);
CREATE TABLE IF NOT EXISTS inbound_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  who TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  bytes_in INTEGER NOT NULL,
  bytes_out INTEGER NOT NULL,
  ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hermes_outbox (
  key TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  ref TEXT,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  link TEXT NOT NULL,
  fire_at TEXT,
  due_at TEXT NOT NULL,
  listed_at TEXT,
  acked_at TEXT
);
CREATE INDEX IF NOT EXISTS hermes_outbox_due ON hermes_outbox(due_at);
`;

/**
 * Columns added to state tables after their first release (`CREATE TABLE IF NOT EXISTS` keeps an
 * older table as it was): added in place, data kept.
 *   drafts.via  'hermes' when Hermes writes the draft through the integration API (ADR-86)
 *   drafts.ids  the short ids of the prompts given to Hermes (T1 → task id, C1 → capture path)
 *   hermes_outbox.listed_at  when Hermes first fetched an item (LifeOS's own bot holds off then)
 */
const ADDED_COLUMNS: [table: string, column: string, decl: string][] = [
  ['drafts', 'via', 'TEXT'],
  ['drafts', 'ids', 'TEXT'],
  ['hermes_outbox', 'listed_at', 'TEXT'],
];

/**
 * The index's schema version. When it changes (a new column, round-2 brief §10's `parent_id`), the
 * index tables are dropped and recreated before use: they are rebuilt from the vault at every start
 * anyway (ADR-1), while `CREATE TABLE IF NOT EXISTS` would keep an old table without the column.
 */
export const INDEX_VERSION = 2;

export function openDb(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(STATE_SCHEMA);
  for (const [table, column, decl] of ADDED_COLUMNS) {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
  const row = db.prepare("SELECT value FROM settings WHERE key = 'index_version'").get() as { value: string } | undefined;
  if (Number(row?.value ?? 0) !== INDEX_VERSION) {
    db.transaction(() => {
      for (const t of INDEX_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
      db.prepare("INSERT INTO settings (key, value) VALUES ('index_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(INDEX_VERSION));
    })();
  }
  db.exec(INDEX_SCHEMA);
  return db;
}

/** Drop and recreate the index tables (app state is kept). */
export function resetIndex(db: DB): void {
  const tx = db.transaction(() => {
    for (const t of INDEX_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    db.exec(INDEX_SCHEMA);
  });
  tx();
}

export function getSetting<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(db: DB, key: string, value: unknown): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

export const nowIso = (): string => new Date().toISOString();
