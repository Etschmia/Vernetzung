import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHub } from '../src/hub.ts';

const hub = createHub({ dbPath: ':memory:', adminPassword: 'geheim-geheim', log: () => {} });
const server = createServer(hub.handler);
let base = '';
let cookie = '';

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  hub.close();
  server.close();
  server.closeAllConnections();
});

type Who = { token: string; session?: string };
const call = async (method: string, path: string, who?: Who, body?: unknown) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${who.token}`;
  if (who?.session) headers['X-Vernetzung-Session'] = who.session;
  const r = await fetch(`${base}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json()) as any };
};
const adminPost = (path: string, form: Record<string, string>) =>
  fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
const newInvite = async (room: string) => {
  await adminPost(`/admin/room/${room}/invites`, { max_uses: '1', days: '1' });
  return hub.core.one<{ code: string }>(
    'SELECT code FROM invites i JOIN rooms r ON r.id = i.room_id WHERE r.slug = ? AND uses = 0 ORDER BY i.rowid DESC', room)!.code;
};
const join = async (room: string, name: string): Promise<Who> => {
  const reg = await call('POST', '/register', undefined,
    { room, invite: await newInvite(room), name, owner: 'Test', description: 'Testagent', agent_type: 'test' });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  const who: Who = { token: reg.json.token };
  const ses = await call('POST', '/session', who, {});
  assert.equal(ses.status, 200);
  who.session = ses.json.session;
  return who;
};

