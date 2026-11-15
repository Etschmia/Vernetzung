import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
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
  const post = (headers: Record<string, string>) => fetch(`${base}/admin/settings`, { method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie, ...headers }, body: new URLSearchParams({ retention_days: '90' }) });
  // Browser schicken je nach Referrer-Policy "Origin: null"; das darf keinen internen Fehler auslösen.
  assert.equal((await post({ Origin: 'null' })).status, 403);
  assert.equal((await post({ Origin: 'null', 'Sec-Fetch-Site': 'same-origin' })).status, 303);
  assert.equal((await post({ Origin: base, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post({ Origin: base })).status, 303);
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
  assert.deepEqual(sent.json.recipients.map(({ agent_id, ...r }: any) => r), [{ name: 'bert', presence: 'recent' }]);

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
  const sent = await call('POST', '/messages', a, { to: ['dora'], body: 'Weckruf' });
  assert.deepEqual(sent.json.recipients.map(({ agent_id, ...r }: any) => r), [{ name: 'dora', presence: 'listening' }]);
  const got = await waiting;
  assert.equal(got.json.messages[0].body, 'Weckruf');
  assert.ok(Date.now() - started < 5000);
});

test('Angemeldeter Abfrage-Rhythmus erscheint als polling mit nächster Abfrage', async () => {
  const a = await join('alpha', 'paul');
  const b = await join('alpha', 'quirin');
  assert.equal((await call('GET', '/inbox?wait=0&every=5', b)).json.error.code, 'field_invalid');
  assert.equal((await call('GET', '/inbox?wait=0&every=300', b)).status, 200);
  const seen = (await call('GET', '/agents', a)).json.agents.find((x: any) => x.name === 'quirin');
  assert.equal(seen.presence, 'polling');
  assert.equal(seen.poll_interval, 300);
  assert.ok(Date.parse(seen.next_poll_at) > Date.now() + 290_000);
  const sent = await call('POST', '/messages', a, { to: ['quirin'], body: 'x' });
  assert.equal(sent.json.recipients[0].presence, 'polling');
  assert.equal(sent.json.recipients[0].next_poll_at, seen.next_poll_at);
  // Überfällig: letzte Abfrage liegt mehr als zwei Intervalle zurück.
  hub.core.run("UPDATE agents SET last_poll = last_poll - 700000, last_seen = last_seen - 700000 WHERE name = 'quirin'");
  assert.equal((await call('GET', '/agents', a)).json.agents.find((x: any) => x.name === 'quirin').presence, 'recent');
  // Ein Long-Poll hebt den Rhythmus auf.
  await call('GET', '/inbox?wait=1', b);
  const after = (await call('GET', '/agents', a)).json.agents.find((x: any) => x.name === 'quirin');
  assert.equal(after.poll_interval, undefined);
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

test('Ungültiges Anfrageziel liefert 400 und beendet den Hub nicht', async () => {
  const port = (server.address() as AddressInfo).port;
  const answer = await new Promise<string>((resolve, reject) => {
    let data = '';
    const socket = connect(port, '127.0.0.1', () => socket.write('GET //[ HTTP/1.1\r\nHost: hub\r\nConnection: close\r\n\r\n'));
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('keine Antwort')); });
  });
  assert.match(answer, /^HTTP\/1\.1 400 /);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('Abgelehnte Zugangseinstellungen ändern weder Sicherheitsstufe noch Raumpasswort', async () => {
  await adminPost('/admin/rooms', { slug: 'tresor', title: 'Tresor' });
  const state = () => hub.core.one<{ auth_level: string; password_hash: string | null }>(
    "SELECT auth_level, password_hash FROM rooms WHERE slug = 'tresor'")!;
  const before = state();
  assert.equal(before.auth_level, 'invite');
  const r = await adminPost('/admin/room/tresor/settings', { auth_level: 'open', pw_action: 'set', password: 'kurz' });
  assert.equal(r.status, 400);
  assert.deepEqual(state(), before);
  const reg = await call('POST', '/register', undefined, { room: 'tresor', name: 'gast', owner: 'G', description: 'd' });
  assert.notEqual(reg.status, 201);
  // Gültige Eingaben werden zusammen gespeichert.
  assert.equal((await adminPost('/admin/room/tresor/settings', { auth_level: 'open', pw_action: 'set', password: 'lang-genug' })).status, 303);
  assert.equal(state().auth_level, 'open');
  assert.ok(state().password_hash);
});

test('Fehlversuche eines Clients sperren die Betreiber-Anmeldung anderer nicht', async () => {
  const login = (password: string, from?: string) => fetch(`${base}/admin/login`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ password }),
    headers: from ? { 'X-Forwarded-For': from } : {},
  });
  const wrong = await Promise.all(Array.from({ length: 10 }, () => login('falsch', '203.0.113.9')));
  assert.deepEqual(wrong.map((r) => r.status), Array(10).fill(401));
  assert.equal((await login('geheim-geheim', '203.0.113.9')).status, 429);
  assert.equal((await login('geheim-geheim', '198.51.100.7')).status, 303);
  assert.equal((await login('geheim-geheim')).status, 303);
});

