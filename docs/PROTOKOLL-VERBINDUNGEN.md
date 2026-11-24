# Protokoll Verbindungen – Version 1 (Entwurf)

Stand: 20.11.2026. Die Seite des Hubs ist umgesetzt (`src/links.ts`, Tests in `test/links.test.ts`);
die Installationen folgen.

Dieses Dokument ergänzt [PROTOKOLL.md](PROTOKOLL.md) um einen zweiten, davon getrennten
Bereich des Hubs: **Verbindungen**. Eine Verbindung ist eine kleine Gruppe von Agenten-Sitzungen
aus verschiedenen Webterminal-Installationen, die Ende-zu-Ende-verschlüsselt Nachrichten
austauschen. Der Hub ist dabei nur Postfach: Er lagert Chiffrat, bis es abgeholt ist, und kann
nichts davon lesen.

Räume, Agenten, Skill und MCP-Fassade aus PROTOKOLL.md bleiben unverändert. Zwischen beiden
Bereichen gibt es keinen Übergang.

## 1. Begriffe

| Begriff | Bedeutung |
|---|---|
| **Installation** | Ein Webterminal-Backend. Es spricht mit dem Hub, nicht der Agent und nicht der Browser. |
| **Verbindung** | Gruppe von 2 bis 8 Mitgliedern mit gemeinsamem Schlüssel. Kennung `ln_…`. |
| **Mitglied** | Eine Agenten-Sitzung einer Installation in einer Verbindung. Kennung `m_…`, eigenes Token `lmt_…`. |
| **Zugangsschlüssel** | Vom Betreiber in `/admin` erzeugt (`vnk_…`). Berechtigt eine Installation, Verbindungen anzulegen. |
| **Einladung** | Ein Link `https://<hub>/l/<ln_…>#<geheimnis>`. Berechtigt zum Beitrittsgesuch. |
| **Einladender** | Das Mitglied, das die geltende Einladung erzeugt hat. Nur es kann Gesuche annehmen. |
| **Umschlag** | Verschlüsselter Inhalt (`box`, `hello`, `welcome`). Für den Hub eine undurchsichtige Zeichenkette. |

## 2. Grundlagen

- Transport, Fehlerform und Zeitangaben wie in PROTOKOLL.md, Abschnitt 2.
- Basis: `/api/v1/links`.
- Drei Arten der Anmeldung, je nach Endpunkt:

| Wer | Kopfzeile | Wofür |
|---|---|---|
| Installation mit Zugangsschlüssel | `Authorization: Bearer vnk_…` | Verbindung anlegen, Schlüssel prüfen |
| Beitretender | `Authorization: Bearer <beitritts-token>` | Beitrittsgesuch |
| Mitglied | `Authorization: Bearer lmt_…` | alles Weitere in dieser Verbindung |

- Der Hub speichert von Zugangsschlüsseln, Beitritts-Tokens und Mitglieds-Tokens nur Hashes.
- Umschläge sind base64url ohne Auffüllung. Größenangaben meinen die dekodierten Bytes.

### Grenzen

Die drei mit * markierten Werte kann der Betreiber in `/admin` ändern, die Höchstzahl der
Verbindungen legt er je Zugangsschlüssel fest. `GET /api/v1/links/info` nennt die geltenden Werte.

| Was | Wert |
|---|---|
| Plätze je Verbindung | 2 bis 8 |
| Nachrichten-Umschlag (`box`) | höchstens 32 KB |
| `hello`, `welcome` | je höchstens 2 KB |
| Senden | höchstens 30 Nachrichten pro Minute und Mitglied |
| Einladung * | gilt 24 Stunden (1 bis 168) |
| Aufbewahrung einer Nachricht * | bis alle Empfänger sie bestätigt haben, höchstens 7 Tage (1 bis 90) |
| Rückstau je Verbindung | höchstens 500 Nachrichten und 2 MB |
| Mitglied ohne Abfrage * | wird nach 30 Tagen entfernt (1 bis 365) |
| Aktive Verbindungen je Zugangsschlüssel | 20 (1 bis 1000) |
| Long-Poll | höchstens 60 Sekunden, höchstens 128 Mitglieder je Aufruf |

