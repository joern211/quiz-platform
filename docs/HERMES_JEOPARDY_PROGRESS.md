# Jeopardy MVP – Fortschrittsdokument

## Ziel und Nicht-Ziele

**Ziel:** Jeopardy als vollständig spielbares Multiplayer-Spiel implementieren.
**Nicht-Ziele:** Andere Spiele (Geo bleibt Referenz), Geo-Regression, großflächige Refactorings.

## Ausgangslage

- **Branch:** `feature/jeopardy-mvp` (neu erstellt von `main`)
- **Ausgangs-Commit:** `06f90b2 fix: stabilize Geo multiplayer flow and CI E2E (#6)`
- **Bestehender Jeopardy-Code:** Nur ein unvollständiges Scaffold in `apps/server/src/games/jeopardy/index.ts` mit in-memory State und ohne Persistenz/Autorisierung.

## Architektur-Entscheidungen

1. **Server ist alleinige Quelle der Wahrheit** – kein Client-seitiges Scoring
2. **Persistenz über RoomGameState** – kein neues Prisma-Modell nötig
3. **Socket-Typisierung** – konsistent mit bestehender Geo-Architektur
4. **Rollenprüfung** – requireRoomRole wiederverwenden
5. **Buzzer-Logik** – atomar via Prisma-Transaction
6. **Punkteberechnung** – serverseitig mit Math.round (50% = Math.round(value/2))

## Phasenplan

- [ ] Phase 1: Baseline & Bestandsaufnahme (dieser Commit)
- [ ] Phase 2: Wartungsarbeiten & Actions-Warnungen
- [ ] Phase 3: Jeopardy-Vertrag & State Machine
- [ ] Phase 4: Server-Engine & Autorisierung
- [ ] Phase 5: Moderator-, Spieler- und Zuschauer-UI
- [ ] Phase 6: Persistenz, Reload und Rejoin
- [ ] Phase 7: Unit- und Integrationstests
- [ ] Phase 8: Playwright-E2E
- [ ] Phase 9: Dokumentation und Abschlussprüfung

## Abgeschlossene Phasen

### Phase 1: Baseline & Bestandsaufnahme ✅

**Änderungen:**
- `git switch -c feature/jeopardy-mvp` von `main` (06f90b2)
- Bestandsaufnahme aller relevanten Dateien

**Befehle:**
```bash
git status && git fetch origin && git switch main && git pull --ff-only origin main && git switch -c feature/jeopardy-mvp
```

**Befunde:**
- Bestehendes Jeopardy: `apps/server/src/games/jeopardy/index.ts` (186 Zeilen) – in-memory state, keine Persistenz, keine Autorisierung, kein Board-Wechsel, keine vollständige Spiellogik
- Geo als Referenz: vollständige Implementierung in `apps/server/src/games/geo/index.ts` (1297 Zeilen)
- Registry: Jeopardy-Handle existiert als Stub
- Game-Socket: `game:start` kennt nur Geo
- Kein Jeopardy-Seiten except `JeopardySetupPage.tsx`
- Keine Jeopardy-Tests
- CI-Workflow: aktuell, keine Node.js-20-Warnungen sichtbar

**Nächster Schritt:**
Phase 3: Jeopardy-Vertrag und State Machine implementieren

## Geänderte Dateien (dieser Commit)

- `docs/HERMES_JEOPARDY_PROGRESS.md` (neu erstellt)

## Ausstehende Befehle für Fortsetzung

```bash
cd /Users/joern.r/quiz-platform
git log --oneline -1
```

## Fortsetzungsprompt

> Lese `docs/HERMES_JEOPARDY_PROGRESS.md` und `git log --oneline -1`. Implementiere dann Phase 3: Jeopardy-State-Machine mit allen Phasen (SELECTING, BUZZ_OPEN, BUZZ_LOCKED, STEAL_OPEN, STEAL_LOCKED, BOARD_COMPLETE, GAME_END). Ergänze Shared Types für Jeopardy-Events. Committe als `feat(jeopardy): define state machine and shared contracts`.
