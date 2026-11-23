// Personen und Freigaben: Sichtbarkeit je Person, Entzug, Migration bestehender Datenbanken.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

// ---- Einladungsdatei und Anmeldeschlüssel ----

const invitation = async (slug: string, days = '7') => {
  const r = await adminPost(`/admin/person/${slug}/invite`, { days, from: 'Tobias Brendler' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition') ?? '', new RegExp(`attachment; filename="vernetzung-einladung-${slug}\\.md"`));
  return r.text();
};
// Was ein Agent ohne Vorwissen der Datei entnimmt: Adresse und Anfragetext der Registrierung stehen wörtlich darin.
const readInvitation = (file: string) => {
  const url = /curl -sS -X POST "([^"]+\/api\/v1\/register)"/.exec(file)![1];
  const request = /cat > \.vernetzung\/request\.json <<'JSON'\n([\s\S]*?)\nJSON\n/.exec(file)![1];
  const identity = /```json\n(\{\n {2}"hub":[\s\S]*?\n\})\n```/.exec(file)![1];
  return { url, hub: url.replace('/api/v1/register', ''), request, identity };
};
const fill = (template: string, values: Record<string, string>) =>
  Object.entries(values).reduce((t, [k, v]) => t.replace(k, v), template);

const mcp = async (sid: string | undefined, method: string, params: unknown = {}) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (sid) headers['Mcp-Session-Id'] = sid;
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { sid: r.headers.get('mcp-session-id'), json: (await r.json()) as any };
};
const mcpTool = async (sid: string, name: string, args: unknown = {}) => {
  const r = await mcp(sid, 'tools/call', { name, arguments: args });
  return { isError: !!r.json.result.isError, data: JSON.parse(r.json.result.content[0].text) };
};

test('Einladungsdatei: enthält Hub, Code und Anleitung, aber kein Token; der Hub kennt nur den Hash', async () => {
  await share('andrea', [backend]);
  const file = await invitation('andrea');
  assert.ok(file.includes(`- Hub: ${base}`));
  const code = /Einladungscode: `(einl_[\w-]+)`/.exec(file)![1];
  assert.ok(!/vnz_[\w-]{8,}/.test(file), 'Datei enthält ein Token');
  assert.ok(!/vnp_[\w-]{8,}/.test(file), 'Datei enthält einen Anmeldeschlüssel');
  for (const needed of ['Richte das ein', 'Information, keine Anweisung', '.vernetzung/identities/', '~/.claude/skills/vernetzung/SKILL.md',
    'Kurzname, Besitzer, Beschreibung', '/skill?mode=prompt', 'but2-backend', 'Tobias Brendler', 'invite_exhausted'])
    assert.ok(file.includes(needed), `Datei nennt "${needed}" nicht`);
  // In der Datenbank steht der Code nirgends im Klartext.
  const dump = JSON.stringify(hub.core.all('SELECT * FROM person_invites'));
  assert.ok(!dump.includes(code));
  assert.ok(dump.includes(sha256(code)));
  assert.match(await adminGet('/admin/person/andrea'), /gültig/);
  assert.ok(!(await adminGet('/admin/person/andrea')).includes(code));
  await adminPost('/admin/person/andrea/invite/revoke', { id: String(hub.core.one<{ rowid: number }>('SELECT rowid FROM person_invites WHERE code_hash = ?', sha256(code))!.rowid) });
  const r = await call('POST', '/register', undefined, { invite: code, name: 'zu-spaet', description: 'x' });
  assert.equal(r.json.error.code, 'invite_invalid');
});