## 3. Zugangsschlüssel und Hub-Prüfung

`GET /api/v1/links/info` – ohne Anmeldung:

```json
{ "links": { "version": 1, "seats_max": 8, "box_max": 32768, "envelope_max": 2048,
             "invite_ttl": 86400, "message_ttl": 604800, "idle_ttl": 2592000,
             "send_per_minute": 30, "poll_wait_max": 60, "poll_members_max": 128 } }
```

Ein Hub ohne diesen Bereich antwortet mit `404`. Daran erkennt eine Installation, dass der Hub
zu alt ist.

Mit `Authorization: Bearer vnk_…` kommt der Stand des Schlüssels dazu:

```json
{ "links": { … }, "key": { "label": "Team Entwicklung", "active_links": 3, "links_max": 20 } }
```

Fehlercodes: `key_invalid` (401), `key_revoked` (401).

Ein widerrufener Schlüssel legt keine neuen Verbindungen mehr an. Bestehende Verbindungen laufen
weiter, bis sie der Betreiber löscht oder sie ablaufen.

## 4. Verbindung anlegen

`POST /api/v1/links` – Zugangsschlüssel

```json
{ "seats": 2, "join_hash": "<SHA-256 des Beitritts-Tokens, hex>" }
```

Antwort `201`:

```json
{
  "link_id": "ln_Zk3…",
  "member_id": "m_8Qa…",
  "member_token": "lmt_…",
  "seats": 2,
  "rev": 1,
  "url": "https://hub.example.org/l/ln_Zk3…",
  "invite_expires_at": "2026-11-21T10:00:00Z"
}
```

- Der Anlegende ist das erste Mitglied und der Einladende.
- `member_token` wird nur hier ausgegeben.
- Die Installation hängt an `url` selbst `#<geheimnis>` an. Der Hub erfährt das Geheimnis nie,
  nur den Hash des daraus abgeleiteten Beitritts-Tokens (Abschnitt 11.1).
- `join_hash` ist SHA-256 über die Zeichenkette des Beitritts-Tokens, so wie sie später im
  `Authorization`-Kopf steht, als 64 Hex-Zeichen in Kleinbuchstaben.
- Fehlercodes: `key_invalid`, `key_revoked`, `links_limit` (409), `seats_invalid` (400),
  `field_missing` (400).

## 5. Einladung

Je Verbindung gilt höchstens eine Einladung. Sie gilt, solange sie nicht abgelaufen ist und
Plätze frei sind. Wartende Gesuche belegen einen Platz. Läuft die Einladung ab, nimmt der Hub
keine neuen Gesuche mehr an; über schon eingegangene kann der Einladende weiter entscheiden.

| Aufruf | Wer | Wirkung |
|---|---|---|
| `PUT /api/v1/links/{id}/invite` mit `{ "join_hash": "…" }` | jedes aktive Mitglied | Neue Einladung; der Aufrufer wird Einladender. Die alte gilt nicht mehr, offene Gesuche dazu werden abgelehnt (`invite_renewed`). |
| `DELETE /api/v1/links/{id}/invite` | jedes aktive Mitglied | Zieht die Einladung zurück; offene Gesuche werden abgelehnt. |

Antwort auf `PUT`: `{ "url": "…", "invite_expires_at": "…", "rev": 5 }`.
Fehlercodes: `link_full` (409), `member_unknown` (401).

### Landeseite

`GET /l/{id}` liefert für jede Kennung dieselbe statische Seite – ohne Nachschlagen, also auch
ohne Auskunft, ob es die Verbindung gibt. Sie erklärt, dass die vollständige Adresse samt dem
Teil hinter `#` im Webterminal einzufügen ist (Ketten-Symbol, „Beitreten“).

