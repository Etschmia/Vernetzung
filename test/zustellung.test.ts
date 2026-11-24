// Zustellung: Bestätigung mit Obergrenze, überlappende Rückfragen, Empfänger in bestehenden Gesprächen.
// Die Fälle stammen aus docs/CODE_REVIEW_2026-11-24.md.
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
  const ok = await fetch(`${base}/admin/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ password: 'geheim-geheim' }) });
  cookie = ok.headers.get('set-cookie')!.split(';')[0];
});
after(() => {
  hub.close();
  server.close();
  server.closeAllConnections();
});

type Who = { token: string; session?: string; id: string };
const call = async (method: string, path: string, who?: Who, body?: unknown) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${who.token}`;
  if (who?.session) headers['X-Vernetzung-Session'] = who.session;
  const r = await fetch(`${base}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json()) as any };
};
const adminPost = (path: string, form: Record<string, string> | [string, string][]) =>
  fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
const join = async (room: string, name: string): Promise<Who> => {
  if (!hub.core.one('SELECT 1 FROM rooms WHERE slug = ?', room)) await adminPost('/admin/rooms', { slug: room, title: room });
  await adminPost(`/admin/room/${room}/invites`, { max_uses: '1', days: '1' });
  const invite = hub.core.one<{ code: string }>(
    'SELECT code FROM invites i JOIN rooms r ON r.id = i.room_id WHERE r.slug = ? AND uses = 0 ORDER BY i.rowid DESC', room)!.code;
  const reg = await call('POST', '/register', undefined, { room, invite, name, owner: 'Test', description: 'Testagent' });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  const who: Who = { token: reg.json.token, id: reg.json.agent_id };
  who.session = (await call('POST', '/session', who, {})).json.session;
  return who;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inboxBodies = async (who: Who) => ((await call('GET', '/inbox', who)).json.messages as { body: string }[]).map((m) => m.body);

test('Bestätigen mit thread_id und up_to: nur dieses Gespräch und nur bis zur genannten Nachricht', async () => {
  const [a, b] = [await join('ack', 'sender'), await join('ack', 'leser')];
  const one = (await call('POST', '/messages', a, { to: ['leser'], body: 'T1 eins' })).json;
  const other = (await call('POST', '/messages', a, { to: ['leser'], body: 'T2 eins' })).json;
  // Der Leser hat "T1 eins" gesehen; danach trifft im selben Gespräch noch etwas ein.
  await call('POST', '/messages', a, { thread_id: one.thread_id, body: 'T1 zwei' });
  const acked = await call('POST', '/inbox/ack', b, { thread_id: one.thread_id, up_to: one.message_id });
  assert.deepEqual([acked.status, acked.json.acked, acked.json.unread], [200, 1, 2]);
  assert.deepEqual(await inboxBodies(b), ['T2 eins', 'T1 zwei']);
  // Eine Nachricht aus einem anderen Gespräch taugt nicht als Obergrenze.
  const wrong = await call('POST', '/inbox/ack', b, { thread_id: one.thread_id, up_to: other.message_id });
  assert.deepEqual([wrong.status, wrong.json.error.code], [404, 'message_unknown']);
  assert.deepEqual(await inboxBodies(b), ['T2 eins', 'T1 zwei']);
  // Die bisherigen Formen bleiben: nur thread_id bestätigt das ganze Gespräch, nur up_to alles bis dahin.
  assert.equal((await call('POST', '/inbox/ack', b, { thread_id: one.thread_id })).json.acked, 1);
  assert.equal((await call('POST', '/inbox/ack', b, { up_to: other.message_id })).json.unread, 0);
});

test('Überlappende Rückfragen: Nach ihrem Ende hält nichts mehr Antworten vom Postfach fern', async () => {
  const [x, y] = [await join('fragen', 'fragt'), await join('fragen', 'antwortet')];
  await join('fragen', 'dritter');
  const t1 = (await call('POST', '/messages', x, { to: ['antwortet'], body: 'Auftakt' })).json.thread_id;
  // Eine Frage in einem zweiten Gespräch bleibt offen, während zwei Rückfragen im ersten überlappen
  // und die frühere zuerst endet.
  const c = call('POST', '/ask', x, { to: ['dritter'], body: 'anderes Gespräch', wait: 1.5 });
  await sleep(50);
  const a1 = call('POST', '/ask', x, { thread_id: t1, body: 'erste Rückfrage', wait: 0.3 });
  await sleep(50);
  const a2 = call('POST', '/ask', x, { thread_id: t1, body: 'zweite Rückfrage', wait: 0.7 });
  for (const r of await Promise.all([a1, a2])) assert.equal(r.json.status, 'waiting');
  // Die dritte Frage wartet noch; im ersten Gespräch wartet niemand mehr.
  assert.equal((await call('POST', '/messages', y, { thread_id: t1, body: 'späte Antwort' })).status, 201);
  assert.deepEqual(await inboxBodies(x), ['späte Antwort']);
  assert.equal((await c).json.status, 'waiting');
  assert.deepEqual(await inboxBodies(x), ['späte Antwort']);
  assert.equal(hub.core.asking.size, 0);
});

test('Überlappende Rückfragen: Solange eine wartet, bekommt sie die Antwort und das Postfach nicht', async () => {
  const [x, y] = [await join('fragen2', 'fragt'), await join('fragen2', 'antwortet')];
  const t = (await call('POST', '/messages', x, { to: ['antwortet'], body: 'Auftakt' })).json.thread_id;
  const a1 = call('POST', '/ask', x, { thread_id: t, body: 'kurz', wait: 0.2 });
  await sleep(50);
  const a2 = call('POST', '/ask', x, { thread_id: t, body: 'lang', wait: 5 });
  assert.equal((await a1).json.status, 'waiting');
  assert.deepEqual(await inboxBodies(x), []);
  await call('POST', '/messages', y, { thread_id: t, body: 'Antwort' });
  const answered = (await a2).json;
  assert.deepEqual([answered.status, answered.reply.body], ['answered', 'Antwort']);
  assert.deepEqual(await inboxBodies(x), []);
});

test('Bestehendes Gespräch: Ein gesperrter oder widerrufener Teilnehmer ist nicht mehr erreichbar', async () => {
  const [a, b] = [await join('status', 'bleibt'), await join('status', 'geht')];
  const t = (await call('POST', '/messages', a, { to: ['geht'], body: 'Hallo' })).json.thread_id;
  const reply = () => call('POST', '/messages', a, { thread_id: t, body: 'Noch da?' });
  assert.equal((await reply()).status, 201);
  const before = hub.core.one<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?', t)!.n;

  await adminPost('/admin/room/status/agent', { id: b.id, action: 'block' });
  const blocked = await reply();
  assert.deepEqual([blocked.status, blocked.json.error.code], [404, 'recipient_unknown']);
  await adminPost('/admin/room/status/agent', { id: b.id, action: 'unblock' });
  assert.equal((await reply()).status, 201);

  await adminPost('/admin/room/status/agent', { id: b.id, action: 'revoke' });
  const revoked = await reply();
  assert.deepEqual([revoked.status, revoked.json.error.code], [404, 'recipient_unknown']);
  const asked = await call('POST', '/ask', a, { thread_id: t, body: 'Und so?', wait: 0 });
  assert.deepEqual([asked.status, asked.json.error.code], [404, 'recipient_unknown']);
  // Abgelehntes legt keine Nachricht an.
  assert.equal(hub.core.one<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?', t)!.n, before + 1);
});

test('Empfänger mit dem Kurznamen des Absenders: wird gefunden; sich selbst schreibt weiterhin niemand', async () => {
  const [mine, theirs] = [await join('farbe-eins', 'rot'), await join('farbe-zwei', 'rot')];
  const other = await join('farbe-eins', 'blau');
  await adminPost('/admin/persons', { slug: 'nutzer-a', name: 'Nutzer A' });
  await adminPost('/admin/person/nutzer-a/assign', { id: mine.id });
  await adminPost('/admin/person/nutzer-a/shares', [['agent', theirs.id]]);

  const byName = await call('POST', '/messages', mine, { to: ['rot'], body: 'An den anderen rot' });
  assert.equal(byName.status, 201, JSON.stringify(byName.json));
  assert.deepEqual(byName.json.recipients.map((r: any) => r.agent_id), [theirs.id]);
  // In einer Gruppe fehlt der gleichnamige Empfänger nicht mehr.
  const group = await call('POST', '/messages', mine, { to: ['blau', 'rot'], body: 'An beide' });
  assert.deepEqual(group.json.recipients.map((r: any) => r.agent_id).sort(), [other.id, theirs.id].sort());
  // Die eigene agent_id meint immer den Absender und entfällt.
  const self = await call('POST', '/messages', mine, { to: [mine.id], body: 'x' });
  assert.deepEqual([self.status, self.json.error.code], [400, 'field_invalid']);
  const withSelf = await call('POST', '/messages', mine, { to: [mine.id, 'blau'], body: 'x' });
  assert.deepEqual(withSelf.json.recipients.map((r: any) => r.agent_id), [other.id]);
  // Ohne gleichnamigen Kontakt bleibt der eigene Kurzname Selbstadressierung.
  const lonely = await call('POST', '/messages', other, { to: ['blau'], body: 'x' });
  assert.deepEqual([lonely.status, lonely.json.error.code], [400, 'field_invalid']);
});
