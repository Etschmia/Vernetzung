import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHub } from '../src/hub.ts';
import {
  fromSecret, makeHello, makeWelcome, newGroupKey, newSecret, openHello, openMessage, openWelcome, sealMessage,
} from './links-crypto.ts';

const hub = createHub({ dbPath: ':memory:', adminPassword: 'geheim-geheim', log: () => {} });
const server = createServer(hub.handler);
let base = '';
let cookie = '';
let key = '';

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/admin/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ password: 'geheim-geheim' }) });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  key = await newKey('Testschlüssel', 50);
});
after(() => {
  hub.close();
  server.close();
  server.closeAllConnections();
});

const call = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}/api/v1/links${path}`, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  });
  return { status: r.status, json: (await r.json()) as any };
};
const adminPost = (path: string, form: Record<string, string>) =>
  fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
const adminPage = async () => (await fetch(`${base}/admin/links`, { headers: { Cookie: cookie } })).text();
async function newKey(label: string, max: number) {
  const r = await adminPost('/admin/links/keys', { label, links_max: String(max) });
  assert.equal(r.status, 200);
  return /<code class="key">(vnk_[\w-]+)<\/code>/.exec(await r.text())![1];
}
const poll = async (members: unknown[], wait = 0) => (await call('POST', '/poll', undefined, { wait, members })).json.results as any[];
const BOX = Buffer.from('nur Testdaten, kein echtes Chiffrat').toString('base64url');

// Legt eine Verbindung an; `guests` treten bei und werden angenommen. Ohne echte Verschlüsselung.
const setup = async (guests = 1, seats = Math.max(2, guests + 1)) => {
  const inv = newSecret();
  const made = await call('POST', '', key, { seats, join_hash: inv.joinHash });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const id = made.json.link_id as string;
  const host = { id: made.json.member_id as string, token: made.json.member_token as string };
  const members = [host];
  for (let i = 0; i < guests; i++) {
    const j = await call('POST', `/${id}/join`, inv.joinToken, { hello: BOX });
    assert.equal(j.status, 201, JSON.stringify(j.json));
    assert.equal((await call('POST', `/${id}/members/${j.json.member_id}/admit`, host.token, { welcome: BOX })).status, 200);
    members.push({ id: j.json.member_id, token: j.json.member_token });
    // Schlüssel abgeholt: sonst meldet jede Abfrage das wartende `welcome` und kehrt sofort zurück.
    await poll([{ token: j.json.member_token, have_key: true }]);
  }
  return { id, inv, host, members };
};

test('Info nennt die Grenzen; ein Zugangsschlüssel wird geprüft', async () => {
  const open = await call('GET', '/info');
  assert.equal(open.status, 200);
  assert.deepEqual(
    { version: open.json.links.version, seats: open.json.links.seats_max, box: open.json.links.box_max, ttl: open.json.links.invite_ttl },
    { version: 1, seats: 8, box: 32768, ttl: 86400 });
  assert.equal(open.json.key, undefined);
  assert.equal((await call('GET', '/info', 'vnk_erfunden')).json.error.code, 'key_invalid');
  const mine = await call('GET', '/info', key);
  assert.deepEqual({ label: mine.json.key.label, max: mine.json.key.links_max }, { label: 'Testschlüssel', max: 50 });
});

test('Anlegen verlangt Zugangsschlüssel, gültige Plätze und den Hash des Beitritts-Tokens', async () => {
  const { joinHash } = newSecret();
  assert.equal((await call('POST', '', undefined, { join_hash: joinHash })).json.error.code, 'key_invalid');
  assert.equal((await call('POST', '', key, { seats: 9, join_hash: joinHash })).json.error.code, 'seats_invalid');
  assert.equal((await call('POST', '', key, { seats: 1, join_hash: joinHash })).json.error.code, 'seats_invalid');
  assert.equal((await call('POST', '', key, { seats: 2 })).json.error.code, 'field_missing');
  assert.equal((await call('POST', '', key, { seats: 2, join_hash: 'kein-hash' })).json.error.code, 'field_invalid');
  const made = await call('POST', '', key, { seats: 3, join_hash: joinHash });
  assert.equal(made.status, 201);
  assert.match(made.json.link_id, /^ln_/);
  assert.equal(made.json.url, `${base}/l/${made.json.link_id}`);
  assert.equal(made.json.rev, 1);
  // Der Hub speichert vom Mitglieds-Token nur den Hash.
  assert.equal(hub.core.one('SELECT 1 FROM link_members WHERE token_hash = ?', made.json.member_token), undefined);
});

test('Zugangsschlüssel begrenzt die Zahl aktiver Verbindungen; Widerruf sperrt nur das Anlegen', async () => {
  const small = await newKey('Klein', 1);
  const first = await call('POST', '', small, { join_hash: newSecret().joinHash });
  assert.equal(first.status, 201);
  assert.equal((await call('POST', '', small, { join_hash: newSecret().joinHash })).json.error.code, 'links_limit');
  // Endet die Verbindung, ist der Platz wieder frei.
  assert.equal((await call('DELETE', `/${first.json.link_id}/members/me`, first.json.member_token)).status, 200);
  const second = await call('POST', '', small, { join_hash: newSecret().joinHash });
  assert.equal(second.status, 201);

  const id = hub.core.one<{ id: string }>("SELECT id FROM link_keys WHERE label = 'Klein'")!.id;
  assert.equal((await adminPost('/admin/links/keys/revoke', { id })).status, 303);
  assert.equal((await call('POST', '', small, { join_hash: newSecret().joinHash })).json.error.code, 'key_revoked');
  assert.equal((await call('GET', '/info', small)).json.error.code, 'key_revoked');
  const [still] = await poll([{ token: second.json.member_token }]);
  assert.equal(still.status, 'active');
});

test('Landeseite ist für jede Kennung dieselbe, ohne Skript', async () => {
  const { id } = await setup(0);
  const real = await fetch(`${base}/l/${id}`);
  const fake = await fetch(`${base}/l/ln_gibtsnicht`);
  assert.equal(real.status, 200);
  assert.equal(fake.status, 200);
  const body = await real.text();
  assert.equal(body, await fake.text());
  assert.ok(!/<script/i.test(body));
  assert.match(real.headers.get('content-security-policy')!, /default-src 'none'/);
  assert.equal(real.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(real.headers.get('cache-control'), 'no-store');
});

test('Ganzer Ablauf mit echter Verschlüsselung: einladen, beitreten, annehmen, schreiben, lesen', async () => {
  // Anna legt an. Geheimnis und Gruppenschlüssel bleiben bei ihr.
  const inv = newSecret();
  const groupKey = newGroupKey();
  const made = await call('POST', '', key, { seats: 2, join_hash: inv.joinHash });
  const linkId = made.json.link_id as string;
  const anna = { id: made.json.member_id as string, token: made.json.member_token as string };
  const url = `${made.json.url}#${inv.secret}`;

  // Bert bekommt die Adresse auf anderem Weg und stellt sein Gesuch.
  const got = new URL(url);
  const bertInv = fromSecret(got.hash.slice(1));
  const bertLink = got.pathname.split('/').pop()!;
  const mine = makeHello(bertInv.inviteKey, bertLink, 'Bert (Partner GmbH)');
  const asked = await call('POST', `/${bertLink}/join`, bertInv.joinToken, { hello: mine.hello });
  assert.equal(asked.status, 201);
  assert.equal(asked.json.status, 'pending');
  const bert = { id: asked.json.member_id as string, token: asked.json.member_token as string };
  assert.equal((await poll([{ token: bert.token }]))[0].status, 'pending');
  assert.equal((await call('POST', `/${linkId}/messages`, bert.token, { box: BOX })).json.error.code, 'not_active');

  // Anna sieht das Gesuch, prüft es mit dem Einladungsschlüssel und nimmt an.
  const [state] = await poll([{ token: anna.token, rev: 1 }]);
  assert.equal(state.inviter, anna.id);
  assert.equal(state.requests.length, 1);
  const request = openHello(inv.inviteKey, linkId, state.requests[0].hello);
  assert.equal(request.name, 'Bert (Partner GmbH)');
  const welcome = makeWelcome(inv.inviteKey, linkId, bert.id, request.pub,
    { key_no: 1, key: groupKey.toString('base64url'), members: [{ id: anna.id, name: 'Anna' }] });
  const admitted = await call('POST', `/${linkId}/members/${bert.id}/admit`, anna.token, { welcome });
  assert.equal(admitted.status, 200);

  // Bert holt den Schlüssel ab; danach vergisst der Hub den Umschlag.
  const [first] = await poll([{ token: bert.token }]);
  assert.equal(first.status, 'active');
  const opened = openWelcome(bertInv.inviteKey, linkId, bert.id, mine.privateKey, first.welcome);
  assert.deepEqual(opened.members, [{ id: anna.id, name: 'Anna' }]);
  const bertKeys = new Map([[opened.key_no as number, Buffer.from(opened.key, 'base64url')]]);
  const [second] = await poll([{ token: bert.token, rev: first.rev, have_key: true }]);
  assert.equal(second.welcome, undefined);
  assert.equal(hub.core.one<{ welcome: string | null }>('SELECT welcome FROM link_members WHERE id = ?', bert.id)!.welcome, null);

  // Anna schreibt, Bert liest.
  const plain = { t: 'msg', n: 1, name: 'Anna', text: 'Wie habt ihr die Schnittstelle gebaut?' };
  const sent = await call('POST', `/${linkId}/messages`, anna.token, { box: sealMessage(groupKey, 1, linkId, anna.id, plain) });
  assert.equal(sent.status, 201);
  assert.deepEqual(sent.json.recipients, [{ member_id: bert.id, presence: 'listening' }]);
  const [inbox] = await poll([{ token: bert.token, rev: second.rev, ack: 0 }]);
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].from, anna.id);
  assert.deepEqual(openMessage(bertKeys, linkId, inbox.messages[0].from, inbox.messages[0].box), plain);
  // Gäbe der Hub einen anderen Absender an, scheiterte die Entschlüsselung.
  assert.throws(() => openMessage(bertKeys, linkId, bert.id, inbox.messages[0].box));

  // Der Hub hat weder Namen noch Text gespeichert.
  const dump = JSON.stringify([
    hub.core.all('SELECT * FROM links'), hub.core.all('SELECT * FROM link_members'), hub.core.all('SELECT * FROM link_messages')]);
  for (const word of ['Anna', 'Bert', 'Schnittstelle', inv.secret, groupKey.toString('base64url')]) assert.ok(!dump.includes(word), word);

  // Nach der Bestätigung lagert nichts mehr.
  const [empty] = await poll([{ token: bert.token, rev: inbox.rev, ack: inbox.messages[0].seq }]);
  assert.deepEqual(empty.messages, []);
  assert.equal(hub.core.one<{ n: number }>('SELECT COUNT(*) AS n FROM link_messages WHERE link_id = ?', linkId)!.n, 0);
});