test('Neu vergebener Kurzname ist an der agent_id vom Vorgänger zu unterscheiden', async () => {
  await adminPost('/admin/rooms', { slug: 'namen', title: 'Namen' });
  const receiver = await join('namen', 'empfang');
  const first = await join('namen', 'vertraut');
  const firstId = (await call('GET', '/me', first)).json.agent_id;
  const listed = () => call('GET', '/agents', receiver).then((r) => r.json.agents.find((a: any) => a.name === 'vertraut').agent_id);
  assert.equal(await listed(), firstId);
  await call('POST', '/messages', first, { to: ['empfang'], body: 'vom ersten Besitzer' });

  await adminPost('/admin/room/namen/agent', { id: firstId, action: 'revoke' });
  const second = await join('namen', 'vertraut');
  const secondId = (await call('GET', '/me', second)).json.agent_id;
  assert.notEqual(secondId, firstId);
  assert.equal(await listed(), secondId);
  await call('POST', '/messages', second, { to: ['empfang'], body: 'vom neuen Besitzer' });

  const inbox = (await call('GET', '/inbox?wait=0', receiver)).json.messages;
  assert.deepEqual(inbox.map((m: any) => [m.from, m.from_id]), [['vertraut', firstId], ['vertraut', secondId]]);
  const sent = await call('POST', '/messages', receiver, { to: ['vertraut'], body: 'an wen geht das?' });
  assert.equal(sent.json.recipients[0].agent_id, secondId);
});

// ---- MCP-Fassade ----
const mcpPost = async (body: unknown, sid?: string, extra: Record<string, string> = {}) => {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'Mcp-Session-Id': sid } : {}), ...extra },
  });
  return { status: r.status, sid: r.headers.get('mcp-session-id'), json: r.status === 200 ? ((await r.json()) as any) : undefined };
};
const mcpOpen = async () => {
  const init = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.protocolVersion, '2025-06-18');
  assert.match(init.json.result.instructions, /Erstkontakt/);
  assert.equal((await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sid!)).status, 202);
  return init.sid!;
};
let rpcId = 10;
const mcpTool = async (sid: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await mcpPost({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }, sid);
  assert.equal(r.status, 200);
  return { isError: r.json.result.isError === true, data: JSON.parse(r.json.result.content[0].text) };
};

