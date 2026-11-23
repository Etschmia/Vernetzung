// Personen und Freigaben: Sichtbarkeit je Person, Entzug, Migration bestehender Datenbanken.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { createHub } from '../src/hub.ts';
import { sha256 } from '../src/core.ts';

const hub = createHub({ dbPath: ':memory:', adminPassword: 'geheim-geheim', log: () => {} });
const server = createServer(hub.handler);
let base = '';
let cookie = '';

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ok = await fetch(`${base}/admin/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ password: 'geheim-geheim' }) });
  cookie = ok.headers.get('set-cookie')!.split(';')[0];
});
after(() => {
  hub.close();
  server.close();
  server.closeAllConnections();
});

type Who = { token: string; session?: string; id: string };
const callAt = (at: string) => async (method: string, path: string, who?: { token: string; session?: string }, body?: unknown) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${who.token}`;
  if (who?.session) headers['X-Vernetzung-Session'] = who.session;
  const r = await fetch(`${at}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json()) as any };
};
const call: ReturnType<typeof callAt> = (...args) => callAt(base)(...args);
const adminPost = (path: string, form: Record<string, string> | [string, string][]) =>
  fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
const adminGet = async (path: string) => (await fetch(`${base}${path}`, { headers: { Cookie: cookie } })).text();

// Legt einen Agenten in einem Raum an und meldet ihn an.
const join = async (room: string, name: string): Promise<Who> => {
  if (!hub.core.one('SELECT 1 FROM rooms WHERE slug = ?', room)) await adminPost('/admin/rooms', { slug: room, title: room });
  await adminPost(`/admin/room/${room}/invites`, { max_uses: '1', days: '1' });
  const invite = hub.core.one<{ code: string }>(
    'SELECT code FROM invites i JOIN rooms r ON r.id = i.room_id WHERE r.slug = ? AND uses = 0 ORDER BY i.rowid DESC', room)!.code;
  const reg = await call('POST', '/register', undefined, { room, invite, name, owner: 'Test', description: 'Testagent', agent_type: 'test' });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  const who: Who = { token: reg.json.token, id: reg.json.agent_id };
  who.session = (await call('POST', '/session', who, {})).json.session;
  return who;
};
const person = async (slug: string, name: string) =>
  assert.equal((await adminPost('/admin/persons', { slug, name })).status, 303);
const assign = async (slug: string, who: Who) =>
  assert.equal((await adminPost(`/admin/person/${slug}/assign`, { id: who.id })).status, 303);
const share = async (slug: string, agents: Who[]) =>
  assert.equal((await adminPost(`/admin/person/${slug}/shares`, agents.map((a) => ['agent', a.id] as [string, string]))).status, 303);
const names = async (who: Who) => ((await call('GET', '/agents', who)).json.agents as { name: string }[]).map((a) => a.name).sort();

let backend: Who, geheim: Who, andrea: Who, bernd: Who;

test('Freigabe je Person: sichtbar sind genau die freigegebenen und die eigenen Agenten', async () => {
  await person('tobias', 'Tobias Brendler');
  await person('andrea', 'Andrea Beispiel');
  await person('bernd', 'Bernd Muster');
  backend = await join('but2', 'but2-backend');
  geheim = await join('but2', 'but2-geheim');
  andrea = await join('raum-andrea', 'andrea-claude');
  bernd = await join('raum-bernd', 'bernd-claude');
  await assign('tobias', backend);
  await assign('tobias', geheim);
  await assign('andrea', andrea);
  await assign('bernd', bernd);
  assert.deepEqual(await names(andrea), ['andrea-claude']);

  await share('andrea', [backend]);
  assert.deepEqual(await names(andrea), ['andrea-claude', 'but2-backend']);
  const list = await call('GET', '/agents', andrea);
  assert.equal(list.json.person, 'andrea');
  assert.equal(list.json.agents.find((a: any) => a.name === 'but2-backend').agent_id, backend.id);

  // Nicht freigegeben und unbekannt sind nicht zu unterscheiden: gleicher Status, gleicher Code, gleicher Text.
  const hidden = await call('POST', '/messages', andrea, { to: ['but2-geheim'], body: 'x' });
  const unknown = await call('POST', '/messages', andrea, { to: ['gibt-es-nicht'], body: 'x' });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.json.error.code, 'recipient_unknown');
  assert.equal(unknown.status, hidden.status);
  assert.equal(unknown.json.error.code, hidden.json.error.code);
  assert.equal(hidden.json.error.message.replace('but2-geheim', 'X'), unknown.json.error.message.replace('gibt-es-nicht', 'X'));
  assert.equal((await call('POST', '/messages', andrea, { to: [geheim.id], body: 'x' })).json.error.code, 'recipient_unknown');
});

test('Freigegebener Agent bekommt die Nachricht und antwortet im Gespräch, ohne die Gegenseite zu sehen', async () => {
  const sent = await call('POST', '/messages', andrea, { to: ['but2-backend'], subject: 'Schnittstelle X', body: 'Wie ist X gedacht?' });
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  const inbox = (await call('GET', '/inbox', backend)).json.messages;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].from, 'andrea-claude');
  assert.equal(inbox[0].from_id, andrea.id);
  assert.equal(inbox[0].from_owner, 'Test');
  // Die Freigabe ist gerichtet: Tobias' Agent sieht Andreas Agenten nicht in der Liste, kann aber antworten.
  assert.ok(!(await names(backend)).includes('andrea-claude'));
  assert.equal((await call('POST', '/messages', backend, { to: ['andrea-claude'], body: 'x' })).json.error.code, 'recipient_unknown');
  const reply = await call('POST', '/messages', backend, { thread_id: sent.json.thread_id, body: 'So ist X gedacht.' });
  assert.equal(reply.status, 201, JSON.stringify(reply.json));
  assert.equal((await call('GET', '/inbox', andrea)).json.messages[0].body, 'So ist X gedacht.');
  // Per agent_id lässt sich ebenfalls adressieren.
  assert.equal((await call('POST', '/messages', andrea, { to: [backend.id], body: 'per id' })).status, 201);
});

test('Ein Agent, zwei Personen: eine agent_id, ein Postfach', async () => {
  await share('bernd', [backend]);
  const viaAndrea = (await call('GET', '/agents', andrea)).json.agents.find((a: any) => a.name === 'but2-backend');
  const viaBernd = (await call('GET', '/agents', bernd)).json.agents.find((a: any) => a.name === 'but2-backend');
  assert.equal(viaAndrea.agent_id, backend.id);
  assert.equal(viaBernd.agent_id, backend.id);
  assert.equal(hub.core.one<{ n: number }>("SELECT COUNT(*) AS n FROM agents WHERE name = 'but2-backend'")!.n, 1);
  // Andrea und Bernd sehen einander nicht.
  assert.deepEqual(await names(bernd), ['bernd-claude', 'but2-backend']);

  const before = (await call('GET', '/inbox', backend)).json.messages.length;
  await call('POST', '/messages', andrea, { to: ['but2-backend'], body: 'von Andrea' });
  await call('POST', '/messages', bernd, { to: ['but2-backend'], body: 'von Bernd' });
  const bodies = (await call('GET', '/inbox', backend)).json.messages.map((m: any) => m.body);
  assert.equal(bodies.length, before + 2);
  assert.ok(bodies.includes('von Andrea') && bodies.includes('von Bernd'));
});

test('Entzug wirkt ab dem nächsten Aufruf: Agent verschwindet, neue Nachrichten werden abgelehnt', async () => {
  const thread = (await call('POST', '/messages', andrea, { to: ['but2-backend'], body: 'vor dem Entzug' })).json.thread_id;
  await share('andrea', []);
  assert.deepEqual(await names(andrea), ['andrea-claude']);
  assert.equal((await call('POST', '/messages', andrea, { to: ['but2-backend'], body: 'x' })).json.error.code, 'recipient_unknown');
  assert.equal((await call('POST', '/messages', andrea, { to: [backend.id], body: 'x' })).json.error.code, 'recipient_unknown');
  // Auch im bestehenden Gespräch, und zwar in beiden Richtungen.
  assert.equal((await call('POST', '/messages', andrea, { thread_id: thread, body: 'x' })).json.error.code, 'recipient_unknown');
  assert.equal((await call('POST', '/messages', backend, { thread_id: thread, body: 'x' })).json.error.code, 'recipient_unknown');
  // Bernds Freigabe ist davon unberührt.
  assert.deepEqual(await names(bernd), ['bernd-claude', 'but2-backend']);
  assert.equal((await call('POST', '/messages', bernd, { to: ['but2-backend'], body: 'geht noch' })).status, 201);
});

test('Gleicher Kurzname in der eigenen Sicht: recipient_ambiguous, die agent_id löst es auf', async () => {
  const doppel = await join('raum-andrea', 'but2-backend');
  await share('andrea', [backend]);
  const r = await call('POST', '/messages', andrea, { to: ['but2-backend'], body: 'x' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'recipient_ambiguous');
  assert.equal((await call('POST', '/messages', andrea, { to: [backend.id], body: 'x' })).status, 201);
  await adminPost('/admin/room/raum-andrea/agent', { id: doppel.id, action: 'revoke' });
  assert.equal((await call('POST', '/messages', andrea, { to: ['but2-backend'], body: 'x' })).status, 201);
});

test('GUI: Personenseite zeigt eigene Agenten und Freigaben; Zuordnung prüft den Kurznamen', async () => {
  const page = await adminGet('/admin/person/andrea');
  assert.match(page, /Andrea Beispiel/);
  assert.match(page, new RegExp(`value="${backend.id}" checked`));
  assert.match(page, new RegExp(`value="${geheim.id}">`));
  assert.match(await adminGet('/admin/persons'), /Tobias Brendler/);
  // Ein Widerruf nimmt die Freigaben des Agenten mit.
  const kurz = await join('but2', 'but2-kurz');
  await share('bernd', [backend, kurz]);
  await adminPost('/admin/room/but2/agent', { id: kurz.id, action: 'revoke' });
  assert.equal(hub.core.one('SELECT 1 FROM shares WHERE agent_id = ?', kurz.id), undefined);
  assert.equal((await adminPost('/admin/persons', { slug: 'andrea', name: 'Doppelt' })).status, 400);
});

// Schema vor Version 1, wie es ein Hub bis November 2026 angelegt hat (ohne poll_interval: die Spalte kam per ALTER).
const OLD_SCHEMA = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE admin_sessions (sid_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE mcp_sessions (sid_hash TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT NOT NULL);
CREATE TABLE rooms (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  auth_level TEXT NOT NULL DEFAULT 'invite', password_hash TEXT, created_at INTEGER NOT NULL);
CREATE TABLE invites (
  code TEXT PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id),
  max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE agents (
  id TEXT PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id), name TEXT NOT NULL,
  owner TEXT NOT NULL, description TEXT NOT NULL, agent_type TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_seen INTEGER, last_poll INTEGER, session_id TEXT, session_seen INTEGER);
CREATE UNIQUE INDEX agents_room_name ON agents(room_id, name) WHERE status != 'revoked';
CREATE TABLE threads (
  id TEXT PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id), subject TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES agents(id), created_at INTEGER NOT NULL);
CREATE TABLE thread_members (
  thread_id TEXT NOT NULL REFERENCES threads(id), agent_id TEXT NOT NULL REFERENCES agents(id),
  PRIMARY KEY (thread_id, agent_id));
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL REFERENCES threads(id), from_agent TEXT NOT NULL REFERENCES agents(id),
  body TEXT NOT NULL, sent_at INTEGER NOT NULL);
CREATE INDEX messages_thread ON messages(thread_id, seq);
CREATE TABLE deliveries (
  message_seq INTEGER NOT NULL REFERENCES messages(seq), agent_id TEXT NOT NULL REFERENCES agents(id),
  acked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (agent_id, message_seq));
`;

test('Migration: eine Datenbank im alten Schema läuft weiter, Tokens, Sitzung und Sicht bleiben gleich', async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'vnz-migration-'));
  const dbPath = joinPath(dir, 'alt.sqlite');
  const now = Date.now();
  const old = new DatabaseSync(dbPath);
  old.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  old.exec(OLD_SCHEMA);
  old.exec(`INSERT INTO rooms (id, slug, title, created_at) VALUES (1, 'alt', 'Alter Raum', ${now}), (2, 'fremd', 'Fremder Raum', ${now})`);
  const agent = old.prepare(`INSERT INTO agents (id, room_id, name, owner, description, agent_type, token_hash, status, created_at, last_seen, session_id, session_seen)
    VALUES (?, ?, ?, 'Alt', 'Bestand', 'test', ?, ?, ?, ?, ?, ?)`);
  agent.run('ag_anna', 1, 'anna', sha256('vnz_anna'), 'active', now, now - 600_000, 'ses_anna', now - 600_000);
  agent.run('ag_bert', 1, 'bert', sha256('vnz_bert'), 'active', now, null, null, null);
  agent.run('ag_fremd', 2, 'carla', sha256('vnz_carla'), 'active', now, null, null, null);
  agent.run('ag_weg', 1, 'bert', sha256('vnz_weg'), 'revoked', now, null, null, null);
  old.exec(`INSERT INTO invites (code, room_id, max_uses, expires_at, created_at) VALUES ('inv_alt', 1, 1, ${now + 86_400_000}, ${now})`);
  old.exec(`INSERT INTO threads (id, room_id, subject, created_by, created_at) VALUES ('th_alt', 1, 'Altes Gespräch', 'ag_bert', ${now})`);
  old.exec("INSERT INTO thread_members (thread_id, agent_id) VALUES ('th_alt', 'ag_anna'), ('th_alt', 'ag_bert')");
  old.exec(`INSERT INTO messages (id, thread_id, from_agent, body, sent_at) VALUES ('msg_alt', 'th_alt', 'ag_bert', 'liegt noch im Postfach', ${now})`);
  old.exec("INSERT INTO deliveries (message_seq, agent_id) VALUES (1, 'ag_anna')");
  old.close();

  const logs: string[] = [];
  const migrated = createHub({ dbPath, adminPassword: 'geheim-geheim', log: (l) => logs.push(l) });
  const srv = createServer(migrated.handler);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const at = callAt(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
  try {
    assert.equal(migrated.core.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 1);
    assert.ok(readdirSync(dir).some((f) => f.startsWith('alt.sqlite.vor-v1-') && f.endsWith('.bak')), 'Sicherungskopie fehlt');
    assert.ok(logs.some((l) => l.includes('Sicherungskopie')));

    // Die alte Sitzung gilt weiter, ohne neue Anmeldung.
    const anna = { token: 'vnz_anna', session: 'ses_anna' };
    const me = await at('GET', '/me', anna);
    assert.equal(me.status, 200, JSON.stringify(me.json));
    assert.deepEqual([me.json.agent_id, me.json.room, me.json.person, me.json.name], ['ag_anna', 'alt', null, 'anna']);
    // Gleiche Sicht wie vorher: der eigene Raum, nicht der fremde, nicht der widerrufene.
    const list = await at('GET', '/agents', anna);
    assert.equal(list.json.room, 'alt');
    assert.deepEqual(list.json.agents.map((a: any) => a.agent_id), ['ag_anna', 'ag_bert']);
    // Postfach, Verlauf und Antwort im alten Gespräch.
    const inbox = await at('GET', '/inbox', anna);
    assert.deepEqual(inbox.json.messages.map((m: any) => [m.id, m.thread_id, m.from, m.body]), [['msg_alt', 'th_alt', 'bert', 'liegt noch im Postfach']]);
    assert.equal((await at('GET', '/threads/th_alt', anna)).json.messages.length, 1);
    assert.equal((await at('POST', '/messages', anna, { thread_id: 'th_alt', body: 'Antwort nach der Migration' })).status, 201);
    assert.equal((await at('POST', '/messages', anna, { to: ['carla'], body: 'x' })).json.error.code, 'recipient_unknown');
    // Ein altes Token ohne Sitzung meldet sich an; der alte Einladungscode gilt, der Kurzname bleibt geschützt.
    const bert = { token: 'vnz_bert' };
    assert.equal((await at('POST', '/session', bert, {})).status, 200);
    const reg = (name: string) => at('POST', '/register', undefined, { room: 'alt', invite: 'inv_alt', name, owner: 'Neu', description: 'x' });
    assert.equal((await reg('anna')).json.error.code, 'name_taken');
    assert.equal((await reg('dora')).status, 201);
    assert.equal((await reg('emil')).json.error.code, 'invite_exhausted');
    // Das neue Schema ist da: Agenten und Threads brauchen keinen Raum mehr, Fremdschlüssel sind heil.
    assert.equal(migrated.core.all('PRAGMA foreign_key_check').length, 0);
    const notnull = (table: string) => migrated.core.all<{ name: string; notnull: number }>(`PRAGMA table_info(${table})`).find((c) => c.name === 'room_id')!.notnull;
    assert.deepEqual([notnull('agents'), notnull('threads')], [0, 0]);
  } finally {
    migrated.close();
    srv.close();
    srv.closeAllConnections();
    await new Promise((r) => setTimeout(r, 50));
  }

  // Ein zweiter Start migriert nicht erneut.
  const again = createHub({ dbPath, adminPassword: 'geheim-geheim', log: () => {} });
  assert.equal(again.core.one<{ n: number }>('SELECT COUNT(*) AS n FROM agents')!.n, 5);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.bak')).length, 1);
  again.close();
  await new Promise((r) => setTimeout(r, 50));
  rmSync(dir, { recursive: true, force: true });
});