test('Beitritt: falsches Token und unbekannte Verbindung sind nicht unterscheidbar; voll und abgelaufen werden gemeldet', async () => {
  const { id, inv } = await setup(0, 2);
  const wrong = await call('POST', `/${id}/join`, newSecret().joinToken, { hello: BOX }, { 'X-Forwarded-For': '203.0.113.1' });
  const unknown = await call('POST', '/ln_gibtsnicht/join', inv.joinToken, { hello: BOX }, { 'X-Forwarded-For': '203.0.113.1' });
  assert.equal(wrong.status, 404);
  assert.deepEqual(wrong.json, unknown.json);
  assert.equal((await call('POST', `/${id}/join`, inv.joinToken, {})).json.error.code, 'field_missing');
  assert.equal((await call('POST', `/${id}/join`, inv.joinToken, { hello: 'nicht base64url!' })).json.error.code, 'field_invalid');
  assert.equal((await call('POST', `/${id}/join`, inv.joinToken, { hello: 'A'.repeat(4000) })).json.error.code, 'envelope_too_large');

  // Ein wartendes Gesuch belegt den zweiten Platz.
  assert.equal((await call('POST', `/${id}/join`, inv.joinToken, { hello: BOX })).status, 201);
  assert.equal((await call('POST', `/${id}/join`, inv.joinToken, { hello: BOX })).json.error.code, 'link_full');

  const late = await setup(0);
  hub.core.run('UPDATE links SET invite_expires_at = ? WHERE id = ?', Date.now() - 1000, late.id);
  const expired = await call('POST', `/${late.id}/join`, late.inv.joinToken, { hello: BOX });
  assert.equal(expired.status, 410);
  assert.equal(expired.json.error.code, 'invite_expired');
});

