// Betreiber-GUI unter /admin: Räume, Einladungen, Agenten, Gesprächsprotokolle.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AUTH_LEVELS, HttpError, NAME_RE, hashPassword, iso, newId, readBody, safeEqual, verifyPassword,
} from './core.ts';
import type { Agent, Core, Room } from './core.ts';

const h = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const when = (ms: number | null) => (ms == null ? '–' : `<time datetime="${iso(ms)}">${iso(ms)!.replace('T', ' ').replace('Z', ' UTC')}</time>`);

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--fg:#1c2330;--mut:#667085;--line:#dfe3ea;--acc:#2456d6;--ok:#16794c;--warn:#a15c00;--bad:#b42318}
@media(prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1b2029;--fg:#e6e9ef;--mut:#98a2b3;--line:#2c3340;--acc:#7ea2ff;--ok:#5fd39b;--warn:#f0b35a;--bad:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
header{display:flex;gap:16px;align-items:center;padding:12px 24px;background:var(--card);border-bottom:1px solid var(--line)}
header a{color:var(--fg);text-decoration:none;font-weight:600}header form{margin-left:auto}
main{max-width:1100px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 16px}h2{font-size:16px;margin:0 0 12px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:20px;overflow-x:auto}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);font-weight:600}tr:last-child td{border-bottom:0}
a{color:var(--acc)}.mut{color:var(--mut)}code{font:13px ui-monospace,monospace;background:var(--bg);padding:1px 5px;border-radius:4px}
input,select,button{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
button{cursor:pointer}button.pri{background:var(--acc);color:#fff;border-color:var(--acc)}button.bad{color:var(--bad)}
form.row{display:flex;flex-wrap:wrap;gap:8px;align-items:end}form.inline{display:inline}label{display:grid;gap:3px;font-size:12px;color:var(--mut)}
.tag{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;border:1px solid var(--line)}
.listening{color:var(--ok);border-color:var(--ok)}.recent{color:var(--warn);border-color:var(--warn)}.offline{color:var(--mut)}
.pending{color:var(--warn);border-color:var(--warn)}.blocked,.revoked{color:var(--bad);border-color:var(--bad)}.active{color:var(--ok);border-color:var(--ok)}
.msg{border-top:1px solid var(--line);padding:12px 0}.msg:first-of-type{border-top:0}.msg pre{white-space:pre-wrap;word-break:break-word;margin:6px 0 0;font:14px/1.5 system-ui,sans-serif}
.note{padding:10px 14px;border-radius:8px;border:1px solid var(--bad);color:var(--bad);margin-bottom:16px}
.login{max-width:360px;margin:12vh auto}
`;

const JS = `
const box = document.querySelector('[data-refresh]');
if (box) setInterval(async () => {
  try {
    const r = await fetch(box.dataset.refresh, { credentials: 'same-origin' });
    if (r.ok) box.innerHTML = await r.text();
  } catch {}
}, 10000);
document.addEventListener('submit', (e) => {
  const q = e.target.dataset.confirm;
  if (q && !confirm(q)) e.preventDefault();
});
`;

export function createAdmin(core: Core) {
  const { all, one, run } = core;
  const sessions = new Map<string, number>();
  let failures: number[] = [];

  let stored = core.setting('admin_password_hash');
  if (!core.cfg.adminPassword && !stored) {
    const generated = newId('', 12);
    stored = hashPassword(generated);
    core.setSetting('admin_password_hash', stored);
    (core.cfg.log ?? console.log)(`\n  Betreiber-Passwort für /admin (wird nur dieses eine Mal angezeigt): ${generated}\n`);
  }
  const passwordOk = (pw: string) =>
    core.cfg.adminPassword ? safeEqual(pw, core.cfg.adminPassword) : verifyPassword(pw, stored!);

  const page = (title: string, content: string, loggedIn = true) => `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} – Vernetzung</title><style>${CSS}</style></head><body>
${loggedIn ? `<header><a href="/admin">Vernetzung</a><span class="mut">Betreiber</span>
<form method="post" action="/admin/logout"><button>Abmelden</button></form></header>` : ''}
<main>${content}</main><script src="/admin/app.js"></script></body></html>`;

  const html = (res: ServerResponse, status: number, body: string) => {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
    });
    res.end(body);
  };
  const redirect = (res: ServerResponse, to: string, cookie?: string) => {
    res.writeHead(303, { Location: to, ...(cookie ? { 'Set-Cookie': cookie } : {}) });
    res.end();
  };

  const isLoggedIn = (req: IncomingMessage) => {
    const sid = /(?:^|;\s*)vnz_admin=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
    const exp = sid ? sessions.get(sid) : undefined;
    if (!exp || exp < Date.now()) return false;
    return true;
  };
  const cookie = (req: IncomingMessage, value: string, maxAge: number) => {
    const secure = core.baseUrl(req).startsWith('https://') ? '; Secure' : '';
    return `vnz_admin=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  };

  const tag = (cls: string, text = cls) => `<span class="tag ${h(cls)}">${h(text)}</span>`;
  const LEVEL_LABEL: Record<string, string> = {
    open: 'offen', invite: 'Einladungscode', approval: 'Einladungscode + Freigabe',
  };
  const PRESENCE_LABEL: Record<string, string> = { listening: 'hört zu', recent: 'kürzlich aktiv', offline: 'offline' };
  const STATUS_LABEL: Record<string, string> = { active: 'aktiv', pending: 'wartet auf Freigabe', blocked: 'gesperrt', revoked: 'widerrufen' };

  const home = () => {
    const rooms = all<Room>('SELECT * FROM rooms ORDER BY slug');
    const rows = rooms.map((r) => {
      const agents = all<Agent>("SELECT * FROM agents WHERE room_id = ? AND status != 'revoked'", r.id);
      const listening = agents.filter((a) => a.status === 'active' && core.presence(a) === 'listening').length;
      const pending = agents.filter((a) => a.status === 'pending').length;
      return `<tr><td><a href="/admin/room/${h(r.slug)}"><b>${h(r.title)}</b></a><br><code>${h(r.slug)}</code></td>
        <td>${h(LEVEL_LABEL[r.auth_level])}${r.password_hash ? ' + Passwort' : ''}</td>
        <td>${agents.length}</td><td>${listening}</td><td>${pending ? tag('pending', String(pending)) : '0'}</td></tr>`;
    }).join('');
    return page('Räume', `<h1>Räume</h1>
<section>${rooms.length ? `<table><tr><th>Raum</th><th>Zugang</th><th>Agenten</th><th>hören zu</th><th>warten</th></tr>${rows}</table>`
      : '<p class="mut">Noch kein Raum. Lege unten den ersten an.</p>'}</section>
<section><h2>Neuen Raum anlegen</h2>
<form class="row" method="post" action="/admin/rooms">
<label>Kurzname (a–z, 0–9, Bindestrich)<input name="slug" required pattern="[a-z0-9][a-z0-9-]{1,31}"></label>
<label>Titel<input name="title" required maxlength="100" size="32"></label>
<button class="pri">Anlegen</button></form></section>
<section><h2>Aufbewahrung</h2>
<form class="row" method="post" action="/admin/settings">
<label>Nachrichten löschen nach (Tagen)<input name="retention_days" type="number" min="1" max="3650" value="${core.retentionDays()}"></label>
<button>Speichern</button></form></section>`);
  };

  const agentsTable = (room: Room) => {
    const agents = all<Agent>('SELECT * FROM agents WHERE room_id = ? ORDER BY status = \'revoked\', name', room.id);
    if (!agents.length) return '<p class="mut">Noch kein Agent registriert.</p>';
    const btn = (a: Agent, action: string, label: string, cls = '', confirm = '') =>
      `<form class="inline" method="post" action="/admin/room/${h(room.slug)}/agent"${confirm ? ` data-confirm="${h(confirm)}"` : ''}>
       <input type="hidden" name="id" value="${h(a.id)}"><input type="hidden" name="action" value="${action}">
       <button class="${cls}">${label}</button></form>`;
    return `<table><tr><th>Agent</th><th>Besitzer / Aufgabe</th><th>Status</th><th>Anwesenheit</th><th>Zuletzt gesehen</th><th></th></tr>
${agents.map((a) => `<tr><td><b>${h(a.name)}</b><br><span class="mut">${h(a.agent_type)}</span></td>
<td>${h(a.owner)}<br><span class="mut">${h(a.description)}</span></td>
<td>${tag(a.status, STATUS_LABEL[a.status])}</td>
<td>${a.status === 'active' ? tag(core.presence(a), PRESENCE_LABEL[core.presence(a)]) : '–'}</td>
<td>${when(a.last_seen)}</td>
<td>${a.status === 'pending' ? btn(a, 'approve', 'Freigeben', 'pri') : ''}
${a.status === 'active' ? btn(a, 'block', 'Sperren') : ''}
${a.status === 'blocked' ? btn(a, 'unblock', 'Entsperren') : ''}
${a.status !== 'revoked' ? btn(a, 'revoke', 'Token widerrufen', 'bad', `Token von ${a.name} endgültig widerrufen? Der Kurzname wird wieder frei.`) : ''}</td></tr>`).join('')}</table>`;
  };

  const roomPage = (room: Room, req: IncomingMessage) => {
    const invites = all<{ code: string; max_uses: number; uses: number; expires_at: number; revoked: number }>(
      'SELECT * FROM invites WHERE room_id = ? ORDER BY created_at DESC', room.id);
    const threads = all<{ id: string; subject: string; last: number; n: number }>(
      `SELECT t.id, t.subject, MAX(m.sent_at) AS last, COUNT(m.seq) AS n FROM threads t
       JOIN messages m ON m.thread_id = t.id WHERE t.room_id = ? GROUP BY t.id ORDER BY last DESC LIMIT 200`, room.id);
    const members = (id: string) => all<{ name: string }>(
      'SELECT a.name FROM thread_members tm JOIN agents a ON a.id = tm.agent_id WHERE tm.thread_id = ? ORDER BY a.name', id)
      .map((m) => h(m.name)).join(', ');
    const base = `/admin/room/${h(room.slug)}`;
    const inviteState = (i: (typeof invites)[number]) =>
      i.revoked ? 'zurückgezogen' : i.expires_at < Date.now() ? 'abgelaufen' : i.uses >= i.max_uses ? 'eingelöst' : 'gültig';
    return page(room.title, `<p><a href="/admin">← Räume</a></p><h1>${h(room.title)} <code>${h(room.slug)}</code></h1>
<section><h2>So treten Agenten bei</h2>
<p>Gib dem Nutzer des Agenten diese drei Angaben: die Adresse <code>${h(core.baseUrl(req))}/skill</code>,
den Raum <code>${h(room.slug)}</code>${room.auth_level === 'open' ? '' : ' und einen Einladungscode von unten'}${room.password_hash ? ' sowie das Raumpasswort' : ''}.</p></section>
<section><h2>Agenten</h2><div data-refresh="${base}/agents">${agentsTable(room)}</div></section>
<section><h2>Einladungscodes</h2>
<form class="row" method="post" action="${base}/invites">
<label>Einlösungen<input name="max_uses" type="number" min="1" max="100" value="1"></label>
<label>Gültig (Tage)<input name="days" type="number" min="1" max="365" value="7"></label>
<button class="pri">Code erzeugen</button></form>
${invites.length ? `<table style="margin-top:12px"><tr><th>Code</th><th>Eingelöst</th><th>Gültig bis</th><th>Zustand</th><th></th></tr>
${invites.map((i) => `<tr><td><code>${h(i.code)}</code></td><td>${i.uses} / ${i.max_uses}</td><td>${when(i.expires_at)}</td><td>${inviteState(i)}</td>
<td>${inviteState(i) === 'gültig' ? `<form class="inline" method="post" action="${base}/invites/revoke"><input type="hidden" name="code" value="${h(i.code)}"><button>Zurückziehen</button></form>` : ''}</td></tr>`).join('')}</table>` : ''}</section>
<section><h2>Zugang</h2>
<form class="row" method="post" action="${base}/settings">
<label>Sicherheitsstufe<select name="auth_level">${AUTH_LEVELS.map((l) =>
      `<option value="${l}"${l === room.auth_level ? ' selected' : ''}>${h(LEVEL_LABEL[l])}</option>`).join('')}</select></label>
<label>Raumpasswort ${room.password_hash ? '(gesetzt)' : '(keines)'}<select name="pw_action">
<option value="keep">unverändert lassen</option><option value="set">neu setzen</option>${room.password_hash ? '<option value="clear">entfernen</option>' : ''}</select></label>
<label>Neues Passwort<input name="password" type="password" autocomplete="new-password"></label>
<button>Speichern</button></form></section>
<section><h2>Gespräche</h2>${threads.length ? `<table><tr><th>Betreff</th><th>Teilnehmer</th><th>Nachrichten</th><th>Letzte</th></tr>
${threads.map((t) => `<tr><td><a href="/admin/thread/${h(t.id)}">${h(t.subject)}</a></td><td>${members(t.id)}</td><td>${t.n}</td><td>${when(t.last)}</td></tr>`).join('')}</table>`
      : '<p class="mut">Noch keine Gespräche.</p>'}</section>`);
  };

  const threadPage = (id: string) => {
    const t = one<{ subject: string; slug: string; title: string }>(
      'SELECT t.subject, r.slug, r.title FROM threads t JOIN rooms r ON r.id = t.room_id WHERE t.id = ?', id);
    if (!t) return null;
    const msgs = all<{ body: string; sent_at: number; name: string }>(
      'SELECT m.body, m.sent_at, a.name FROM messages m JOIN agents a ON a.id = m.from_agent WHERE m.thread_id = ? ORDER BY m.seq', id);
    return page(t.subject, `<p><a href="/admin/room/${h(t.slug)}">← ${h(t.title)}</a></p><h1>${h(t.subject)}</h1>
<section>${msgs.map((m) => `<div class="msg"><b>${h(m.name)}</b> <span class="mut">${when(m.sent_at)}</span><pre>${h(m.body)}</pre></div>`).join('')}</section>`);
  };

  const loginPage = (error = '') => page('Anmelden', `<div class="login"><section><h1>Vernetzung</h1>
${error ? `<div class="note">${h(error)}</div>` : ''}
<form method="post" action="/admin/login" style="display:grid;gap:10px">
<label>Betreiber-Passwort<input name="password" type="password" required autofocus autocomplete="current-password"></label>
<button class="pri">Anmelden</button></form></section></div>`, false);

  return async function handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname.replace(/\/+$/, '') || '/admin';
    try {
      if (path === '/admin/app.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=300' });
        return res.end(JS);
      }
      let form = new URLSearchParams();
      if (req.method === 'POST') {
        // Schutz gegen fremde Seiten, die Formulare abschicken: Origin muss zum Hub gehören.
        // Browser melden die Herkunft über Sec-Fetch-Site und Origin; Origin kann auch "null" lauten.
        const origin = req.headers.origin;
        const site = req.headers['sec-fetch-site'];
        const own = [`http://${req.headers.host}`, `https://${req.headers.host}`, new URL(core.baseUrl(req)).origin];
        const foreign = site ? site !== 'same-origin' && site !== 'none' : origin != null && !own.includes(origin);
        if (foreign) throw new HttpError(403, 'origin', 'Anfrage von fremder Herkunft abgelehnt.');
        form = new URLSearchParams(await readBody(req));
      } else if (req.method !== 'GET') throw new HttpError(405, 'method', 'Methode nicht erlaubt.');
      const f = (k: string) => (form.get(k) ?? '').trim();

      if (path === '/admin/login') {
        if (req.method === 'GET') return html(res, 200, loginPage());
        failures = failures.filter((t) => Date.now() - t < 10 * 60_000);
        if (failures.length >= 10) return html(res, 429, loginPage('Zu viele Fehlversuche. Bitte in zehn Minuten erneut versuchen.'));
        if (!passwordOk(form.get('password') ?? '')) {
          failures.push(Date.now());
          await new Promise((r) => setTimeout(r, 500));
          return html(res, 401, loginPage('Das Passwort ist falsch.'));
        }
        const sid = newId('', 24);
        sessions.set(sid, Date.now() + 12 * 3600_000);
        return redirect(res, '/admin', cookie(req, sid, 12 * 3600));
      }
      if (!isLoggedIn(req)) return redirect(res, '/admin/login');

      if (path === '/admin/logout' && req.method === 'POST') {
        const sid = /(?:^|;\s*)vnz_admin=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
        if (sid) sessions.delete(sid);
        return redirect(res, '/admin/login', cookie(req, '', 0));
      }
      if (path === '/admin' && req.method === 'GET') return html(res, 200, home());

      if (path === '/admin/rooms' && req.method === 'POST') {
        const slug = f('slug');
        if (!NAME_RE.test(slug)) throw new HttpError(400, 'slug', 'Der Kurzname des Raums darf nur a–z, 0–9 und Bindestrich enthalten, 2 bis 32 Zeichen.');
        if (one('SELECT 1 FROM rooms WHERE slug = ?', slug)) throw new HttpError(400, 'slug', 'Einen Raum mit diesem Kurznamen gibt es schon.');
        run('INSERT INTO rooms (slug, title, created_at) VALUES (?, ?, ?)', slug, f('title').slice(0, 100) || slug, Date.now());
        return redirect(res, `/admin/room/${slug}`);
      }
      if (path === '/admin/settings' && req.method === 'POST') {
        const days = Math.min(3650, Math.max(1, Math.floor(Number(f('retention_days'))) || 90));
        core.setSetting('retention_days', String(days));
        core.cleanup();
        return redirect(res, '/admin');
      }

      const threadMatch = /^\/admin\/thread\/([\w-]+)$/.exec(path);
      if (threadMatch && req.method === 'GET') {
        const body = threadPage(threadMatch[1]);
        if (!body) throw new HttpError(404, 'not_found', 'Dieses Gespräch gibt es nicht.');
        return html(res, 200, body);
      }

      const m = /^\/admin\/room\/([a-z0-9-]+)(\/[a-z/]+)?$/.exec(path);
      const room = m ? one<Room>('SELECT * FROM rooms WHERE slug = ?', m[1]) : undefined;
      if (!m || !room) throw new HttpError(404, 'not_found', 'Diese Seite gibt es nicht.');
      const sub = m[2] ?? '';
      const back = `/admin/room/${room.slug}`;

      if (sub === '' && req.method === 'GET') return html(res, 200, roomPage(room, req));
      if (sub === '/agents' && req.method === 'GET') return html(res, 200, agentsTable(room));
      if (req.method !== 'POST') throw new HttpError(404, 'not_found', 'Diese Seite gibt es nicht.');

      if (sub === '/invites') {
        const maxUses = Math.min(100, Math.max(1, Math.floor(Number(f('max_uses'))) || 1));
        const days = Math.min(365, Math.max(1, Math.floor(Number(f('days'))) || 7));
        run('INSERT INTO invites (code, room_id, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
          newId('inv_', 12), room.id, maxUses, Date.now() + days * 86_400_000, Date.now());
      } else if (sub === '/invites/revoke') {
        run('UPDATE invites SET revoked = 1 WHERE code = ? AND room_id = ?', f('code'), room.id);
      } else if (sub === '/settings') {
        const level = f('auth_level');
        if (!AUTH_LEVELS.includes(level)) throw new HttpError(400, 'level', 'Unbekannte Sicherheitsstufe.');
        run('UPDATE rooms SET auth_level = ? WHERE id = ?', level, room.id);
        const pwAction = f('pw_action');
        if (pwAction === 'set') {
          const pw = form.get('password') ?? '';
          if (pw.length < 8) throw new HttpError(400, 'password', 'Das Raumpasswort braucht mindestens 8 Zeichen.');
          run('UPDATE rooms SET password_hash = ? WHERE id = ?', hashPassword(pw), room.id);
        } else if (pwAction === 'clear') run('UPDATE rooms SET password_hash = NULL WHERE id = ?', room.id);
      } else if (sub === '/agent') {
        const agent = one<Agent>('SELECT * FROM agents WHERE id = ? AND room_id = ?', f('id'), room.id);
        const next = ({ approve: ['pending', 'active'], block: ['active', 'blocked'], unblock: ['blocked', 'active'] } as
          Record<string, string[]>)[f('action')];
        if (agent && f('action') === 'revoke' && agent.status !== 'revoked') {
          run("UPDATE agents SET status = 'revoked', session_id = NULL, session_seen = NULL, last_poll = NULL WHERE id = ?", agent.id);
          core.wake(agent.id, 'recheck');
        } else if (agent && next && agent.status === next[0]) {
          run('UPDATE agents SET status = ? WHERE id = ?', next[1], agent.id);
          core.wake(agent.id, 'recheck');
        }
      } else throw new HttpError(404, 'not_found', 'Diese Seite gibt es nicht.');
      return redirect(res, back);
    } catch (err) {
      if (err instanceof HttpError)
        return html(res, err.status, page('Fehler', `<div class="note">${h(err.message)}</div><p><a href="/admin">Räume</a></p>`, isLoggedIn(req)));
      core.cfg.log?.(`Fehler: ${(err as Error).stack}`);
      html(res, 500, page('Fehler', '<div class="note">Interner Fehler.</div>', false));
    }
  };
}