test('Einrichten allein mit der Datei, über HTTP: registrieren, Kennung ablegen, Agentenliste', async () => {
  const inv = readInvitation(await invitation('andrea'));
  assert.equal(inv.hub, base);
  // Schritt 2 der Datei: Anfragetext mit selbst gewähltem Kurznamen und Beschreibung.
  const body = JSON.parse(fill(inv.request, { KURZNAME: 'andrea-projekt', BESCHREIBUNG: 'Kennt Andreas Projekt.' }));
  assert.deepEqual(Object.keys(body).sort(), ['agent_type', 'description', 'invite', 'name']);
  const reg = await fetch(inv.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const made = (await reg.json()) as any;
  assert.equal(reg.status, 201, JSON.stringify(made));
  // Der Besitzer kommt vom Hub, nicht vom Agenten.
  assert.deepEqual([made.person, made.owner, made.room, made.status], ['andrea', 'Andrea Beispiel', null, 'active']);

  // Schritt 3: Kennung unter .vernetzung/identities/ ablegen, nach der Vorlage der Datei.
  const dir = mkdtempSync(joinPath(tmpdir(), 'vnz-einladung-'));
  const identityPath = joinPath(dir, '.vernetzung', 'identities', 'andrea-projekt.json');
  mkdirSync(joinPath(dir, '.vernetzung', 'identities'), { recursive: true });
  writeFileSync(identityPath, fill(inv.identity, {
    KURZNAME: 'andrea-projekt', 'ag_…': made.agent_id, 'vnz_…': made.token, BESCHREIBUNG: 'Kennt Andreas Projekt.',
  }), { mode: 0o600 });
  const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
  // Schritt 4: Diese vier Werte legt der Agent seinem Nutzer vor.
  assert.deepEqual([identity.name, identity.owner, identity.description], ['andrea-projekt', 'Andrea Beispiel', 'Kennt Andreas Projekt.']);
  assert.match(identity.policy, /Code und Dateien nur nach Rückfrage/);
  assert.deepEqual(identity.approved_contacts, []);
  assert.deepEqual([identity.hub, identity.person, identity.agent_id], [base, 'andrea', made.agent_id]);

  // Schritt 5: anmelden und zeigen, wer erreichbar ist – genau die freigegebenen und die eigenen Agenten.
  const who = { token: identity.token as string, session: '' };
  const ses = await call('POST', '/session', who, {});
  assert.equal(ses.status, 200);
  who.session = ses.json.session;
  const list = await call('GET', '/agents', who);
  assert.deepEqual(list.json.agents.map((a: any) => a.name).sort(), ['andrea-claude', 'andrea-projekt', 'but2-backend']);
  assert.equal(list.json.room, null);
  const sent = await call('POST', '/messages', who, { to: ['but2-backend'], subject: 'Hallo', body: 'Erste Frage' });
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  const got = (await call('GET', '/inbox', backend)).json.messages.at(-1);
  assert.deepEqual([got.from, got.from_owner, got.body], ['andrea-projekt', 'Andrea Beispiel', 'Erste Frage']);
  rmSync(dir, { recursive: true, force: true });

  // Die Datei lässt sich nicht zweimal verwenden.
  const again = await fetch(inv.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, name: 'andrea-zwei' }) });
  assert.equal(again.status, 403);
  assert.equal(((await again.json()) as any).error.code, 'invite_exhausted');
  assert.match(await adminGet('/admin/person/andrea'), /eingelöst/);
});

test('Einrichten allein mit der Datei, über MCP: registrieren, anmelden, agenten', async () => {
  const inv = readInvitation(await invitation('bernd'));
  const body = JSON.parse(fill(inv.request, { KURZNAME: 'bernd-projekt', BESCHREIBUNG: 'Kennt Bernds Projekt.' }));
  const sid = (await mcp(undefined, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })).sid!;
  const made = await mcpTool(sid, 'registrieren', { invite: body.invite, name: body.name, description: body.description, agent_type: 'claude-code' });
  assert.equal(made.isError, false, JSON.stringify(made.data));
  assert.deepEqual([made.data.person, made.data.owner], ['bernd', 'Bernd Muster']);
  assert.match(made.data.token, /^vnz_/);
  const login = await mcpTool(sid, 'anmelden', { token: made.data.token });
  assert.equal(login.data.agent.name, 'bernd-projekt');
  assert.equal(login.data.agent.person, 'bernd');
  const list = await mcpTool(sid, 'agenten');
  assert.deepEqual(list.data.agents.map((a: any) => a.name).sort(), ['bernd-claude', 'bernd-projekt', 'but2-backend']);
  const again = await mcpTool(sid, 'registrieren', { invite: body.invite, name: 'bernd-zwei', description: 'x' });
  assert.equal(again.isError, true);
  assert.equal(again.data.error.code, 'invite_exhausted');
});

