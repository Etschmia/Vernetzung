# Code Review vom 14. November 2026

Geprüfter Stand: fb97db7c7ac79a7201cab36fc44e6b8a06949c28.

Umfang: sämtliche Dateien in src/, vorhandene Tests, Start- und Docker-Konfiguration sowie Abgleich mit README und Protokoll. Es wurden keine Änderungen am Anwendungs- oder Testcode vorgenommen.

## Funde nach Priorität

| Nr. | Priorität | Fund | Nachweis |
|---|---|---|---|
| 1 | P1 – hoch | Ungültiger Anfragepfad beendet den Hub-Prozess | Reproduziert mit Node-HTTP-Parser |
| 2 | P1 – hoch | Wiedervergebene Kurznamen übernehmen Kontaktfreigaben | API-Verhalten reproduziert, Freigabefolge aus Skill abgeleitet |
| 3 | P1 – hoch | Fehlgeschlagenes Speichern kann einen Raum trotzdem öffnen | Reproduziert gegen Handler und In-Memory-Datenbank |
| 4 | P2 – mittel | Zehn fremde Fehlversuche sperren die Betreiber-Anmeldung global | Reproduziert gegen Handler |
| 5 | P2 – mittel | Docker-Standardstart hat kein beschreibbares Datenverzeichnis | Statische Prüfung; Docker hier nicht verfügbar |

## 1. Ungültiger Anfragepfad beendet den Hub-Prozess

**Fundstelle:** [src/hub.ts](../src/hub.ts), Zeilen 22–25; Einbindung in [src/server.ts](../src/server.ts), Zeile 15.

Der URL-Konstruktor wird im Request-Listener ohne Fehlerbehandlung ausgeführt. Das Request-Target //[, bestehend aus zwei Schrägstrichen und einer öffnenden eckigen Klammer, wird vom Node-HTTP-Parser angenommen, vom URL-Konstruktor aber verworfen. Die Exception verlässt den Request-Listener; der reguläre Server beendet sich.

**Auslöser:** Eine nicht authentifizierte HTTP-Anfrage:

    GET //[ HTTP/1.1
    Host: hub.example.org
    Connection: close

**Beobachtet:** Ein isolierter Node-Unterprozess mit dem echten createServer(hub.handler) und einem In-Memory-Duplex als Socket beendet sich mit Exitcode 1. Der Stack enthält:

    TypeError: Invalid URL
        at new URL (node:internal/url:818:25)
        at Server.handler (.../src/hub.ts:23:17)
        at parserOnIncoming (node:_http_server:1186:12)
    code: 'ERR_INVALID_URL'
    input: '//['

**Auswirkung:** Eine einzelne Anfrage kann sämtliche API-, Postfach- und Verwaltungsfunktionen bis zum Neustart ausfallen lassen. Voraussetzung ist, dass ein vorgeschalteter Proxy das Request-Target durchlässt; die Proxy-Konfiguration liegt nicht im Repository und wurde nicht geprüft.

**Empfehlung:** Das Parsen der Anfrage-URL im Request-Listener abfangen und ungültige Targets mit HTTP 400 beantworten. Ein Regressionstest sollte eine tatsächlich vom HTTP-Parser verarbeitete Anfrage verwenden.

## 2. Wiedervergebene Kurznamen übernehmen Kontaktfreigaben

**Fundstellen:** [src/skill.ts](../src/skill.ts), Zeilen 13–15 und 210–213; [src/api.ts](../src/api.ts), Zeilen 35–38, 95–99 und 139–149; [src/admin.ts](../src/admin.ts), Zeilen 406–408; [src/core.ts](../src/core.ts), Zeile 83.

Der Skill speichert freigegebene Kontakte ausschließlich als Kurzname in approved_contacts. Nach einem Token-Widerruf wird derselbe Kurzname wieder zur Registrierung freigegeben. Die neue Registrierung bekommt zwar eine andere agent_id, aber weder die öffentliche Agentenliste noch die Nachrichten liefern diese stabile Identität mit. Für einen empfangenden Agenten erscheint der neue Besitzer deshalb als bereits freigegebener Kontakt.

**Reproduktion:**

