# Game Framework

PR #8 führt eine gemeinsame Basis für alle Spiel-Engines ein. Ziel ist, dass neue Spiele nur ihre fachliche Spiellogik implementieren und wiederkehrende Infrastruktur aus dem Core verwenden.

## Core-Bausteine

### Registry / Lifecycle

Datei: `apps/server/src/games/registry.ts`

Jede produktive Engine wird über einen `GameHandle` registriert. Die generische Socket-Schicht kennt keine spielinternen Details mehr.

Verfügbare Hooks:

- `initialize(context)`: Game-State aufbauen und persistieren.
- `afterStart(context)`: optionaler Hook nach `game:start`, z. B. für Geo INTRO → erste Runde.

Nicht implementierte Spiele werden bewusst **nicht** als No-op registriert. Ein Startversuch liefert `GAME_NOT_IMPLEMENTED`.

### Authorization

Datei: `apps/server/src/games/core/access.ts`

`authorizeGameAction()` prüft zentral:

- Socket gehört zu einem Raum.
- Socket ist dem tatsächlichen Socket.IO-Raumkanal beigetreten.
- exakte zugelassene Rollen.
- optional vorhandene Participation.

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

Die jeweilige Engine entscheidet weiterhin, **wie viele** Punkte vergeben oder abgezogen werden.

### Buzzer

Datei: `apps/server/src/games/core/buzzer.ts`

Der Buzzer-Core modelliert:

- geschlossen / geöffnet
- erster gültiger Gewinner
- Ausschluss einzelner Spieler
- Reset

Persistenz und Phasenwechsel bleiben Aufgabe der Engine. Für race-sensitive Buzzes muss die resultierende Änderung zusammen mit dem Game-State revisionssicher gespeichert werden.

## How to add a new game

Beispiel: `weristdas`.

### 1. Engine-Verzeichnis anlegen

```
apps/server/src/games/weristdas/
  engine.ts
  state.ts
  contracts.ts
  *.test.ts
```

Trenne dabei:

- `contracts.ts`: Events, Payloads, Phasen und Zod-Schemas.
- `state.ts`: fachlicher State und pure State-Transformationen.
- `engine.ts`: Datenbank, Socket.IO und Lifecycle.

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
6. bei konkurrierenden Aktionen `saveGameStateIfRevision()` verwenden.
7. nur notwendige Daten senden.

Moderator-Geheimnisse dürfen nur an Moderator-Sockets gehen.

### 6. Score-Regeln lokal halten

Die Engine entscheidet den Delta-Wert. Beispiel:

```ts
const delta = result === 'both' ? 3 : result === 'one' ? 1 : -1;
state.scores = applyScoreDelta(state.scores, playerId, delta);
```

Der Core soll keine Wer-ist-das-, Jeopardy- oder Geo-Regeln kennen.

### 7. Buzzer verwenden

```ts
const opened = openBuzzer(createBuzzerState(), {
  excludePlayerIds: wrongPlayers,
});
const claim = claimBuzzer(opened, playerId);
```

Bei echtem Multiplayer muss die erfolgreiche Claim-Änderung revisionssicher zusammen mit dem Game-State gespeichert werden. Die pure Buzzer-Funktion allein ersetzt keine Datenbank-Concurrency.

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
