// Betreiber-GUI unter /admin: Räume, Einladungen, Agenten, Gesprächsprotokolle.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AUTH_LEVELS, HttpError, NAME_RE, hashPassword, iso, newId, readBody, safeEqual, sha256, verifyPassword,
} from './core.ts';
import type { Agent, Core, Room } from './core.ts';

const h = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
// Anzeige minutengenau in UTC; die volle Zeit steht im Tooltip.
const when = (ms: number | null) =>
  ms == null ? '–' : `<time datetime="${iso(ms)}" title="${iso(ms)!.replace('T', ' ').replace('Z', ' UTC')}">${iso(ms)!.slice(0, 16).replace('T', ' ')}</time>`;

// Gestaltung nach dem Depot Design System: cremefarbener Grund, Smaragd-Akzent, Stein-Neutrale,
// ein weicher Schatten, großzügige Radien. Hell auf :root, dunkel auf [data-theme="dark"].
// Farben stehen ausschließlich in den Variablen; Regeln darunter verwenden nur var(--…).
const FONTS = 'https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700&family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=Geist+Mono:wght@400;500;600&display=swap';

const CSS = `
:root{
--font-sans:'Schibsted Grotesk',ui-sans-serif,system-ui,sans-serif;
--font-display:'Bricolage Grotesque','Schibsted Grotesk',ui-sans-serif,sans-serif;
--font-mono:'Geist Mono',ui-monospace,monospace;
--background:oklch(0.977 0.008 84);--foreground:oklch(0.245 0.012 56);
--card:oklch(1 0 0);--muted:oklch(0.951 0.012 84);--muted-foreground:oklch(0.52 0.018 60);
--primary:oklch(0.596 0.145 163);--primary-foreground:oklch(0.985 0.001 106.423);
--secondary:oklch(0.95 0.026 163);--secondary-foreground:oklch(0.378 0.077 168.94);
--accent:oklch(0.954 0.038 80);--accent-foreground:oklch(0.473 0.137 46.201);
--destructive:oklch(0.577 0.245 27.325);--success:oklch(0.596 0.145 163);--warning:oklch(0.769 0.16 70);--info:oklch(0.62 0.13 233);
--link:oklch(0.47 0.12 164);--link-hover:oklch(0.38 0.11 164);
--border:oklch(0.912 0.014 84);--input:oklch(0.912 0.014 84);--ring:oklch(0.596 0.145 163);
--code-inline-bg:oklch(0.95 0.02 84);
--radius-sm:8px;--radius:10px;--radius-lg:16px;--radius-xl:20px;--radius-pill:999px;
--shadow-soft:0 1px 2px oklch(0.25 0.04 70 / 0.05),0 16px 40px -20px oklch(0.3 0.08 70 / 0.16);
--canvas-gradient:radial-gradient(1100px 520px at 88% -10%,oklch(0.94 0.05 163 / 0.5),transparent 60%),radial-gradient(900px 480px at -8% 4%,oklch(0.96 0.045 80 / 0.55),transparent 55%);
}
[data-theme="dark"]{
--background:oklch(0.165 0.005 56);--foreground:oklch(0.985 0.001 106.423);
--card:oklch(0.216 0.006 56.043);--muted:oklch(0.268 0.007 34.298);--muted-foreground:oklch(0.709 0.01 56.259);
--primary:oklch(0.696 0.17 162.48);--primary-foreground:oklch(0.19 0.02 160);
--secondary:oklch(0.3 0.03 165);--secondary-foreground:oklch(0.92 0.03 165);
--accent:oklch(0.31 0.04 70);--accent-foreground:oklch(0.9 0.05 75);
--destructive:oklch(0.704 0.191 22.216);--success:oklch(0.696 0.17 162.48);--warning:oklch(0.82 0.17 80);--info:oklch(0.72 0.14 233);
--link:oklch(0.8 0.14 163);--link-hover:oklch(0.88 0.12 163);
--border:oklch(1 0 0 / 0.1);--input:oklch(1 0 0 / 0.15);--ring:oklch(0.696 0.17 162.48);
--code-inline-bg:oklch(1 0 0 / 0.08);
--shadow-soft:0 1px 2px rgba(0,0,0,0.3),0 18px 44px -22px rgba(0,0,0,0.6);
--canvas-gradient:radial-gradient(1100px 520px at 88% -10%,oklch(0.5 0.09 163 / 0.18),transparent 60%),radial-gradient(900px 480px at -8% 4%,oklch(0.55 0.07 72 / 0.16),transparent 55%);
}
*{box-sizing:border-box}
html{color-scheme:light}html[data-theme="dark"]{color-scheme:dark}
body{margin:0;min-height:100vh;background:var(--background);background-image:var(--canvas-gradient);background-attachment:fixed;color:var(--foreground);font:400 15px/1.5 var(--font-sans);-webkit-font-smoothing:antialiased}
header{position:sticky;top:0;z-index:10;backdrop-filter:blur(12px);background:color-mix(in oklab,var(--card) 78%,transparent);border-bottom:1px solid var(--border)}
.bar{max-width:1180px;margin:0 auto;padding:12px 24px;display:flex;align-items:center;gap:12px}
.brand{display:flex;align-items:center;gap:11px;text-decoration:none;color:var(--foreground);margin-right:auto}
.logo{width:34px;height:34px;border-radius:11px;background:var(--primary);color:var(--primary-foreground);display:flex;align-items:center;justify-content:center;box-shadow:var(--shadow-soft);flex:none}
.brand b{display:block;font:700 15px/1.15 var(--font-display);letter-spacing:-.01em}
.brand small{display:block;font-size:11px;line-height:1.15;color:var(--muted-foreground)}
main{max-width:1180px;margin:0 auto;padding:32px 24px 56px}
h1{font:800 32px/1.1 var(--font-display);letter-spacing:-.025em;margin:0 0 24px;display:flex;flex-wrap:wrap;align-items:baseline;gap:12px}
h2{font:600 16px/1.3 var(--font-display);letter-spacing:-.01em;margin:0 0 14px}
p{margin:0 0 12px}p:last-child{margin-bottom:0}
.back{font-size:13px;margin-bottom:12px}
section{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:22px;margin-bottom:20px;box-shadow:var(--shadow-soft);overflow-x:auto}
a{color:var(--link);font-weight:600;text-decoration:none}a:hover{color:var(--link-hover);text-decoration:underline;text-underline-offset:3px}
.mut{color:var(--muted-foreground)}
code,time,.mono{font-family:var(--font-mono);font-size:12.5px;font-variant-numeric:tabular-nums}
time{white-space:nowrap}
code{background:var(--code-inline-bg);padding:.15em .45em;border-radius:6px;font-weight:500}
h1 code{font-size:14px;letter-spacing:0}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:11px 12px;font:600 11px var(--font-sans);letter-spacing:.06em;text-transform:uppercase;color:var(--muted-foreground);background:var(--muted);white-space:nowrap}
th:first-child{border-radius:var(--radius) 0 0 var(--radius)}th:last-child{border-radius:0 var(--radius) var(--radius) 0}
td{padding:13px 12px;border-bottom:1px solid var(--border);vertical-align:middle}
tr:last-child td{border-bottom:0}
td.num{font-family:var(--font-mono);font-weight:500;font-variant-numeric:tabular-nums}
td.wide{min-width:220px}
td.acts{text-align:right;white-space:nowrap}
.who{display:flex;align-items:center;gap:11px}
.tile{width:30px;height:30px;border-radius:9px;background:var(--secondary);color:var(--secondary-foreground);display:inline-flex;align-items:center;justify-content:center;font:700 11px var(--font-sans);flex:none}
.who b{font-weight:600;white-space:nowrap}.who .mono{white-space:nowrap}.sub{font-size:12px;color:var(--muted-foreground)}
input,select{height:38px;padding:0 12px;border-radius:var(--radius);border:1px solid var(--input);background:var(--card);color:var(--foreground);font:400 14px var(--font-sans);outline:none;min-width:0}
input:focus,select:focus{border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in oklab,var(--ring) 25%,transparent)}
button{height:32px;padding:0 13px;border-radius:var(--radius);border:1px solid var(--border);background:var(--card);color:var(--foreground);font:600 13px var(--font-sans);cursor:pointer;display:inline-flex;align-items:center;gap:7px;white-space:nowrap}
button:hover{background:var(--muted)}
button:focus-visible,a:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in oklab,var(--ring) 35%,transparent);border-radius:var(--radius)}
button.pri{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground)}
button.pri:hover{background:color-mix(in oklab,var(--primary) 88%,var(--foreground))}
button.bad{background:color-mix(in oklab,var(--destructive) 10%,transparent);border-color:color-mix(in oklab,var(--destructive) 30%,transparent);color:color-mix(in oklab,var(--destructive) 80%,var(--foreground))}
button.bad:hover{background:color-mix(in oklab,var(--destructive) 18%,transparent)}
button.pill{border-radius:var(--radius-pill);box-shadow:var(--shadow-soft)}
form.row{display:flex;flex-wrap:wrap;gap:12px;align-items:end}form.row button{height:38px}
form.inline{display:inline-block;margin-left:6px}
label{display:grid;gap:5px;font:600 12px var(--font-sans);color:var(--muted-foreground)}
.tag{--c:var(--muted-foreground);display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:var(--radius-pill);font:600 12px var(--font-sans);white-space:nowrap;background:color-mix(in oklab,var(--c) 14%,transparent);color:color-mix(in oklab,var(--c) 68%,var(--foreground))}
.tag::before{content:"";width:7px;height:7px;border-radius:var(--radius-pill);background:var(--c);flex:none}
.tag.active,.tag.listening,.tag.polling{--c:var(--success)}
.tag.recent,.tag.pending{--c:var(--warning)}
.tag.blocked,.tag.revoked{--c:var(--destructive)}
.tag.info{--c:var(--info)}
.msg{border-top:1px solid var(--border);padding:16px 0}.msg:first-child{border-top:0;padding-top:0}.msg:last-child{padding-bottom:0}
.msg .who{margin-bottom:8px}
.msg pre{white-space:pre-wrap;word-break:break-word;margin:0 0 0 41px;font:400 14px/1.6 var(--font-sans)}
.note{padding:12px 16px;border-radius:var(--radius);border:1px solid color-mix(in oklab,var(--destructive) 30%,transparent);background:color-mix(in oklab,var(--destructive) 9%,transparent);color:color-mix(in oklab,var(--destructive) 78%,var(--foreground));font-weight:500;margin-bottom:16px}
.empty{color:var(--muted-foreground);font-size:14px}
.login{max-width:380px;margin:12vh auto 0}.login section{padding:28px;border-radius:var(--radius-xl)}
.login .brand{margin-bottom:22px}.login form{display:grid;gap:14px}.login button{height:38px;justify-content:center}
@media(max-width:640px){.bar,main{padding-left:16px;padding-right:16px}h1{font-size:26px}section{padding:16px}.brand small{display:none}}
`;

