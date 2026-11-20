// Verbindungen unter /api/v1/links – siehe docs/PROTOKOLL-VERBINDUNGEN.md.
//
// Der Hub ist hier nur Postfach für Chiffrat: Er kennt weder Namen noch Inhalte. Umschläge
// (box, hello, welcome) prüft er ausschließlich auf Form und Größe.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, LISTENING_MS, RECENT_MS, iso, newId, readJson, safeEqual, sendJson, sha256 } from './core.ts';
import type { Core } from './core.ts';

export const LINK_VERSION = 1;
export const LINK_SEATS_MAX = 8;
export const LINK_BOX_MAX = 32 * 1024;
export const LINK_ENVELOPE_MAX = 2 * 1024;
export const LINK_SEND_PER_MINUTE = 30;
export const LINK_BACKLOG_MESSAGES = 500;
export const LINK_BACKLOG_BYTES = 2 * 1024 * 1024;
export const LINK_POLL_MEMBERS_MAX = 128;
export const LINK_POLL_WAIT_MAX = 60;
export const LINK_KEY_LINKS_DEFAULT = 20;
const POLL_BATCH = 100;
const TOMBSTONE_MS = 24 * 3600_000;
const JOIN_FAILURES_MAX = 10;
const JOIN_FAILURES_WINDOW_MS = 10 * 60_000;

// Vom Betreiber einstellbare Grenzen (Tabelle settings).
const LIMITS = {
  invite_hours: { key: 'links_invite_hours', def: 24, min: 1, max: 168 },
  message_days: { key: 'links_message_days', def: 7, min: 1, max: 90 },
  idle_days: { key: 'links_idle_days', def: 30, min: 1, max: 365 },
} as const;
export type LinkLimit = keyof typeof LIMITS;

type Json = Record<string, unknown>;
type Ctx = { req: IncomingMessage; res: ServerResponse; body: Json };
type Result = readonly [number, unknown] | null;

type KeyRow = { id: string; label: string; key_hash: string; links_max: number; revoked: number; created_at: number };
type Link = {
  id: string; key_id: string; seats: number; rev: number; seq: number;
  join_hash: string | null; invite_by: string | null; invite_expires_at: number | null;
  created_at: number; last_activity: number;
};
type Member = {
  id: string; link_id: string; token_hash: string; status: string; reason: string | null;
  hello: string | null; welcome: string | null; joined_seq: number; acked_seq: number;
  lost_from: number | null; lost_to: number | null; last_poll: number | null;
  created_at: number; changed_at: number;
};

const ENVELOPE_RE = /^[A-Za-z0-9_-]+$/;
// Dekodierte Bytes zu einer Anzahl base64url-Zeichen.
const bytesOf = (chars: number) => Math.floor((chars * 3) / 4);

export type Links = ReturnType<typeof createLinks>;

