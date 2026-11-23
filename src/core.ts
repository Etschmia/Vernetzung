// Gemeinsamer Kern: Datenbank, Schema und Hilfsfunktionen für API und GUI.
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Config = {
  dbPath: string;
  adminPassword?: string;
  publicUrl?: string;
  /** Adressen vorgeschalteter Proxys, deren X-Forwarded-For gilt. Derselbe Rechner gilt immer. */
  trustedProxies?: string[];
  log?: (line: string) => void;
};

export type Room = {
  id: number; slug: string; title: string; auth_level: string;
  password_hash: string | null; created_at: number;
};

export type Agent = {
  id: string; room_id: number | null; person_id: number | null; name: string; owner: string; description: string;
  agent_type: string; token_hash: string; status: string; created_at: number;
  last_seen: number | null; last_poll: number | null; poll_interval: number | null;
  session_id: string | null; session_seen: number | null;
};

export type Person = { id: number; slug: string; name: string; created_at: number };

export const LISTENING_MS = 90_000;
export const RECENT_MS = 30 * 60_000;
export const SESSION_BUSY_MS = 120_000;
export const MAX_BODY_BYTES = 32 * 1024;
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_THREAD_MEMBERS = 8;
export const SEND_LIMIT_PER_MINUTE = 30;
export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
export const AUTH_LEVELS = ['open', 'invite', 'approval'];

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const iso = (ms: number | null) =>
  ms == null ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const newId = (prefix: string, bytes = 12) => prefix + randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 32).toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [, saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

export const safeEqual = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));

// Agenten und Threads stehen als Funktion da, weil die Migration sie unter anderem Namen neu aufbaut.
const AGENTS_COLUMNS = 'id, room_id, name, owner, description, agent_type, token_hash, status, created_at, last_seen, last_poll, poll_interval, session_id, session_seen';
const AGENTS_TABLE = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY, room_id INTEGER REFERENCES rooms(id), person_id INTEGER REFERENCES persons(id), name TEXT NOT NULL,
  owner TEXT NOT NULL, description TEXT NOT NULL, agent_type TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_seen INTEGER, last_poll INTEGER, poll_interval INTEGER, session_id TEXT, session_seen INTEGER);`;
const THREADS_COLUMNS = 'id, room_id, subject, created_by, created_at';
const THREADS_TABLE = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY, room_id INTEGER REFERENCES rooms(id), subject TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES agents(id), created_at INTEGER NOT NULL);`;
export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_sessions (sid_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mcp_sessions (sid_hash TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  auth_level TEXT NOT NULL DEFAULT 'invite', password_hash TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id),
  max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS persons (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL);
${AGENTS_TABLE('agents')}
CREATE UNIQUE INDEX IF NOT EXISTS agents_room_name ON agents(room_id, name) WHERE status != 'revoked';
CREATE UNIQUE INDEX IF NOT EXISTS agents_person_name ON agents(person_id, name) WHERE person_id IS NOT NULL AND status != 'revoked';
-- Freigabe: Die Agenten der Person sehen und erreichen diesen Agenten.
CREATE TABLE IF NOT EXISTS shares (
  agent_id TEXT NOT NULL REFERENCES agents(id), person_id INTEGER NOT NULL REFERENCES persons(id),
  created_at INTEGER NOT NULL, PRIMARY KEY (agent_id, person_id));
CREATE INDEX IF NOT EXISTS shares_person ON shares(person_id);
${THREADS_TABLE('threads')}
CREATE TABLE IF NOT EXISTS thread_members (
  thread_id TEXT NOT NULL REFERENCES threads(id), agent_id TEXT NOT NULL REFERENCES agents(id),
  PRIMARY KEY (thread_id, agent_id));
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL REFERENCES threads(id), from_agent TEXT NOT NULL REFERENCES agents(id),
  body TEXT NOT NULL, sent_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, seq);
CREATE TABLE IF NOT EXISTS deliveries (
  message_seq INTEGER NOT NULL REFERENCES messages(seq), agent_id TEXT NOT NULL REFERENCES agents(id),
  acked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (agent_id, message_seq));