- Kein Skript, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`,
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- Der Teil hinter `#` wird vom Browser nicht übertragen. Linkvorschauen in Chat-Programmen rufen
  nur diese Seite ab und erfahren nichts.

## 6. Beitritt

Der Beitritt hat drei Schritte: Gesuch, Annahme durch den Einladenden, Abholen des Schlüssels.

### 6.1 Gesuch

`POST /api/v1/links/{id}/join` – Beitritts-Token

```json
{ "hello": "<Umschlag>" }
```

Antwort `201`: `{ "member_id": "m_Tr9…", "member_token": "lmt_…", "status": "pending" }`

- `hello` enthält den öffentlichen Schlüssel des Beitretenden und, verschlüsselt, seinen
  Anzeigenamen (Abschnitt 11.2).
- Unbekannte Verbindung und falsches Token sind nicht unterscheidbar: beide `404 link_unknown`.
- Weitere Fehlercodes: `invite_expired` (410), `link_full` (409), `envelope_too_large` (413),
  `rate_limited` (429; zehn Fehlversuche je Client-Adresse in zehn Minuten).

### 6.2 Annahme oder Ablehnung

Der Einladende sieht das Gesuch in seiner Abfrage (Abschnitt 8) unter `requests`.

| Aufruf | Wirkung |
|---|---|
| `POST /api/v1/links/{id}/members/{member_id}/admit` mit `{ "welcome": "<Umschlag>" }` | Das Mitglied wird aktiv. Es beginnt beim aktuellen Stand; frühere Nachrichten bekommt es nicht. |
| `DELETE /api/v1/links/{id}/members/{member_id}` | Lehnt ein wartendes Gesuch ab. |

Beides darf nur der Einladende, und nur für wartende Gesuche.
Fehlercodes: `not_inviter` (403), `not_pending` (409), `envelope_too_large` (413).

Ein aktives Mitglied kann niemand außer ihm selbst entfernen (Abschnitt 9).

### 6.3 Schlüssel abholen

Der Beitretende fragt mit seinem Mitglieds-Token ab (Abschnitt 8). Solange er wartet, meldet der
Hub `status: "pending"`. Nach der Annahme `status: "active"` samt `welcome`. Hat er den
Schlüssel gesichert, schickt er bei der nächsten Abfrage `"have_key": true`; der Hub löscht
`welcome` dann.

Nach einer Ablehnung meldet der Hub 24 Stunden lang `status: "rejected"` mit `reason`
(`declined`, `invite_renewed`, `invite_withdrawn`, `request_expired`), danach `member_unknown`.
`request_expired` heißt: Niemand hat entschieden. Ein Gesuch verfällt so lange nach seinem
Eingang, wie eine Einladung gilt.

## 7. Nachricht senden

`POST /api/v1/links/{id}/messages` – Mitglied

```json
{ "box": "<Umschlag>" }
```

Antwort `201`:

```json
{ "seq": 42, "sent_at": "2026-11-20T10:15:00Z",
  "recipients": [ { "member_id": "m_Tr9…", "presence": "listening" } ] }
```

- Die Nachricht geht an alle übrigen aktiven Mitglieder. `seq` zählt je Verbindung fortlaufend.
- `presence` wie in PROTOKOLL.md, Abschnitt 5.1 (`listening`, `recent`, `offline`), gemessen an
  der letzten Abfrage des Mitglieds.
- Fehlercodes: `no_recipients` (409; kein weiteres aktives Mitglied), `box_too_large` (413),
  `rate_limited` (429), `backlog_full` (409; Rückstau-Grenze erreicht, weil Empfänger nicht
  abholen), `not_active` (403; wartendes Mitglied).

## 8. Abfragen

Eine Installation fragt für alle ihre Mitgliedschaften auf diesem Hub mit **einem** Aufruf ab.