// Wird im <head> geladen: setzt das Farbschema vor dem ersten Zeichnen, danach die Bedienelemente.
const JS = `
(() => {
  const root = document.documentElement;
  let theme;
  try { theme = localStorage.getItem('vnz-theme'); } catch {}
  if (theme !== 'dark' && theme !== 'light') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  root.dataset.theme = theme;
  document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.querySelector('[data-theme-toggle]');
    const label = () => { if (toggle) toggle.querySelector('span').textContent = root.dataset.theme === 'dark' ? 'Hell' : 'Dunkel'; };
    label();
    if (toggle) toggle.addEventListener('click', () => {
      root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('vnz-theme', root.dataset.theme); } catch {}
      label();
    });
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
  });
})();
`;

const LOGO = `<span class="logo"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="8" r="2.4"/><circle cx="11" cy="18" r="2.4"/><path d="M8.3 6.6l7.4 1M7 8.2l3 7.6M16.6 10l-4.2 6"/></svg></span>`;
const SUN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;

export function createAdmin(core: Core) {
  const { all, one, run } = core;
  // Fehlversuche je Client-Adresse: fremde Fehlversuche sperren den Betreiber nicht aus.
  const failures = new Map<string, number[]>();
  // X-Forwarded-For zählt nur, wenn die Anfrage von einem bekannten Proxy kommt (derselbe Rechner oder Konfiguration).
  const clientAddress = (req: IncomingMessage) => {
    const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    const trusted = peer === '127.0.0.1' || peer === '::1' || (core.cfg.trustedProxies ?? []).includes(peer);
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean).pop();
    return trusted && forwarded ? forwarded : peer;
  };

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
<title>${h(title)} – Vernetzung</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONTS}" rel="stylesheet"><style>${CSS}</style><script src="/admin/app.js"></script></head><body>
${loggedIn ? `<header><div class="bar"><a class="brand" href="/admin">${LOGO}<span><b>Vernetzung</b><small>Betreiber</small></span></a>
<button type="button" class="pill" data-theme-toggle>${SUN}<span>Dunkel</span></button>
<form method="post" action="/admin/logout"><button>Abmelden</button></form></div></header>` : ''}
<main>${content}</main></body></html>`;

  const html = (res: ServerResponse, status: number, body: string) => {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'",
    });
    res.end(body);
  };
  const redirect = (res: ServerResponse, to: string, cookie?: string) => {
    res.writeHead(303, { Location: to, ...(cookie ? { 'Set-Cookie': cookie } : {}) });
    res.end();
  };

  const isLoggedIn = (req: IncomingMessage) => {
    const sid = /(?:^|;\s*)vnz_admin=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (!sid) return false;
    const row = one<{ expires_at: number }>('SELECT expires_at FROM admin_sessions WHERE sid_hash = ?', sha256(sid));
    return !!row && row.expires_at > Date.now();
  };
  const cookie = (req: IncomingMessage, value: string, maxAge: number) => {
    const secure = core.baseUrl(req).startsWith('https://') ? '; Secure' : '';
    return `vnz_admin=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  };

  const tag = (cls: string, text = cls) => `<span class="tag ${h(cls)}">${h(text)}</span>`;
  // Kachel mit Kürzel und Name, wie die Wertpapier-Zeilen im Depot Design.
  const who = (name: string, sub = '') =>
    `<div class="who"><span class="tile" aria-hidden="true">${h(name.replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase())}</span>
     <div><b>${h(name)}</b>${sub ? `<div class="sub">${sub}</div>` : ''}</div></div>`;
  const LEVEL_LABEL: Record<string, string> = {
    open: 'offen', invite: 'Einladungscode', approval: 'Einladungscode + Freigabe',
  };
  const PRESENCE_LABEL: Record<string, string> = { listening: 'hört zu', recent: 'kürzlich aktiv', offline: 'offline' };
  const presenceLabel = (a: Agent) => {
    if (core.presence(a) !== 'polling') return PRESENCE_LABEL[core.presence(a)];
    const s = a.poll_interval!;
    return `fragt alle ${s % 60 === 0 ? `${s / 60} Min` : `${s} Sek`} ab`;
  };
  const STATUS_LABEL: Record<string, string> = { active: 'aktiv', pending: 'wartet auf Freigabe', blocked: 'gesperrt', revoked: 'widerrufen' };

  const home = () => {
    const rooms = all<Room>('SELECT * FROM rooms ORDER BY slug');
    const rows = rooms.map((r) => {
      const agents = all<Agent>("SELECT * FROM agents WHERE room_id = ? AND status != 'revoked'", r.id);
      const listening = agents.filter((a) => a.status === 'active' && ['listening', 'polling'].includes(core.presence(a))).length;
      const pending = agents.filter((a) => a.status === 'pending').length;
      return `<tr><td><a href="/admin/room/${h(r.slug)}">${h(r.title)}</a><div class="sub mono">${h(r.slug)}</div></td>
        <td>${h(LEVEL_LABEL[r.auth_level])}${r.password_hash ? ' + Passwort' : ''}</td>
        <td class="num">${agents.length}</td><td class="num">${listening}</td><td class="num">${pending ? tag('pending', String(pending)) : '0'}</td></tr>`;
    }).join('');
    return page('Räume', `<h1>Räume</h1>
<section>${rooms.length ? `<table><tr><th>Raum</th><th>Zugang</th><th>Agenten</th><th>erreichbar</th><th>warten</th></tr>${rows}</table>`
      : '<p class="empty">Noch kein Raum. Lege unten den ersten an.</p>'}</section>
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
    if (!agents.length) return '<p class="empty">Noch kein Agent registriert.</p>';
    const btn = (a: Agent, action: string, label: string, cls = '', confirm = '') =>
      `<form class="inline" method="post" action="/admin/room/${h(room.slug)}/agent"${confirm ? ` data-confirm="${h(confirm)}"` : ''}>
       <input type="hidden" name="id" value="${h(a.id)}"><input type="hidden" name="action" value="${action}">
       <button class="${cls}">${label}</button></form>`;
    const unread = (a: Agent) =>
      one<{ n: number }>('SELECT COUNT(*) AS n FROM deliveries WHERE agent_id = ? AND acked = 0', a.id)!.n;
    return `<table><tr><th>Agent</th><th>Besitzer / Aufgabe</th><th>Status</th><th>Anwesenheit</th><th>Postfach</th><th>Zuletzt gesehen (UTC)</th><th></th></tr>
${agents.map((a) => `<tr><td>${who(a.name, `<span class="mono">${h(a.agent_type)}</span>`)}</td>
<td class="wide">${h(a.owner)}<div class="sub">${h(a.description)}</div></td>
<td>${tag(a.status, STATUS_LABEL[a.status])}</td>
<td>${a.status === 'active' ? tag(core.presence(a), presenceLabel(a)) : '–'}</td>
<td class="num">${unread(a) ? tag('pending', String(unread(a))) : '0'}</td>
<td>${when(a.last_seen)}</td>
<td class="acts">${a.status === 'pending' ? btn(a, 'approve', 'Freigeben', 'pri') : ''}
${a.status === 'active' ? btn(a, 'block', 'Sperren') : ''}
${a.status === 'blocked' ? btn(a, 'unblock', 'Entsperren') : ''}
${a.status !== 'revoked' ? btn(a, 'revoke', 'Widerrufen', 'bad', `Token von ${a.name} endgültig widerrufen? Der Kurzname wird wieder frei.`) : ''}</td></tr>`).join('')}</table>`;
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
    return page(room.title, `<p class="back"><a href="/admin">← Räume</a></p><h1>${h(room.title)} <code>${h(room.slug)}</code></h1>
<section><h2>So treten Agenten bei</h2>
<p>Gib dem Nutzer des Agenten diese drei Angaben: die Adresse <code>${h(core.baseUrl(req))}/skill</code>,
den Raum <code>${h(room.slug)}</code>${room.auth_level === 'open' ? '' : ' und einen Einladungscode von unten'}${room.password_hash ? ' sowie das Raumpasswort' : ''}.</p></section>
<section><h2>Agenten</h2><div data-refresh="${base}/agents">${agentsTable(room)}</div></section>
<section><h2>Einladungscodes</h2>
<form class="row" method="post" action="${base}/invites">
<label>Einlösungen<input name="max_uses" type="number" min="1" max="100" value="1"></label>
<label>Gültig (Tage)<input name="days" type="number" min="1" max="365" value="7"></label>
<button class="pri">Code erzeugen</button></form>
${invites.length ? `<table style="margin-top:18px"><tr><th>Code</th><th>Eingelöst</th><th>Gültig bis (UTC)</th><th>Zustand</th><th></th></tr>
${invites.map((i) => `<tr><td><code>${h(i.code)}</code></td><td class="num">${i.uses} / ${i.max_uses}</td><td>${when(i.expires_at)}</td>
<td>${tag({ gültig: 'active', eingelöst: 'info' }[inviteState(i) as string] ?? 'offline', inviteState(i))}</td>
<td class="acts">${inviteState(i) === 'gültig' ? `<form class="inline" method="post" action="${base}/invites/revoke"><input type="hidden" name="code" value="${h(i.code)}"><button>Zurückziehen</button></form>` : ''}</td></tr>`).join('')}</table>` : ''}</section>
<section><h2>Zugang</h2>
<form class="row" method="post" action="${base}/settings">
<label>Sicherheitsstufe<select name="auth_level">${AUTH_LEVELS.map((l) =>
      `<option value="${l}"${l === room.auth_level ? ' selected' : ''}>${h(LEVEL_LABEL[l])}</option>`).join('')}</select></label>
<label>Raumpasswort ${room.password_hash ? '(gesetzt)' : '(keines)'}<select name="pw_action">
<option value="keep">unverändert lassen</option><option value="set">neu setzen</option>${room.password_hash ? '<option value="clear">entfernen</option>' : ''}</select></label>
<label>Neues Passwort<input name="password" type="password" autocomplete="new-password"></label>
<button>Speichern</button></form></section>
<section><h2>Gespräche</h2>${threads.length ? `<table><tr><th>Betreff</th><th>Teilnehmer</th><th>Nachrichten</th><th>Letzte (UTC)</th></tr>
${threads.map((t) => `<tr><td><a href="/admin/thread/${h(t.id)}">${h(t.subject)}</a></td><td>${members(t.id)}</td><td class="num">${t.n}</td><td>${when(t.last)}</td></tr>`).join('')}</table>`
      : '<p class="empty">Noch keine Gespräche.</p>'}</section>`);
  };

  const threadPage = (id: string) => {
    const t = one<{ subject: string; slug: string; title: string }>(
      'SELECT t.subject, r.slug, r.title FROM threads t JOIN rooms r ON r.id = t.room_id WHERE t.id = ?', id);
    if (!t) return null;
    const msgs = all<{ body: string; sent_at: number; name: string }>(
      'SELECT m.body, m.sent_at, a.name FROM messages m JOIN agents a ON a.id = m.from_agent WHERE m.thread_id = ? ORDER BY m.seq', id);
    return page(t.subject, `<p class="back"><a href="/admin/room/${h(t.slug)}">← ${h(t.title)}</a></p><h1>${h(t.subject)}</h1>
<section>${msgs.map((m) => `<div class="msg">${who(m.name, when(m.sent_at))}<pre>${h(m.body)}</pre></div>`).join('')}</section>`);
  };

  const loginPage = (error = '') => page('Anmelden', `<div class="login"><section><div class="brand">${LOGO}<span><b>Vernetzung</b><small>Betreiber-Anmeldung</small></span></div>
${error ? `<div class="note">${h(error)}</div>` : ''}
<form method="post" action="/admin/login">
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
        for (const [address, times] of failures) {
          const fresh = times.filter((t) => Date.now() - t < 10 * 60_000);
          if (fresh.length) failures.set(address, fresh);
          else failures.delete(address);
        }
        const client = clientAddress(req);
        const mine = failures.get(client) ?? [];
        if (mine.length >= 10) return html(res, 429, loginPage('Zu viele Fehlversuche. Bitte in zehn Minuten erneut versuchen.'));
        if (!passwordOk(form.get('password') ?? '')) {
          failures.set(client, [...mine, Date.now()]);
          await new Promise((r) => setTimeout(r, 500));
          return html(res, 401, loginPage('Das Passwort ist falsch.'));
        }
        const sid = newId('', 24);
        run('DELETE FROM admin_sessions WHERE expires_at < ?', Date.now());
        run('INSERT INTO admin_sessions (sid_hash, expires_at) VALUES (?, ?)', sha256(sid), Date.now() + 12 * 3600_000);
        return redirect(res, '/admin', cookie(req, sid, 12 * 3600));
      }
      if (!isLoggedIn(req)) return redirect(res, '/admin/login');

      if (path === '/admin/logout' && req.method === 'POST') {
        const sid = /(?:^|;\s*)vnz_admin=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
        if (sid) run('DELETE FROM admin_sessions WHERE sid_hash = ?', sha256(sid));
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
        // Erst alles prüfen, dann in einem Schritt speichern: eine abgelehnte Eingabe ändert nichts.
        const pwAction = f('pw_action');
        let hash = room.password_hash;
        if (pwAction === 'set') {
          const pw = form.get('password') ?? '';
          if (pw.length < 8) throw new HttpError(400, 'password', 'Das Raumpasswort braucht mindestens 8 Zeichen.');
          hash = hashPassword(pw);
        } else if (pwAction === 'clear') hash = null;
        run('UPDATE rooms SET auth_level = ?, password_hash = ? WHERE id = ?', level, hash, room.id);
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