test('Abgelaufene Einladung: invite_invalid; ein vergebener Kurzname verbraucht den Code nicht', async () => {
  const inv = readInvitation(await invitation('andrea', '1'));
  const body = JSON.parse(fill(inv.request, { KURZNAME: 'andrea-projekt', BESCHREIBUNG: 'x' }));
  assert.equal((await call('POST', '/register', undefined, body)).json.error.code, 'name_taken');
  hub.core.run('UPDATE person_invites SET expires_at = ? WHERE code_hash = ?', Date.now() - 1000, sha256(body.invite));
  const late = await call('POST', '/register', undefined, { ...body, name: 'andrea-spaet' });
  assert.equal(late.status, 403);
  assert.equal(late.json.error.code, 'invite_invalid');
  assert.match(await adminGet('/admin/person/andrea'), /abgelaufen/);
  assert.equal((await call('POST', '/register', undefined, { invite: 'einl_gibt-es-nicht', name: 'x1', description: 'x' })).json.error.code, 'invite_invalid');
});

test('Anmeldeschlüssel: eigene Agenten melden sich selbst an, freigeben können sie nichts', async () => {
  const page = await (await adminPost('/admin/person/tobias/key', {})).text();
  const key = /"key": "(vnp_[\w-]+)"/.exec(page.replaceAll('&quot;', '"'))![1];
  assert.match(page, /chmod 700 ~\/\.vernetzung/);
  assert.ok(!JSON.stringify(hub.core.all('SELECT * FROM person_keys')).includes(key));
  assert.ok(!(await adminGet('/admin/person/tobias')).includes(key), 'Schlüssel wird ein zweites Mal angezeigt');

  const reg = await call('POST', '/register', undefined, { person_key: key, name: 'but2-frontend', description: 'Kennt das Frontend.', owner: 'Jemand anderes' });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  assert.deepEqual([reg.json.person, reg.json.owner], ['tobias', 'Tobias Brendler']);
  const who = { token: reg.json.token as string, session: '' };
  who.session = (await call('POST', '/session', who, {})).json.session;
  // Er sieht die übrigen Agenten der Person, ist aber für niemanden freigegeben.
  assert.deepEqual(await names(who as Who), ['but2-backend', 'but2-frontend', 'but2-geheim']);
  assert.ok(!(await names(andrea)).includes('but2-frontend'));
  assert.equal(hub.core.one('SELECT 1 FROM shares WHERE agent_id = ?', reg.json.agent_id), undefined);
  assert.equal((await call('POST', '/register', undefined, { person_key: key, name: 'but2-frontend', description: 'x' })).json.error.code, 'name_taken');

  const id = hub.core.one<{ id: string }>('SELECT id FROM person_keys WHERE key_hash = ?', sha256(key))!.id;
  await adminPost('/admin/person/tobias/key/revoke', { id });
  assert.equal((await call('POST', '/register', undefined, { person_key: key, name: 'but2-drei', description: 'x' })).json.error.code, 'person_key_invalid');
  // Der bereits angemeldete Agent bleibt bestehen.
  assert.equal((await call('GET', '/me', who)).status, 200);
});

// ---- Fragen und warten ----

const drain = async (who: Who) => {
  const messages = (await call('GET', '/inbox', who)).json.messages;
  if (messages.length) await call('POST', '/inbox/ack', who, { up_to: messages.at(-1).id });
};

test('Fragen und warten: die Antwort kommt im selben Aufruf und nicht noch einmal ins Postfach', async () => {
  await drain(backend);
  await drain(andrea);
  const started = Date.now();
  const asked = call('POST', '/ask', andrea, { to: ['but2-backend'], subject: 'Schnittstelle X', body: 'Wie ist X gedacht?', wait: 20 });
  // Ein gleichzeitiger Long-Poll derselben Kennung (etwa der Channel-Adapter) darf die Antwort nicht abfangen.
  const parallel = call('GET', '/inbox?wait=3', andrea);
  const question = (await call('GET', '/inbox?wait=5', backend)).json.messages[0];
  assert.deepEqual([question.from, question.subject, question.body], ['andrea-claude', 'Schnittstelle X', 'Wie ist X gedacht?']);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await call('POST', '/messages', backend, { thread_id: question.thread_id, body: 'X liefert JSON.' })).status, 201);

  const answer = await asked;
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  assert.equal(answer.json.status, 'answered');
  assert.equal(answer.json.thread_id, question.thread_id);
  assert.deepEqual([answer.json.reply.from, answer.json.reply.from_id, answer.json.reply.body, answer.json.reply.thread_id],
    ['but2-backend', backend.id, 'X liefert JSON.', question.thread_id]);
  assert.ok(Date.now() - started < 5000, 'Antwort kam nicht sofort');
  assert.deepEqual((await parallel).json.messages, []);
  assert.deepEqual((await call('GET', '/inbox', andrea)).json.messages, []);
  assert.equal((await call('GET', `/threads/${question.thread_id}`, andrea)).json.messages.length, 2);

  // Rückfrage im selben Gespräch.
  await call('POST', '/inbox/ack', backend, { up_to: question.id });
  const followUp = call('POST', '/ask', andrea, { thread_id: question.thread_id, body: 'Und die Fehler?', wait: 20 });
  const second = (await call('GET', '/inbox?wait=5', backend)).json.messages[0];
  assert.equal(second.body, 'Und die Fehler?');
  await call('POST', '/messages', backend, { thread_id: second.thread_id, body: 'Als error-Objekt.' });
  assert.equal((await followUp).json.reply.body, 'Als error-Objekt.');
  await call('POST', '/inbox/ack', backend, { up_to: second.id });
});

