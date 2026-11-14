// Startpunkt: liest die Umgebung und startet den Hub.
import { createServer } from 'node:http';
import { createHub } from './hub.ts';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

const hub = createHub({
  dbPath: process.env.VERNETZUNG_DB ?? './data/vernetzung.sqlite',
  adminPassword: process.env.VERNETZUNG_ADMIN_PASSWORD || undefined,
  publicUrl: process.env.VERNETZUNG_PUBLIC_URL || undefined,
  trustedProxies: (process.env.VERNETZUNG_TRUSTED_PROXIES ?? '').split(',').map((x) => x.trim()).filter(Boolean),
  log: (line) => console.log(line),
});

const server = createServer(hub.handler);
// Long-Polls dauern bis zu 60 Sekunden; die Zeitgrenzen des Servers müssen darüber liegen.
server.requestTimeout = 0;
server.keepAliveTimeout = 75_000;
server.listen(port, host, () => {
  console.log(`Vernetzung-Hub läuft auf http://${host}:${port}`);
  console.log(`Betreiber-Oberfläche: ${process.env.VERNETZUNG_PUBLIC_URL ?? `http://${host}:${port}`}/admin`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    hub.close();
    server.close();
    // Wartenden Long-Polls kurz Zeit geben, ihre Antwort zu senden.
    setTimeout(() => server.closeAllConnections(), 300);
  });
}
