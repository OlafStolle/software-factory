# Privates Factory-Kanban

Lesende Projektion von GitHub-Issues/PRs, keine Queue und kein Dispatcher. Node (22+) und die bereits für `nv-dev` angemeldete GitHub CLI genügen. Keine zusätzlichen Pakete. Offene Issues und PRs werden alle 60 Sekunden getrennt bis zum expliziten Limit von jeweils 1.000 abgefragt; am Limit erscheint eine Unvollständigkeitswarnung. Zusätzlich erscheinen die zuletzt angelegten 100 geschlossenen Issues als begrenzter Verlauf. Abruffehler erhalten den letzten erfolgreichen Datenstand samt Zeitpunkt.

`node runner/kanban.mjs` startet ausschließlich auf `127.0.0.1:4310`. Der Bind-Host ist nicht konfigurierbar. Nur GET `/` ist erlaubt. Keine Zugangsdaten, CLI-Fehlermeldungen, Issue-Bodies oder Worker-Logs werden ausgegeben. GitHub-Labels und PRs sind beobachteter Zustand, kein Beweis einer laufenden Factory oder eines erfolgreichen Deployments.

## Betrieb auf VPS2

`deploy/software-factory-kanban.service` ist ein Systemdienst mit unprivilegiertem Benutzer `nv-dev`. Er erwartet den Code unter `/home/nv-dev/software-factory` und Node unter `/usr/bin/node`. Bei anderem Installationspfad sowohl `WorkingDirectory` als auch `ExecStart` per Drop-in anpassen. Kein Factory-Runner-Secretsfile einbinden. Die GitHub-Anmeldung wird aus dem vorhandenen Benutzerprofil gelesen. Dienst erst nach Installation des geprüften Codes aktivieren.

Zugang von Olafs Rechner durch den bestehenden SSH-Tunnelzugang:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:4310:127.0.0.1:4310 VPS2
```

Dann `http://127.0.0.1:4310/` öffnen. Keine öffentliche Proxyroute, keine Firewallfreigabe und kein Tailscale Funnel anlegen. Ein lokaler Tunnel muss aktiv bleiben. Bindung mit `ss -ltn` kontrollieren: ausschließlich `127.0.0.1:4310`.

Optional über `FACTORY_RUNTIME_SNAPSHOT=/pfad/runtime.json` einen vom Koordinator atomar geschriebenen Snapshot einlesen. Es werden nur diese Anzeigefelder gelesen:

```json
{
  "updatedAt": "2026-11-14T00:00:00Z",
  "status": "Beobachtung",
  "hosts": [{"name":"vps2","freeSlots":0,"memoryAvailableGiB":9,"diskFreeGiB":27}],
  "workers": [{"id":"vps2-k2-1","host":"vps2","state":"nicht zugeteilt","issue":null}],
  "cleanup": {"status":"kein Lauf","lastRun":null}
}
```

Die Beispieldaten sind kein Betriebsnachweis. Ein fehlender Snapshot wird ausdrücklich als nicht eingerichteter Laufzeitstatus dargestellt; alte Zeitstempel bleiben sichtbar; nach drei Minuten erscheint eine Veraltungswarnung. Keine separaten Claims im Board speichern. Die Zuordnung der vier Pilot-Issues und der beiden bereits bekannten PRs ist dokumentiert in `runner/kanban.mjs`; weitere Themenzuordnungen später aus dem gemeinsamen Factory-Contract übernehmen.

## Vorhandene operative Registry

Opt-in über `FACTORY_ORCHESTRATION_TOKEN_FILE=/home/nv-dev/.config/nv-orchestration-41/reviewer.token`. Erst aktivieren, wenn der private Tunnel zur vorhandenen API auf VPS2-Loopback-Port 13739 verfügbar ist. Der Server liest ausschließlich `GET http://127.0.0.1:13739/api/orchestration/v1/overview`; Ziel ist fest codiert, Redirects sind verboten und der Request hat fünf Sekunden Timeout. Das Token bleibt serverseitig im Authorization-Header und wird weder im HTML noch in Fehlertexten ausgegeben. Der Dienst benötigt lediglich Leserechte auf die vorhandene Token-Datei; diese nicht ins Repository kopieren.

Aufgaben werden nach dem konfigurierten GitHub-Repository gefiltert. Das Board übernimmt nur Task-ID, Issue-Nummer, Zustand, Claim, Zuweisung, Pause, Revision und Quell-Prüfzeitpunkt sowie Akteur-ID/Rolle. Es speichert keine neue Queue, schreibt keine Claims und zeigt keine Execution-Pläne, Checkpoints oder Audit-Payloads. Die Registry-Anzeige ist vom aus GitHub abgeleiteten Kanban-Zustand getrennt. Alte Quell-Prüfzeitpunkte sind sichtbar; ein frischer API-Abruf bedeutet nicht, dass die Quellen frisch synchronisiert wurden. Bei API-Fehlern bleiben letzter erfolgreicher Stand und Zeitpunkt erhalten, ergänzt um eine Warnung. Hardware-Ressourcen bleiben ohne separaten Snapshot unbekannt.

## Prüfung und Rücknahme

`node --test runner/kanban.test.mjs` prüft HTML-Escaping, sichere Links, fehlenden Laufzeitstatus, Fehler mit Erhalt des letzten Datenstands, Limitwarnung, Loopback-Bindung und das Verbot von Schreib-/Dateiendpunkten. Es benötigt kein GitHub und keine Modellaufrufe.

Rücknahme: Kanban-Dienst stoppen/deaktivieren und SSH-Tunnel beenden. Da das Board nichts in GitHub oder in die Registry schreibt, bleiben Aufgaben und Worker unberührt.