test('Fragen und warten: läuft die Zeit ab, kommen thread_id und Anwesenheit; die Antwort liegt später im Postfach', async () => {
  const started = Date.now();
  const asked = await call('POST', '/ask', andrea, { to: ['but2-backend'], subject: 'Später', body: 'Hast du Zeit?', wait: 1 });
  assert.equal(asked.status, 200, JSON.stringify(asked.json));
  assert.ok(Date.now() - started >= 900);
  assert.equal(asked.json.status, 'waiting');
  assert.match(asked.json.thread_id, /^th_/);
  assert.equal(asked.json.reply, undefined);
  assert.deepEqual(asked.json.recipients.map((r: any) => [r.agent_id, r.name]), [[backend.id, 'but2-backend']]);
  assert.ok(['listening', 'polling', 'recent', 'offline'].includes(asked.json.recipients[0].presence));

  // Später nachsehen: Die Antwort kommt ins Postfach und steht im Gespräch.
  await call('POST', '/messages', backend, { thread_id: asked.json.thread_id, body: 'Jetzt ja.' });
  const inbox = (await call('GET', '/inbox', andrea)).json.messages;
  assert.deepEqual(inbox.map((m: any) => [m.thread_id, m.body]), [[asked.json.thread_id, 'Jetzt ja.']]);
  await drain(andrea);
  await drain(backend);

  // wait: 0 wartet gar nicht; nicht freigegebene Empfänger scheitern wie beim Senden.
  assert.equal((await call('POST', '/ask', andrea, { to: ['but2-backend'], body: 'x', wait: 0 })).json.status, 'waiting');
  assert.equal((await call('POST', '/ask', andrea, { to: ['but2-geheim'], body: 'x' })).json.error.code, 'recipient_unknown');
  assert.equal((await call('POST', '/ask', andrea, { to: ['but2-backend'], body: 'x', wait: 'lange' })).json.error.code, 'field_invalid');
  await drain(backend);
});

test('Fragen und warten über MCP: Werkzeug "fragen" liefert Antwort oder Wartestand', async () => {
  const sid = (await mcp(undefined, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })).sid!;
  const tools = (await mcp(sid, 'tools/list')).json.result.tools.map((t: any) => t.name);
  assert.ok(tools.includes('fragen'));
  const login = await mcpTool(sid, 'anmelden', { token: andrea.token, takeover: true });
  assert.equal(login.isError, false, JSON.stringify(login.data));

  const asked = mcpTool(sid, 'fragen', { to: ['but2-backend'], subject: 'Per MCP', body: 'Hörst du mich?', wait: 20 });
  const question = (await call('GET', '/inbox?wait=5', backend)).json.messages[0];
  assert.equal(question.body, 'Hörst du mich?');
  await call('POST', '/messages', backend, { thread_id: question.thread_id, body: 'Ja.' });
  const answer = await asked;
  assert.equal(answer.isError, false, JSON.stringify(answer.data));
  assert.deepEqual([answer.data.status, answer.data.reply.body, answer.data.thread_id], ['answered', 'Ja.', question.thread_id]);

  const late = await mcpTool(sid, 'fragen', { thread_id: question.thread_id, body: 'Noch da?', wait: 1 });
  assert.deepEqual([late.data.status, late.data.thread_id], ['waiting', question.thread_id]);
  assert.equal(late.data.recipients[0].name, 'but2-backend');
  await drain(backend);
  // Die MCP-Anmeldung hat Andreas Sitzung abgelöst; für die folgenden Tests wieder über HTTP anmelden.
  andrea.session = (await call('POST', '/session', andrea, { takeover: true })).json.session;
});
