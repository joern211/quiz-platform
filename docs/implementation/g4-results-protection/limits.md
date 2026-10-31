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

## Neu: Spiel-Sockets (Schlüssel Raum + Teilnehmer + Gruppe)

Der Schlüssel entsteht serverseitig aus der authentifizierten Socket-Identität
(`participationId`, Raum) — nie aus einer vom Client behaupteten ID, nie aus IP, Socket
oder `commandId`. Mehrere Tabs/Reconnects derselben Teilnehmerin teilen ein Budget (ein
zweiter Tab ersetzt ohnehin die erste Verbindung, Gerätebindung). Fremde Teilnehmer,
fremde Räume und andere Gruppen haben eigene Budgets.

| Gruppe | Aktionen / Einstiege | Burst | Dauerrate | Begründung |
| --- | --- | --- | --- | --- |
| `PLAYER_INPUT` | `answer`, `buzz`, `stealBuzz`, `joker5050/Spy/Risk` | 20 | 5/s | Antippen: wenige pro Sekunde; Buzzer-Hämmern ≈ 10/s wird nach ~4 s gebremst |
| `HOST_CONTROL` | `judge`, `stealJudge`, `reveal`, `next`, `fieldOpen`, `boardSwitch`, `open`, `hint`, `buzzerOverride` (und jede andere geschützte Host-Aktion) | 30 | 5/s | Host urteilt/deckt auf höchstens etwa 1×/s |
| `RESULT_COMMAND` | `game:result:command` (REVIEW/FINALIZE/ADJUST/AMEND/ROLLBACK) | 10 | 1/s | seltene, bewusste Aktion |
| `READ` | `geo:resync`, `jeopardy:resync`, `weristdas:resync`, `game:core:read`, `game:result:read` | 40 | 8/s | jeder Client liest einmal je `game:core:changed` |
| `REPLAY` | Wiederholung eines **eigenen bereits bekannten** Commands (Transport-Retry nach verlorener Bestätigung) | 60 | 10/s | eigenes Budget, damit ein Retry nie mit neuen Absichten konkurriert, ein Replay-Flood aber begrenzt bleibt |
| `DENIED` | geschützte Spielbefehle ohne Rolle/Recht (z. B. Viewer sendet `judge`) | 30 | 3/s | verhindert unbegrenzte DB-Reads und Logzeilen durch Befehle, die nie ausführbar sind |

**Zählung.** Neue Absicht = ein Token der Gruppe. Gleiche `commandId` desselben Akteurs
mit vorhandenem Receipt = Replay-Token (nie Gruppen-Token). Ohne `commandId` (Legacy)
zählt jeder Aufruf als neue Absicht. Ungültige Payloads (Schema) kommen vor dem Budget und
kosten nichts. Unauthentifizierte Sockets ohne Raum/Teilnehmer werden nicht verfolgt.

**Ablehnung.** Früh, nach Autorisierung und vor Receipt/Engine: kein Receipt, keine
Mutation, keine private Antwort, kein DB-Write. Antwort `{ success:false, error:'RATE_LIMITED',
code, messageKey:'RATE_LIMITED', traceId, retryable:true, details:{ retryAfterMs } }`. Eine
Ablehnungsserie hat **eine** Diagnosezeile; alle Antworten der Serie tragen deren traceId.
Eine abgelehnte Absicht ist nicht gespeichert und kann nach Ablauf neu gesendet werden.

**Aufräumen.** Eintrag verschwindet, sobald der Bucket wieder voll wäre (Sweep alle 60 s,
unref-Timer); harte Obergrenze 5000 Schlüssel (älteste zuerst). Es gibt keine Einträge für
beliebige behauptete Tokens.

**Neustart.** Rein im Speicher der Einzelinstanz: nach einem Prozessneustart beginnen alle
Budgets voll (Test mit echtem Neustart). Kein Redis/Cluster.

**Client.** `RATE_LIMITED` ist eine endgültige Antwort: das Absichtstoken wird verworfen, die
nächste Aktion erzeugt eine neue Absicht; keine automatische Wiederholung. Spieler-, Jeopardy-,
WID- und Ergebnis-UI zeigen „Zu viele Aktionen in kurzer Zeit …“ statt eines Fehlercodes.

## Grenzen / bewusst nicht gelöst

- **Nicht im Guard:** `game:start/pause/resume/end` (sockets/game.ts), `game:recovery:command`,
  `room:command` und Lobbyaktionen. Sie sind Host-/Rechte-gebunden und receipt-idempotent; Befehle
  ohne Recht verursachen dort weiterhin ungedrosselte Ablehnungen (Rest für ein späteres Paket).
- **Neue Identität = neues Budget:** Verlassen und als neue Teilnehmerin beitreten setzt es zurück;
  der Beitritt hängt an den (produktiven) IP-Limits oben.
- **Receipt-Wachstum über die Zeit** (Retention) ist nicht Teil von G4; die Rate begrenzt nur die
  Geschwindigkeit.
- Zwei Prozesse hätten getrennte Budgets (kein Cluster-Bedarf belegt).

## Tests

`actionLimits.test.ts` (Fake-Clock: Burst, exakte Entsperrgrenze, Unabhängigkeit, Aufräumen,
Trace-Serie, Gruppierung) · `g4Protection.integration.test.ts` (echte Sockets: Burst mit frischen
Command-IDs, Isolation Spieler/Host/Raum, Tabs/Reconnect, Replay mit leerem Budget, Replay-Budget,
Ablehnungs- und Lese-Budget, Buzz-Spam blockiert Host nicht) · `g4Restart.integration.test.ts`
(echter Neustart: Budget startet neu, Ablehnungen hinterließen kein Receipt) ·
`ResultScreen.test.tsx`/`GeoRecovery.test.tsx` (verständliche Meldung, Auswahl bleibt nutzbar).