test('Zehn Fehlversuche beim Beitritt sperren diese Client-Adresse, andere nicht', async () => {
  const { id, inv } = await setup(0);
  const from = (address: string, token: string) =>
    call('POST', `/${id}/join`, token, { hello: BOX }, { 'X-Forwarded-For': address });
  for (let i = 0; i < 10; i++) assert.equal((await from('203.0.113.7', 'falsch')).status, 404);
  assert.equal((await from('203.0.113.7', inv.joinToken)).json.error.code, 'rate_limited');
  assert.equal((await from('203.0.113.8', inv.joinToken)).status, 201);
});

test('Über Gesuche entscheidet nur der Einladende; Ablehnung erreicht den Beitretenden', async () => {
  const { id, inv, host, members } = await setup(1, 4);
  const guest = members[1];
  const asked = await call('POST', `/${id}/join`, inv.joinToken, { hello: BOX });
  const target = asked.json.member_id as string;
  assert.equal((await call('POST', `/${id}/members/${target}/admit`, guest.token, { welcome: BOX })).json.error.code, 'not_inviter');
  assert.equal((await call('DELETE', `/${id}/members/${target}`, guest.token)).json.error.code, 'not_inviter');
  // Gesuche sieht nur der Einladende.
  assert.equal((await poll([{ token: guest.token }]))[0].requests, undefined);
  assert.equal((await poll([{ token: host.token }]))[0].requests.length, 1);
  // Ein aktives Mitglied kann niemand hinauswerfen.
  assert.equal((await call('DELETE', `/${id}/members/${guest.id}`, host.token)).json.error.code, 'not_pending');
  assert.equal((await call('POST', `/${id}/members/${target}/admit`, host.token, {})).json.error.code, 'field_missing');

  assert.equal((await call('DELETE', `/${id}/members/${target}`, host.token)).status, 200);
  const [told] = await poll([{ token: asked.json.member_token }]);
  assert.deepEqual({ status: told.status, reason: told.reason }, { status: 'rejected', reason: 'declined' });
  assert.equal((await call('POST', `/${id}/members/${target}/admit`, host.token, { welcome: BOX })).json.error.code, 'not_pending');
  assert.equal((await poll([{ token: host.token }]))[0].members.length, 2);
});