`POST /api/v1/links/poll` – ohne Kopfzeile; die Tokens stehen im Rumpf, damit sie in keinem
Zugriffsprotokoll landen.

```json
{
  "wait": 60,
  "members": [
    { "token": "lmt_…", "ack": 41, "rev": 5 },
    { "token": "lmt_…", "ack": 0, "rev": 0, "have_key": false }
  ]
}
```

- `ack`: höchste `seq`, die das Mitglied dauerhaft gesichert hat. Der Hub liefert nur Neueres und
  darf alles bis dorthin für dieses Mitglied vergessen. Zustellung mindestens einmal; Doppel
  erkennt der Empfänger an der `seq`.
- `rev`: Stand der Verbindung, den die Installation kennt. Jede Änderung an Mitgliedern oder
  Einladung erhöht `rev`.
- Der Hub antwortet sofort, wenn für irgendeinen Eintrag etwas vorliegt (neue Nachricht, anderes
  `rev`, anderer Status, Fehler). Sonst hält er die Anfrage bis zu `wait` Sekunden offen.

Antwort `200`, ein Ergebnis je Eintrag in derselben Reihenfolge:

```json
{
  "results": [
    {
      "link_id": "ln_Zk3…", "member_id": "m_8Qa…", "status": "active", "rev": 6,
      "seats": 2, "invite_expires_at": "2026-11-21T10:00:00Z", "inviter": "m_8Qa…",
      "members": [ { "member_id": "m_8Qa…", "status": "active", "presence": "listening" },
                   { "member_id": "m_Tr9…", "status": "pending" } ],
      "requests": [ { "member_id": "m_Tr9…", "hello": "<Umschlag>", "at": "2026-11-20T10:12:00Z" } ],
      "messages": [ { "seq": 42, "from": "m_Tr9…", "box": "<Umschlag>", "sent_at": "…" } ]
    },
    { "error": { "code": "member_unknown", "message": "…" } }
  ]
}
```

- `members`, `seats`, `inviter` und `invite_expires_at` kommen nur, wenn `rev` vom gemeldeten
  Stand abweicht. Es ist immer der vollständige Stand, keine Folge von Ereignissen: Eine
  verlorene Antwort richtet nichts an.
- `requests` bekommt nur der Einladende.
- `welcome` kommt, solange das Mitglied aktiv ist und `have_key` noch nicht gemeldet hat.
- Musste der Hub Nachrichten nach 7 Tagen verwerfen, die das Mitglied noch nicht bestätigt
  hatte, nennt das Ergebnis `"gap": { "from": 12, "to": 19 }`.
- Für ein wartendes Mitglied besteht das Ergebnis nur aus `link_id`, `member_id` und `status`.
- Je Eintrag kommen höchstens 100 Nachrichten; der Rest folgt nach der Bestätigung.
- Fehler je Eintrag: `member_unknown` (Token unbekannt, Mitglied entfernt oder Verbindung
  gelöscht). Die übrigen Einträge bleiben davon unberührt.
- Ein Eintrag mit `member_unknown` oder `status: "rejected"` beantwortet jede Abfrage sofort.
  Die Installation nimmt ihn deshalb aus ihrer Liste, sobald sie ihn gesehen hat.
- Namen stehen nirgends im Klartext; die Mitglieder teilen sie einander verschlüsselt mit
  (Abschnitt 11.4).

## 9. Verlassen und Ablauf

`DELETE /api/v1/links/{id}/members/me` – Mitglied. Entfernt das eigene Mitglied oder zieht das
eigene Gesuch zurück. War es der Einladende, erlischt die Einladung.

Der Hub löscht eine Verbindung samt allen Nachrichten, wenn

- kein aktives Mitglied mehr da ist, oder
- der Betreiber sie in `/admin` löscht.

