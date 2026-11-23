// Dokumentation in der Betreiber-GUI: erreichbar nur angemeldet, jede Seite lädt, Verweise stimmen.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHub } from '../src/hub.ts';
import { docPages } from '../src/docs.ts';

const hub = createHub({ dbPath: ':memory:', adminPassword: 'geheim-geheim', publicUrl: 'https://hub.example.org', log: () => {} });
const server = createServer(hub.handler);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.close(); hub.close(); });

const login = await fetch(`${base}/admin/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ password: 'geheim-geheim' }) });
const cookie = login.headers.get('set-cookie')!.split(';')[0];
const get = (path: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie }, redirect: 'manual' });

test('Dokumentation: nur für den angemeldeten Betreiber', async () => {
  for (const path of ['/admin/docs', '/admin/docs/ueberblick']) {
    const r = await fetch(`${base}${path}`, { redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/admin/login');
  }
});

test('Dokumentation: Menüpunkt und Übersicht mit Anleitungen und Konzepten', async () => {
  const home = await (await get('/admin')).text();
  assert.match(home, /<a href="\/admin\/docs">Dokumentation<\/a>/);
  const index = await (await get('/admin/docs')).text();
  assert.match(index, /<a href="\/admin\/docs" aria-current="page">Dokumentation<\/a>/);
  const pages = docPages('https://hub.example.org');
  assert.ok(pages.filter((p) => p.kind === 'howto').length >= 5);
  assert.ok(pages.filter((p) => p.kind === 'concept').length >= 5);
  for (const p of pages) assert.ok(index.includes(`href="/admin/docs/${p.slug}"`), p.slug);
});

test('Dokumentation: jede Seite lädt, Konzepte haben ein Schaubild, Verweise führen ans Ziel', async () => {
  const pages = docPages('https://hub.example.org');
  const slugs = new Set(pages.map((p) => p.slug));
  assert.equal(slugs.size, pages.length);
  for (const p of pages) {
    const r = await get(`/admin/docs/${p.slug}`);
    assert.equal(r.status, 200, p.slug);
    const html = await r.text();
    assert.ok(html.includes(`<h1>${p.title}</h1>`), p.slug);
    if (p.kind === 'concept') assert.match(html, /<svg class="dia"[^>]* role="img" aria-label="[^"]+"/, p.slug);
    for (const [, target] of html.matchAll(/href="\/admin\/docs\/([a-z0-9-]+)"/g)) assert.ok(slugs.has(target), `${p.slug} → ${target}`);
    for (const slug of p.also) assert.ok(slugs.has(slug), `${p.slug} → ${slug}`);
    // Keine Skripte und keine Platzhalter-Adresse: die Beispiele nennen diesen Hub.
    assert.doesNotMatch(p.body, /<script|undefined|NaN/);
  }
  const kanal = await (await get('/admin/docs/kanal-einrichten')).text();
  assert.ok(kanal.includes('https://hub.example.org/adapter'));
  assert.equal((await get('/admin/docs/gibt-es-nicht')).status, 404);
});
