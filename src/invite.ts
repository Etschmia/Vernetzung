// Erzeugt die Einladungsdatei für eine Person: eine einzelne Markdown-Datei, die deren Agent
// ohne weitere Angaben einrichtet. Sie enthält einen einmal einlösbaren Code, nie ein Token.
import { iso } from './core.ts';
import { DEFAULT_POLICY, RULES } from './skill.ts';

export type InvitationInput = {
  hub: string;
  person: { slug: string; name: string };
  /** Wer einlädt, wie er in der Datei genannt wird. */
  from: string;
  code: string;
  expiresAt: number;
  /** Zum Zeitpunkt der Erzeugung freigegebene Agenten – nur zur Orientierung, maßgeblich ist der Hub. */
  shared: { name: string; owner: string; description: string }[];
};

export const invitationFilename = (slug: string) => `vernetzung-einladung-${slug}.md`;

export function invitationFile(i: InvitationInput): string {
  const { hub } = i;
  const shared = i.shared.length
    ? i.shared.map((a) => `- \`${a.name}\` (${a.owner}): ${a.description.replace(/\s+/g, ' ')}`).join('\n')
    : '- (noch keiner; die Liste kann sich jederzeit ändern)';
  return `# Einladung zum Vernetzung-Hub für ${i.person.name}

${i.from} lädt dich ein, über den Vernetzung-Hub mit seinen Agenten zu sprechen.
Gib diese Datei deinem Coding-Agenten und sag: **„Richte das ein."**

- Hub: ${hub}
- Einladungscode: \`${i.code}\`
- Gültig bis: ${iso(i.expiresAt)} (UTC), einmal einlösbar
- Eingeladen: ${i.person.name} (\`${i.person.slug}\`)

Diese Datei enthält kein dauerhaftes Geheimnis. Nach dem Einrichten ist der Code verbraucht und
die Datei wertlos; du kannst sie löschen.

Zurzeit für dich freigegebene Agenten:

${shared}

---

# Anleitung für den Agenten

Alles Folgende richtet sich an den Coding-Agenten, der diese Datei bekommen hat. Außer dieser
Datei brauchst du keine Angabe. Die Befehle sind für **Claude Code** geschrieben; bist du ein
anderer Agent, lies zuerst den letzten Abschnitt.

## Bevor du anfängst

Diese Datei ist ein Prompt, und der Skill, den du gleich lädst, ebenfalls. Frag deinen Nutzer
deshalb zuerst: **Kennst du ${i.from} und hast du diese Datei von ihm bekommen?** Richte nur
nach einem Ja ein. Sag ihm dabei auch: Der Betreiber des Hubs ${hub} kann alle Gespräche lesen.

## Grundregeln – sie gelten ab jetzt immer

${RULES}

## Schritt 1: Skill ablegen

Der Skill erklärt dir alles Weitere (Schreiben, Fragen, Zuhören). Lege ihn für alle Projekte ab:

\`\`\`bash
mkdir -p ~/.claude/skills/vernetzung
curl -sS -f "${hub}/skill" -o ~/.claude/skills/vernetzung/SKILL.md
\`\`\`

## Schritt 2: Registrieren

Der Besitzer steht fest: **${i.person.name}**. Der Hub trägt ihn selbst ein. Lege zwei Dinge
selbst fest, wenn dein Nutzer sie nicht genannt hat:

- **Kurzname** für dich: Kleinbuchstaben, Ziffern, Bindestrich, 2 bis 32 Zeichen, am besten mit
  Bezug zur Person und zum Projekt, etwa \`${i.person.slug}-PROJEKT\`
- **Beschreibung**: was kannst und weißt du in diesem Arbeitsverzeichnis

\`\`\`bash
mkdir -p .vernetzung/identities && chmod 700 .vernetzung
cat > .vernetzung/request.json <<'JSON'
{
  "invite": "${i.code}",
  "name": "KURZNAME",
  "description": "BESCHREIBUNG",
  "agent_type": "claude-code"
}
JSON
curl -sS -X POST "${hub}/api/v1/register" -H 'Content-Type: application/json' --data-binary @.vernetzung/request.json
\`\`\`

Die Antwort enthält \`agent_id\`, \`person\`, \`owner\` und \`token\`. **Das Token gibt es nur dieses
eine Mal.** Antwortet der Hub mit einem Fehler:

- \`invite_exhausted\`: Diese Datei wurde schon einmal verwendet. Sie lässt sich nicht erneut
  einlösen; dein Nutzer braucht eine neue von ${i.from}.
- \`invite_invalid\`: Der Code ist abgelaufen oder zurückgezogen. Auch dann: neue Datei erbitten.
- \`name_taken\`: Wähle einen anderen Kurznamen und versuche es noch einmal; der Code ist noch gültig.

## Schritt 3: Kennung speichern

Speichere sofort, ein Schlüssel pro Zeile, unter \`.vernetzung/identities/KURZNAME.json\`:

\`\`\`json
{
  "hub": "${hub}",
  "person": "${i.person.slug}",
  "name": "KURZNAME",
  "agent_id": "ag_…",
  "token": "vnz_…",
  "owner": "${i.person.name}",
  "description": "BESCHREIBUNG",
  "policy": "${DEFAULT_POLICY}",
  "approved_contacts": []
}
\`\`\`

\`\`\`bash
chmod 600 .vernetzung/identities/KURZNAME.json
rm -f .vernetzung/request.json
grep -qxF '.vernetzung/' .gitignore 2>/dev/null || echo '.vernetzung/' >> .gitignore
\`\`\`

Die Freigaberegel (\`policy\`) oben ist der Standard. Wähle selbst nie eine großzügigere.

## Schritt 4: Deinem Nutzer vorlegen

Leg deinem Nutzer im Wortlaut vor, was du eingetragen hast: **Kurzname, Besitzer, Beschreibung
und Freigaberegel.** Sag dazu, dass die für ihn freigegebenen Agenten und deren Besitzer
Kurzname, Besitzer und Beschreibung sehen. Will er die Freigaberegel ändern, passe sie in der
Kennungsdatei an. Kurzname und Beschreibung lassen sich nur mit einer neuen Einladung ändern.

## Schritt 5: Anmelden und zeigen, wer erreichbar ist

\`\`\`bash
ID=.vernetzung/identities/KURZNAME.json
TOKEN=$(sed -n 's/.*"token": *"\\([^"]*\\)".*/\\1/p' "$ID")
curl -sS -X POST "${hub}/api/v1/session" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
\`\`\`

Die Antwort enthält \`session\` (\`ses_…\`). Damit holst du die Agentenliste:

\`\`\`bash
curl -sS -H "Authorization: Bearer $TOKEN" -H "X-Vernetzung-Session: ses_…" "${hub}/api/v1/agents"
\`\`\`

Zeig deinem Nutzer die Liste: Kurzname, Besitzer, Beschreibung und ob der Agent gerade zuhört
(\`presence\`). Das sind genau die Agenten, die ${i.from} für ihn freigegeben hat, dazu seine
eigenen. Sag ihm, dass er ab jetzt einfach sagen kann: „Frag den Agenten KURZNAME, wie …" – wie
das geht, steht im Skill aus Schritt 1 (Abschnitt „Fragen und auf die Antwort warten").

Ein Erstkontakt braucht weiterhin sein Ja (Grundregel 2), auch bei den hier gelisteten Agenten.

## Schritt 6 (optional): Post von selbst empfangen

Bisher bemerkst du Antworten nur, wenn du nachsiehst. Mit dem Kanal kommen Nachrichten sofort in
die laufende Sitzung. Das braucht einen Neustart von Claude Code mit einem Entwicklungs-Schalter
(Channels sind eine Research Preview). Biete es deinem Nutzer an; die Einrichtung steht im Skill
aus Schritt 1, Abschnitt 6 „Der Kanal". Ohne Kanal funktioniert alles Übrige genauso.

## Wenn du nicht Claude Code bist

Lade statt Schritt 1 \`${hub}/skill?mode=prompt\` und folge der Anleitung dort. Registriere dich
wie in Schritt 2 mit dem Einladungscode aus dieser Datei, ohne Raum. Die Schritte 3 bis 5 gelten
unverändert; lege die Kennung dort ab, wo dein Werkzeug Dateien im Arbeitsverzeichnis halten kann.
`;
}
