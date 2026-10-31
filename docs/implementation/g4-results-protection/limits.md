# G4 D — Limits und Spamschutz

Basis: main `1f8fdce` (G1–G3). Ausgangslage laut [G1-Matrix](../g1-command-contract/matrix.md):
HTTP-Limits in Produktion, Live-Medien-Fenster pro Socket/Event, **kein** aktionsbezogenes
Limit auf den Spiel-Sockets. Code: `apps/server/src/games/core/actionLimits.ts`
(Token-Bucket), `limitGuard.ts` (Anwendung), Einhängepunkte unten.

## Bestehende Grenzen (unverändert, ehrlich eingeordnet)

| Einstieg | Schutz | Schlüssel | Grenze | Anmerkung |
| --- | --- | --- | --- | --- |
| `POST /auth/login` | express-rate-limit | IP | 5 / 15 min | nur `NODE_ENV=production` |
| `POST /rooms` (Erstellen) | express-rate-limit | IP | 10 / 15 min | nur Produktion |
| Raum-Beitritt (PIN-Brute-Force) | express-rate-limit | IP | 20 / 15 min | nur Produktion; **bewusst IP-basiert** (Voranmeldung, noch keine Teilnehmeridentität) |
| JSON-Bodies, Medien-Upload, Audiodecoder | Größen-/Laufzeit-/Parallelitätsgrenzen | – | je Pfad | unverändert |
| Live-Medien-Events | Fenster pro Socket und Event | Socket | 10 s: Join/Restart 20, Self 60, Control 30 | unverändert |
| `GET /rooms/:code/results` | Zugriffspolitik, **kein** Rate-Limit | – | – | öffentliche Räume lesen anonym; bewusst kein neuer IP-Limiter (gemeinsames WLAN). Offener Rest |

## Neu: Spiel-Sockets — zwei Stufen

Schlüssel in beiden Stufen: Raum + `participationId` aus der **serverseitig gesetzten** Socket-Identität —
nie eine vom Client behauptete ID, nie IP, Socket oder `commandId`. Mehrere Tabs/Reconnects derselben
Teilnehmerin teilen ein Budget (ein zweiter Tab ersetzt ohnehin die erste Verbindung, Gerätebindung); fremde
Teilnehmer, fremde Räume und andere Gruppen haben eigene Budgets.

### Stufe 1 — frühe Zulassung ohne Datenbank (`requestAdmission.ts`, Socket-Middleware)

Läuft vor jedem Handler und nutzt nur Identität, Eventname und Zähler im Speicher. Sie **verleiht kein Recht**:
jedes zugelassene Paket durchläuft weiter Mitgliedschaft, Sitzung, Gerätebindung, Grants/Revocations, Raum,
Phase und Receipts. Zweck: Die Arbeit **vor** den feineren Budgets (Mitgliedschafts-, Rechte- und Receipt-Lookups,
Logzeilen) wächst nicht mit der Paketzahl, sondern ist durch das Budget begrenzt.

Erfasste Events: `geo:*`, `jeopardy:*`, `weristdas:*`, `game:*` (Start/Pause/Resume/Ende, Ergebnis lesen/ändern,
Recovery, Core-Read, Buzzer-Override) und `room:command`. Nicht erfasst (nicht in der Stufe, eigene Verträge):
Lobby (`player:*`, Chat), `room:subscribe`, Live-Medien (eigene Fenster, siehe oben).

| Budget | Zählung | Burst | Dauerrate |
| --- | --- | --- | --- |
| `REQUEST` | jedes erfasste Paket der Identität | 40 | 12/s |
| `DENIED` | Pakete, die mit einer Autorisierungsablehnung beantwortet wurden (`FORBIDDEN`, `NOT_AUTHORIZED`, `NO_PARTICIPATION`, `VIEWERS_CANNOT_MODIFY`, …) — der Zähler wird beim Antworten belastet; ist er leer, wird die Identität früh abgewiesen | 30 | 3/s |

