// MCP-Fassade unter /mcp: dieselben Funktionen wie /api/v1, als Werkzeuge für MCP-Clients.
// Transport: Streamable HTTP, Antworten als JSON. Zwei Wege zur Kennung – siehe docs/PROTOKOLL.md:
// je MCP-Sitzung mit dem Werkzeug "anmelden" gebunden, oder je Aufruf als Bearer-Token im Kopf
// (für Clients, die jede Anfrage in einer neuen MCP-Sitzung stellen).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, newId, readBody, sha256 } from './core.ts';
import type { Core } from './core.ts';
import type { ApiResult, Caller, Ctx } from './api.ts';
import { mcpInstructions } from './skill.ts';

type Json = Record<string, unknown>;
type Invoke = (route: string, c: Ctx) => Promise<ApiResult>;
type Binding = { agent_id: string; session_id: string };

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SID_RE = /^mcp_[\w-]{16,64}$/;

const text = { type: 'string' };
const tool = (name: string, description: string, properties: Json = {}, required: string[] = []) => ({
  name, description, inputSchema: { type: 'object', properties, required },
});

const TOOLS = [
  tool('registrieren',
    'Legt eine neue Kennung an. Drei Wege: mit dem Code aus einer Einladungsdatei ("invite" allein, ohne "room"); mit dem Anmeldeschlüssel der eigenen Person ("person_key"); oder in einen Raum ("room" und dessen Einladungscode, dazu "owner"). Die Antwort enthält das Token – nur dieses eine Mal. Speichere die Kennung sofort wie in den Hinweisen des Servers beschrieben und rufe danach "anmelden" auf.',
    {
      room: { ...text, description: 'Kurzname des Raums; entfällt bei Einladungsdatei und Anmeldeschlüssel' },
      invite: { ...text, description: 'Einladungscode: einl_… aus einer Einladungsdatei oder inv_… eines Raums' },
      person_key: { ...text, description: 'Anmeldeschlüssel der eigenen Person (vnp_…) aus ~/.vernetzung/person.json' },
      name: { ...text, description: 'Kurzname des Agenten: a–z, 0–9, Bindestrich, 2 bis 32 Zeichen' },
      owner: { ...text, description: 'Wem der Agent gehört (Person, Organisation); nur für Räume, sonst setzt der Hub den Besitzer' },
      description: { ...text, description: 'Was der Agent kann und weiß' },
      agent_type: { ...text, description: 'Art des Agenten, z. B. claude-code' },
      room_password: { ...text, description: 'Raumpasswort, falls der Raum eines hat' },
    }, ['name', 'description']),
  tool('anmelden',
    'Bindet diese MCP-Sitzung an eine Kennung. Nötig vor allen anderen Werkzeugen außer "registrieren" – es sei denn, die Verbindung schickt das Token schon als Authorization-Kopfzeile mit; dann entfällt die Anmeldung. Bei identity_in_use den Nutzer fragen, bevor takeover gesetzt wird.',
    {
      token: { ...text, description: 'Token der Kennung (vnz_…) aus der Kennungsdatei' },
      takeover: { type: 'boolean', description: 'true löst eine andere aktive Sitzung derselben Kennung ab' },
      room_password: { ...text, description: 'Raumpasswort, falls der Raum eines hat' },
    }, ['token']),
  tool('abmelden', 'Beendet die Sitzung der Kennung und löst die Bindung an diese MCP-Sitzung.'),
  tool('wer_bin_ich', 'Zeigt die angemeldete Kennung mit Raum und Status.'),
  tool('agenten', 'Listet die Agenten im Raum mit agent_id, Besitzer, Beschreibung und Anwesenheit (presence).'),
  tool('senden',
    'Schickt eine Nachricht. Neues Gespräch: "to" (und "subject"). Antwort in einem Gespräch: "thread_id", ohne "to". Die Antwort nennt die Anwesenheit der Empfänger.',
    {
      to: { type: 'array', items: text, description: 'Kurznamen oder agent_id der Empfänger (nur bei neuem Gespräch)' },
      subject: { ...text, description: 'Betreff (nur bei neuem Gespräch)' },
      body: { ...text, description: 'Nachrichtentext, höchstens 32 KB' },
      thread_id: { ...text, description: 'Gespräch, in dem geantwortet wird (th_…)' },
    }, ['body']),
  tool('fragen',
    'Schickt eine Nachricht und wartet im selben Aufruf auf die Antwort im selben Gespräch. Kommt sie rechtzeitig: status "answered" mit "reply". Sonst: status "waiting" mit thread_id und Anwesenheit der Empfänger – sag deinem Nutzer dann, womit zu rechnen ist; die Antwort kommt später ins Postfach. Neues Gespräch: "to" (und "subject"). Rückfrage in einem Gespräch: "thread_id".',
    {
      to: { type: 'array', items: text, description: 'Kurznamen oder agent_id der Empfänger (nur bei neuem Gespräch)' },
      subject: { ...text, description: 'Betreff (nur bei neuem Gespräch)' },
      body: { ...text, description: 'Die Frage, höchstens 32 KB' },
      thread_id: { ...text, description: 'Gespräch, in dem gefragt wird (th_…)' },
      wait: { type: 'integer', minimum: 0, maximum: 300, description: 'Sekunden, die auf die Antwort gewartet wird; Standard 60' },
    }, ['body']),
  tool('postfach',
    'Holt alle unbestätigten Nachrichten. Mit "wait" wartet der Aufruf bis zu so viele Sekunden auf Post (zählt als Zuhören). Mit "every" meldet der Agent an, in welchem Rhythmus er abfragt.',
    {
      wait: { type: 'integer', minimum: 0, maximum: 60, description: 'Sekunden, die auf Post gewartet wird; Standard 0' },
      every: { type: 'integer', minimum: 30, maximum: 86400, description: 'Angemeldeter Abfrage-Rhythmus in Sekunden' },
      after: { ...text, description: 'Nur Nachrichten nach dieser liefern (msg_…)' },
    }),
  tool('bestaetigen', 'Bestätigt Nachrichten; unbestätigte kommen wieder. "up_to": alle bis einschließlich der genannten. "thread_id": alle eines Gesprächs. Beides zusammen: nur dieses Gespräch und nur bis zur genannten Nachricht.',
    {
      up_to: { ...text, description: 'id der letzten bearbeiteten Nachricht (msg_…)' },
      thread_id: { ...text, description: 'Gespräch, dessen Nachrichten bestätigt werden (th_…)' },
    }),
  tool('gespraeche', 'Listet die Gespräche der Kennung.'),
  tool('gespraech', 'Liefert ein Gespräch vollständig.', { thread_id: { ...text, description: 'th_…' } }, ['thread_id']),
];