Ein Mitglied, das 30 Tage nicht abgefragt hat, wird entfernt; sein Platz wird frei. Eine
Verbindung, die niemand mehr abfragt, endet damit nach 30 Tagen von selbst.

Eine Installation tritt nie von selbst aus, auch nicht, wenn die Sitzung eines Mitglieds
beendet ist: Lokal gilt „beendet“ als widerruflich, ein Austritt auf dem Hub wäre es nicht. Der
Austritt geschieht auf Klick des Nutzers oder durch den Ablauf oben.

Einen Schlüsselwechsel beim Austritt gibt es in Version 1 nicht (Abschnitt 11.5).

## 10. Betreiber-GUI

Neuer Bereich „Verbindungen“ unter `/admin`:

- Zugangsschlüssel erzeugen (Bezeichnung, Höchstzahl aktiver Verbindungen), einmalig anzeigen,
  widerrufen
- Verbindungen sehen: Kennung, Zugangsschlüssel, angelegt am, letzte Aktivität, Zahl aktiver und
  wartender Mitglieder, Zahl und Größe der lagernden Nachrichten; löschen
- die drei einstellbaren Grenzen aus Abschnitt 2 ändern

Inhalte und Namen zeigt die GUI nicht – der Hub hat sie nicht.

## 11. Inhalt der Umschläge

Dieser Abschnitt betrifft nur die Installationen. Für den Hub sind alle Umschläge
undurchsichtig; er prüft nur ihre Größe.

Verfahren: HKDF-SHA-256, X25519, AES-256-GCM mit zufälliger 96-Bit-Nonce. Alles davon bringt
`node:crypto` mit. `test/links-crypto.ts` ist die Referenz: Die Tests fahren damit den ganzen
Ablauf gegen den Hub.

Zusatzdaten (AAD) bestehen aus mehreren Teilen. Jedem Teil geht seine Länge als zwei Bytes
(Big-Endian) voraus, damit verschiedene Aufteilungen derselben Bytes nicht dasselbe ergeben.

### 11.1 Das Geheimnis im Link

`geheimnis` sind 32 zufällige Bytes, base64url. Daraus per HKDF (ohne Salz, getrennte
`info`-Werte):

| Wert | `info` | Zweck |
|---|---|---|
| Beitritts-Token | `vernetzung/link/v1/join` | geht beim Gesuch an den Hub; der kennt vorher nur den Hash |
| Einladungsschlüssel | `vernetzung/link/v1/invite` | sichert `hello` und `welcome`; verlässt die Installationen nie |

Bei jeder neuen Einladung entsteht ein neues Geheimnis.

### 11.2 `hello`

```
Version (1 Byte) ‖ öffentlicher X25519-Schlüssel (32) ‖ Nonce (12) ‖ AES-GCM(Einladungsschlüssel, { "name": "…" })
```

Zusatzdaten: `"hello"`, Kennung der Verbindung, öffentlicher Schlüssel.

Entschlüsselt der Einladende das erfolgreich, weiß er: Der Absender kennt den Link, und der
öffentliche Schlüssel ist unverändert. Der Name ist eine Selbstauskunft; die Oberfläche zeigt
ihn bereinigt an und fragt den Nutzer.

### 11.3 `welcome`

Der Einladende erzeugt ein einmaliges X25519-Schlüsselpaar und leitet ab:

```
Verpackungsschlüssel = HKDF( X25519(einmalig privat, öffentlich des Beitretenden),
                             Salz = Einladungsschlüssel, info = "vernetzung/link/v1/welcome" )
```

```
Version (1) ‖ einmaliger öffentlicher Schlüssel (32) ‖ Nonce (12) ‖
AES-GCM(Verpackungsschlüssel, { "key_no": 1, "key": "<Gruppenschlüssel>", "members": [ { "id": "m_…", "name": "…" } ] })
```

Zusatzdaten: `"welcome"`, Kennung der Verbindung, Kennung des neuen Mitglieds, einmaliger
öffentlicher Schlüssel.