Ausgeschöpft → Antwort `RATE_LIMITED` sofort, **0 Datenbank-Reads, 0 zusätzliche Logzeilen**, unabhängig von der
weiteren Paketzahl. Ein paralleler Burst vor der ersten Antwort ist durch den `REQUEST`-Burst (40) begrenzt; ein
Zuschauer, der 80 Recovery-Befehle sendet, erzeugt höchstens 40 Ablehnungs-Logzeilen plus die eine Serienzeile
(vorher: 80), danach keine mehr. Der Host hat ein eigenes Budget und bleibt handlungsfähig.

### Stufe 2 — Budgets je Aktion im Handler (nach Autorisierung)

| Gruppe | Aktionen / Einstiege | Burst | Dauerrate | Begründung |
| --- | --- | --- | --- | --- |
| `PLAYER_INPUT` | `answer`, `buzz`, `stealBuzz`, `joker5050/Spy/Risk` | 20 | 5/s | Antippen: wenige pro Sekunde; Buzzer-Hämmern ≈ 10/s wird nach ~4 s gebremst |
| `HOST_CONTROL` | `judge`, `stealJudge`, `reveal`, `next`, `fieldOpen`, `boardSwitch`, `open`, `hint`, `buzzerOverride` | 30 | 5/s | Host urteilt/deckt auf höchstens etwa 1×/s |
| `RESULT_COMMAND` | `game:result:command` | 10 | 1/s | seltene, bewusste Aktion |
| `READ` | `geo/jeopardy/weristdas:resync`, `game:core:read`, `game:result:read` | 40 | 8/s | jeder Client liest einmal je `game:core:changed` |
| `REPLAY` | Wiederholung eines **eigenen bereits bekannten** Commands (Transport-Retry nach verlorener Bestätigung) | 60 | 10/s | eigenes Budget: Retry konkurriert nicht mit neuen Absichten, ein Replay-Flood bleibt begrenzt |

Diese Stufe schützt vor allem die **Schreibarbeit** (Receipt, Mutation, Event). Der Receipt-Lookup zur
Replay-Erkennung findet erst **nach** Stufe 1 statt und ist damit durch deren Budget begrenzt.

**Zählung.** Neue Absicht = ein Token der Gruppe (Stufe 2) und ein `REQUEST`-Token. Gleiche `commandId` desselben
Akteurs mit vorhandenem Receipt = `REPLAY`-Token (nie Gruppen-Token). Ohne `commandId` (Legacy) zählt jeder
Aufruf als neue Absicht. Ungültige Payloads kommen vor Stufe 2, zählen aber in Stufe 1 (sie kosten ein Paket).
Sockets ohne serverseitige Identität (nicht beigetreten) werden nicht verfolgt; ihre Handler lehnen ohne
Datenbankarbeit ab.

**Ablehnung.** Keine Mutation, kein Receipt, keine private Antwort. Antwort `{ success:false,
error:'RATE_LIMITED', code, messageKey:'RATE_LIMITED', traceId, retryable:true, details:{ retryAfterMs } }`.
Eine Ablehnungsserie hat **eine** Diagnosezeile; alle Antworten der Serie tragen deren traceId. Eine abgelehnte
Absicht ist nicht gespeichert und kann nach `retryAfterMs` neu gesendet werden; **ein gespeicherter Erfolg bleibt
abrufbar** (Test: gleicher Command nach der Wartezeit → `replayed`).

**Aufräumen.** Eintrag verschwindet, sobald der Bucket wieder voll wäre (Sweep alle 60 s, unref-Timer); harte
Obergrenze 5000 Schlüssel (älteste zuerst). Keine Einträge für beliebige behauptete Tokens.

**Neustart.** Rein im Speicher der Einzelinstanz: nach einem Prozessneustart beginnen alle Budgets voll (Test
mit echtem Neustart). Kein Redis/Cluster.