test('Ein neues Mitglied beginnt beim aktuellen Stand und bekommt Früheres nicht', async () => {
  const { id, inv, host, members } = await setup(1, 3);
  assert.equal((await call('POST', `/${id}/messages`, host.token, { box: BOX })).json.seq, 1);
  const asked = await call('POST', `/${id}/join`, inv.joinToken, { hello: BOX });
  await call('POST', `/${id}/members/${asked.json.member_id}/admit`, host.token, { welcome: BOX });
  assert.deepEqual((await poll([{ token: asked.json.member_token }]))[0].messages, []);
  assert.equal((await poll([{ token: members[1].token }]))[0].messages.length, 1);
  assert.equal((await call('POST', `/${id}/messages`, host.token, { box: BOX })).json.seq, 2);
  assert.deepEqual((await poll([{ token: asked.json.member_token }]))[0].messages.map((m: any) => m.seq), [2]);
});

test('Eine Abfrage bedient mehrere Mitgliedschaften; unbekannte Tokens stören die übrigen nicht', async () => {
  const one = await setup(1);
  const two = await setup(1);
  await call('POST', `/${one.id}/messages`, one.host.token, { box: BOX });
  const results = await poll([{ token: one.members[1].token }, { token: 'lmt_erfunden' }, { token: two.members[1].token }]);
  assert.equal(results.length, 3);
  assert.equal(results[0].messages.length, 1);
  assert.equal(results[1].error.code, 'member_unknown');
  assert.deepEqual({ link: results[2].link_id, messages: results[2].messages }, { link: two.id, messages: [] });
  assert.equal((await call('POST', '/poll', undefined, { members: [] })).json.error.code, 'field_missing');
  assert.equal((await call('POST', '/poll', undefined, { members: [{ ack: 1 }] })).json.error.code, 'field_invalid');
  assert.equal((await call('POST', '/poll', undefined, { members: [{ token: 'x', ack: -1 }] })).json.error.code, 'field_invalid');
  assert.equal((await call('POST', '/poll', undefined,
    { members: Array.from({ length: 129 }, () => ({ token: 'x' })) })).json.error.code, 'too_many_members');
});