1. Zwei Agenten namens trusted und receiver im selben Raum registrieren. receiver gibt den ursprünglichen Kontakt trusted frei.
2. trusted sendet eine Nachricht an receiver.
3. Der Betreiber widerruft das Token von trusted.
4. Eine andere Person registriert trusted erneut und sendet ebenfalls an receiver.
5. Das Postfach von receiver abfragen.

**Beobachtet:** Die beiden Registrierungen haben unterschiedliche agent_id-Werte. Beide Nachrichten enthalten jedoch denselben Absender "trusted". Die Nachrichtenfelder sind ausschließlich id, thread_id, from, to, subject, body und sent_at. Die Information zur Unterscheidung der Absender fehlt.

**Auswirkung:** Wer einen freigewordenen Namen erhält, kann unter dem bestehenden Vertrauensverhältnis des vorherigen Besitzers kommunizieren. Im Modus open reicht die Registrierung; in anderen Modi sind zusätzlich Einladung, gegebenenfalls Raumpasswort und Betreiberfreigabe erforderlich. Die Umgehung der erneuten Kontaktfreigabe folgt aus der Skill-Anweisung; ein externer KI-Agent wurde im Review nicht ausgeführt.

**Empfehlung:** Kontaktfreigaben an unveränderliche Agenten-IDs binden, zusammen mit Hub und Raum. Diese IDs in Agentenlisten, Absender- und Empfängerinformationen ausliefern. Bei einer Neuregistrierung desselben Namens muss eine neue Kontaktfreigabe erforderlich sein.

## 3. Fehlgeschlagenes Speichern kann einen Raum trotzdem öffnen

**Fundstelle:** [src/admin.ts](../src/admin.ts), Zeilen 392–401.

Beim Speichern der Zugangseinstellungen wird zuerst auth_level in der Datenbank aktualisiert. Erst danach wird das neue Raumpasswort auf seine Mindestlänge geprüft. Bei einem zu kurzen Passwort folgt HTTP 400, aber die bereits geschriebene Sicherheitsstufe bleibt bestehen. Eine Transaktion oder ein Rollback fehlt.

**Reproduktion:**

1. Einen Raum review mit Standardstufe invite ohne Raumpasswort anlegen.
2. Angemeldet folgendes Formular an POST /admin/room/review/settings senden:

       auth_level=open&pw_action=set&password=short

3. Trotz Fehlerantwort eine Registrierung ohne Einladung und ohne Raumpasswort versuchen.

**Beobachtet:**

    Antwort auf Einstellungsänderung: HTTP 400
    Datenbank danach: {"auth_level":"open","password_hash":null}
    Registrierung ohne Einladung und Passwort: HTTP 201

**Auswirkung:** Der Betreiber möchte den Raum auf „offen + Passwort“ umstellen und erhält eine Fehlermeldung. Tatsächlich ist der Raum danach ohne Passwort offen. Andere Wechsel der Sicherheitsstufe können ebenfalls trotz abgelehnter Formularübermittlung bestehen bleiben.

**Empfehlung:** Sämtliche Eingaben vor dem ersten Schreibzugriff validieren und die zusammengehörigen Änderungen atomar speichern. Regressionstest: Nach einem abgelehnten Formular müssen sowohl Sicherheitsstufe als auch Passwort-Hash unverändert sein.

## 4. Zehn fremde Fehlversuche sperren die Betreiber-Anmeldung global

**Fundstelle:** [src/admin.ts](../src/admin.ts), Zeile 148 sowie Zeilen 333–338.

Die Fehlversuche werden in einem einzigen Array für den gesamten Hub gesammelt. Sobald zehn Einträge innerhalb von zehn Minuten vorhanden sind, wird jede weitere Anmeldung vor der Passwortprüfung mit HTTP 429 abgewiesen. Auch das korrekte Betreiber-Passwort wird dann nicht mehr geprüft.

**Reproduktion:** Ohne Anmeldung zehn falsche Passwörter an POST /admin/login senden; danach von einem anderen Client das richtige Passwort senden.

**Beobachtet:**

    Zehn falsche Anmeldungen: jeweils HTTP 401
    Anschließende Anmeldung mit richtigem Passwort: HTTP 429

**Auswirkung:** Ein nicht authentifizierter Angreifer kann neue Betreiber-Anmeldungen für ungefähr zehn Minuten blockieren und die Sperre nach Ablauf wieder auslösen. Eine bestehende Betreiber-Sitzung bleibt nutzbar. Ein Neustart leert das Array, ist aber kein zuverlässiger Schutz gegen wiederholte Angriffe.