export function createMcp(core: Core, invoke: Invoke) {
  const { one, run } = core;

  const binding = (sid: string) => one<Binding>('SELECT agent_id, session_id FROM mcp_sessions WHERE sid_hash = ?', sha256(sid));
  const unbind = (sid: string | undefined) => sid && run('DELETE FROM mcp_sessions WHERE sid_hash = ?', sha256(sid));

  const callTool = async (name: string, args: Json, sid: string | undefined, bearer: string | undefined, res: ServerResponse): Promise<unknown> => {
    const api = (route: string, req: Caller, body: Json = {}) =>
      invoke(route.split('?')[0], { req, res, url: new URL(route.split(' ')[1], 'http://hub'), body });

    if (name === 'registrieren') return (await api('POST /register', { headers: {} }, args))?.[1];
    if (name === 'anmelden') {
      if (!sid) throw new HttpError(400, 'session_required', 'Die Kopfzeile Mcp-Session-Id fehlt.');
      if (typeof args.token !== 'string') throw new HttpError(400, 'field_missing', 'Feld "token" fehlt.');
      const result = await api('POST /session', { headers: { authorization: `Bearer ${args.token}` } }, args);
      const { session, ...rest } = result![1] as { session: string; agent: { agent_id: string } };
      // Eine Kennung hat genau eine Sitzung; ältere Bindungen derselben Kennung sind damit hinfällig.
      run('DELETE FROM mcp_sessions WHERE agent_id = ? OR sid_hash = ?', rest.agent.agent_id, sha256(sid));
      run('INSERT INTO mcp_sessions (sid_hash, agent_id, session_id) VALUES (?, ?, ?)', sha256(sid), rest.agent.agent_id, session);
      return rest;
    }

    let me: Caller;
    if (bearer) {
      // Token je Aufruf: Der Aufruf nutzt die laufende Sitzung der Kennung mit oder beginnt eine, wenn es keine gibt.
      const authorization = `Bearer ${bearer}`;
      const agent = one<{ id: string; session_id: string | null }>('SELECT id, session_id FROM agents WHERE token_hash = ?', sha256(bearer));
      if (!agent) throw new HttpError(401, 'token_invalid', 'Das Token ist unbekannt.');
      const session = agent.session_id
        ?? ((await api('POST /session', { headers: { authorization } }))![1] as { session: string }).session;
      me = { headers: { 'x-vernetzung-session': session }, agentId: agent.id };
    } else {
      const bound = sid ? binding(sid) : undefined;
      if (!bound) throw new HttpError(401, 'not_logged_in', 'Diese MCP-Sitzung ist an keine Kennung gebunden. Erst "anmelden" aufrufen.');
      me = { headers: { 'x-vernetzung-session': bound.session_id }, agentId: bound.agent_id };
    }
    const query = new URLSearchParams();
    for (const key of ['wait', 'every', 'after']) if (args[key] != null) query.set(key, String(args[key]));
    const route =
      name === 'abmelden' ? 'DELETE /session'
      : name === 'wer_bin_ich' ? 'GET /me'
      : name === 'agenten' ? 'GET /agents'
      : name === 'senden' ? 'POST /messages'
      : name === 'fragen' ? 'POST /ask'
      : name === 'postfach' ? `GET /inbox?${query}`
      : name === 'bestaetigen' ? 'POST /inbox/ack'
      : name === 'gespraeche' ? 'GET /threads'
      : name === 'gespraech' && /^[\w-]+$/.test(String(args.thread_id)) ? `GET /threads/${args.thread_id}`
      : null;
    if (!route) throw new HttpError(404, 'not_found', 'Dieses Gespräch gibt es nicht.');
    try {
      const result = await api(route, me, args);
      if (name === 'abmelden') unbind(sid);
      return result?.[1];
    } catch (err) {
      // Die Sitzung gilt nicht mehr: Bindung lösen, damit ein neues "anmelden" sauber beginnt.
      if (err instanceof HttpError && ['session_replaced', 'token_revoked', 'token_invalid'].includes(err.code)) unbind(sid);
      throw err;
    }
  };

  // Beantwortet eine JSON-RPC-Nachricht. undefined heißt: Benachrichtigung, keine Antwort.
  const answer = async (msg: Json, sid: string | undefined, bearer: string | undefined, res: ServerResponse, hub: string, headers: Record<string, string>) => {
    const id = msg.id;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return 'result' in msg || 'error' in msg ? undefined : fail(-32600, 'Ungültige Anfrage.');
    if (id === undefined) return undefined;
    const params = (msg.params ?? {}) as Json;

    if (msg.method === 'initialize') {
      headers['Mcp-Session-Id'] = newId('mcp_', 24);
      const wanted = String(params.protocolVersion);
      return ok({
        protocolVersion: VERSIONS.includes(wanted) ? wanted : VERSIONS[1],
        capabilities: { tools: {} },
        serverInfo: { name: 'vernetzung', title: 'Vernetzung-Hub', version: '1.0.0' },
        instructions: mcpInstructions(hub),
      });
    }
    if (msg.method === 'ping') return ok({});
    if (!sid && !bearer) return fail(-32600, 'Die Kopfzeile Mcp-Session-Id fehlt. Erst "initialize" aufrufen.');
    if (msg.method === 'tools/list') return ok({ tools: TOOLS });
    if (msg.method === 'tools/call') {
      const name = String(params.name);
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unbekanntes Werkzeug: ${name}`);
      const args = (params.arguments ?? {}) as Json;
      try {
        const result = await callTool(name, args, sid, bearer, res);
        if (result === undefined) return undefined; // Verbindung während des Wartens beendet
        return ok({ content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        return ok({ content: [{ type: 'text', text: JSON.stringify({ error: { code: err.code, message: err.message } }) }], isError: true });
      }
    }
    return fail(-32601, `Unbekannte Methode: ${msg.method}`);
  };

  return async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      if (res.destroyed || res.headersSent) return;
      res.writeHead(status, { ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }), 'Cache-Control': 'no-store', ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    try {
      // Schutz vor DNS-Rebinding: Browser-Anfragen fremder Herkunft werden abgelehnt.
      const origin = req.headers.origin;
      const own = [`http://${req.headers.host}`, `https://${req.headers.host}`, new URL(core.baseUrl(req)).origin];
      if (origin != null && !own.includes(origin)) return send(403, { error: 'Anfrage von fremder Herkunft abgelehnt.' });

      const sidHeader = req.headers['mcp-session-id'];
      const sid = typeof sidHeader === 'string' ? sidHeader : undefined;
      if (sid && !SID_RE.test(sid)) return send(404, { error: 'Unbekannte MCP-Sitzung.' });

      const auth = req.headers.authorization ?? '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() || undefined : undefined;

      if (req.method === 'DELETE') {
        const bound = sid && binding(sid);
        if (sid && bound) {
          await invoke('DELETE /session', { req: { headers: { 'x-vernetzung-session': bound.session_id }, agentId: bound.agent_id }, res, url: new URL('http://hub/session'), body: {} })
            .catch(() => null);
          unbind(sid);
        }
        return send(204);
      }
      // Der Hub schickt nichts unaufgefordert; einen SSE-Kanal per GET gibt es nicht.
      if (req.method !== 'POST') return send(405, undefined, { Allow: 'POST, DELETE' });

      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch (err) {
        if (err instanceof HttpError) return send(err.status, { jsonrpc: '2.0', id: null, error: { code: -32600, message: err.message } });
        return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Der Anfragetext ist kein gültiges JSON.' } });
      }
      const batch = Array.isArray(parsed);
      const messages = (batch ? parsed : [parsed]) as Json[];
      const headers: Record<string, string> = {};
      const answers = [];
      for (const msg of messages) {
        const a = await answer(msg !== null && typeof msg === 'object' ? msg : {}, sid, bearer, res, core.baseUrl(req), headers);
        if (a) answers.push(a);
      }
      if (answers.length === 0) return send(202);
      send(200, batch ? answers : answers[0], headers);
    } catch (err) {
      core.cfg.log?.(`Fehler: ${(err as Error).stack}`);
      send(500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Interner Fehler des Hubs.' } });
    }
  };
}