test('Long-Poll: wartet bei bekanntem Stand und wird von Nachricht und Gesuch geweckt', async () => {
  const { id, inv, host, members } = await setup(1, 3);
  const guest = members[1];
  const rev = (await poll([{ token: guest.token }]))[0].rev;
  const hostRev = (await poll([{ token: host.token }]))[0].rev;

  // Nichts Neues: die Abfrage läuft in die Wartezeit.
  const started = Date.now();
  const [idle] = await poll([{ token: guest.token, rev }], 1);
  assert.ok(Date.now() - started >= 900);
  assert.deepEqual({ rev: idle.rev, messages: idle.messages, members: idle.members }, { rev, messages: [], members: undefined });

  const waiting = poll([{ token: guest.token, rev }], 20);
  await new Promise((r) => setTimeout(r, 50));
  const sent = await call('POST', `/${id}/messages`, host.token, { box: BOX });
  assert.deepEqual(sent.json.recipients, [{ member_id: guest.id, presence: 'listening' }]);
  assert.equal((await waiting)[0].messages.length, 1);

  const hostWaiting = poll([{ token: host.token, rev: hostRev }], 20);
  await new Promise((r) => setTimeout(r, 50));
  await call('POST', `/${id}/join`, inv.joinToken, { hello: BOX });
  const [woken] = await hostWaiting;
  assert.equal(woken.requests.length, 1);
  assert.ok(woken.rev > hostRev);
});

test('Senden: Größe, Form, Rate, Rückstau und fehlende Empfänger', async () => {
  const alone = await setup(0);
  assert.equal((await call('POST', `/${alone.id}/messages`, alone.host.token, { box: BOX })).json.error.code, 'no_recipients');

  const { id, host, members } = await setup(1);
  assert.equal((await call('POST', `/${id}/messages`, 'lmt_erfunden', { box: BOX })).json.error.code, 'member_unknown');
  assert.equal((await call('POST', `/${id}/messages`, alone.host.token, { box: BOX })).json.error.code, 'member_unknown');
  assert.equal((await call('POST', `/${id}/messages`, host.token, { box: 'mit leerzeichen' })).json.error.code, 'field_invalid');
  const big = await call('POST', `/${id}/messages`, host.token, { box: 'A'.repeat(44_000) });
  assert.deepEqual({ status: big.status, code: big.json.error.code }, { status: 413, code: 'box_too_large' });
  assert.equal((await call('POST', `/${id}/messages`, host.token, { box: 'A'.repeat(43_000) })).status, 201);

  // Rückstau: holt der Empfänger nicht ab, nimmt der Hub irgendwann nichts mehr an.
  for (let seq = 100; seq < 600; seq++)
    hub.core.run('INSERT INTO link_messages (link_id, seq, from_member, box, sent_at) VALUES (?, ?, ?, ?, ?)', id, seq, host.id, 'AAAA', Date.now());
  assert.equal((await call('POST', `/${id}/messages`, host.token, { box: BOX })).json.error.code, 'backlog_full');
  hub.core.run('DELETE FROM link_messages WHERE link_id = ?', id);

  // Rate: 30 pro Minute und Mitglied (drei Versuche oben zählen mit).
  let last = 201;
  for (let i = 0; i < 28 && last === 201; i++) last = (await call('POST', `/${id}/messages`, members[1].token, { box: BOX })).status;
  assert.equal(last, 201);
  for (let i = 0; i < 3; i++) last = (await call('POST', `/${id}/messages`, members[1].token, { box: BOX })).status;
  assert.equal(last, 429);
});