**Empfehlung:** Das Anmeldelimit so gestalten, dass fremde Clients den berechtigten Betreiber nicht global aussperren können, etwa durch zusätzliche Begrenzung je vertrauenswürdig bestimmter Client-Adresse und abgestufte Verzögerungen. Proxy-Header dürfen dabei nur von bekannten Proxys akzeptiert werden.

## 5. Docker-Standardstart hat kein beschreibbares Datenverzeichnis

**Fundstelle:** [Dockerfile](../Dockerfile), Zeilen 6–9; Datenbanköffnung in [src/core.ts](../src/core.ts), Zeilen 102–104.

Das Image setzt VERNETZUNG_DB=/data/vernetzung.sqlite, deklariert VOLUME /data und startet anschließend als USER node. /data wird vorher weder für diesen Benutzer angelegt noch an ihn übereignet. Bei einem frischen Docker-Volume entsteht das Verzeichnis dadurch mit Root-Besitz; der Benutzer node kann darin keine SQLite-Datei anlegen.

**Auslöser:** Der in der README dokumentierte Docker-Start mit einem neu angelegten benannten Volume, beispielsweise:

    docker build -t vernetzung .
    docker run --rm -v vernetzung-review-empty:/data vernetzung

**Auswirkung:** Der dokumentierte Docker-Pfad kann beim Öffnen der Datenbank bereits vor dem HTTP-Start scheitern. Ein vom Betreiber zuvor passend berechtigtes Volume kann das Problem verdecken.

**Nachweisgrenze:** Statischer Befund aus Volume-Pfad und Benutzerwechsel. Docker ist in dieser Review-Umgebung nicht installiert; der Containerstart und die konkrete Fehlermeldung wurden nicht ausgeführt beziehungsweise beobachtet.

**Empfehlung:** Das Datenverzeichnis vor VOLUME und USER node mit passenden Eigentumsrechten anlegen. Den dokumentierten Start mit einem frischen benannten Volume prüfen.

## Durchgeführte Prüfungen und Grenzen

- npm run typecheck: erfolgreich.
- npm test: alle 13 Tests erfolgreich. Der erste Lauf war durch die Port-Sperre der Sandbox blockiert; der freigegebene Lauf außerhalb der Sandbox war erfolgreich.
- Funde 1–4 zusätzlich mit isolierten Reproduktionen unter Node.js v22.22.3 überprüft. Die Reproduktionen verwendeten In-Memory-SQLite und simulierte Request-/Response-Streams; bei Fund 1 wurde zusätzlich der echte Node-HTTP-Parser verwendet. Das Hilfsskript liegt außerhalb des Repositorys unter /tmp/vernetzung-review-2026-11-14.mjs; vorhandene Tests wurden nicht verändert.
- Keine Anfragen an einen produktiven Hub, keine Docker-Ausführung und kein Verhaltenstest externer KI-Agenten. Die tatsächliche Reverse-Proxy-Konfiguration war nicht Teil des Reviews.
- Die bestehenden Tests decken die beschriebenen Fehlerfälle nicht ab; erfolgreiche Tests widerlegen diese Funde daher nicht.

## Ergebnis der Nachprüfung (14. November 2026)

Alle fünf Funde wurden am Code nachvollzogen und sind berechtigt. Jeder Fund ist in einem eigenen Commit behoben. Stand danach: `npm run typecheck` erfolgreich, `npm test` mit 17 von 17 Tests erfolgreich (vorher 13).

| Nr. | Urteil | Commit | Test |
|---|---|---|---|
| 1 | berechtigt, behoben | 297a21b | neu; scheitert ohne den Fix |
| 2 | berechtigt, behoben (Hub vollständig, Agentenseite über den Skill-Text) | d2be334 | neu, deckt die Hub-Seite ab |
| 3 | berechtigt, behoben | 85623bb | neu; scheitert ohne den Fix |
| 4 | berechtigt, behoben | 7470fd2 | neu; scheitert ohne den Fix |
| 5 | berechtigt, behoben, aber nicht ausgeführt | f140f54 | keiner; Docker ist auf diesem Rechner nicht installiert |

### Zu Fund 1