**Client und Befehls-ID.** `RATE_LIMITED` ist eine **vorläufige** Antwort: Eine frühe Ablehnung hat nicht ins
Receipt geschaut und sagt nichts darüber, ob ein früherer Versuch derselben Absicht (mit verlorener Bestätigung)
bereits gespeichert wurde. Der gemeinsame Intentclient (`createCommandIntentClient`, auch vom Browser-Adapter
benutzt) **behält deshalb die Befehls-ID** bei `RATE_LIMITED` — wie bei `COMMAND_IN_PROGRESS` und
`outcomeUnknown`. Ein manueller Retry nach `retryAfterMs` trägt dieselbe ID: war der erste Versuch gespeichert,
wird er aus dem Receipt beantwortet (`replayed`), sonst läuft die Absicht genau einmal. Endgültige Erfolge und
fachliche Ablehnungen verbrauchen die ID weiterhin; eine verspätete Bestätigung eines älteren Sendens löscht keine
neuere Absicht (`discardIntentTokenIfCurrent`). Der Client wiederholt **nie automatisch**; er zeigt „Zu viele
Aktionen in kurzer Zeit …“ und gibt die Bedienung wieder frei. Alle betroffenen Oberflächen (Spieler, Jeopardy
inkl. Feld öffnen/Weiter/Boardwechsel und Resync, WID inkl. Resync/Ende, Geo-Host
Pause/Fortsetzen/Auflösen/Weiter/Ende, Raumpanel, Ergebnis) zeigen diese Meldung.

## Grenzen / bewusst nicht gelöst

- **Rechtegebunden ≠ Spamschutz:** Auch `game:start/pause/resume/end`, `game:recovery:command` und `room:command`
  laufen jetzt durch Stufe 1 (frühe Zulassung + `DENIED`). Sie haben **keine** Stufe-2-Gruppe (Host-Handlungen,
  receipt-idempotent, selten); ein berechtigter Host mit sehr hoher Rate bremst nur sich selbst.
- **Nicht erfasst:** Lobby-Events (`player:*`, Chat) und `room:subscribe` — eigene Verträge, nicht Teil von G4.
- **Neue Identität = neues Budget:** Verlassen und als neue Teilnehmerin beitreten setzt es zurück; der Beitritt
  hängt an den (produktiven) IP-Limits oben.
- **Receipt-Wachstum über die Zeit** (Retention) ist nicht Teil von G4; die Rate begrenzt nur die Geschwindigkeit.
- **Verbleibende Last pro Identität:** höchstens `REQUEST`-Burst (40) plus 12 Pakete/s mit je einigen Lookups; das
  ist beabsichtigt hoch genug für legitimen Mehrspielerbetrieb.
- Zwei Prozesse hätten getrennte Budgets (kein Cluster-Bedarf belegt).

## Tests

`actionLimits.test.ts` (Fake-Clock: Burst, exakte Entsperrgrenze, Unabhängigkeit, Aufräumen, Trace-Serie, Gruppen) ·
`g4Protection.integration.test.ts` (echte Sockets; **DB-Reads per Prisma-Middleware gezählt**: ausgeschöpfte
Identität → `[]` für alle Einstiegspunkte; Zuschauer-Flood auf Recovery/Pause vs. Host, Spieler, Raum; Reconnect/Tab;
gespeicherter Replay nach Wartezeit; **echter Intentclient + echte Handler + DB: verlorene Bestätigung → Ablehnung (REQUEST, REPLAY, Aktionsbudget) → Retry ergibt genau eine Wirkung**; Replay-/Ablehnungs-/Lese-Budget; Buzz-Spam blockiert Host nicht) ·
`g4Restart.integration.test.ts` (echter Neustart) · `commandIntentClient.test.ts` (ID-Lebenszyklus am echten Client) · `limitMessages.test.tsx`, `ResultScreen.test.tsx`,
`GeoRecovery.test.tsx` (Meldung in den betroffenen Oberflächen, Auswahl bleibt nutzbar).