export function createLinks(core: Core) {
  const { all, one, run, tx } = core;
  const sendTimes = new Map<string, number[]>();
  const joinFailures = new Map<string, number[]>();

  const limit = (name: LinkLimit): number => {
    const l = LIMITS[name];
    const v = Math.floor(Number(core.setting(l.key) ?? l.def));
    return Number.isFinite(v) ? Math.min(l.max, Math.max(l.min, v)) : l.def;
  };

  const bearer = (req: IncomingMessage): string => {
    const header = req.headers.authorization ?? '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  };

  // Umschlag: base64url ohne Auffüllung; gemessen werden die dekodierten Bytes.
  const envelope = (v: unknown, field: string, max: number, tooLarge: string): string => {
    if (v == null || v === '') throw new HttpError(400, 'field_missing', `Feld "${field}" fehlt.`);
    if (typeof v !== 'string' || !ENVELOPE_RE.test(v))
      throw new HttpError(400, 'field_invalid', `Feld "${field}" muss base64url ohne Auffüllung sein.`);
    if (bytesOf(v.length) > max)
      throw new HttpError(413, tooLarge, `Feld "${field}" ist größer als ${Math.round(max / 1024)} KB.`);
    return v;
  };

  const joinHash = (v: unknown): string => {
    if (v == null || v === '') throw new HttpError(400, 'field_missing', 'Feld "join_hash" fehlt.');
    if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v))
      throw new HttpError(400, 'field_invalid', 'Feld "join_hash" muss ein SHA-256-Wert in Kleinbuchstaben-Hex sein.');
    return v;
  };

  const keyAuth = (req: IncomingMessage): KeyRow => {
    const token = bearer(req);
    const key = token ? one<KeyRow>('SELECT * FROM link_keys WHERE key_hash = ?', sha256(token)) : undefined;
    if (!key) throw new HttpError(401, 'key_invalid', 'Der Zugangsschlüssel fehlt oder ist unbekannt.');
    if (key.revoked) throw new HttpError(401, 'key_revoked', 'Der Zugangsschlüssel wurde widerrufen.');
    return key;
  };

  const UNKNOWN = 'Dieses Mitglied gibt es nicht (Token unbekannt, entfernt, oder die Verbindung wurde gelöscht).';

  // Prüft das Mitglieds-Token gegen die Verbindung im Pfad.
  const memberAuth = (req: IncomingMessage, linkId: string, opts: { anyStatus?: boolean } = {}) => {
    const token = bearer(req);
    if (!token) throw new HttpError(401, 'token_missing', 'Der Authorization-Header mit Bearer-Token fehlt.');
    const member = one<Member>('SELECT * FROM link_members WHERE token_hash = ?', sha256(token));
    if (!member || member.link_id !== linkId) throw new HttpError(401, 'member_unknown', UNKNOWN);
    if (!opts.anyStatus) {
      if (member.status === 'pending')
        throw new HttpError(403, 'not_active', 'Dieses Mitglied wartet noch auf die Annahme durch den Einladenden.');
      if (member.status !== 'active') throw new HttpError(401, 'member_unknown', UNKNOWN);
    }
    const link = one<Link>('SELECT * FROM links WHERE id = ?', linkId)!;
    return { member, link };
  };

  const memberIds = (linkId: string) =>
    all<{ id: string }>('SELECT id FROM link_members WHERE link_id = ?', linkId).map((m) => m.id);
  const wakeAll = (ids: string[]) => { for (const id of ids) core.wake(id, 'link'); };
  const wakeLink = (linkId: string) => wakeAll(memberIds(linkId));
  const bump = (linkId: string) => run('UPDATE links SET rev = rev + 1 WHERE id = ?', linkId);
  const count = (linkId: string, status: string) =>
    one<{ n: number }>('SELECT COUNT(*) AS n FROM link_members WHERE link_id = ? AND status = ?', linkId, status)!.n;

  const presence = (m: Pick<Member, 'id' | 'last_poll'>): string => {
    if (core.waiters.get(m.id)?.size) return 'listening';
    if (m.last_poll == null) return 'offline';
    const age = Date.now() - m.last_poll;
    return age < LISTENING_MS ? 'listening' : age < RECENT_MS ? 'recent' : 'offline';
  };

  // Offene Gesuche ablehnen. Die Zeile bleibt als Vermerk stehen, bis der Beitretende ihn gesehen hat
  // oder 24 Stunden um sind.
  const rejectPending = (linkId: string, reason: string, memberId?: string) =>
    run(`UPDATE link_members SET status = 'rejected', reason = ?, hello = NULL, changed_at = ?
         WHERE link_id = ? AND status = 'pending'${memberId ? ' AND id = ?' : ''}`,
      ...(memberId ? [reason, Date.now(), linkId, memberId] : [reason, Date.now(), linkId]));

  const clearInvite = (linkId: string) =>
    run('UPDATE links SET join_hash = NULL, invite_by = NULL, invite_expires_at = NULL WHERE id = ?', linkId);

  // Eine Nachricht darf weg, sobald jeder aktive Empfänger sie bestätigt hat (oder erst danach beitrat).
  const purgeAcked = (linkId: string) =>
    run(`DELETE FROM link_messages WHERE link_id = ? AND NOT EXISTS (
           SELECT 1 FROM link_members m WHERE m.link_id = link_messages.link_id AND m.status = 'active'
             AND m.id != link_messages.from_member
             AND m.acked_seq < link_messages.seq AND m.joined_seq < link_messages.seq)`, linkId);

  const dropLink = (linkId: string) => {
    run('DELETE FROM link_messages WHERE link_id = ?', linkId);
    run('DELETE FROM link_members WHERE link_id = ?', linkId);
    run('DELETE FROM links WHERE id = ?', linkId);
  };

  // Ein aktives Mitglied ist weg (ausgetreten oder abgelaufen). Liefert true, wenn die Verbindung damit endet.
  const afterDeparture = (link: Link, memberId: string): boolean => {
    if (link.invite_by === memberId) {
      clearInvite(link.id);
      rejectPending(link.id, 'invite_withdrawn');
    }
    if (count(link.id, 'active') === 0) {
      dropLink(link.id);
      return true;
    }
    bump(link.id);
    purgeAcked(link.id);
    return false;
  };

  const limitsInfo = () => ({
    version: LINK_VERSION, seats_max: LINK_SEATS_MAX, box_max: LINK_BOX_MAX, envelope_max: LINK_ENVELOPE_MAX,
    invite_ttl: limit('invite_hours') * 3600, message_ttl: limit('message_days') * 86_400,
    idle_ttl: limit('idle_days') * 86_400, send_per_minute: LINK_SEND_PER_MINUTE,
    poll_wait_max: LINK_POLL_WAIT_MAX, poll_members_max: LINK_POLL_MEMBERS_MAX,
  });

  const activeLinks = (keyId: string) =>
    one<{ n: number }>('SELECT COUNT(*) AS n FROM links WHERE key_id = ?', keyId)!.n;

  const info = (c: Ctx) => {
    if (!bearer(c.req)) return [200, { links: limitsInfo() }] as const;
    const key = keyAuth(c.req);
    return [200, {
      links: limitsInfo(),
      key: { label: key.label, active_links: activeLinks(key.id), links_max: key.links_max },
    }] as const;
  };

  const create = (c: Ctx) => {
    const key = keyAuth(c.req);
    const seats = c.body.seats ?? 2;
    if (typeof seats !== 'number' || !Number.isInteger(seats) || seats < 2 || seats > LINK_SEATS_MAX)
      throw new HttpError(400, 'seats_invalid', `Plätze: 2 bis ${LINK_SEATS_MAX}.`);
    const hash = joinHash(c.body.join_hash);
    const now = Date.now();
    const id = newId('ln_');
    const memberId = newId('m_', 9);
    const token = newId('lmt_', 32);
    const expires = now + limit('invite_hours') * 3600_000;
    tx(() => {
      // Innerhalb der Transaktion zählen: zwei gleichzeitige Anfragen überschreiten die Grenze nicht.
      if (activeLinks(key.id) >= key.links_max)
        throw new HttpError(409, 'links_limit',
          `Dieser Zugangsschlüssel hat bereits ${key.links_max} aktive Verbindungen. Erst eine beenden.`);
      run(`INSERT INTO links (id, key_id, seats, join_hash, invite_by, invite_expires_at, created_at, last_activity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, key.id, seats, hash, memberId, expires, now, now);
      run(`INSERT INTO link_members (id, link_id, token_hash, status, created_at, changed_at)
           VALUES (?, ?, ?, 'active', ?, ?)`, memberId, id, sha256(token), now, now);
    });
    return [201, {
      link_id: id, member_id: memberId, member_token: token, seats, rev: 1,
      url: `${core.baseUrl(c.req)}/l/${id}`, invite_expires_at: iso(expires),
    }] as const;
  };

  const renewInvite = (c: Ctx, linkId: string) => {
    const { member } = memberAuth(c.req, linkId);
    const hash = joinHash(c.body.join_hash);
    const expires = Date.now() + limit('invite_hours') * 3600_000;
    const rev = tx(() => {
      // Gesuche zur alten Einladung lassen sich mit dem neuen Geheimnis nicht mehr prüfen.
      rejectPending(linkId, 'invite_renewed');
      const link = one<Link>('SELECT * FROM links WHERE id = ?', linkId)!;
      if (count(linkId, 'active') >= link.seats)
        throw new HttpError(409, 'link_full', 'Alle Plätze dieser Verbindung sind vergeben.');
      run('UPDATE links SET join_hash = ?, invite_by = ?, invite_expires_at = ?, rev = rev + 1 WHERE id = ?',
        hash, member.id, expires, linkId);
      return link.rev + 1;
    });
    wakeLink(linkId);
    return [200, { url: `${core.baseUrl(c.req)}/l/${linkId}`, invite_expires_at: iso(expires), rev }] as const;
  };

  const withdrawInvite = (c: Ctx, linkId: string) => {
    const { link } = memberAuth(c.req, linkId);
    tx(() => {
      clearInvite(linkId);
      rejectPending(linkId, 'invite_withdrawn');
      bump(linkId);
    });
    wakeLink(linkId);
    return [200, { rev: link.rev + 1 }] as const;
  };

  const join = (c: Ctx, linkId: string) => {
    const now = Date.now();
    const client = core.clientAddress(c.req);
    for (const [address, times] of joinFailures) {
      const fresh = times.filter((t) => now - t < JOIN_FAILURES_WINDOW_MS);
      if (fresh.length) joinFailures.set(address, fresh);
      else joinFailures.delete(address);
    }
    if ((joinFailures.get(client) ?? []).length >= JOIN_FAILURES_MAX)
      throw new HttpError(429, 'rate_limited', 'Zu viele Fehlversuche. Bitte in zehn Minuten erneut versuchen.');

    const token = bearer(c.req);
    const link = one<Link>('SELECT * FROM links WHERE id = ?', linkId);
    // Unbekannte Verbindung, zurückgezogene Einladung und falsches Token sind von außen nicht unterscheidbar.
    if (!token || !link || !link.join_hash || !safeEqual(sha256(token), link.join_hash)) {
      joinFailures.set(client, [...(joinFailures.get(client) ?? []), now]);
      throw new HttpError(404, 'link_unknown', 'Zu dieser Einladung gibt es keine offene Verbindung (erneuert, zurückgezogen oder schon getrennt?).');
    }
    if (link.invite_expires_at == null || link.invite_expires_at <= now)
      throw new HttpError(410, 'invite_expired', 'Die Einladung ist abgelaufen. Der Einladende kann sie erneuern.');
    const hello = envelope(c.body.hello, 'hello', LINK_ENVELOPE_MAX, 'envelope_too_large');

    const memberId = newId('m_', 9);
    const memberToken = newId('lmt_', 32);
    tx(() => {
      // Wartende Gesuche belegen einen Platz, bis sie entschieden oder verfallen sind.
      if (count(linkId, 'active') + count(linkId, 'pending') >= link.seats)
        throw new HttpError(409, 'link_full', 'Alle Plätze dieser Verbindung sind vergeben.');
      run(`INSERT INTO link_members (id, link_id, token_hash, status, hello, created_at, changed_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?)`, memberId, linkId, sha256(memberToken), hello, now, now);
      run('UPDATE links SET rev = rev + 1, last_activity = ? WHERE id = ?', now, linkId);
    });
    wakeLink(linkId);
    return [201, { member_id: memberId, member_token: memberToken, status: 'pending' }] as const;
  };

  // Annahme oder Ablehnung eines Gesuchs – nur durch den Einladenden.
  const decide = (c: Ctx, linkId: string, targetId: string, admit: boolean) => {
    const { member, link } = memberAuth(c.req, linkId);
    if (link.invite_by !== member.id)
      throw new HttpError(403, 'not_inviter', 'Über Gesuche entscheidet nur, wer die geltende Einladung erzeugt hat.');
    const welcome = admit ? envelope(c.body.welcome, 'welcome', LINK_ENVELOPE_MAX, 'envelope_too_large') : '';
    const rev = tx(() => {
      const target = one<Member>('SELECT * FROM link_members WHERE id = ? AND link_id = ?', targetId, linkId);
      if (!target || target.status !== 'pending')
        throw new HttpError(409, 'not_pending', 'Zu diesem Mitglied gibt es kein offenes Gesuch.');
      const now = Date.now();
      if (admit) {
        // Das neue Mitglied beginnt beim aktuellen Stand; Früheres bekommt es nicht.
        const seq = one<{ seq: number }>('SELECT seq FROM links WHERE id = ?', linkId)!.seq;
        run(`UPDATE link_members SET status = 'active', hello = NULL, welcome = ?, joined_seq = ?, acked_seq = ?, changed_at = ?
             WHERE id = ?`, welcome, seq, seq, now, targetId);
      } else rejectPending(linkId, 'declined', targetId);
      run('UPDATE links SET rev = rev + 1, last_activity = ? WHERE id = ?', now, linkId);
      return one<{ rev: number }>('SELECT rev FROM links WHERE id = ?', linkId)!.rev;
    });
    wakeLink(linkId);
    return [200, { rev }] as const;
  };

  const leave = (c: Ctx, linkId: string) => {
    const { member, link } = memberAuth(c.req, linkId, { anyStatus: true });
    const ids = memberIds(linkId);
    tx(() => {
      run('DELETE FROM link_members WHERE id = ?', member.id);
      if (member.status === 'active') afterDeparture(link, member.id);
      else if (member.status === 'pending') bump(linkId);
    });
    sendTimes.delete(member.id);
    wakeAll(ids);
    return [200, { ok: true }] as const;
  };

  const send = (c: Ctx, linkId: string) => {
    const { member } = memberAuth(c.req, linkId);
    const box = envelope(c.body.box, 'box', LINK_BOX_MAX, 'box_too_large');

    const now = Date.now();
    const recent = (sendTimes.get(member.id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= LINK_SEND_PER_MINUTE)
      throw new HttpError(429, 'rate_limited', `Zu viele Nachrichten. Höchstens ${LINK_SEND_PER_MINUTE} pro Minute.`);
    recent.push(now);
    sendTimes.set(member.id, recent);

    const result = tx(() => {
      const recipients = all<Member>(
        "SELECT * FROM link_members WHERE link_id = ? AND status = 'active' AND id != ?", linkId, member.id);
      if (!recipients.length)
        throw new HttpError(409, 'no_recipients', 'In dieser Verbindung gibt es kein weiteres aktives Mitglied.');
      const backlog = one<{ n: number; chars: number | null }>(
        'SELECT COUNT(*) AS n, SUM(LENGTH(box)) AS chars FROM link_messages WHERE link_id = ?', linkId)!;
      if (backlog.n >= LINK_BACKLOG_MESSAGES
        || bytesOf((backlog.chars ?? 0) + box.length) > LINK_BACKLOG_BYTES)
        throw new HttpError(409, 'backlog_full', 'Auf dem Hub lagern zu viele nicht abgeholte Nachrichten dieser Verbindung.');
      const seq = one<{ seq: number }>('SELECT seq FROM links WHERE id = ?', linkId)!.seq + 1;
      run('UPDATE links SET seq = ?, last_activity = ? WHERE id = ?', seq, now, linkId);
      run('INSERT INTO link_messages (link_id, seq, from_member, box, sent_at) VALUES (?, ?, ?, ?, ?)',
        linkId, seq, member.id, box, now);
      return { seq, recipients };
    });
    // Anwesenheit vor dem Wecken ermitteln: so erfährt der Absender, wer die Nachricht sofort sieht.
    const recipients = result.recipients.map((r) => ({ member_id: r.id, presence: presence(r) }));
    wakeAll(result.recipients.map((r) => r.id));
    return [201, { seq: result.seq, sent_at: iso(now), recipients }] as const;
  };

  type Entry = { token: string; ack: number; rev: number; haveKey: boolean };
  const counter = (v: unknown, field: string): number => {
    if (v == null) return 0;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0)
      throw new HttpError(400, 'field_invalid', `Feld "${field}" muss eine ganze Zahl ab 0 sein.`);
    return v;
  };

  // Stand einer Verbindung, wie ihn ein aktives Mitglied sieht. Immer vollständig, nie als Ereignisfolge.
  const roster = (link: Link, member: Member) => {
    const members = all<Member>(
      "SELECT * FROM link_members WHERE link_id = ? AND status IN ('active', 'pending') ORDER BY created_at, id", link.id);
    return {
      seats: link.seats,
      inviter: link.invite_by,
      invite_expires_at: iso(link.invite_expires_at),
      members: members.map((m) =>
        m.status === 'active' ? { member_id: m.id, status: m.status, presence: presence(m) } : { member_id: m.id, status: m.status }),
      // Gesuche sieht nur der Einladende: nur er kann sie prüfen.
      ...(link.invite_by === member.id
        ? { requests: members.filter((m) => m.status === 'pending').map((m) => ({ member_id: m.id, hello: m.hello, at: iso(m.created_at) })) }
        : {}),
    };
  };

  // Wertet einen Eintrag der Abfrage aus und verbucht dabei Bestätigung und Zeitpunkt.
  const evaluate = (e: Entry): { result: unknown; ready: boolean; id?: string } => {
    const member = one<Member>('SELECT * FROM link_members WHERE token_hash = ?', sha256(e.token));
    if (!member) return { ready: true, result: { error: { code: 'member_unknown', message: UNKNOWN } } };
    const link = one<Link>('SELECT * FROM links WHERE id = ?', member.link_id)!;
    run('UPDATE link_members SET last_poll = ? WHERE id = ?', Date.now(), member.id);
    const head = { link_id: link.id, member_id: member.id, status: member.status };
    if (member.status === 'rejected') return { ready: true, result: { ...head, reason: member.reason } };
    if (member.status === 'pending') return { ready: false, id: member.id, result: head };

    let acked = member.acked_seq;
    const ack = Math.min(e.ack, link.seq);
    if (ack > acked) {
      acked = ack;
      run('UPDATE link_members SET acked_seq = ? WHERE id = ?', acked, member.id);
      purgeAcked(link.id);
    }
    let welcome = member.welcome;
    if (e.haveKey && welcome) {
      run('UPDATE link_members SET welcome = NULL WHERE id = ?', member.id);
      welcome = null;
    }
    let gap: { from: number; to: number } | undefined;
    if (member.lost_to != null) {
      if (acked >= member.lost_to) run('UPDATE link_members SET lost_from = NULL, lost_to = NULL WHERE id = ?', member.id);
      else gap = { from: member.lost_from ?? member.lost_to, to: member.lost_to };
    }
    const messages = all<{ seq: number; from_member: string; box: string; sent_at: number }>(
      `SELECT seq, from_member, box, sent_at FROM link_messages
       WHERE link_id = ? AND seq > ? AND from_member != ? ORDER BY seq LIMIT ${POLL_BATCH}`,
      link.id, Math.max(acked, member.joined_seq), member.id)
      .map((m) => ({ seq: m.seq, from: m.from_member, box: m.box, sent_at: iso(m.sent_at) }));
    const changed = e.rev !== link.rev;
    return {
      id: member.id,
      ready: changed || messages.length > 0 || !!welcome || !!gap,
      result: {
        ...head, rev: link.rev,
        ...(changed ? roster(link, member) : {}),
        ...(welcome ? { welcome } : {}),
        ...(gap ? { gap } : {}),
        messages,
      },
    };
  };

  const poll = async (c: Ctx): Promise<Result> => {
    const wait = Math.min(LINK_POLL_WAIT_MAX, Math.max(0, Number(c.body.wait) || 0));
    const raw = c.body.members;
    if (!Array.isArray(raw) || raw.length === 0)
      throw new HttpError(400, 'field_missing', 'Feld "members" fehlt: eine Liste mit mindestens einem Eintrag.');
    if (raw.length > LINK_POLL_MEMBERS_MAX)
      throw new HttpError(400, 'too_many_members', `Höchstens ${LINK_POLL_MEMBERS_MAX} Mitglieder je Abfrage.`);
    const entries: Entry[] = raw.map((x) => {
      const e = (x ?? {}) as Json;
      if (typeof e !== 'object' || typeof e.token !== 'string' || !e.token)
        throw new HttpError(400, 'field_invalid', 'Jeder Eintrag in "members" braucht ein Feld "token".');
      return { token: e.token, ack: counter(e.ack, 'ack'), rev: counter(e.rev, 'rev'), haveKey: e.have_key === true };
    });

    const round = () => tx(() => entries.map(evaluate));
    let results = round();
    if (wait > 0 && !results.some((r) => r.ready)) {
      const ids = [...new Set(results.map((r) => r.id).filter((id): id is string => !!id))];
      const reason = await new Promise<string>((resolve) => {
        const done = (r: string) => {
          clearTimeout(timer);
          for (const id of ids) core.waiters.get(id)?.delete(done);
          c.res.off('close', onClose);
          resolve(r);
        };
        const onClose = () => done('closed');
        const timer = setTimeout(() => done('timeout'), wait * 1000);
        c.res.on('close', onClose);
        for (const id of ids) {
          const set = core.waiters.get(id) ?? new Set();
          core.waiters.set(id, set);
          set.add(done);
        }
      });
      if (reason === 'closed') return null;
      results = round();
    }
    return [200, { results: results.map((r) => r.result) }] as const;
  };

  // Stündlich: Verfallenes entfernen. Liefert nichts; geweckt wird, wer davon betroffen ist.
  const cleanup = () => {
    const now = Date.now();
    const wake = new Set<string>();
    tx(() => {
      // 1. Nachrichten über der Aufbewahrungsfrist. Wer sie noch nicht bestätigt hatte, erfährt die Lücke.
      const cutoff = now - limit('message_days') * 86_400_000;
      const old = all<{ link_id: string; first: number; last: number }>(
        'SELECT link_id, MIN(seq) AS first, MAX(seq) AS last FROM link_messages WHERE sent_at < ? GROUP BY link_id', cutoff);
      for (const o of old) {
        const members = all<Member>("SELECT * FROM link_members WHERE link_id = ? AND status = 'active'", o.link_id);
        for (const m of members) {
          const lost = one<{ first: number | null; last: number | null }>(
            `SELECT MIN(seq) AS first, MAX(seq) AS last FROM link_messages
             WHERE link_id = ? AND sent_at < ? AND seq > ? AND from_member != ?`,
            o.link_id, cutoff, Math.max(m.acked_seq, m.joined_seq), m.id)!;
          if (lost.last == null) continue;
          run('UPDATE link_members SET lost_from = ?, lost_to = ? WHERE id = ?',
            Math.min(m.lost_from ?? lost.first!, lost.first!), lost.last, m.id);
          wake.add(m.id);
        }
        run('DELETE FROM link_messages WHERE link_id = ? AND sent_at < ?', o.link_id, cutoff);
      }

      // 2. Gesuche, über die niemand entschieden hat.
      const stale = now - limit('invite_hours') * 3600_000;
      for (const p of all<Member>("SELECT * FROM link_members WHERE status = 'pending' AND created_at < ?", stale)) {
        rejectPending(p.link_id, 'request_expired', p.id);
        bump(p.link_id);
        for (const id of memberIds(p.link_id)) wake.add(id);
      }

      // 3. Vermerke über abgelehnte Gesuche.
      run("DELETE FROM link_members WHERE status = 'rejected' AND changed_at < ?", now - TOMBSTONE_MS);

      // 4. Mitglieder, die lange nicht abgefragt haben. Geht das letzte, endet die Verbindung.
      const idle = now - limit('idle_days') * 86_400_000;
      for (const m of all<Member>(
        "SELECT * FROM link_members WHERE status = 'active' AND COALESCE(last_poll, created_at) < ?", idle)) {
        const link = one<Link>('SELECT * FROM links WHERE id = ?', m.link_id);
        if (!link) continue;
        for (const id of memberIds(link.id)) wake.add(id);
        run('DELETE FROM link_members WHERE id = ?', m.id);
        afterDeparture(link, m.id);
        sendTimes.delete(m.id);
      }
    });
    wakeAll([...wake]);
  };

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    try {
      const path = url.pathname.replace(/^\/api\/v1\/links/, '').replace(/\/+$/, '');
      const body: Json = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE' ? await readJson(req) : {};
      const c: Ctx = { req, res, body };
      const route = `${req.method} ${path}`;
      const at = (re: RegExp) => re.exec(route);
      let m: RegExpExecArray | null;
      const result: Result =
        route === 'GET /info' ? info(c)
        : route === 'POST ' ? create(c)
        : route === 'POST /poll' ? await poll(c)
        : (m = at(/^POST \/(ln_[\w-]+)\/join$/)) ? join(c, m[1])
        : (m = at(/^PUT \/(ln_[\w-]+)\/invite$/)) ? renewInvite(c, m[1])
        : (m = at(/^DELETE \/(ln_[\w-]+)\/invite$/)) ? withdrawInvite(c, m[1])
        : (m = at(/^POST \/(ln_[\w-]+)\/messages$/)) ? send(c, m[1])
        : (m = at(/^DELETE \/(ln_[\w-]+)\/members\/me$/)) ? leave(c, m[1])
        : (m = at(/^POST \/(ln_[\w-]+)\/members\/(m_[\w-]+)\/admit$/)) ? decide(c, m[1], m[2], true)
        : (m = at(/^DELETE \/(ln_[\w-]+)\/members\/(m_[\w-]+)$/)) ? decide(c, m[1], m[2], false)
        : (() => { throw new HttpError(404, 'not_found', 'Diesen Endpunkt gibt es nicht.'); })();
      if (result) sendJson(res, result[0], result[1]);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      core.cfg.log?.(`Fehler: ${(err as Error).stack}`);
      sendJson(res, 500, { error: { code: 'internal', message: 'Interner Fehler des Hubs.' } });
    }
  }

  // Für die Betreiber-GUI. Inhalte und Namen gibt es hier nicht – der Hub hat sie nicht.
  const admin = {
    keys: () => all<KeyRow & { active_links: number }>(
      `SELECT k.*, (SELECT COUNT(*) FROM links l WHERE l.key_id = k.id) AS active_links
       FROM link_keys k ORDER BY k.revoked, k.created_at DESC`),
    createKey: (label: string, linksMax: number): string => {
      const token = newId('vnk_', 32);
      run('INSERT INTO link_keys (id, label, key_hash, links_max, created_at) VALUES (?, ?, ?, ?, ?)',
        newId('lk_', 9), label, sha256(token), linksMax, Date.now());
      return token;
    },
    revokeKey: (id: string) => run('UPDATE link_keys SET revoked = 1 WHERE id = ?', id),
    links: () => all<{
      id: string; label: string; seats: number; created_at: number; last_activity: number;
      active: number; pending: number; stored: number; chars: number | null;
    }>(
      `SELECT l.id, k.label, l.seats, l.created_at, l.last_activity,
         (SELECT COUNT(*) FROM link_members m WHERE m.link_id = l.id AND m.status = 'active') AS active,
         (SELECT COUNT(*) FROM link_members m WHERE m.link_id = l.id AND m.status = 'pending') AS pending,
         (SELECT COUNT(*) FROM link_messages x WHERE x.link_id = l.id) AS stored,
         (SELECT SUM(LENGTH(x.box)) FROM link_messages x WHERE x.link_id = l.id) AS chars
       FROM links l JOIN link_keys k ON k.id = l.key_id ORDER BY l.last_activity DESC LIMIT 500`)
      .map(({ chars, ...l }) => ({ ...l, bytes: bytesOf(chars ?? 0) })),
    deleteLink: (id: string) => {
      const ids = memberIds(id);
      tx(() => dropLink(id));
      wakeAll(ids);
    },
    limits: () => Object.fromEntries(
      (Object.keys(LIMITS) as LinkLimit[]).map((name) => [name, { ...LIMITS[name], value: limit(name) }])) as
      Record<LinkLimit, { key: string; def: number; min: number; max: number; value: number }>,
    setLimit: (name: LinkLimit, value: number) => {
      const l = LIMITS[name];
      const v = Math.floor(value);
      core.setSetting(l.key, String(Number.isFinite(v) ? Math.min(l.max, Math.max(l.min, v)) : l.def));
    },
  };

  return { handle, cleanup, admin };
}

// Landeseite einer Einladung. Für jede Kennung dieselbe: kein Nachschlagen, also keine Auskunft,
// ob es die Verbindung gibt. Kein Skript – der Teil hinter # bleibt im Browser.
export const invitePage = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Einladung zu einer Verbindung</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8f6f1;color:#2b2622;font:16px/1.55 system-ui,sans-serif}
main{max-width:34rem;margin:1rem;padding:1.75rem;background:#fff;border:1px solid #e7e2d8;border-radius:16px}
h1{font-size:1.35rem;margin:0 0 .75rem}p{margin:0 0 .85rem}ol{margin:0 0 .85rem;padding-left:1.25rem}li{margin-bottom:.35rem}
.mut{color:#746b62;font-size:.9rem;margin:0}
@media(prefers-color-scheme:dark){body{background:#1b1917;color:#f3f1ee}main{background:#262321;border-color:#3a3633}.mut{color:#a8a099}}
</style></head><body><main>
<h1>Einladung zu einer Verbindung</h1>
<p>Diese Adresse lädt eine Agenten-Sitzung in deinem Webterminal dazu ein, sich mit Sitzungen einer
anderen Installation zu verbinden. Im Browser lässt sie sich nicht annehmen.</p>
<ol>
<li>Kopiere die Adresse <strong>vollständig</strong> aus der Adresszeile – samt dem Teil hinter dem <code>#</code>.</li>
<li>Öffne dein Webterminal und dort das Ketten-Symbol an der Sitzung, die beitreten soll.</li>
<li>Wähle „Beitreten“ und füge die Adresse ein.</li>
</ol>
<p class="mut">Der Teil hinter dem # ist der Schlüssel. Er wird nicht an diesen Server übertragen und
gehört nur an Personen, die beitreten sollen. Die Nachrichten der Verbindung sind Ende-zu-Ende-verschlüsselt;
der Betreiber dieses Servers kann sie nicht lesen.</p>
</main></body></html>
`;
