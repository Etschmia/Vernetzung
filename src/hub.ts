// Setzt API, GUI und Skill-Auslieferung zu einem HTTP-Handler zusammen.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createCore } from './core.ts';
import type { Config } from './core.ts';
import { createApi } from './api.ts';
import { createAdmin } from './admin.ts';
import { createMcp } from './mcp.ts';
import { createLinks, invitePage } from './links.ts';
import { landing, skillMarkdown, skillPrompt } from './skill.ts';

export function createHub(cfg: Config) {
  const core = createCore(cfg);
  const api = createApi(core);
  const links = createLinks(core);
  const admin = createAdmin(core, links);
  const mcp = createMcp(core, api.invoke);
  const cleanup = () => {
    core.cleanup();
    links.cleanup();
  };
  cleanup();
  const timer = setInterval(cleanup, 3600_000);
  timer.unref();

  const text = (res: ServerResponse, status: number, type: string, body: string) => {
    res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(body);
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    // Der HTTP-Parser lässt Ziele wie "//[" durch, die der URL-Konstruktor ablehnt.
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://hub');
    } catch {
      return text(res, 400, 'text/plain', 'Ungültige Anfrage-Adresse.\n');
    }
    const path = url.pathname;
    if (path === '/api/v1/links' || path.startsWith('/api/v1/links/')) return void links.handle(req, res, url);
    if (path.startsWith('/api/v1/')) return void api.handle(req, res, url);
    if (path === '/mcp') return void mcp(req, res);
    if (path === '/admin' || path.startsWith('/admin/')) return void admin(req, res, url);
    if (req.method !== 'GET') return text(res, 405, 'text/plain', 'Methode nicht erlaubt.\n');
    const hub = core.baseUrl(req);
    if (path === '/skill')
      return text(res, 200, 'text/markdown', url.searchParams.get('mode') === 'prompt' ? skillPrompt(hub) : skillMarkdown(hub));
    if (path === '/') return text(res, 200, 'text/markdown', landing(hub));
    if (path === '/healthz') return text(res, 200, 'text/plain', 'ok\n');
    // Landeseite einer Einladung: für jede Kennung dieselbe Seite, ohne Skript und ohne Nachschlagen.
    if (/^\/l\/[\w-]{1,64}$/.test(path)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      });
      return void res.end(invitePage);
    }
    text(res, 404, 'text/plain', 'Nicht gefunden.\n');
  };

  const close = () => {
    clearInterval(timer);
    for (const id of core.waiters.keys()) core.wake(id, 'shutdown');
    // Die geweckten Long-Polls antworten im nächsten Durchlauf; erst danach die Datenbank schließen.
    setImmediate(() => core.db.close());
  };

  return { handler, close, core, links };
}
