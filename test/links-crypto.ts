// Referenz für Abschnitt 11 von docs/PROTOKOLL-VERBINDUNGEN.md: Inhalt der Umschläge.
// Der Hub benutzt nichts davon – für ihn sind Umschläge undurchsichtig. Die Tests fahren damit
// den ganzen Ablauf so, wie ihn eine Installation fährt; wer eine Installation baut, kann sich
// an diese Datei halten.
import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

const VERSION = 1;
const b64 = (b: Buffer) => b.toString('base64url');
const hkdf = (ikm: Buffer, salt: Buffer, info: string) => Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));

const seal = (key: Buffer, aad: Buffer, plain: unknown) => {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aad);
  return Buffer.concat([nonce, c.update(JSON.stringify(plain), 'utf8'), c.final(), c.getAuthTag()]);
};
const open = (key: Buffer, aad: Buffer, sealed: Buffer): any => {
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  d.setAAD(aad);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return JSON.parse(Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()]).toString('utf8'));
};

const rawPublic = (key: KeyObject) => Buffer.from(key.export({ format: 'jwk' }).x!, 'base64url');
const publicFromRaw = (raw: Buffer) => createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64(raw) }, format: 'jwk' });
const aad = (...parts: (string | Buffer)[]) => Buffer.concat(parts.map((p) => {
  const b = Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8');
  // Längenpräfix: verschiedene Aufteilungen derselben Bytes ergeben verschiedene Zusatzdaten.
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}));

// 11.1 – das Geheimnis im Link und was daraus wird.
export function newSecret() {
  return fromSecret(b64(randomBytes(32)));
}
export function fromSecret(secret: string) {
  const s = Buffer.from(secret, 'base64url');
  const joinToken = b64(hkdf(s, Buffer.alloc(0), 'vernetzung/link/v1/join'));
  return {
    secret,
    joinToken,
    // Der Hub bekommt beim Anlegen nur diesen Hash: SHA-256 über die Zeichenkette des Tokens.
    joinHash: createHash('sha256').update(joinToken).digest('hex'),
    inviteKey: hkdf(s, Buffer.alloc(0), 'vernetzung/link/v1/invite'),
  };
}

// 11.2 – Gesuch des Beitretenden.
export function makeHello(inviteKey: Buffer, linkId: string, name: string) {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pub = rawPublic(publicKey);
  const hello = b64(Buffer.concat([Buffer.from([VERSION]), pub, seal(inviteKey, aad('hello', linkId, pub), { name })]));
  return { hello, privateKey: privateKey.export({ format: 'jwk' }) };
}
export function openHello(inviteKey: Buffer, linkId: string, hello: string) {
  const raw = Buffer.from(hello, 'base64url');
  if (raw[0] !== VERSION) throw new Error('unbekannte Version');
  const pub = raw.subarray(1, 33);
  return { pub, name: open(inviteKey, aad('hello', linkId, pub), raw.subarray(33)).name as string };
}

// 11.3 – Antwort des Einladenden: der Gruppenschlüssel, verpackt für genau dieses Mitglied.
export function makeWelcome(inviteKey: Buffer, linkId: string, memberId: string, pub: Buffer, content: unknown) {
  const once = generateKeyPairSync('x25519');
  const oncePub = rawPublic(once.publicKey);
  const shared = diffieHellman({ privateKey: once.privateKey, publicKey: publicFromRaw(pub) });
  const wrap = hkdf(shared, inviteKey, 'vernetzung/link/v1/welcome');
  return b64(Buffer.concat([Buffer.from([VERSION]), oncePub, seal(wrap, aad('welcome', linkId, memberId, oncePub), content)]));
}
export function openWelcome(inviteKey: Buffer, linkId: string, memberId: string, privateJwk: object, welcome: string) {
  const raw = Buffer.from(welcome, 'base64url');
  if (raw[0] !== VERSION) throw new Error('unbekannte Version');
  const oncePub = raw.subarray(1, 33);
  const shared = diffieHellman({
    privateKey: createPrivateKey({ key: privateJwk as any, format: 'jwk' }), publicKey: publicFromRaw(oncePub),
  });
  const wrap = hkdf(shared, inviteKey, 'vernetzung/link/v1/welcome');
  return open(wrap, aad('welcome', linkId, memberId, oncePub), raw.subarray(33));
}

// 11.4 – Nachrichten unter dem Gruppenschlüssel.
export const newGroupKey = () => randomBytes(32);
export function sealMessage(groupKey: Buffer, keyNo: number, linkId: string, fromMember: string, plain: unknown) {
  const head = Buffer.alloc(5);
  head[0] = VERSION;
  head.writeUInt32BE(keyNo, 1);
  return b64(Buffer.concat([head, seal(groupKey, aad('msg', linkId, fromMember, head), plain)]));
}
export function openMessage(keys: Map<number, Buffer>, linkId: string, fromMember: string, box: string) {
  const raw = Buffer.from(box, 'base64url');
  if (raw[0] !== VERSION) throw new Error('unbekannte Version');
  const head = raw.subarray(0, 5);
  const key = keys.get(head.readUInt32BE(1));
  if (!key) throw new Error('unbekannte Schlüsselnummer');
  return open(key, aad('msg', linkId, fromMember, head), raw.subarray(5));
}