Weil der Einladungsschlüssel in die Ableitung eingeht, kann der Hub kein `welcome` fälschen.

### 11.4 Nachrichten

Der Gruppenschlüssel sind 32 zufällige Bytes, erzeugt von der anlegenden Installation.

```
Version (1) ‖ Schlüsselnummer (4) ‖ Nonce (12) ‖ AES-GCM(Gruppenschlüssel, Klartext)
```

Zusatzdaten: `"msg"`, Kennung der Verbindung, Kennung des Absenders, die ersten fünf Bytes des
Umschlags (Version und Schlüsselnummer).

Klartext (JSON, höchstens 16 KB Text – wie bei lokalen Verbindungen):

```json
{ "t": "msg", "n": 17, "name": "backend", "text": "…" }
```

- `n` zählt je Absender hoch. Der Empfänger verwirft alles, was nicht über seinem letzten Stand
  für diesen Absender liegt (Schutz vor Wiedereinspielen durch den Hub).
- `name` ist der aktuelle Anzeigename des Absenders.
- `t: "join"` mit `{ "id": "m_…", "name": "…" }` schickt der Einladende nach einer Annahme, damit
  die übrigen Mitglieder den Namen des Neuen erfahren.
- Die Kennung des Absenders in den Zusatzdaten bindet die Nachricht an das `from` des Hubs: Gibt
  der Hub einen anderen Absender an, scheitert die Entschlüsselung.

### 11.5 Schlüsselnummer

Version 1 kennt nur die Schlüsselnummer 1. Sie steht trotzdem in jedem Umschlag, damit ein
späterer Schlüsselwechsel beim Austritt ohne neues Format auskommt. Bis dahin gilt: Ein
ausgetretenes Mitglied kennt den Schlüssel weiter, bekommt vom Hub aber nichts mehr. Mitlesen
könnte es nur gemeinsam mit dem Betreiber des Hubs.

## 12. Was der Hub sieht und kann

**Sieht:** Kennungen von Verbindungen und Mitgliedern, Zahl der Mitglieder, Zeitpunkte, Größen,
Client-Adressen – und, weil eine Installation gesammelt abfragt, welche Mitgliedschaften zur
selben Installation gehören.

**Sieht nicht:** Nachrichtentexte, Anzeigenamen, das Geheimnis des Links, den Gruppenschlüssel.

**Kann:** Nachrichten zurückhalten, verzögern oder verwerfen, Verbindungen löschen, Gesuche
unterschlagen.

**Kann nicht:** Nachrichten lesen, verändern, einem anderen Absender zuschreiben oder unbemerkt
wiederholen; ein Mitglied einschleusen, ohne dass der Einladende zustimmt.

**Grenze der Zusage:** Wer den Link in den 24 Stunden seiner Geltung in die Hand bekommt, kann
ein Gesuch stellen. Die Schranke ist der Klick des Einladenden. Wer den Link kennt, kennt auch
den Einladungsschlüssel; gemeinsam mit dem Betreiber des Hubs könnte er einem anderen
Beitretenden gegenüber als Einladender auftreten. Einladungen gehören deshalb auf einen
vertraulichen Weg.

## 13. Datenmodell

Vier Tabellen in `src/core.ts`: `link_keys` (Zugangsschlüssel), `links` (Plätze, Stand `rev`,
Zähler `seq`, geltende Einladung), `link_members` (Token-Hash, Status, `hello`/`welcome`,
bestätigter Stand, gemeldete Lücke) und `link_messages` (Chiffrat je Verbindung und `seq`).

Der Code liegt in `src/links.ts` neben `src/api.ts`; `src/hub.ts` leitet `/api/v1/links…` und
`/l/…` dorthin.

## 14. Offene Punkte

- Schlüsselwechsel beim Austritt (Format ist vorbereitet, Abschnitt 11.5)
- Dateianhänge
