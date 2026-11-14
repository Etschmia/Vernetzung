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
  id: string; room_id: number; name: string; owner: string; description: string;
  agent_type: string; token_hash: string; status: string; created_at: number;
  last_seen: number | null; last_poll: number | null; poll_interval: number | null;
  session_id: string | null; session_seen: number | null;
};

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_sessions (sid_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  auth_level TEXT NOT NULL DEFAULT 'invite', password_hash TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id),
  max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id), name TEXT NOT NULL,
  owner TEXT NOT NULL, description TEXT NOT NULL, agent_type TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_seen INTEGER, last_poll INTEGER, session_id TEXT, session_seen INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS agents_room_name ON agents(room_id, name) WHERE status != 'revoked';
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id), subject TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES agents(id), created_at INTEGER NOT NULL);
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
`;

export type Core = ReturnType<typeof createCore>;

export function createCore(cfg: Config) {
  if (cfg.dbPath !== ':memory:') mkdirSync(dirname(cfg.dbPath), { recursive: true });
  const db = new DatabaseSync(cfg.dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Nachträglich hinzugekommene Spalten für bestehende Datenbanken.
  const columns = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes('poll_interval')) db.exec('ALTER TABLE agents ADD COLUMN poll_interval INTEGER');

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
    });
  };

  const baseUrl = (req: IncomingMessage): string => {
    if (cfg.publicUrl) return cfg.publicUrl.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
    return `${proto}://${req.headers.host ?? 'localhost'}`;
  };

  return { db, cfg, all, one, run, tx, waiters, wake, presence, setting, setSetting, retentionDays, cleanup, baseUrl };
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

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