Bestätigt: Mit dem alten Code lieferte `GET //[` über eine echte TCP-Verbindung keine Antwort, und der Testlauf meldete `TypeError: Invalid URL` als unbehandelte Ausnahme. Der Request-Listener fängt den Fehler jetzt ab und antwortet mit HTTP 400. Der Regressionstest schickt die Anfrage roh über einen Socket, also durch den HTTP-Parser von Node, und prüft danach `/healthz`.

Nicht geprüft: ob der vorgeschaltete Proxy des produktiven Hubs ein solches Ziel überhaupt durchlässt. Gegen den produktiven Hub wurde die Anfrage bewusst nicht gesendet.

### Zu Fund 2

Bestätigt. Umgesetzt nach der Empfehlung:

- Der Hub liefert die unveränderliche `agent_id` in der Agentenliste, in `recipients` der Sendeantwort und als `from_id` in jeder Nachricht. Die bisherigen Felder bleiben unverändert, vorhandene Agenten laufen also weiter.
- Der Skill speichert Freigaben als `{ "name": …, "agent_id": … }`, vergleicht bei eingehenden Nachrichten `from_id` und vor einem neuen Gespräch die `agent_id` aus der Agentenliste. Derselbe Kurzname mit anderer `agent_id` gilt als Erstkontakt. Einträge ohne `agent_id` aus älteren Kennungen gelten nicht mehr als freigegeben.
- Das Protokoll (Abschnitte 5.1 bis 5.3, 6 und 7) ist angepasst.

Grenzen: Die Freigabe prüft der Agent, nicht der Hub; durchgesetzt wird sie also nur von Agenten, die den neuen Skill geladen haben. Bereits eingerichtete Agenten müssen den Skill neu beziehen. Ein Verhaltenstest mit einem echten Agenten steht aus. Antworten in einem bestehenden Gespräch waren nie betroffen: Teilnehmer eines Threads sind über die `agent_id` festgelegt, ein neuer Besitzer des Kurznamens gehört nicht dazu.

### Zu Fund 3

Bestätigt. Die Eingaben werden jetzt vollständig geprüft, danach schreibt eine einzige `UPDATE`-Anweisung Sicherheitsstufe und Passwort-Hash gemeinsam. Der Test stellt den Ablauf aus dem Review nach und prüft, dass nach der abgelehnten Eingabe Stufe und Hash unverändert sind und die Registrierung ohne Einladung scheitert.

### Zu Fund 4

Bestätigt. Fehlversuche werden je Client-Adresse gezählt (zehn in zehn Minuten). `X-Forwarded-For` gilt nur, wenn die Anfrage von einem Proxy auf demselben Rechner kommt oder von einer Adresse aus der neuen Einstellung `VERNETZUNG_TRUSTED_PROXIES` (README ergänzt); ausgewertet wird der letzte Eintrag, also der vom Proxy angehängte.

Grenzen:

- Abgestufte Verzögerungen aus der Empfehlung sind nicht umgesetzt; es bleibt bei der festen halben Sekunde je Fehlversuch.
- Steht der Proxy auf einem anderen Rechner und ist nicht eingetragen, erscheinen alle Clients unter seiner Adresse. Dann gilt das alte Verhalten: eine gemeinsame Sperre.
- Ein Angreifer mit vielen Adressen (etwa einem IPv6-Präfix) erhält je Adresse zehn Versuche. Eine globale Obergrenze gibt es absichtlich nicht mehr, weil genau sie die Aussperrung ermöglichte. Gegen Erraten schützt damit vor allem die Stärke des Betreiber-Passworts.

### Zu Fund 5

Statisch nachvollzogen und plausibel: `VOLUME /data` legt das Verzeichnis mit Root-Besitz an, der Hub läuft als `node`. Das Dockerfile legt `/data` jetzt vor `VOLUME` an und übereignet es `node`; ein frisches benanntes Volume übernimmt diese Rechte. Das Image wurde weder gebaut noch gestartet. Ein Bind-Mount auf ein Verzeichnis des Hosts bringt weiterhin dessen Rechte mit.

### Nebenbefunde beim Beheben

- Der produktive Hub läuft bis zu einem Neustart des Dienstes noch mit dem alten Stand.
- Ein Test, der eine unbehandelte Ausnahme im Request-Listener auslöst, hängt ohne eigene Zeitgrenze; der neue Test zu Fund 1 setzt deshalb eine Zeitgrenze auf den Socket.
