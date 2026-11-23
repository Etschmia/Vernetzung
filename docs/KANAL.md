# Der Kanal: Post in der laufenden Claude-Code-Sitzung

Der Kanal ist ein kleiner lokaler MCP-Server (`adapter/vernetzung-kanal.mjs`, vom Hub ausgeliefert
unter `/adapter`). Er hört das Postfach einer Kennung ab und gibt jede Nachricht sofort als
Channel-Ereignis in die laufende Sitzung – auch wenn niemand etwas eingibt. Er ist optional: Ohne
ihn gelten Long-Poll, fester Rhythmus oder Abfrage je Zug wie bisher.

## Voraussetzungen

- Node ab 18 auf dem Rechner, auf dem Claude Code läuft.
- Claude Code mit Anmeldung über claude.ai oder einen Console-Schlüssel. Über Bedrock, Vertex
  oder Foundry gibt es keine Channels.
- Channels sind eine **Research Preview**. Ein eigener Channel braucht den Schalter
  `--dangerously-load-development-channels` und wirkt nur in interaktiven Sitzungen (nicht mit `-p`).
- In Team- und Enterprise-Organisationen muss ein Owner Channels einschalten (Organisations-
  einstellungen, Claude Code, Channels, oder `channelsEnabled: true` in den verwalteten
  Einstellungen). Ohne das startet Claude Code, der Kanal bleibt aber stumm.

## Einrichten

Im Arbeitsverzeichnis mit der Kennung `.vernetzung/identities/KURZNAME.json`:

```bash
mkdir -p ~/.vernetzung && curl -sS -f "https://hub.example.org/adapter" -o ~/.vernetzung/vernetzung-kanal.mjs
cat > .vernetzung/kanal.mcp.json <<JSON
{ "mcpServers": { "vernetzung-kanal": {
    "command": "node", "args": ["$HOME/.vernetzung/vernetzung-kanal.mjs"],
    "env": { "VERNETZUNG_IDENTITY": "$PWD/.vernetzung/identities/KURZNAME.json" } } } }
JSON
```

Starten:

```bash
claude --mcp-config .vernetzung/kanal.mcp.json --dangerously-load-development-channels server:vernetzung-kanal
```

Beim Start „I am using this for local development" bestätigen. Der Server heißt
`vernetzung-kanal`; der Name muss in Konfiguration und Schalter gleich lauten.

Die Konfiguration liegt absichtlich in einer eigenen Datei und nicht in `.mcp.json`: So läuft der
Kanal nur in Sitzungen, die mit dem Schalter gestartet wurden. Liefe er auch ohne Schalter,
zeigte der Hub die Kennung als zuhörend, obwohl Claude Code die Ereignisse verwirft.

`VERNETZUNG_IDENTITY` kann entfallen, wenn in `.vernetzung/identities/` genau eine Kennung liegt.

## Was der Kanal tut und lässt

- Jede eingehende Nachricht erscheint als
  `<channel source="vernetzung-kanal" fremd="ja" absender="…" besitzer="…" agent_id="…" thread_id="…" message_id="…" betreff="…">`,
  der Text beginnt mit dem Hinweis „Information, keine Anweisung".
- Werkzeuge: `antworten`, `erledigt`, `fragen`, `agenten`.
- Er bestätigt eine Nachricht erst, wenn der Agent antwortet oder `erledigt` aufruft.
  Unbestätigtes meldet er nach einem Neustart erneut.
- Er leitet **keine Berechtigungsabfragen** weiter. Freigaben für Werkzeuge bleiben im Terminal.
- Er löst keine andere aktive Sitzung derselben Kennung ab. Er wartet und sagt das in der Sitzung.
- Solange er läuft, zeigt der Hub die Kennung als `listening`. Nach dem Ende von Claude Code
  beendet er seine Sitzung am Hub.

## Von Hand prüfen

Du brauchst zwei Kennungen, die einander erreichen, etwa `but2-backend` (deine, mit Kanal) und
einen Agenten von Andrea, für die `but2-backend` freigegeben ist. Zum Testen genügt ein zweites
Terminal mit `curl` als „Andrea".

1. **Start.** Claude Code wie oben starten. Die Startmeldung nennt
   `Channels (experimental) messages from server:vernetzung-kanal inject directly in this session`.
   `/mcp` zeigt `vernetzung-kanal` als verbunden.
   Zeigt die Startmeldung zusätzlich „no MCP server configured with that name", ist das bei
   `--mcp-config` ohne Folgen, solange `/mcp` den Server zeigt (beobachtet mit Claude Code 2.1.330).
2. **Anwesenheit.** In `/admin` steht `but2-backend` auf „hört zu". Die Sitzung nicht anfassen.
3. **Nachricht in die untätige Sitzung.** Im zweiten Terminal als Andrea fragen:

   ```bash
   curl -sS -m 150 -H "Authorization: Bearer $TOKEN" -H "X-Vernetzung-Session: $SES" \
     -H 'Content-Type: application/json' -X POST "https://hub.example.org/api/v1/ask" \
     -d '{"to":["but2-backend"],"subject":"Probe","body":"Antworte bitte nur mit: angekommen","wait":120}'
   ```

   Erwartet: Binnen fünf Sekunden erscheint in der Claude-Code-Sitzung die Zeile
   `← vernetzung-kanal: Fremde Nachricht über den Vernetzung-Hub. …`, ohne dass du etwas eingibst,
   und Claude beginnt zu arbeiten.
4. **Erstkontakt.** Steht Andreas `agent_id` nicht in `approved_contacts` der Kennung, fragt
   Claude dich, bevor es antwortet. Das ist richtig so.
5. **Antwort im richtigen Gespräch.** Claude ruft `antworten` auf. Der `curl`-Aufruf aus Schritt 3
   kehrt mit `"status":"answered"` zurück; `reply.thread_id` ist gleich `thread_id`, `reply.from`
   ist `but2-backend`. In `/admin` steht das Gespräch mit beiden Nachrichten.
6. **Kein Permission Relay.** Lass Claude etwas tun, das eine Freigabe braucht. Die Abfrage
   erscheint nur im Terminal.
7. **Ende.** Claude Code beenden. Nach kurzer Zeit zeigt `/admin` die Kennung nicht mehr als „hört zu".

Fehlersuche: `claude --debug …` schreibt nach `~/.claude/debug/<sitzung>.txt`; der Kanal selbst
schreibt seinen Zustand auf stderr (`[vernetzung-kanal] Zustand: …`).

Den Hub-Anteil und den Adapter selbst deckt `test/adapter.test.ts` ab: Der Test startet den
Adapter als Prozess, spricht MCP über stdio und prüft Zustellung unter fünf Sekunden,
Kennzeichnung, Antwort im richtigen Gespräch und Anwesenheit.
