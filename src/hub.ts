// Setzt API, GUI und Skill-Auslieferung zu einem HTTP-Handler zusammen.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createCore } from './core.ts';
import type { Config } from './core.ts';
import { createApi } from './api.ts';
import { createAdmin } from './admin.ts';
import { landing, skillMarkdown, skillPrompt } from './skill.ts';

export function createHub(cfg: Config) {
  const core = createCore(cfg);
  const api = createApi(core);
  const admin = createAdmin(core);
  core.cleanup();
  const timer = setInterval(() => core.cleanup(), 3600_000);
  timer.unref();

  const text = (res: ServerResponse, status: number, type: string, body: string) => {
    res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(body);
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://hub');
    const path = url.pathname;
    if (path.startsWith('/api/v1/')) return void api(req, res, url);
    if (path === '/admin' || path.startsWith('/admin/')) return void admin(req, res, url);
    if (req.method !== 'GET') return text(res, 405, 'text/plain', 'Methode nicht erlaubt.\n');
    const hub = core.baseUrl(req);
    if (path === '/skill')
      return text(res, 200, 'text/markdown', url.searchParams.get('mode') === 'prompt' ? skillPrompt(hub) : skillMarkdown(hub));
    if (path === '/') return text(res, 200, 'text/markdown', landing(hub));
    if (path === '/healthz') return text(res, 200, 'text/plain', 'ok\n');
    text(res, 404, 'text/plain', 'Nicht gefunden.\n');
  };

  const close = () => {
    clearInterval(timer);
    for (const id of core.waiters.keys()) core.wake(id, 'shutdown');
    // Die geweckten Long-Polls antworten im nächsten Durchlauf; erst danach die Datenbank schließen.
    setImmediate(() => core.db.close());
  };

  return { handler, close, core };
}
