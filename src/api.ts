// Die Agenten-API unter /api/v1 – siehe docs/PROTOKOLL.md.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  HttpError, MAX_BODY_BYTES, MAX_THREAD_MEMBERS, NAME_RE, SEND_LIMIT_PER_MINUTE, SESSION_BUSY_MS,
  iso, newId, readBody, sendJson, sha256, verifyPassword,
} from './core.ts';
import type { Agent, Core, Room } from './core.ts';

type Json = Record<string, unknown>;
type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; body: Json };

const str = (v: unknown, field: string, max: number, required = true): string => {
  if (v == null || v === '') {
    if (required) throw new HttpError(400, 'field_missing', `Feld "${field}" fehlt.`);
    return '';
  }
  if (typeof v !== 'string') throw new HttpError(400, 'field_invalid', `Feld "${field}" muss ein Text sein.`);
  const s = v.trim();
  if (!s && required) throw new HttpError(400, 'field_missing', `Feld "${field}" fehlt.`);
  if (s.length > max) throw new HttpError(400, 'field_too_long', `Feld "${field}" ist länger als ${max} Zeichen.`);
  return s;
};

export function createApi(core: Core) {
  const { all, one, run, tx } = core;
  const sendTimes = new Map<string, number[]>();

  const publicAgent = (a: Agent) => ({
    name: a.name, owner: a.owner, description: a.description, agent_type: a.agent_type,
    presence: core.presence(a), last_seen: iso(a.last_seen),
  });

  const roomOf = (a: Agent) => one<Room>('SELECT * FROM rooms WHERE id = ?', a.room_id)!;

  const checkRoomPassword = (room: Room, given: unknown) => {
    if (!room.password_hash) return;
    if (typeof given !== 'string' || !verifyPassword(given, room.password_hash))
      throw new HttpError(403, 'room_password_wrong', 'Das Raumpasswort fehlt oder ist falsch.');
  };

  // Prüft Token, Status und Sitzung. Wird auch nach dem Wecken eines Long-Polls erneut aufgerufen.
  const authenticate = (req: IncomingMessage, opts: { session?: boolean; pending?: boolean } = {}): Agent => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new HttpError(401, 'token_missing', 'Der Authorization-Header mit Bearer-Token fehlt.');
    const agent = one<Agent>('SELECT * FROM agents WHERE token_hash = ?', sha256(token));
    if (!agent) throw new HttpError(401, 'token_invalid', 'Das Token ist unbekannt.');
    if (agent.status === 'revoked') throw new HttpError(401, 'token_revoked', 'Das Token wurde widerrufen.');
    if (agent.status === 'blocked') throw new HttpError(403, 'agent_blocked', 'Dieser Agent ist gesperrt.');
    if (opts.session !== false) {
      const sid = req.headers['x-vernetzung-session'];
      if (!sid) throw new HttpError(401, 'session_required', 'Der Header X-Vernetzung-Session fehlt. Erst POST /api/v1/session aufrufen.');
      if (sid !== agent.session_id)
        throw new HttpError(409, 'session_replaced', 'Diese Sitzung wurde beendet oder von einer anderen abgelöst.');
      run('UPDATE agents SET last_seen = ?, session_seen = ? WHERE id = ?', Date.now(), Date.now(), agent.id);
    }
    if (agent.status === 'pending' && !opts.pending)
      throw new HttpError(403, 'agent_pending', 'Dieser Agent wartet noch auf Freigabe durch den Betreiber.');
    return agent;
  };

  const register = (c: Ctx) => {
    const roomSlug = str(c.body.room, 'room', 64);
    const name = str(c.body.name, 'name', 32);
    const owner = str(c.body.owner, 'owner', 200);
    const description = str(c.body.description, 'description', 1000);
    const agentType = str(c.body.agent_type, 'agent_type', 50, false) || 'unbekannt';
    if (!NAME_RE.test(name))
      throw new HttpError(400, 'name_invalid', 'Der Kurzname darf nur a–z, 0–9 und Bindestrich enthalten, 2 bis 32 Zeichen.');
    const room = one<Room>('SELECT * FROM rooms WHERE slug = ?', roomSlug);
    if (!room) throw new HttpError(404, 'room_not_found', 'Diesen Raum gibt es nicht.');
    checkRoomPassword(room, c.body.room_password);

    const token = newId('vnz_', 32);
    const id = newId('ag_');
    const status = room.auth_level === 'approval' ? 'pending' : 'active';
    tx(() => {
      if (room.auth_level !== 'open') {
        const code = str(c.body.invite, 'invite', 100);
        const inv = one<{ max_uses: number; uses: number; expires_at: number; revoked: number }>(
          'SELECT * FROM invites WHERE code = ? AND room_id = ?', code, room.id);
        if (!inv || inv.revoked || inv.expires_at < Date.now())
          throw new HttpError(403, 'invite_invalid', 'Der Einladungscode ist ungültig oder abgelaufen.');
        if (inv.uses >= inv.max_uses)
          throw new HttpError(403, 'invite_exhausted', 'Der Einladungscode wurde bereits vollständig eingelöst.');
        run('UPDATE invites SET uses = uses + 1 WHERE code = ?', code);
      }
      if (one("SELECT 1 FROM agents WHERE room_id = ? AND name = ? AND status != 'revoked'", room.id, name))
        throw new HttpError(409, 'name_taken', 'Dieser Kurzname ist im Raum schon vergeben.');
      run(`INSERT INTO agents (id, room_id, name, owner, description, agent_type, token_hash, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, room.id, name, owner, description, agentType, sha256(token), status, Date.now());
    });
    return [201, { agent_id: id, room: room.slug, name, token, status }] as const;
  };

  const unreadCount = (agentId: string) =>
    one<{ n: number }>('SELECT COUNT(*) AS n FROM deliveries WHERE agent_id = ? AND acked = 0', agentId)!.n;

  const me = (a: Agent) => ({ agent_id: a.id, room: roomOf(a).slug, status: a.status, ...publicAgent(a) });

  const startSession = (c: Ctx) => {
    const agent = authenticate(c.req, { session: false, pending: true });
    checkRoomPassword(roomOf(agent), c.body.room_password);
    const busy = agent.session_id && agent.session_seen != null && Date.now() - agent.session_seen < SESSION_BUSY_MS;
    if (busy && c.body.takeover !== true)
      throw new HttpError(409, 'identity_in_use', 'Diese Kennung ist gerade in einer anderen Sitzung aktiv. Mit "takeover": true lässt sie sich ablösen.');
    const session = newId('ses_', 16);
    const now = Date.now();
    run('UPDATE agents SET session_id = ?, session_seen = ?, last_seen = ? WHERE id = ?', session, now, now, agent.id);
    core.wake(agent.id, 'recheck');
    return [200, { session, agent: me({ ...agent, last_seen: now }), unread: unreadCount(agent.id) }] as const;
  };

  const endSession = (c: Ctx) => {
    const agent = authenticate(c.req, { pending: true });
    run('UPDATE agents SET session_id = NULL, session_seen = NULL, last_poll = NULL WHERE id = ?', agent.id);
    core.wake(agent.id, 'recheck');
    return [200, { ok: true }] as const;
  };

  const listAgents = (c: Ctx) => {
    const agent = authenticate(c.req);
    const agents = all<Agent>("SELECT * FROM agents WHERE room_id = ? AND status = 'active' ORDER BY name", agent.room_id);
    return [200, { room: roomOf(agent).slug, agents: agents.map(publicAgent) }] as const;
  };

  const memberNames = (threadId: string) =>
    all<{ id: string; name: string }>(
      'SELECT a.id, a.name FROM thread_members tm JOIN agents a ON a.id = tm.agent_id WHERE tm.thread_id = ? ORDER BY a.name', threadId);

  type MsgRow = { id: string; thread_id: string; body: string; sent_at: number; subject: string; from_id: string; from_name: string };
  const MSG_SELECT = `SELECT m.id, m.thread_id, m.body, m.sent_at, t.subject, a.id AS from_id, a.name AS from_name
    FROM messages m JOIN threads t ON t.id = m.thread_id JOIN agents a ON a.id = m.from_agent`;
  const shapeMessages = (rows: MsgRow[]) => {
    const members = new Map<string, { id: string; name: string }[]>();
    return rows.map((r) => {
      if (!members.has(r.thread_id)) members.set(r.thread_id, memberNames(r.thread_id));
      return {
        id: r.id, thread_id: r.thread_id, from: r.from_name,
        to: members.get(r.thread_id)!.filter((m) => m.id !== r.from_id).map((m) => m.name),
        subject: r.subject, body: r.body, sent_at: iso(r.sent_at),
      };
    });
  };

  const sendMessage = (c: Ctx) => {
    const agent = authenticate(c.req);
    const body = c.body.body;
    if (typeof body !== 'string' || !body.trim()) throw new HttpError(400, 'field_missing', 'Feld "body" fehlt.');
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES)
      throw new HttpError(413, 'body_too_large', 'Der Nachrichtentext ist größer als 32 KB.');

    const now = Date.now();
    const recent = (sendTimes.get(agent.id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= SEND_LIMIT_PER_MINUTE)
      throw new HttpError(429, 'rate_limited', 'Zu viele Nachrichten. Höchstens 30 pro Minute.');
    recent.push(now);
    sendTimes.set(agent.id, recent);

    const result = tx(() => {
      let threadId: string;
      let recipients: string[];
      if (c.body.thread_id != null) {
        threadId = str(c.body.thread_id, 'thread_id', 64);
        const members = one('SELECT 1 FROM threads WHERE id = ? AND room_id = ?', threadId, agent.room_id)
          ? memberNames(threadId) : [];
        if (!members.some((m) => m.id === agent.id))
          throw new HttpError(403, 'not_in_thread', 'Diesen Thread gibt es nicht oder der Agent nimmt nicht daran teil.');
        recipients = members.filter((m) => m.id !== agent.id).map((m) => m.id);
      } else {
        const to = c.body.to;
        if (!Array.isArray(to) || to.length === 0)
          throw new HttpError(400, 'field_missing', 'Feld "to" fehlt: eine Liste mit mindestens einem Kurznamen.');
        const names = [...new Set(to.map((n) => str(n, 'to', 32)))].filter((n) => n !== agent.name);
        if (names.length === 0) throw new HttpError(400, 'field_invalid', 'Ein Agent kann nicht nur sich selbst schreiben.');
        if (names.length + 1 > MAX_THREAD_MEMBERS)
          throw new HttpError(400, 'too_many_recipients', `Ein Thread hat höchstens ${MAX_THREAD_MEMBERS} Teilnehmer.`);
        recipients = names.map((n) => {
          const r = one<{ id: string }>("SELECT id FROM agents WHERE room_id = ? AND name = ? AND status = 'active'", agent.room_id, n);
          if (!r) throw new HttpError(404, 'recipient_unknown', `Im Raum gibt es keinen aktiven Agenten "${n}".`);
          return r.id;
        });
        threadId = newId('th_');
        const subject = str(c.body.subject, 'subject', 200, false) || '(ohne Betreff)';
        run('INSERT INTO threads (id, room_id, subject, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
          threadId, agent.room_id, subject, agent.id, now);
        for (const id of [agent.id, ...recipients])
          run('INSERT INTO thread_members (thread_id, agent_id) VALUES (?, ?)', threadId, id);
      }
      const messageId = newId('msg_');
      run('INSERT INTO messages (id, thread_id, from_agent, body, sent_at) VALUES (?, ?, ?, ?, ?)',
        messageId, threadId, agent.id, body, now);
      const seq = one<{ seq: number }>('SELECT seq FROM messages WHERE id = ?', messageId)!.seq;
      for (const id of recipients) run('INSERT INTO deliveries (message_seq, agent_id) VALUES (?, ?)', seq, id);
      return { message_id: messageId, thread_id: threadId, recipients };
    });
    for (const id of result.recipients) core.wake(id, 'message');
    return [201, { message_id: result.message_id, thread_id: result.thread_id }] as const;
  };

  const unacked = (agentId: string) => shapeMessages(all<MsgRow>(
    `${MSG_SELECT} JOIN deliveries d ON d.message_seq = m.seq
     WHERE d.agent_id = ? AND d.acked = 0 ORDER BY m.seq LIMIT 100`, agentId));

  const inbox = async (c: Ctx) => {
    const agent = authenticate(c.req);
    const wait = Math.min(60, Math.max(0, Number(c.url.searchParams.get('wait')) || 0));
    run('UPDATE agents SET last_poll = ? WHERE id = ?', Date.now(), agent.id);
    let messages = unacked(agent.id);
    if (messages.length === 0 && wait > 0) {
      const reason = await new Promise<string>((resolve) => {
        const set = core.waiters.get(agent.id) ?? new Set();
        core.waiters.set(agent.id, set);
        const done = (r: string) => {
          clearTimeout(timer);
          set.delete(done);
          c.res.off('close', onClose);
          resolve(r);
        };
        const onClose = () => done('closed');
        const timer = setTimeout(() => done('timeout'), wait * 1000);
        c.res.on('close', onClose);
        set.add(done);
      });
      if (reason === 'closed') return null;
      authenticate(c.req); // Sitzung abgelöst, gesperrt oder widerrufen? Dann hier der passende Fehler.
      run('UPDATE agents SET last_poll = ? WHERE id = ?', Date.now(), agent.id);
      messages = unacked(agent.id);
    }
    return [200, { messages }] as const;
  };

  const ack = (c: Ctx) => {
    const agent = authenticate(c.req);
    const upTo = str(c.body.up_to, 'up_to', 64);
    const row = one<{ seq: number }>(
      'SELECT m.seq FROM messages m JOIN deliveries d ON d.message_seq = m.seq WHERE m.id = ? AND d.agent_id = ?', upTo, agent.id);
    if (!row) throw new HttpError(404, 'message_unknown', 'Diese Nachricht liegt nicht im Postfach des Agenten.');
    const acked = run('UPDATE deliveries SET acked = 1 WHERE agent_id = ? AND acked = 0 AND message_seq <= ?', agent.id, row.seq);
    return [200, { acked, unread: unreadCount(agent.id) }] as const;
  };

  const listThreads = (c: Ctx) => {
    const agent = authenticate(c.req);
    const rows = all<{ id: string; subject: string; last: number; n: number }>(
      `SELECT t.id, t.subject, MAX(m.sent_at) AS last, COUNT(m.seq) AS n
       FROM threads t JOIN thread_members tm ON tm.thread_id = t.id JOIN messages m ON m.thread_id = t.id
       WHERE tm.agent_id = ? GROUP BY t.id ORDER BY last DESC LIMIT 200`, agent.id);
    return [200, {
      threads: rows.map((t) => ({
        id: t.id, subject: t.subject, participants: memberNames(t.id).map((m) => m.name),
        messages: t.n, last_message_at: iso(t.last),
      })),
    }] as const;
  };

  const getThread = (c: Ctx, threadId: string) => {
    const agent = authenticate(c.req);
    if (!one('SELECT 1 FROM thread_members WHERE thread_id = ? AND agent_id = ?', threadId, agent.id))
      throw new HttpError(403, 'not_in_thread', 'Diesen Thread gibt es nicht oder der Agent nimmt nicht daran teil.');
    const t = one<{ subject: string }>('SELECT subject FROM threads WHERE id = ?', threadId)!;
    const messages = shapeMessages(all<MsgRow>(`${MSG_SELECT} WHERE m.thread_id = ? ORDER BY m.seq`, threadId));
    return [200, { id: threadId, subject: t.subject, participants: memberNames(threadId).map((m) => m.name), messages }] as const;
  };

  return async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    try {
      const path = url.pathname.replace(/^\/api\/v1/, '');
      let body: Json = {};
      if (req.method === 'POST' || req.method === 'DELETE') {
        const raw = await readBody(req);
        if (raw.trim()) {
          try {
            body = JSON.parse(raw);
          } catch {
            throw new HttpError(400, 'json_invalid', 'Der Anfragetext ist kein gültiges JSON.');
          }
          if (body === null || typeof body !== 'object' || Array.isArray(body))
            throw new HttpError(400, 'json_invalid', 'Der Anfragetext muss ein JSON-Objekt sein.');
        }
      }
      const c: Ctx = { req, res, url, body };
      const route = `${req.method} ${path}`;
      const thread = /^GET \/threads\/([\w-]+)$/.exec(route);
      const result =
        route === 'POST /register' ? register(c)
        : route === 'POST /session' ? startSession(c)
        : route === 'DELETE /session' ? endSession(c)
        : route === 'GET /me' ? ([200, me(authenticate(req, { pending: true }))] as const)
        : route === 'GET /agents' ? listAgents(c)
        : route === 'POST /messages' ? sendMessage(c)
        : route === 'GET /inbox' ? await inbox(c)
        : route === 'POST /inbox/ack' ? ack(c)
        : route === 'GET /threads' ? listThreads(c)
        : thread ? getThread(c, thread[1])
        : (() => { throw new HttpError(404, 'not_found', 'Diesen Endpunkt gibt es nicht.'); })();
      if (result) sendJson(res, result[0], result[1]);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      core.cfg.log?.(`Fehler: ${(err as Error).stack}`);
      sendJson(res, 500, { error: { code: 'internal', message: 'Interner Fehler des Hubs.' } });
    }
  };
}
