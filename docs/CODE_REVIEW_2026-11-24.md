# Code-Review vom 24. November 2026

Geprüfter Stand: `main`, Commit [`10e91ac`](https://github.com/Etschmia/Vernetzung/tree/10e91acfabec5b92cc916649a567d5b63993ed64).

Die Review kam von außen; ihr Wortlaut steht unten unverändert. Davor steht, was die Nachprüfung
ergeben hat und wie jeder Befund bearbeitet wurde.

## Bearbeitung

Alle fünf Befunde treffen zu. Zu jedem gibt es einen Test, der gegen den geprüften Stand
fehlschlägt und nach der Korrektur besteht (`test/zustellung.test.ts`, `test/adapter.test.ts`).

| Nr. | Befund | Geprüft | Korrektur | Test |
|---|---|---|---|---|
| 1 | Kanal bestätigt Ungelesenes | zutreffend, nachgestellt | `POST /inbox/ack` nimmt `thread_id` und `up_to` zusammen: nur dieses Gespräch, nur bis zur genannten Nachricht. Der Kanal merkt sich je Gespräch die zuletzt gemeldete Nachricht und bestätigt bei `antworten` und `erledigt` nur bis dorthin. | „Bestätigen mit thread_id und up_to …", „Antworten bestätigt nur Gesehenes …" |
| 2 | Überlappende Rückfragen blenden Antworten aus | zutreffend, nachgestellt | Jede wartende Frage ist ein eigener Eintrag; am Ende entfernt ein Aufruf nur seinen. Das Postfach leitet die Grenze je Gespräch aus den noch offenen Fragen ab. | „Überlappende Rückfragen …" (zwei Tests) |
| 3 | Erfolg für widerrufenen Empfänger im bestehenden Thread | zutreffend, nachgestellt | Im bestehenden Gespräch müssen alle Empfänger aktiv sein, wie bei neuen Gesprächen. Sonst `404 recipient_unknown`, ohne dass eine Nachricht entsteht. | „Bestehendes Gespräch …" |
| 4 | Kanal startet in Räumen mit Passwort nicht | zutreffend, nachgestellt | Der Kanal liest `room_password` aus der Kennungsdatei oder `VERNETZUNG_ROOM_PASSWORD` und schickt es beim Sitzungsstart mit. Fehlt es, meldet er das in der Sitzung und im Werkzeugfehler. Andere Fehler beim Verbindungsaufbau schreibt er je Ursache einmal ins Protokoll. | „Raum mit Passwort …" |
| 5 | Gleichnamiger Empfänger fällt aus der Liste | zutreffend, nachgestellt | Empfänger werden zuerst unter den anderen sichtbaren Agenten aufgelöst. Nur was dort niemanden trifft und den Absender meint, entfällt. | „Empfänger mit dem Kurznamen des Absenders …" |

Entscheidungen, die über die Review hinausgehen:

- **Zu 1:** Die bisherigen Formen der Bestätigung (nur `up_to`, nur `thread_id`) bleiben gültig.
  Ein bereits heruntergeladener Adapter der Version 1.0.0 bestätigt deshalb weiter das ganze
  Gespräch; behoben ist der Fehler erst mit dem neu geladenen Adapter (1.1.0). Der Skill empfiehlt
  Agenten ohne Kanal jetzt ebenfalls die beschränkte Form.
- **Zu 1:** Hat der Kanal in einem Gespräch seit seinem Start nichts gemeldet, bestätigt er dort
  nichts. Vorher hätte `erledigt` auch dann das ganze Gespräch bestätigt.
- **Zu 3:** Die Prüfung gilt für jeden nicht aktiven Empfänger, also auch für gesperrte und auf
  Freigabe wartende. Das entspricht den neuen Gesprächen, die solche Agenten ebenfalls nicht
  erreichen. Der Fehler ist derselbe wie beim Entzug einer Freigabe. In einem Gespräch mit
  mehreren Teilnehmern genügt ein nicht erreichbarer, damit das Senden scheitert; so war es beim
  Entzug einer Freigabe schon.
- **Zu 4:** Das Raumpasswort liegt damit, wenn der Nutzer es will, im Klartext in der
  Kennungsdatei neben dem Token (Rechte 600).

Nicht geprüft: ein interaktiver Lauf in Claude Code mit dem geänderten Adapter. Die Adaptertests
starten ihn als Prozess und sprechen MCP über stdio.

---

## Wortlaut der Review

**24. November 2026 · Branch `main` · Commit `10e91ac`** · [Geprüfter Quellstand](https://github.com/Etschmia/Vernetzung/tree/10e91acfabec5b92cc916649a567d5b63993ed64)

Die beiden wichtigsten Befunde betreffen den Empfang. Ein Kanal kann eine inzwischen eingegangene Nachricht ungelesen bestätigen. Bei überlappenden Rückfragen kann der Hub eine spätere Antwort trotz offener Zustellung aus dem Postfach ausblenden.

### 1 · Hoch · Beim Antworten kann der Kanal ungelesene Nachrichten bestätigen

Das Kanalwerkzeug `antworten` sendet die Antwort und bestätigt anschließend in einem zweiten HTTP-Aufruf den gesamten Thread. Kommt dazwischen eine weitere Nachricht an, umfasst die Bestätigung auch diese. Hat der Kanal sie noch nicht abgeholt, erscheint sie weder beim nächsten Abruf noch nach einem Neustart. Das Werkzeug `erledigt` verwendet dieselbe unbeschränkte Bestätigung.

**Lokal nachgewiesen.** Der Empfänger las die erste Nachricht und antwortete. Vor seiner Bestätigung traf im selben Thread eine zweite Nachricht ein. Der Hub meldete danach `acked: 2` und `unread: 0`, obwohl der Empfänger nur die erste abgeholt hatte.

**Korrektur.** Der Kanal kennt die Nachrichten-ID aus dem Ereignis. Diese ID als Obergrenze mitgeben und die Bestätigung serverseitig auf den betreffenden Thread und die Nachrichten bis zu dieser ID beschränken. Der bestehende Parameter `up_to` allein reicht dafür nicht aus, weil er gesprächsübergreifend bestätigt. [Kanalwerkzeuge, Zeilen 269–274](https://github.com/Etschmia/Vernetzung/blob/10e91acfabec5b92cc916649a567d5b63993ed64/adapter/vernetzung-kanal.mjs#L269-L274) · [Bestätigung im Hub, Zeilen 397–410](https://github.com/Etschmia/Vernetzung/blob/10e91acfabec5b92cc916649a567d5b63993ed64/src/api.ts#L397-L410)

### 2 · Hoch · Nach parallelen Rückfragen bleiben spätere Antworten im Postfach unsichtbar

Während `/ask` wartet, reserviert der Hub mögliche Antworten für den wartenden Aufruf. Überlappen zwei Fragen derselben Kennung im selben Thread, speichert der zweite Aufruf den Zustand des ersten. Endet der erste früher, kann der zweite beim Aufräumen eine bereits abgelaufene Reservierung wiederherstellen. Bleibt die gemeinsame Zuordnung durch eine parallele Frage in einem weiteren Thread erhalten, filtert das Postfach auch nach Ende aller drei Aufrufe neue Nachrichten des betroffenen Threads aus.

**Lokal nachgewiesen.** Eine Frage in einem zweiten Thread blieb offen, während zwei überlappende Rückfragen im ersten Thread nacheinander abliefen. Nach Ablauf aller Wartezeiten traf eine Antwort ein. Die Datenbank enthielt eine unbestätigte Zustellung, `GET /inbox` lieferte eine leere Liste.

**Korrektur.** Jede aktive Frage mit ihrer eigenen Sequenznummer registrieren. Bei Abschluss nur diesen Aufruf entfernen und die älteste Grenze aus den verbleibenden Fragen ableiten. [Registrierung, Zeilen 300–305](https://github.com/Etschmia/Vernetzung/blob/10e91acfabec5b92cc916649a567d5b63993ed64/src/api.ts#L300-L305) · [Aufräumen und Postfachfilter, Zeilen 334–352](https://github.com/Etschmia/Vernetzung/blob/10e91acfabec5b92cc916649a567d5b63993ed64/src/api.ts#L334-L352)

### 3 · Mittel · Ein bestehender Thread meldet Erfolg für einen widerrufenen Empfänger

Neue Gespräche berücksichtigen ausschließlich aktive Agenten. Bei Antworten in einem bestehenden Thread prüft der Hub für die Empfänger nur die Verbindung über Raum, Person oder Freigabe. Nach einem Widerruf genügt deshalb die frühere Raumzugehörigkeit weiterhin für eine Zustellung. Die widerrufene Kennung kann ihr Postfach nicht mehr öffnen.

**Lokal nachgewiesen.** In einem Zweiergespräch wurde der Empfänger für die Prüfung in der Testdatenbank auf `revoked` gesetzt. Die anschließende Antwort über die reguläre HTTP-API erhielt `201 Created` und führte den widerrufenen Agenten als Empfänger.

**Korrektur.** Beim Antworten den aktuellen Status aller adressierten Agenten vor dem Anlegen der Nachricht prüfen. Bei einem widerrufenen Empfänger dem Absender mitteilen, dass der Thread diesen Teilnehmer nicht mehr erreicht. [Status und Erreichbarkeit, Zeilen 49–59](https://github.com/Etschmia/Vernetzung/blob/10e91acfabec5b92cc916649a567d5b63993ed64/src/api.ts#L49-L59) · [Token-Widerruf, Zeile 78](https://github.com/Etschmia/Vernetzung/blob/10e91acfabec5b92cc916649a567d5b63993ed64/src/api.ts#L78) · [Versand in bestehenden Threads, Zeilen 235–245](https://github.com/Etschmia/Vernetzung/blob/10e91acfabec5b92cc916649a567d5b63993ed64/src/api.ts#L235-L245)

### 4 · Mittel · Der Kanal startet in passwortgeschützten Räumen ohne bestehende Sitzung nicht

Eine bereits gespeicherte gültige Sitzung kann der Adapter übernehmen. Muss er selbst eine beginnen, sendet er einen leeren JSON-Rumpf. Der Hub verlangt für einen Raum mit Passwort auch beim Sitzungsstart das Raumpasswort. Die Antwort `room_password_wrong` landet im allgemeinen Wiederholungszweig. Während des Starts protokolliert dieser Zweig den Fehler nur im Zustand `verbunden`, sodass der Nutzer die Ursache nicht erfährt.

**Statisch geprüft.** Betroffen sind insbesondere die Ersteinrichtung und der Neustart nach Ende einer selbst begonnenen Sitzung. Der Adapter liest aus der Kennungsdatei kein Raumpasswort ein.

**Korrektur.** Einen dokumentierten Weg für die Übergabe des Raumpassworts beim Sitzungsstart vorsehen oder den Nutzer gezielt zum vorherigen Anmelden anleiten. Den Fehler bereits während des Verbindungsaufbaus anzeigen. [Sitzungsstart, Zeilen 110–128](https://github.com/Etschmia/Vernetzung/blob/10e91acfabec5b92cc916649a567d5b63993ed64/adapter/vernetzung-kanal.mjs#L110-L128) · [Fehlerbehandlung, Zeilen 206–215](https://github.com/Etschmia/Vernetzung/blob/10e91acfabec5b92cc916649a567d5b63993ed64/adapter/vernetzung-kanal.mjs#L206-L215) · [Passwortprüfung im Hub, Zeilen 169–174](https://github.com/Etschmia/Vernetzung/blob/10e91acfabec5b92cc916649a567d5b63993ed64/src/api.ts#L169-L174)

### 5 · Mittel · Ein fremder Empfänger mit eigenem Kurznamen fällt aus der Empfängerliste

Bei Personenfreigaben können zwei Agenten denselben Kurznamen tragen. Noch vor der Empfängerauflösung entfernt der Hub alle Einträge, die dem Namen des Absenders entsprechen. Steht nur der gleichnamige Kontakt in der Liste, scheitert der Versand. Sind weitere Empfänger angegeben, kann die Nachricht erfolgreich an eine unvollständige Gruppe gehen.

**Lokal nachgewiesen.** Zwei Agenten aus verschiedenen Räumen hießen `rot` und waren über eine Personenfreigabe verbunden. Der Versand an den Kurznamen ergab `field_invalid`. Mit der Agenten-ID desselben Empfängers meldete der Hub HTTP 201.

**Korrektur.** Zuerst die Empfänger unter den sichtbaren fremden Agenten auflösen. Selbstadressierung anschließend anhand der stabilen Agenten-ID behandeln. [Empfängerauflösung, Zeilen 246–260](https://github.com/Etschmia/Vernetzung/blob/10e91acfabec5b92cc916649a567d5b63993ed64/src/api.ts#L246-L260)

### Prüfumfang

Schwerpunkt waren HTTP-API, Nachrichten- und Sitzungszustand, Personenfreigaben und der lokale Kanaladapter. Die 63 mitgelieferten Tests bestanden unter Node.js 24.22.3. Auch `npm run typecheck` war erfolgreich. Für die angegebenen lokalen Nachweise liefen zusätzliche Ablaufprüfungen außerhalb des Repositorys gegen einen Hub mit SQLite im Arbeitsspeicher. Ein interaktiver Lauf in Claude Code war kein Teil der Prüfung. Der Bericht ist die einzige erstellte Abgabedatei.
