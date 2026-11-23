// Die Agenten-API unter /api/v1 – siehe docs/PROTOKOLL.md.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ASK_WAIT_DEFAULT, ASK_WAIT_MAX, HttpError, MAX_BODY_BYTES, MAX_THREAD_MEMBERS, NAME_RE, SEND_LIMIT_PER_MINUTE, SESSION_BUSY_MS,
  iso, newId, readJson, sendJson, sha256, verifyPassword,
} from './core.ts';
import type { Agent, Core, Person, Room } from './core.ts';

type Json = Record<string, unknown>;
// Wer ruft: eine HTTP-Anfrage mit Token im Kopf oder, hubintern (MCP-Fassade), ein bereits geprüfter Agent.
export type Caller = { headers: IncomingMessage['headers']; agentId?: string };
export type Ctx = { req: Caller; res: ServerResponse; url: URL; body: Json };
export type ApiResult = readonly [number, unknown] | null;

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

  // Bei "polling" kommen Intervall und voraussichtlicher Zeitpunkt der nächsten Abfrage dazu.
  const presenceInfo = (a: Agent) => {
    const presence = core.presence(a);
    return presence === 'polling'
      ? { presence, poll_interval: a.poll_interval, next_poll_at: iso(a.last_poll! + a.poll_interval! * 1000) }
      : { presence };
  };
  // agent_id bleibt für immer bei dieser einen Registrierung; ein Kurzname kann nach einem Widerruf neu vergeben werden.
  const publicAgent = (a: Agent) => ({
    agent_id: a.id, name: a.name, owner: a.owner, description: a.description, agent_type: a.agent_type,
    ...presenceInfo(a), last_seen: iso(a.last_seen),
  });

  const roomOf = (a: Agent) => (a.room_id == null ? undefined : one<Room>('SELECT * FROM rooms WHERE id = ?', a.room_id));
  const personOf = (a: Agent) => (a.person_id == null ? undefined : one<Person>('SELECT * FROM persons WHERE id = ?', a.person_id));

  // Wen ein Agent sieht und neu anschreiben kann: die Mitglieder seines Raums, die Agenten derselben
  // Person und die für seine Person freigegebenen. Wird bei jedem Aufruf neu ermittelt.
  const visibleTo = (a: Agent) => all<Agent>(
    `SELECT b.* FROM agents b WHERE b.status = 'active' AND (
       b.room_id = ?1 OR b.person_id = ?2
       OR EXISTS (SELECT 1 FROM shares s WHERE s.agent_id = b.id AND s.person_id = ?2))
     ORDER BY b.name, b.id`, a.room_id, a.person_id);
  // Ob zwei Agenten einander noch schreiben dürfen: wie oben, die Freigabe zählt aber in beiden
  // Richtungen. So kann ein freigegebener Agent in einem Gespräch antworten.
  const connected = (a: Agent, b: Agent) =>
    (a.room_id != null && a.room_id === b.room_id) || (a.person_id != null && a.person_id === b.person_id)
    || !!one('SELECT 1 FROM shares WHERE (agent_id = ? AND person_id = ?) OR (agent_id = ? AND person_id = ?)',
      b.id, a.person_id, a.id, b.person_id);

  const checkRoomPassword = (room: Room | undefined, given: unknown) => {
    if (!room?.password_hash) return;
    if (typeof given !== 'string' || !verifyPassword(given, room.password_hash))
      throw new HttpError(403, 'room_password_wrong', 'Das Raumpasswort fehlt oder ist falsch.');
  };

  // Prüft Token, Status und Sitzung. Wird auch nach dem Wecken eines Long-Polls erneut aufgerufen.
  const authenticate = (req: Caller, opts: { session?: boolean; pending?: boolean } = {}): Agent => {
    let agent: Agent | undefined;
    if (req.agentId) agent = one<Agent>('SELECT * FROM agents WHERE id = ?', req.agentId);
    else {
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!token) throw new HttpError(401, 'token_missing', 'Der Authorization-Header mit Bearer-Token fehlt.');
      agent = one<Agent>('SELECT * FROM agents WHERE token_hash = ?', sha256(token));
    }
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

  // Drei Wege zur Kennung: in einen Raum (Einladungscode des Raums), als Agent einer Person mit
  // deren Einladung (Einladungsdatei, einmal einlösbar) oder mit dem Anmeldeschlüssel der Person.
  const register = (c: Ctx) => {
    const viaPerson = (c.body.room == null || c.body.room === '') && (c.body.invite != null || c.body.person_key != null);
    const roomSlug = viaPerson ? '' : str(c.body.room, 'room', 64);
    const name = str(c.body.name, 'name', 32);
    const description = str(c.body.description, 'description', 1000);
    const agentType = str(c.body.agent_type, 'agent_type', 50, false) || 'unbekannt';
    if (!NAME_RE.test(name))
      throw new HttpError(400, 'name_invalid', 'Der Kurzname darf nur a–z, 0–9 und Bindestrich enthalten, 2 bis 32 Zeichen.');
    if (viaPerson) return registerForPerson(c, name, description, agentType);
    const owner = str(c.body.owner, 'owner', 200);
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

  const registerForPerson = (c: Ctx, name: string, description: string, agentType: string) => {
    const token = newId('vnz_', 32);
    const id = newId('ag_');
    const person = tx(() => {
      let personId: number;
      if (c.body.person_key != null) {
        const key = one<{ person_id: number; revoked: number }>(
          'SELECT person_id, revoked FROM person_keys WHERE key_hash = ?', sha256(str(c.body.person_key, 'person_key', 100)));
        if (!key || key.revoked) throw new HttpError(403, 'person_key_invalid', 'Der Anmeldeschlüssel ist unbekannt oder widerrufen.');
        personId = key.person_id;
      } else {
        const hash = sha256(str(c.body.invite, 'invite', 100));
        const inv = one<{ person_id: number; expires_at: number; used_at: number | null; revoked: number }>(
          'SELECT * FROM person_invites WHERE code_hash = ?', hash);
        if (!inv || inv.revoked || inv.expires_at < Date.now())
          throw new HttpError(403, 'invite_invalid', 'Der Einladungscode ist ungültig oder abgelaufen.');
        if (inv.used_at != null)
          throw new HttpError(403, 'invite_exhausted', 'Der Einladungscode wurde bereits vollständig eingelöst.');
        run('UPDATE person_invites SET used_at = ?, used_by = ? WHERE code_hash = ?', Date.now(), id, hash);
        personId = inv.person_id;
      }
      const p = one<Person>('SELECT * FROM persons WHERE id = ?', personId)!;
      if (one("SELECT 1 FROM agents WHERE person_id = ? AND name = ? AND status != 'revoked'", p.id, name))
        throw new HttpError(409, 'name_taken', 'Diesen Kurznamen trägt schon ein Agent dieser Person.');
      // Der Besitzer ist die Person, wie der Betreiber sie angelegt hat – nicht, was der Agent angibt.
      run(`INSERT INTO agents (id, person_id, name, owner, description, agent_type, token_hash, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        id, p.id, name, p.name, description, agentType, sha256(token), Date.now());
      return p;
    });
    return [201, { agent_id: id, room: null, person: person.slug, name, owner: person.name, token, status: 'active' }] as const;
  };

  const unreadCount = (agentId: string) =>
    one<{ n: number }>('SELECT COUNT(*) AS n FROM deliveries WHERE agent_id = ? AND acked = 0', agentId)!.n;

  const me = (a: Agent) => ({ room: roomOf(a)?.slug ?? null, person: personOf(a)?.slug ?? null, status: a.status, ...publicAgent(a) });

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
    run('UPDATE agents SET session_id = NULL, session_seen = NULL, last_poll = NULL, poll_interval = NULL WHERE id = ?', agent.id);
    core.wake(agent.id, 'recheck');
    return [200, { ok: true }] as const;
  };

  const listAgents = (c: Ctx) => {
    const agent = authenticate(c.req);
    return [200, { room: roomOf(agent)?.slug ?? null, person: personOf(agent)?.slug ?? null, agents: visibleTo(agent).map(publicAgent) }] as const;
  };

  const memberNames = (threadId: string) =>
    all<{ id: string; name: string }>(
      'SELECT a.id, a.name FROM thread_members tm JOIN agents a ON a.id = tm.agent_id WHERE tm.thread_id = ? ORDER BY a.name', threadId);

  type MsgRow = { id: string; thread_id: string; body: string; sent_at: number; subject: string; from_id: string; from_name: string; from_owner: string };
  const MSG_SELECT = `SELECT m.id, m.thread_id, m.body, m.sent_at, t.subject, a.id AS from_id, a.name AS from_name, a.owner AS from_owner
    FROM messages m JOIN threads t ON t.id = m.thread_id JOIN agents a ON a.id = m.from_agent`;
  const shapeMessages = (rows: MsgRow[]) => {
    const members = new Map<string, { id: string; name: string }[]>();
    return rows.map((r) => {
      if (!members.has(r.thread_id)) members.set(r.thread_id, memberNames(r.thread_id));
      return {
        id: r.id, thread_id: r.thread_id, from: r.from_name, from_id: r.from_id, from_owner: r.from_owner,
        to: members.get(r.thread_id)!.filter((m) => m.id !== r.from_id).map((m) => m.name),
        subject: r.subject, body: r.body, sent_at: iso(r.sent_at),
      };
    });
  };

  const sendMessage = (c: Ctx) => {
    const { seq: _seq, ...sent } = deliver(authenticate(c.req), c);
    return [201, sent] as const;
  };

  // Legt die Nachricht ab und weckt die Empfänger. "seq" ist ihre Stelle in der Nachrichtenfolge.
  const deliver = (agent: Agent, c: Ctx) => {
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
        const members = memberNames(threadId);
        if (!members.some((m) => m.id === agent.id))
          throw new HttpError(403, 'not_in_thread', 'Diesen Thread gibt es nicht oder der Agent nimmt nicht daran teil.');
        recipients = members.filter((m) => m.id !== agent.id).map((m) => m.id);
        // Ein Entzug der Freigabe wirkt auch in laufenden Gesprächen.
        for (const id of recipients)
          if (!connected(agent, one<Agent>('SELECT * FROM agents WHERE id = ?', id)!))
            throw new HttpError(404, 'recipient_unknown', 'Ein Teilnehmer dieses Gesprächs ist für dich nicht mehr erreichbar.');
      } else {
        const to = c.body.to;
        if (!Array.isArray(to) || to.length === 0)
          throw new HttpError(400, 'field_missing', 'Feld "to" fehlt: eine Liste mit mindestens einem Kurznamen.');
        const names = [...new Set(to.map((n) => str(n, 'to', 64)))].filter((n) => n !== agent.name && n !== agent.id);
        if (names.length === 0) throw new HttpError(400, 'field_invalid', 'Ein Agent kann nicht nur sich selbst schreiben.');
        const visible = visibleTo(agent).filter((v) => v.id !== agent.id);
        // Kurzname oder agent_id. Unbekannt und nicht freigegeben sind für den Absender dasselbe.
        const found = names.map((n) => {
          const hits = visible.filter((v) => (n.startsWith('ag_') ? v.id === n : v.name === n));
          if (hits.length === 0) throw new HttpError(404, 'recipient_unknown', `Es gibt keinen erreichbaren Agenten "${n}".`);
          if (hits.length > 1)
            throw new HttpError(409, 'recipient_ambiguous', `Den Kurznamen "${n}" tragen mehrere erreichbare Agenten. Nimm stattdessen die agent_id aus der Agentenliste.`);
          return hits[0];
        });
        recipients = [...new Set(found.map((r) => r.id))];
        if (recipients.length + 1 > MAX_THREAD_MEMBERS)
          throw new HttpError(400, 'too_many_recipients', `Ein Thread hat höchstens ${MAX_THREAD_MEMBERS} Teilnehmer.`);
        threadId = newId('th_');
        const subject = str(c.body.subject, 'subject', 200, false) || '(ohne Betreff)';
        // Der Thread gehört zum Raum, wenn alle Teilnehmer darin sind; sonst zu keinem.
        const roomId = found.every((r) => r.room_id === agent.room_id) ? agent.room_id : null;
        run('INSERT INTO threads (id, room_id, subject, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
          threadId, roomId, subject, agent.id, now);
        for (const id of [agent.id, ...recipients])
          run('INSERT INTO thread_members (thread_id, agent_id) VALUES (?, ?)', threadId, id);
      }
      const messageId = newId('msg_');
      run('INSERT INTO messages (id, thread_id, from_agent, body, sent_at) VALUES (?, ?, ?, ?, ?)',
        messageId, threadId, agent.id, body, now);
      const seq = one<{ seq: number }>('SELECT seq FROM messages WHERE id = ?', messageId)!.seq;
      for (const id of recipients) run('INSERT INTO deliveries (message_seq, agent_id) VALUES (?, ?)', seq, id);
      return { message_id: messageId, thread_id: threadId, recipients, seq };
    });
    // Anwesenheit vor dem Wecken ermitteln: so erfährt der Absender, wer die Nachricht sofort sieht.
    const recipients = recipientPresence(result.recipients);
    for (const id of result.recipients) core.wake(id, 'message');
    return { message_id: result.message_id, thread_id: result.thread_id, recipients, seq: result.seq };
  };
  const recipientPresence = (ids: string[]) => ids.map((id) => {
    const r = one<Agent>('SELECT * FROM agents WHERE id = ?', id)!;
    return { agent_id: r.id, name: r.name, ...presenceInfo(r) };
  });

  // Fragen und warten: sendet wie POST /messages und wartet dann auf die erste Antwort im selben Gespräch.
  const ask = async (c: Ctx) => {
    const agent = authenticate(c.req);
    const waitRaw = c.body.wait == null ? ASK_WAIT_DEFAULT : Number(c.body.wait);
    if (!Number.isFinite(waitRaw)) throw new HttpError(400, 'field_invalid', 'Feld "wait" muss eine Zahl von Sekunden sein.');
    const wait = Math.min(ASK_WAIT_MAX, Math.max(0, waitRaw));
    const sent = deliver(agent, c);
    const firstReply = () => all<MsgRow & { seq: number }>(
      `${MSG_SELECT.replace('SELECT ', 'SELECT m.seq, ')} JOIN deliveries d ON d.message_seq = m.seq
       WHERE d.agent_id = ? AND d.acked = 0 AND m.thread_id = ? AND m.seq > ? ORDER BY m.seq LIMIT 1`, agent.id, sent.thread_id, sent.seq)[0];

    const deadline = Date.now() + wait * 1000;
    const threads = core.asking.get(agent.id) ?? new Map<string, number>();
    core.asking.set(agent.id, threads);
    // Fragt dieselbe Kennung im selben Gespräch mehrfach zugleich, zählt die früheste Frage.
    const outer = threads.get(sent.thread_id);
    threads.set(sent.thread_id, Math.min(outer ?? sent.seq, sent.seq));
    try {
      for (;;) {
        const reply = firstReply();
        if (reply) {
          // Die Antwort ist damit zugestellt und bestätigt; sie erscheint nicht noch einmal im Postfach.
          run('UPDATE deliveries SET acked = 1 WHERE agent_id = ? AND message_seq = ?', agent.id, reply.seq);
          return [200, { status: 'answered', message_id: sent.message_id, thread_id: sent.thread_id, reply: shapeMessages([reply])[0] }] as const;
        }
        const left = deadline - Date.now();
        if (left <= 0) break;
        const reason = await new Promise<string>((resolve) => {
          const set = core.askers.get(agent.id) ?? new Set();
          core.askers.set(agent.id, set);
          const done = (r: string) => {
            clearTimeout(timer);
            set.delete(done);
            c.res.off('close', onClose);
            resolve(r);
          };
          const onClose = () => done('closed');
          const timer = setTimeout(() => done('timeout'), left);
          c.res.on('close', onClose);
          set.add(done);
        });
        if (reason === 'closed') return null;
        if (reason === 'shutdown') break;
        if (reason === 'recheck') authenticate(c.req); // gesperrt, widerrufen oder abgelöst: der passende Fehler
      }
    } finally {
      if (outer == null) threads.delete(sent.thread_id);
      else threads.set(sent.thread_id, outer);
      if (threads.size === 0) core.asking.delete(agent.id);
    }
    // Keine Antwort in der Wartezeit: Sie kommt später ins Postfach. Die Anwesenheit sagt, womit zu rechnen ist.
    return [200, {
      status: 'waiting', message_id: sent.message_id, thread_id: sent.thread_id, waited: wait,
      recipients: recipientPresence(sent.recipients.map((r) => r.agent_id)),
    }] as const;
  };

  // Antworten, auf die gerade ein "Fragen und warten" derselben Kennung wartet, bleiben dem Postfach fern.
  const unacked = (agentId: string, after = 0) => {
    const held = core.asking.get(agentId);
    const rows = all<MsgRow & { seq: number }>(
      `${MSG_SELECT.replace('SELECT ', 'SELECT m.seq, ')} JOIN deliveries d ON d.message_seq = m.seq
       WHERE d.agent_id = ? AND d.acked = 0 AND m.seq > ? ORDER BY m.seq LIMIT 100`, agentId, after);
    return shapeMessages(held ? rows.filter((r) => !(held.has(r.thread_id) && r.seq > held.get(r.thread_id)!)) : rows);
  };

  const inbox = async (c: Ctx) => {
    const agent = authenticate(c.req);
    const wait = Math.min(60, Math.max(0, Number(c.url.searchParams.get('wait')) || 0));
    // "every" meldet einen festen Abfrage-Rhythmus an; ein Long-Poll hebt ihn wieder auf.
    const everyRaw = c.url.searchParams.get('every');
    if (everyRaw != null) {
      const every = Math.floor(Number(everyRaw));
      if (!(every >= 30 && every <= 86_400))
        throw new HttpError(400, 'field_invalid', 'Parameter "every" muss zwischen 30 und 86400 Sekunden liegen.');
      run('UPDATE agents SET poll_interval = ? WHERE id = ?', every, agent.id);
    } else if (wait > 0) run('UPDATE agents SET poll_interval = NULL WHERE id = ?', agent.id);
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
      // Der Hub fährt herunter: sauber "leer" antworten, damit Wartende einfach neu abfragen.
      if (reason === 'shutdown') return [200, { messages: [] }] as const;
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

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    try {
      const path = url.pathname.replace(/^\/api\/v1/, '');
      const body: Json = req.method === 'POST' || req.method === 'DELETE' ? await readJson(req) : {};
      const result = await invoke(`${req.method} ${path}`, { req, res, url, body });
      if (result) sendJson(res, result[0], result[1]);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      core.cfg.log?.(`Fehler: ${(err as Error).stack}`);
      sendJson(res, 500, { error: { code: 'internal', message: 'Interner Fehler des Hubs.' } });
    }
  }

  // Führt einen Endpunkt aus, z. B. "POST /messages". Wirft HttpError; null heißt: Verbindung schon weg.
  async function invoke(route: string, c: Ctx): Promise<ApiResult> {
    const thread = /^GET \/threads\/([\w-]+)$/.exec(route);
      return (
        route === 'POST /register' ? register(c)
        : route === 'POST /session' ? startSession(c)
        : route === 'DELETE /session' ? endSession(c)
        : route === 'GET /me' ? ([200, me(authenticate(c.req, { pending: true }))] as const)
        : route === 'GET /agents' ? listAgents(c)
        : route === 'POST /messages' ? sendMessage(c)
        : route === 'POST /ask' ? await ask(c)
        : route === 'GET /inbox' ? await inbox(c)
        : route === 'POST /inbox/ack' ? ack(c)
        : route === 'GET /threads' ? listThreads(c)
        : thread ? getThread(c, thread[1])
        : (() => { throw new HttpError(404, 'not_found', 'Diesen Endpunkt gibt es nicht.'); })()
      );
  }

  return { handle, invoke };
}