test('MCP: Verbindungsaufbau, Werkzeugliste, Fehlerfälle des Transports', async () => {
  const sid = await mcpOpen();
  const list = await mcpPost({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid);
  assert.deepEqual(list.json.result.tools.map((t: any) => t.name),
    ['registrieren', 'anmelden', 'abmelden', 'wer_bin_ich', 'agenten', 'senden', 'postfach', 'bestaetigen', 'gespraeche', 'gespraech']);
  assert.equal((await mcpPost({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).json.error.code, -32600);
  assert.equal((await mcpPost({ jsonrpc: '2.0', id: 4, method: 'gibt/es/nicht' }, sid)).json.error.code, -32601);
  assert.equal((await mcpPost({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'unbekannt' } }, sid)).json.error.code, -32602);
  assert.equal((await mcpPost({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, sid, { Origin: 'https://boese.example' })).status, 403);
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', body: '{kaputt' })).status, 400);
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
  const unbound = await mcpTool(sid, 'agenten');
  assert.ok(unbound.isError);
  assert.equal(unbound.data.error.code, 'not_logged_in');
});

test('MCP: registrieren, anmelden und Nachrichten mit einem Agenten der HTTP-API austauschen', async () => {
  await adminPost('/admin/rooms', { slug: 'mcp', title: 'MCP' });
  const http = await join('mcp', 'per-http');
  const sid = await mcpOpen();
  const reg = await mcpTool(sid, 'registrieren', { room: 'mcp', invite: await newInvite('mcp'), name: 'per-mcp', owner: 'M', description: 'd' });
  assert.match(reg.data.token, /^vnz_/);
  assert.ok((await mcpTool(sid, 'anmelden', { token: 'vnz_falsch' })).isError);
  const login = await mcpTool(sid, 'anmelden', { token: reg.data.token });
  assert.equal(login.data.agent.name, 'per-mcp');
  assert.equal(login.data.session, undefined);
  assert.equal((await mcpTool(sid, 'wer_bin_ich')).data.agent_id, reg.data.agent_id);
  assert.deepEqual((await mcpTool(sid, 'agenten')).data.agents.map((a: any) => a.name), ['per-http', 'per-mcp']);

  // MCP wartet per Long-Poll, die HTTP-Seite schreibt.
  const waiting = mcpTool(sid, 'postfach', { wait: 5 });
  await new Promise((r) => setTimeout(r, 100));
  const sent = await call('POST', '/messages', http, { to: ['per-mcp'], subject: 'Hallo', body: 'von HTTP' });
  assert.equal(sent.json.recipients[0].presence, 'listening');
  const got = (await waiting).data.messages;
  assert.equal(got[0].body, 'von HTTP');
  assert.equal((await mcpTool(sid, 'bestaetigen', { up_to: got[0].id })).data.unread, 0);
  await mcpTool(sid, 'senden', { thread_id: got[0].thread_id, body: 'von MCP' });
  assert.equal((await call('GET', '/inbox?wait=0', http)).json.messages[0].body, 'von MCP');
  assert.equal((await mcpTool(sid, 'gespraech', { thread_id: got[0].thread_id })).data.messages.length, 2);
  assert.equal((await mcpTool(sid, 'gespraeche')).data.threads.length, 1);
  assert.equal((await mcpTool(sid, 'postfach', { every: 300 })).data.messages.length, 0);
  assert.equal((await call('GET', '/agents', http)).json.agents[1].presence, 'polling');

  // Zwei MCP-Sitzungen, zwei Kennungen: jede sieht nur ihre eigene.
  const sid2 = await mcpOpen();
  const reg2 = await mcpTool(sid2, 'registrieren', { room: 'mcp', invite: await newInvite('mcp'), name: 'zweiter', owner: 'Z', description: 'd' });
  await mcpTool(sid2, 'anmelden', { token: reg2.data.token });
  assert.equal((await mcpTool(sid2, 'wer_bin_ich')).data.name, 'zweiter');
  assert.equal((await mcpTool(sid, 'wer_bin_ich')).data.name, 'per-mcp');

  // Dieselbe Kennung in einer weiteren MCP-Sitzung: erst abgelehnt, nach Ablösen ist die alte Sitzung gelöst.
  const sid3 = await mcpOpen();
  assert.equal((await mcpTool(sid3, 'anmelden', { token: reg.data.token })).data.error.code, 'identity_in_use');
  assert.equal((await mcpTool(sid3, 'anmelden', { token: reg.data.token, takeover: true })).data.agent.name, 'per-mcp');
  assert.equal((await mcpTool(sid, 'wer_bin_ich')).data.error.code, 'not_logged_in');

  assert.deepEqual((await mcpTool(sid3, 'abmelden')).data, { ok: true });
  assert.equal((await mcpTool(sid3, 'agenten')).data.error.code, 'not_logged_in');
  // Beenden der MCP-Sitzung meldet die Kennung ab.
  assert.equal((await fetch(`${base}/mcp`, { method: 'DELETE', headers: { 'Mcp-Session-Id': sid2 } })).status, 204);
  assert.equal(hub.core.one<{ session_id: string | null }>('SELECT session_id FROM agents WHERE id = ?', reg2.data.agent_id)!.session_id, null);
});

test('MCP: Token als Kopfzeile wirkt je Aufruf, auch über wechselnde MCP-Sitzungen', async () => {
  await adminPost('/admin/rooms', { slug: 'kopf', title: 'Kopf' });
  const http = await join('kopf', 'gegenueber');
  const reg = await mcpTool(await mcpOpen(), 'registrieren', { room: 'kopf', invite: await newInvite('kopf'), name: 'ohne-sitzung', owner: 'O', description: 'd' });
  const viaHeader = async (name: string, args: Record<string, unknown> = {}, token = reg.data.token, sid?: string | null) => {
    const r = await mcpPost({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
      sid === null ? undefined : sid ?? await mcpOpen(), { Authorization: `Bearer ${token}` });
    return JSON.parse(r.json.result.content[0].text);
  };
  // Jeder Aufruf in einer neuen MCP-Sitzung, einer ganz ohne.
  assert.equal((await viaHeader('wer_bin_ich')).name, 'ohne-sitzung');
  assert.equal((await viaHeader('senden', { to: ['gegenueber'], body: 'per Kopfzeile' })).recipients[0].name, 'gegenueber');
  assert.equal((await call('GET', '/inbox?wait=0', http)).json.messages[0].from, 'ohne-sitzung');
  assert.equal((await viaHeader('agenten', {}, undefined, null)).agents.length, 2);
  // Alle Aufrufe teilen sich eine Sitzung der Kennung.
  const session = () => hub.core.one<{ session_id: string | null }>('SELECT session_id FROM agents WHERE id = ?', reg.data.agent_id)!.session_id;
  const first = session();
  await viaHeader('postfach');
  assert.equal(session(), first);
  assert.deepEqual(await viaHeader('abmelden'), { ok: true });
  assert.equal(session(), null);
  assert.equal((await viaHeader('wer_bin_ich')).name, 'ohne-sitzung');
  assert.equal((await viaHeader('wer_bin_ich', {}, 'vnz_falsch')).error.code, 'token_invalid');
  // Widerruf wirkt auch hier.
  await adminPost('/admin/room/kopf/agent', { id: reg.data.agent_id, action: 'revoke' });
  assert.equal((await viaHeader('wer_bin_ich')).error.code, 'token_revoked');
});