test('Einladung erneuern: neuer Einladender, alte Gesuche verfallen; zurückziehen schließt den Beitritt', async () => {
  const { id, inv, host, members } = await setup(1, 4);
  const guest = members[1];
  const old = await call('POST', `/${id}/join`, inv.joinToken, { hello: BOX });
  const next = newSecret();
  const renewed = await call('PUT', `/${id}/invite`, guest.token, { join_hash: next.joinHash });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.json.url, `${base}/l/${id}`);
  assert.equal((await poll([{ token: old.json.member_token }]))[0].reason, 'invite_renewed');
  assert.equal((await call('POST', `/${id}/join`, inv.joinToken, { hello: BOX })).status, 404);

  const asked = await call('POST', `/${id}/join`, next.joinToken, { hello: BOX });
  assert.equal(asked.status, 201);
  const [hostState] = await poll([{ token: host.token }]);
  assert.equal(hostState.inviter, guest.id);
  assert.equal(hostState.requests, undefined);
  assert.equal((await call('POST', `/${id}/members/${asked.json.member_id}/admit`, host.token, { welcome: BOX })).json.error.code, 'not_inviter');

  assert.equal((await call('DELETE', `/${id}/invite`, host.token)).status, 200);
  assert.equal((await poll([{ token: asked.json.member_token }]))[0].reason, 'invite_withdrawn');
  assert.equal((await call('POST', `/${id}/join`, next.joinToken, { hello: BOX })).status, 404);
  const [after] = await poll([{ token: host.token }]);
  assert.deepEqual({ inviter: after.inviter, expires: after.invite_expires_at }, { inviter: null, expires: null });

  // Sind alle Plätze vergeben, gibt es keine neue Einladung.
  const full = await setup(1, 2);
  assert.equal((await call('PUT', `/${full.id}/invite`, full.host.token, { join_hash: newSecret().joinHash })).json.error.code, 'link_full');
});

test('Verlassen: der Platz wird frei, mit dem Einladenden erlischt die Einladung, mit dem letzten Mitglied die Verbindung', async () => {
  const { id, inv, host, members } = await setup(2, 3);
  const [, b, c] = members;
  const pendingLeft = await setup(0);
  const asked = await call('POST', `/${pendingLeft.id}/join`, pendingLeft.inv.joinToken, { hello: BOX });
  assert.equal((await call('DELETE', `/${pendingLeft.id}/members/me`, asked.json.member_token)).status, 200);
  assert.equal((await poll([{ token: pendingLeft.host.token }]))[0].members.length, 1);

  await call('POST', `/${id}/messages`, b.token, { box: BOX });
  const waiting = poll([{ token: c.token, rev: (await poll([{ token: c.token }]))[0].rev, ack: 1 }], 20);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await call('DELETE', `/${id}/members/me`, host.token)).status, 200);
  const [woken] = await waiting;
  assert.deepEqual(woken.members.map((m: any) => m.member_id), [b.id, c.id]);
  assert.equal(woken.inviter, null);
  assert.equal((await call('POST', `/${id}/join`, inv.joinToken, { hello: BOX })).status, 404);
  assert.equal((await poll([{ token: host.token }]))[0].error.code, 'member_unknown');
  // Die Nachricht wartete nur noch auf den Gegangenen.
  assert.equal(hub.core.one<{ n: number }>('SELECT COUNT(*) AS n FROM link_messages WHERE link_id = ?', id)!.n, 0);

  await call('DELETE', `/${id}/members/me`, b.token);
  await call('DELETE', `/${id}/members/me`, c.token);
  assert.equal(hub.core.one('SELECT 1 FROM links WHERE id = ?', id), undefined);
  assert.equal((await call('DELETE', `/${id}/members/me`, c.token)).json.error.code, 'member_unknown');
});