test('GUI: Anmeldung nötig, falsches Passwort scheitert, richtiges legt Räume an', async () => {
  assert.equal((await fetch(`${base}/admin`, { redirect: 'manual' })).status, 303);
  const bad = await fetch(`${base}/admin/login`, { method: 'POST', body: new URLSearchParams({ password: 'falsch' }) });
  assert.equal(bad.status, 401);
  const ok = await fetch(`${base}/admin/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ password: 'geheim-geheim' }) });
  assert.equal(ok.status, 303);
  cookie = ok.headers.get('set-cookie')!.split(';')[0];
  for (const slug of ['alpha', 'beta']) assert.equal((await adminPost('/admin/rooms', { slug, title: `Raum ${slug}` })).status, 303);
  const page = await (await fetch(`${base}/admin`, { headers: { Cookie: cookie } })).text();
  assert.match(page, /Raum alpha/);
});

test('GUI lehnt Formulare fremder Herkunft ab', async () => {
  const r = await fetch(`${base}/admin/rooms`, { method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie, Origin: 'https://boese.example' }, body: new URLSearchParams({ slug: 'fremd', title: 'x' }) });
  assert.equal(r.status, 403);
});

test('Skill wird in beiden Formen ausgeliefert und nennt den Hub', async () => {
  const skill = await (await fetch(`${base}/skill`)).text();
  assert.match(skill, /^---\nname: vernetzung/);
  assert.ok(skill.includes(`${base}/api/v1/register`));
  assert.match(await (await fetch(`${base}/skill?mode=prompt`)).text(), /^Richte dir/);
});

test('Registrierung: Einladung nötig, einmalig, Name eindeutig', async () => {
  const fields = { room: 'alpha', name: 'eins', owner: 'A', description: 'd' };
  assert.equal((await call('POST', '/register', undefined, fields)).json.error.code, 'field_missing');
  assert.equal((await call('POST', '/register', undefined, { ...fields, invite: 'inv_falsch' })).json.error.code, 'invite_invalid');
  assert.equal((await call('POST', '/register', undefined, { ...fields, room: 'gibtsnicht', invite: 'x' })).json.error.code, 'room_not_found');
  const invite = await newInvite('alpha');
  assert.equal((await call('POST', '/register', undefined, { ...fields, invite, name: 'Großer Name' })).json.error.code, 'name_invalid');
  assert.equal((await call('POST', '/register', undefined, { ...fields, invite })).status, 201);
  assert.equal((await call('POST', '/register', undefined, { ...fields, invite, name: 'zwei' })).json.error.code, 'invite_exhausted');
  assert.equal((await call('POST', '/register', undefined, { ...fields, invite: await newInvite('alpha') })).json.error.code, 'name_taken');
});

test('Ohne Token oder Sitzung geht nichts', async () => {
  assert.equal((await call('GET', '/agents')).json.error.code, 'token_missing');
  assert.equal((await call('GET', '/agents', { token: 'vnz_erfunden' })).json.error.code, 'token_invalid');
  const a = await join('alpha', 'ohne-sitzung');
  assert.equal((await call('GET', '/agents', { token: a.token })).json.error.code, 'session_required');
});

test('Nachrichten: senden, abholen, bestätigen, antworten, Verlauf', async () => {
  const a = await join('alpha', 'anna');
  const b = await join('alpha', 'bert');
  const sent = await call('POST', '/messages', a, { to: ['bert'], subject: 'Hallo', body: 'Erste Frage' });
  assert.equal(sent.status, 201);

  const inbox = await call('GET', '/inbox', b);
  assert.equal(inbox.json.messages.length, 1);
  assert.deepEqual(
    { from: inbox.json.messages[0].from, to: inbox.json.messages[0].to, subject: inbox.json.messages[0].subject, body: inbox.json.messages[0].body },
    { from: 'anna', to: ['bert'], subject: 'Hallo', body: 'Erste Frage' });
  // Unbestätigt kommt die Nachricht wieder.
  assert.equal((await call('GET', '/inbox', b)).json.messages.length, 1);
  assert.equal((await call('POST', '/inbox/ack', b, { up_to: inbox.json.messages[0].id })).json.acked, 1);
  assert.deepEqual((await call('GET', '/inbox', b)).json, { messages: [] });

  assert.equal((await call('POST', '/messages', b, { thread_id: sent.json.thread_id, body: 'Antwort' })).status, 201);
  assert.equal((await call('GET', '/inbox', a)).json.messages[0].body, 'Antwort');
  const thread = await call('GET', `/threads/${sent.json.thread_id}`, a);
  assert.deepEqual(thread.json.messages.map((m: any) => m.body), ['Erste Frage', 'Antwort']);
  assert.equal((await call('GET', '/threads', b)).json.threads[0].messages, 2);

  assert.equal((await call('POST', '/messages', a, { to: ['niemand'], body: 'x' })).json.error.code, 'recipient_unknown');
  assert.equal((await call('POST', '/messages', a, { to: ['bert'], body: 'x'.repeat(33 * 1024) })).json.error.code, 'body_too_large');
});

test('Long-Poll wird durch eine eintreffende Nachricht geweckt', async () => {
  const a = await join('alpha', 'carl');
  const b = await join('alpha', 'dora');
  const started = Date.now();
  const waiting = call('GET', '/inbox?wait=20', b);
  await new Promise((r) => setTimeout(r, 150));
  const list = await call('GET', '/agents', a);
  assert.equal(list.json.agents.find((x: any) => x.name === 'dora').presence, 'listening');
  await call('POST', '/messages', a, { to: ['dora'], body: 'Weckruf' });
  const got = await waiting;
  assert.equal(got.json.messages[0].body, 'Weckruf');
  assert.ok(Date.now() - started < 5000);
});

test('Räume sind voneinander getrennt', async () => {
  const a = await join('alpha', 'emil');
  const x = await join('beta', 'xaver');
  const names = (await call('GET', '/agents', x)).json.agents.map((g: any) => g.name);
  assert.deepEqual(names, ['xaver']);
  assert.equal((await call('POST', '/messages', x, { to: ['emil'], body: 'x' })).json.error.code, 'recipient_unknown');
  const t = await call('POST', '/messages', a, { to: ['anna'], body: 'intern' });
  assert.equal((await call('GET', `/threads/${t.json.thread_id}`, x)).json.error.code, 'not_in_thread');
  assert.equal((await call('POST', '/messages', x, { thread_id: t.json.thread_id, body: 'x' })).json.error.code, 'not_in_thread');
});

test('Doppelanmeldung wird abgelehnt, Ablösen beendet die alte Sitzung samt Long-Poll', async () => {
  const a = await join('alpha', 'fritz');
  assert.equal((await call('POST', '/session', { token: a.token }, {})).json.error.code, 'identity_in_use');
  const waiting = call('GET', '/inbox?wait=20', a);
  await new Promise((r) => setTimeout(r, 100));
  const second = await call('POST', '/session', { token: a.token }, { takeover: true });
  assert.equal(second.status, 200);
  assert.equal((await waiting).json.error.code, 'session_replaced');
  assert.equal((await call('GET', '/agents', a)).json.error.code, 'session_replaced');
  assert.equal((await call('GET', '/agents', { token: a.token, session: second.json.session })).status, 200);
});

test('Stufe approval: wartende Agenten dürfen nichts, bis der Betreiber freigibt; Sperren und Widerruf wirken', async () => {
  await adminPost('/admin/room/beta/settings', { auth_level: 'approval', pw_action: 'keep' });
  const reg = await call('POST', '/register', undefined,
    { room: 'beta', invite: await newInvite('beta'), name: 'wartend', owner: 'W', description: 'd' });
  assert.equal(reg.json.status, 'pending');
  const w: Who = { token: reg.json.token };
  w.session = (await call('POST', '/session', w, {})).json.session;
  assert.equal((await call('GET', '/me', w)).json.status, 'pending');
  assert.equal((await call('GET', '/agents', w)).json.error.code, 'agent_pending');

  const act = (action: string) => adminPost('/admin/room/beta/agent', { id: reg.json.agent_id, action });
  await act('approve');
  assert.equal((await call('GET', '/agents', w)).status, 200);
  await act('block');
  assert.equal((await call('GET', '/agents', w)).json.error.code, 'agent_blocked');
  await act('unblock');
  await act('revoke');
  assert.equal((await call('GET', '/agents', w)).json.error.code, 'token_revoked');
  // Der Kurzname ist nach dem Widerruf wieder frei.
  const again = await call('POST', '/register', undefined,
    { room: 'beta', invite: await newInvite('beta'), name: 'wartend', owner: 'W', description: 'd' });
  assert.equal(again.status, 201);
});

test('Raumpasswort wird bei Registrierung und Anmeldung verlangt', async () => {
  const a = await join('alpha', 'gerd');
  await adminPost('/admin/room/alpha/settings', { auth_level: 'invite', pw_action: 'set', password: 'raumpasswort' });
  const fields = { room: 'alpha', name: 'hans', owner: 'H', description: 'd' };
  assert.equal((await call('POST', '/register', undefined, { ...fields, invite: await newInvite('alpha') })).json.error.code, 'room_password_wrong');
  assert.equal((await call('POST', '/session', { token: a.token }, { takeover: true })).json.error.code, 'room_password_wrong');
  assert.equal((await call('POST', '/session', { token: a.token }, { takeover: true, room_password: 'raumpasswort' })).status, 200);
  assert.equal((await call('POST', '/register', undefined, { ...fields, invite: await newInvite('alpha'), room_password: 'raumpasswort' })).status, 201);
});

test('GUI zeigt Gespräche und maskiert HTML in Nachrichten', async () => {
  await adminPost('/admin/room/alpha/settings', { auth_level: 'invite', pw_action: 'clear' });
  const a = await join('alpha', 'ida');
  const t = await call('POST', '/messages', a, { to: ['anna'], subject: '<b>fett</b>', body: '<script>alert(1)</script>' });
  const page = await (await fetch(`${base}/admin/thread/${t.json.thread_id}`, { headers: { Cookie: cookie } })).text();
  assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!page.includes('<script>alert(1)'));
  const room = await (await fetch(`${base}/admin/room/alpha`, { headers: { Cookie: cookie } })).text();
  assert.ok(room.includes('&lt;b&gt;fett&lt;/b&gt;'));
});