-- Verbindungen (docs/PROTOKOLL-VERBINDUNGEN.md): getrennt von Räumen und Agenten. Der Hub kennt
-- weder Namen noch Inhalte, nur Plätze (Token-Hashes) und Chiffrat.
CREATE TABLE IF NOT EXISTS link_keys (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
  links_max INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY, key_id TEXT NOT NULL REFERENCES link_keys(id), seats INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1, seq INTEGER NOT NULL DEFAULT 0,
  join_hash TEXT, invite_by TEXT, invite_expires_at INTEGER,
  created_at INTEGER NOT NULL, last_activity INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS link_members (
  id TEXT PRIMARY KEY, link_id TEXT NOT NULL REFERENCES links(id), token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL, reason TEXT, hello TEXT, welcome TEXT,
  joined_seq INTEGER NOT NULL DEFAULT 0, acked_seq INTEGER NOT NULL DEFAULT 0,
  lost_from INTEGER, lost_to INTEGER,
  last_poll INTEGER, created_at INTEGER NOT NULL, changed_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS link_members_link ON link_members(link_id);
CREATE TABLE IF NOT EXISTS link_messages (
  link_id TEXT NOT NULL REFERENCES links(id), seq INTEGER NOT NULL, from_member TEXT NOT NULL,
  box TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY (link_id, seq));
`;

// Bringt eine bestehende Datenbank auf den aktuellen Stand. Eine neue Datenbank braucht das nicht.
function migrate(db: DatabaseSync, cfg: Config) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agents'").get()) return;
  const columns = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes('poll_interval')) db.exec('ALTER TABLE agents ADD COLUMN poll_interval INTEGER');
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version >= 1) return;

  // Version 1: Personen und Freigaben. Agenten und Threads brauchen keinen Raum mehr; SQLite löst ein
  // NOT NULL nur durch Neuaufbau der Tabelle. Vorher eine Kopie der Datenbank daneben legen.
  if (cfg.dbPath !== ':memory:') {
    const backup = `${cfg.dbPath}.vor-v1-${Date.now()}.bak`;
    db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    cfg.log?.(`Datenbank wird auf Version 1 gebracht. Sicherungskopie: ${backup}`);
  }
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS persons (
      id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    for (const [table, create, cols] of [['agents', AGENTS_TABLE, AGENTS_COLUMNS], ['threads', THREADS_TABLE, THREADS_COLUMNS]] as const) {
      db.exec(create(`${table}_new`));
      db.exec(`INSERT INTO ${table}_new (${cols}) SELECT ${cols} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Migration: Fremdschlüssel verletzt.');
    db.exec('PRAGMA user_version = 1');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export type Core = ReturnType<typeof createCore>;

export function createCore(cfg: Config) {
  if (cfg.dbPath !== ':memory:') mkdirSync(dirname(cfg.dbPath), { recursive: true });
  const db = new DatabaseSync(cfg.dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db, cfg);
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  const cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  type P = string | number | null;
  const all = <T>(sql: string, ...p: P[]) => stmt(sql).all(...p) as T[];
  const one = <T>(sql: string, ...p: P[]) => stmt(sql).get(...p) as T | undefined;
  const run = (sql: string, ...p: P[]) => Number(stmt(sql).run(...p).changes);
  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  // Wartende Long-Polls je Agent. Der Grund sagt dem Wartenden, warum er geweckt wurde.
  const waiters = new Map<string, Set<(reason: string) => void>>();
  const wake = (agentId: string, reason: string) => {
    for (const done of [...(waiters.get(agentId) ?? [])]) done(reason);
  };

  // listening: wartet gerade oder fragt in dichter Folge ab. polling: fragt nach angemeldetem
  // Rhythmus ab und ist nicht überfällig (doppeltes Intervall plus 30 Sekunden Spielraum).
  const presence = (a: Pick<Agent, 'id' | 'last_seen' | 'last_poll' | 'poll_interval'>): string => {
    const now = Date.now();
    if (waiters.get(a.id)?.size) return 'listening';
    if (a.poll_interval && a.last_poll != null) {
      if (now - a.last_poll < a.poll_interval * 2000 + 30_000) return 'polling';
    } else if (a.last_poll != null && now - a.last_poll < LISTENING_MS) return 'listening';
    if (a.last_seen != null && now - a.last_seen < RECENT_MS) return 'recent';
    return 'offline';
  };

  const setting = (key: string) => one<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value;
  const setSetting = (key: string, value: string) =>
    run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);

  const retentionDays = () => Number(setting('retention_days') ?? 90);
  const cleanup = () => {
    const cutoff = Date.now() - retentionDays() * 86_400_000;
    tx(() => {
      run('DELETE FROM deliveries WHERE message_seq IN (SELECT seq FROM messages WHERE sent_at < ?)', cutoff);
      run('DELETE FROM messages WHERE sent_at < ?', cutoff);
      run('DELETE FROM thread_members WHERE thread_id NOT IN (SELECT DISTINCT thread_id FROM messages)');
      run('DELETE FROM threads WHERE id NOT IN (SELECT DISTINCT thread_id FROM messages)');
      // MCP-Bindungen, deren Sitzung beendet oder abgelöst wurde.
      run('DELETE FROM mcp_sessions WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = agent_id AND a.session_id = mcp_sessions.session_id)');
    });
  };

  const baseUrl = (req: IncomingMessage): string => {
    if (cfg.publicUrl) return cfg.publicUrl.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
    return `${proto}://${req.headers.host ?? 'localhost'}`;
  };

  // X-Forwarded-For zählt nur, wenn die Anfrage von einem bekannten Proxy kommt (derselbe Rechner oder Konfiguration).
  const clientAddress = (req: IncomingMessage): string => {
    const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    const trusted = peer === '127.0.0.1' || peer === '::1' || (cfg.trustedProxies ?? []).includes(peer);
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean).pop();
    return trusted && forwarded ? forwarded : peer;
  };

  return {
    db, cfg, all, one, run, tx, waiters, wake, presence, setting, setSetting, retentionDays, cleanup, baseUrl,
    clientAddress,
  };
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new HttpError(413, 'body_too_large', 'Die Anfrage ist zu groß.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Liest den Rumpf als JSON-Objekt; ein leerer Rumpf ergibt {}.
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'json_invalid', 'Der Anfragetext ist kein gültiges JSON.');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw new HttpError(400, 'json_invalid', 'Der Anfragetext muss ein JSON-Objekt sein.');
  return body as Record<string, unknown>;
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