test('Aufräumen: alte Nachrichten hinterlassen eine gemeldete Lücke, Gesuche und stille Mitglieder verfallen', async () => {
  const { id, inv, host, members } = await setup(1, 3);
  const guest = members[1];
  for (let i = 0; i < 3; i++) await call('POST', `/${id}/messages`, host.token, { box: BOX });
  const day = 86_400_000;
  hub.core.run('UPDATE link_messages SET sent_at = ? WHERE link_id = ? AND seq <= 2', Date.now() - 8 * day, id);
  hub.links.cleanup();
  const [lossy] = await poll([{ token: guest.token }]);
  assert.deepEqual(lossy.gap, { from: 1, to: 2 });
  assert.deepEqual(lossy.messages.map((m: any) => m.seq), [3]);
  // Der Absender selbst hat nichts verloren.
  assert.equal((await poll([{ token: host.token }]))[0].gap, undefined);
  assert.equal((await poll([{ token: guest.token, ack: 3 }]))[0].gap, undefined);

  const asked = await call('POST', `/${id}/join`, inv.joinToken, { hello: BOX });
  hub.core.run('UPDATE link_members SET created_at = ? WHERE id = ?', Date.now() - 2 * day, asked.json.member_id);
  hub.links.cleanup();
  assert.equal((await poll([{ token: asked.json.member_token }]))[0].reason, 'request_expired');
  // Der Vermerk selbst verschwindet nach einem Tag.
  hub.core.run('UPDATE link_members SET changed_at = ? WHERE id = ?', Date.now() - 2 * day, asked.json.member_id);
  hub.links.cleanup();
  assert.equal((await poll([{ token: asked.json.member_token }]))[0].error.code, 'member_unknown');

  hub.core.run('UPDATE link_members SET last_poll = ? WHERE id = ?', Date.now() - 31 * day, guest.id);
  hub.links.cleanup();
  assert.equal((await poll([{ token: guest.token }]))[0].error.code, 'member_unknown');
  assert.deepEqual((await poll([{ token: host.token }]))[0].members.map((m: any) => m.member_id), [host.id]);
  hub.core.run('UPDATE link_members SET last_poll = ? WHERE id = ?', Date.now() - 31 * day, host.id);
  hub.links.cleanup();
  assert.equal(hub.core.one('SELECT 1 FROM links WHERE id = ?', id), undefined);
});

test('GUI: zeigt den Bestand ohne Inhalte, löscht Verbindungen und stellt Grenzen ein', async () => {
  assert.equal((await fetch(`${base}/admin/links`, { redirect: 'manual' })).status, 303);
  const { id, host, members } = await setup(1);
  await call('POST', `/${id}/messages`, host.token, { box: BOX });
  const page = await adminPage();
  assert.ok(page.includes(id));
  assert.ok(page.includes('Testschlüssel'));
  assert.ok(!page.includes(BOX));
  assert.ok(!page.includes(key));

  const waiting = poll([{ token: members[1].token, rev: (await poll([{ token: members[1].token, ack: 1 }]))[0].rev, ack: 1 }], 20);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await adminPost('/admin/links/delete', { id })).status, 303);
  assert.equal((await waiting)[0].error.code, 'member_unknown');
  assert.ok(!(await adminPage()).includes(id));

  assert.equal((await adminPost('/admin/links/limits', { invite_hours: '2', message_days: '999', idle_days: '10' })).status, 303);
  const info = (await call('GET', '/info')).json.links;
  assert.deepEqual({ invite: info.invite_ttl, message: info.message_ttl, idle: info.idle_ttl },
    { invite: 7200, message: 90 * 86400, idle: 10 * 86400 });
  await adminPost('/admin/links/limits', { invite_hours: '24', message_days: '7', idle_days: '30' });
  const foreign = await fetch(`${base}/admin/links/keys`, { method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie, Origin: 'https://boese.example' }, body: new URLSearchParams({ label: 'fremd' }) });
  assert.equal(foreign.status, 403);
});

test('Die Agenten-API bleibt unberührt: unbekannte Pfade unter /links und Räume daneben', async () => {
  assert.equal((await call('GET', '/gibtsnicht')).json.error.code, 'not_found');
  assert.equal((await call('GET', '')).json.error.code, 'not_found');
  const agents = await fetch(`${base}/api/v1/agents`);
  assert.equal(((await agents.json()) as any).error.code, 'token_missing');
});
