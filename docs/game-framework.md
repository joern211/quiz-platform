# Game Framework

PR #8 führt eine gemeinsame Basis für alle Spiel-Engines ein. Ziel ist, dass neue Spiele nur ihre fachliche Spiellogik implementieren und wiederkehrende Infrastruktur aus dem Core verwenden.

## Core-Bausteine

### Registry / Lifecycle

Datei: `apps/server/src/games/registry.ts`

Jede produktive Engine wird über einen `GameHandle` registriert. `game:start`, `game:pause`, `game:resume` und Cleanup werden über die Registry aufgelöst. Ältere Geo-Aktionsadapter liegen noch in `sockets/game.ts`; neue Spiele registrieren ihre Events im eigenen Modul.

Verfügbare Hooks:

- `initialize(context)`: Game-State aufbauen und persistieren.
- `afterStart(context)`: optionaler Hook nach `game:start`, z. B. für Geo INTRO → erste Runde.
- `pause(context)`, `resume(context)`: optionale Fähigkeiten mit eigenem Timerverhalten.
- `cleanup(roomId)`: optionale Freigabe spielspezifischer Ressourcen beim Ende.

Vor `initialize` wird der Raum atomar von LOBBY auf RUNNING gesetzt. Schlägt die Initialisierung fehl, wird genau diese Revision wieder auf LOBBY gesetzt und ein partieller Game-State entfernt. Ein konkurrierend veränderter Raum wird dabei nicht blind überschrieben.

Nicht implementierte Spiele werden bewusst **nicht** als No-op registriert. Ein Startversuch liefert `GAME_NOT_IMPLEMENTED`.

### Authorization

Datei: `apps/server/src/games/core/access.ts`

`authorizeGameAction()` prüft zentral:

- Socket gehört zu einem Raum.
- Socket ist dem tatsächlichen Socket.IO-Raumkanal beigetreten.
- exakte zugelassene Rollen.
- optional vorhandene Participation.

`authorizeGameContext()` lädt zusätzlich den Raum und die GameDefinition aus der Datenbank, prüft `gameSlug` und optional den RUNNING-Status sowie eine aktive, nicht entfernte Participation. Geo und Jeopardy nutzen diesen Context in ihren mutierenden Handlern; der vom Client mitgesendete Raumcode oder Rejoin-Token ist keine Spielautorität. Beim Rejoin verliert ein ersetzter Socket seine Raumzugehörigkeit und seine serverseitige Identität.

Game-spezifische Handler dürfen weiterhin kompatible Fehlercodes nach außen mappen.

### State / Persistence

Datei: `apps/server/src/games/core/state.ts`

Wichtige Funktionen:

- `loadGameState<T>()`
- `upsertGameState<T>()`
- `saveGameStateIfRevision<T>()`

Race-sensitive Mutationen nutzen Optimistic Concurrency über `RoomGameState.revision`. Bei konkurrierenden Änderungen wird `GameStateConflictError` ausgelöst.

Der Core speichert den State, interpretiert aber keine fachlichen Felder.

### Scores

Datei: `apps/server/src/games/core/score.ts`

Der Core stellt nur technische Score-Mutationen bereit:

- `applyScoreDelta()`
- `ensureScoreEntries()`
- `recordScoreMutation(tx, ...)`: aktualisiert `Participation.score` und schreibt einen `ScoreEvent` in derselben Transaktion wie den Game-State. Die Participation muss zum angegebenen Raum gehören.

Die jeweilige Engine entscheidet weiterhin, **wie viele** Punkte vergeben oder abgezogen werden.

### Buzzer

Datei: `apps/server/src/games/core/buzzer.ts`

Der Buzzer-Core modelliert:

- geschlossen / geöffnet
- erster gültiger Gewinner
- Ausschluss einzelner Spieler
- Reset

Jeopardy verwendet `claimBuzzer()` im Haupt- und Steal-Buzz. Persistenz und Phasenwechsel bleiben Aufgabe der Engine. Die erfolgreiche Claim-Änderung wird mit `saveGameStateIfRevision()` in einer Transaktion gespeichert; der erste falsche Spieler steht beim Steal in der Ausschlussliste.

### Resync und Geheimnisse

`room:resync` prüft die serverseitige Socket-Identität, Raumzugehörigkeit und den tatsächlichen Socket.IO-Kanal. Der mitgesendete Raumcode dient nur als Plausibilitätsprüfung.

Jeopardy registriert seine Events und seine rollenabhängige Projektion in `games/jeopardy/events.ts`. Geo registriert `geo:resync` in `games/geo/resync.ts`; `projectGeoStateForClient()` gibt öffentliche Frage und Punktestand aus. Spieler erhalten nur eigene Antwort und Joker, Zuschauer keine eigenen Aktionsdaten. Die richtige Option ist vor der Auflösung nur für Moderatoren enthalten. `questions[]` aus dem persistierten State wird niemals als Ganzes übertragen.

Die Webansichten von Geo abonnieren den Raum nach Reconnect erneut und rufen danach `geo:resync` auf. Neue Spiele müssen ebenso eine rollenabhängige Projektion aus dem persistierten State bereitstellen; der Client darf kein vollständiges State-JSON erhalten.

### Timer und Frontend

Geo bleibt vorerst der einzige Nutzer des serverseitigen Timers. `timerEndMs` beziehungsweise die Restzeit bei Pause liegen im persistierten State. Pause und Resume aktualisieren State und Raumphase atomar; aktive Timer werden nach einem Serverneustart aus aktiven Geo-Räumen rekonstruiert. Ein allgemeiner Timer-Core würde derzeit nur diesen einen Anwendungsfall umhüllen. Ein künftiges Timerspiel kann dieses Muster zuerst übernehmen und bei gemeinsamem Bedarf extrahieren.

`apps/web/src/components/GameShell/` stellt Raumcode, Phase und Verbindungsstatus bereit. Geo verwendet es in der Zuschaueransicht; die individuellen Spielflächen bleiben getrennt.

### Fehler und alte Gerüste

Neue Core-Aktionen verwenden insbesondere `NOT_IN_ROOM`, `FORBIDDEN`, `NO_PARTICIPATION`, `WRONG_GAME` und `STATE_CONFLICT`. `games/core/errors.ts` bildet bekannte fachliche Fehler und Revisionskonflikte auf öffentliche ACK-Codes ab und verbirgt unerwartete interne Fehlermeldungen. Bestehende Buzzer-Client-Codes bleiben kompatibel. Bei neuen Events Payloads mit Zod prüfen und Fehler über ACK zurückgeben.

Die nicht verwendeten In-Memory-Handler für Wer ist das, Timeline, Lügen, Song und eine alte Jeopardy-Variante wurden entfernt. Sie waren nicht in der Registry registriert und enthielten keine sichere Persistence- oder Rejoin-Implementierung. Neue Engines werden nach den folgenden Schritten neu aufgebaut.

## How to add a new game

Beispiel: `weristdas`.

### 1. Engine-Verzeichnis anlegen

```
apps/server/src/games/weristdas/
  engine.ts
  events.ts
  resync.ts
  state.ts
  contracts.ts
  *.test.ts
```

Trenne dabei:

- `contracts.ts`: Events, Payloads, Phasen und Zod-Schemas.
- `state.ts`: fachlicher State und pure State-Transformationen.
- `engine.ts`: Datenbank, Socket.IO und Lifecycle.
- `events.ts`: Socket-Registrierung, Payload-Prüfung und ACK-Behandlung.
- `resync.ts`: öffentliche und rollenabhängige Client-Projektionen.

### 2. Game-State definieren

Der State enthält nur fachlich notwendige Daten. Wiederkehrende Mechanismen wie Scores oder Buzzer sollen möglichst über die Core-Helfer modelliert werden.

Keine geheimen Daten ungefiltert an Clients senden.

### 3. Engine initialisieren

Die Engine implementiert mindestens eine Initialisierung, die:

1. Setup validiert.
2. PLAYER-Participations lädt.
3. initialen State erstellt.
4. über `upsertGameState()` persistiert.
5. rollenunabhängige öffentliche Initialdaten broadcastet.

### 4. Engine registrieren

In `games/registry.ts` einen echten `GameHandle` ergänzen.

Keine Platzhalter registrieren.

### 5. Events absichern

Für jede Socket-Aktion:

1. Payload validieren.
2. `authorizeGameAction()` verwenden.
3. Phase prüfen.
4. State laden.
5. fachliche Änderung berechnen.
6. bei konkurrierenden Aktionen `saveGameStateIfRevision()` innerhalb einer Transaktion verwenden.
7. nur notwendige Daten senden.

Moderator-Geheimnisse dürfen nur an Moderator-Sockets gehen.

### 6. Score-Regeln lokal halten

Die Engine entscheidet den Delta-Wert. Beispiel:

```ts
const delta = result === 'both' ? 3 : result === 'one' ? 1 : -1;
state.scores = applyScoreDelta(state.scores, playerId, delta);
await saveGameStateIfRevision(tx, { roomId, expectedRevision, state, phase: state.phase });
await recordScoreMutation(tx, {
  roomId, participationId: playerId, score: state.scores[playerId],
  delta, reason: 'WERISTDAS_ANTWORT', roundIndex,
});
```

Der Core soll keine Wer-ist-das-, Jeopardy- oder Geo-Regeln kennen.

### 7. Buzzer verwenden

```ts
const opened = openBuzzer(createBuzzerState(), {
  excludePlayerIds: wrongPlayers,
});
const claim = claimBuzzer(opened, playerId);
```

Bei echtem Multiplayer muss die erfolgreiche Claim-Änderung revisionssicher zusammen mit dem Game-State gespeichert werden. Für einen Steal die zuerst antwortende Participation in `excludePlayerIds` übergeben. Die pure Buzzer-Funktion allein ersetzt keine Datenbank-Concurrency.

### 8. Resync implementieren

Resync muss aus dem persistierten Server-State aufgebaut werden.

Dabei nach Rolle filtern:

- Moderator: darf Moderatorinformationen erhalten.
- Player: nur spielbare öffentliche und eigene Daten.
- Viewer: keine Player-Aktionen und keine geheimen Lösungen.

Reload/Rejoin darf nicht dazu führen, dass Antworten oder Moderator-Secrets geleakt werden.

### 9. Tests

Mindestens:

- Engine-Initialisierung
- Rollenrechte
- falsche Phase
- State-Revision/Conflict
- Rejoin/Resync
- Buzzer-Race falls vorhanden
- Secret-Leak-Regression
- E2E-Hauptfluss

Bestehende Geo- und Jeopardy-Tests dienen als Referenz.

## Architekturregel

Der Core enthält technische Mechanik. Die Engine enthält Spielregeln.

Wenn eine Abstraktion nur für ein einziges Spiel sinnvoll ist, bleibt sie zunächst in diesem Spiel. Erst bei tatsächlicher Wiederverwendung wird sie in den Core verschoben.
