# Jeopardy MVP – Fortschrittsdokument (Stand: 2026-09-25)

> Audit-Korrektur (2026-09-26): Die früheren Häkchen in diesem Dokument sind historische
> Implementierungsbehauptungen, keine aktuelle Freigabe. Maßgeblich ist
> `docs/CODEX_JEOPARDY_COMPLETION_PROGRESS.md`. Dort stehen lokale Prüfungen und
> die blockierten Nachweise. Insbesondere waren die alten „Integrationstests“
> nur Unit-Tests, die frühere Transaktion keine wirksame Revisionssperre,
> und J1–J10 waren nie erfolgreich in Chromium nachgewiesen. CI/PR sind offen.

## Ziel und Nicht-Ziele

**Ziel:** Jeopardy als vollständig spielbares Multiplayer-Spiel implementieren.
**Nicht-Ziele:** Andere Spiele, Geo-Regression, großflächige Refactorings.

## Branch & Commits

- **Branch:** `feature/jeopardy-mvp`
- **Ausgangs-Commit auf main:** `06f90b2`
- **Letzter Commit:** `7ce81db fix(jeopardy): use game:start ACK gameSlug for lobby navigation`
- **Anzahl Commits:** 18 seit Basis
- **Letzter Base-Commit (main):** `5e4e59d` (ursprünglich), aktueller main `06f90b2`

## Architektur-Entscheidungen

1. **Server ist alleinige Quelle der Wahrheit** – kein Client-seitiges Scoring
2. **Persistenz über RoomGameState** – kein neues Prisma-Modell nötig
3. **Socket-Typisierung** – konsistent mit bestehender Geo-Architektur
4. **Rollenprüfung** – MODERATOR_ONLY für alle mutierenden Jeopardy-Events (P0-07)
5. **Buzzer-Logik** – Revisionsvergleich in `updateMany` innerhalb einer Prisma-Transaktion; echter konkurrierender Socket-Test ergänzt (P0-10)
6. **Punkteberechnung** – serverseitig mit Math.round (50% = Math.round(value/2))
7. **Dual-Board** – Board 1 normal, Board 2 doppelte Punkte
8. **Zod-Validierung** – alle Jeopardy-Payloads zur Laufzeit geprüft (P0-08)
9. **Error Handling** – alle Socket-Handler mit .catch(), einmaliges ACK (P0-09)
10. **Lösungs-Leak verhindert** – '••••••' für nicht-Moderatoren (P0-07)
11. **board:switch** konsistent → `jeopardy:board:switch` (P0-04)
12. **playerName konsistent** statt displayName in allen Events (P0-05)

## Phase 1-9: Audit-P0-Punkte (Stand nach Audit-Fix)

| # | Punkt | Status | Anmerkung |
|---|-------|--------|-----------|
| P0-01 | Jeopardy-Editor erreichbar | ✅ | `/moderator/vorbereitung/jeopardy` → JeopardySetupPage |
| P0-02 | Spielabhängige Navigation | ✅ | game:start ACK liefert gameSlug → richtige Route je Rolle |
| P0-03 | Setup-Daten vereinheitlichen | ✅ | `title` → `name` in toEngineBoard(), JSON-Import via toEngineBoard() |
| P0-04 | Socket-Event-Namen vereinheitlichen | ✅ | `jeopardy:switch:board` → `jeopardy:board:switch` konsistent |
| P0-05 | Payload-Felder vereinheitlichen | ✅ | `displayName` → `playerName` überall |
| P0-06 | Board-Wechsel reparieren | ✅ | JeopardyModeratorPage: BOARD_COMPLETE/FIELD_DONE-logisch korrekt |
| P0-07 | Lösungs-Leak schließen | ✅ | MODERATOR_ONLY in allen Handlern, '••••••' für Nicht-Moderatoren |
| P0-08 | Runtime-Validierung (Zod) | ✅ | JeopardyFieldOpenSchema + JeopardyBuzzSchema + JeopardyJudgSchema |
| P0-09 | Fehlerbehandlung | ✅ | try/catch + einmaliges ACK + logger.error in jedem Handler |
| P0-10 | Atomarität/Idempotenz | 🔄 | Revisionsvergleich und Socket-Race-Test grün; weitere Cross-Room/Reload-Fälle offen |
| P0-11 | Vollständiger Jeopardy-Resync | 🔄 | Client-Hydrierung und Lösungsfilter ergänzt; Browser-Reload noch nicht nachgewiesen |
| P0-12 | Alte/neue Engine zusammenführen | ✅ | handleJeopardyGame aus engine.ts ist die einzige Implementierung |
| P0-13 | Integrationstests verbessern | 🔄 | Echte Socket.IO/SQLite-Suite ergänzt, weitere Fälle offen |
| P0-14 | Playwright-Tests reparieren | 🔄 | J1–J10 nicht lokal ausgeführt (Chromium fehlt) |
| P0-15 | CI korrigieren | 🔄 | Doppelte Server-Startverantwortung beseitigt; GitHub Actions nicht ausgeführt |
| — | Dokumentation | 🔄 | Dieses Dokument |

## Geänderte Dateien

### Server
| Datei | Änderung |
|-------|----------|
| `apps/server/src/sockets/index.ts` | 10 Jeopardy-Handler + Zod-Validierung + MODERATOR_ONLY + error handling + jeopardy:resync |
| `apps/server/src/sockets/game.ts` | game:start sendet gameSlug in ACK + room:snapshot |
| `apps/server/src/sockets/room.ts` | room:snapshot enthält gameSlug |
| `apps/server/src/games/jeopardy/engine.ts` | MODERATOR_ONLY in allen Handlern, revision-basiertes locking, '••••••' answer mask |
| `apps/server/src/http/rooms.ts` | Keine Änderung (API stabil) |
| `prisma/seed.ts` | geo slug: 'geo-integration' → 'geo', jeopardy BUZZER game def hinzugefügt, mod-1 pw |
| `.github/workflows/ci.yml` | playwright config + DB pre-seed im E2E job |
| `playwright.config.ts` | webServer: startet server (3001) und vite (5173) vor tests |

### Web
| Datei | Änderung |
|-------|----------|
| `apps/web/src/App.tsx` | `/moderator/vorbereitung/jeopardy` → JeopardySetupPage; Jeopardy-Spielrouten |
| `apps/web/src/pages/ModeratorLobbyPage.tsx` | game:start ACK mit gameSlug → navigation |
| `apps/web/src/pages/PlayerLobbyPage.tsx` | game:start ACK mit gameSlug → navigation |
| `apps/web/src/pages/ViewerLobbyPage.tsx` | game:start ACK mit gameSlug → navigation |
| `apps/web/src/pages/JeopardySetupPage.tsx` | toEngineBoard() title→name, JSON-Import via toEngineBoard() |
| `apps/web/src/hooks/useJeopardy.ts` | `jeopardy:switch:board` → `jeopardy:board:switch`, playerName statt displayName |
| `apps/web/src/lib/socket.ts` | JeopardyClient/ServerToClientEvents mit playerName, jeopardy:resync |
| `apps/web/e2e/jeopardy-e2e.spec.ts` | REST room creation, loginAsModerator fix, startGame URL fix |
| `apps/web/vite.config.ts` | `host: true` für `pnpm --filter @quiz/web -- --host` |

## Aktueller Prüfstand (2026-09-26)

| Prüfung | Lokales Ergebnis |
|---|---|
| Frozen Install, Prisma Client, Migrationen | erfolgreich (Migration auf temporärer E2E-Datenbank) |
| Typecheck und Build | erfolgreich unter Node 24; `.nvmrc` fordert Node 22 |
| Lint | erfolgreich, 0 Fehler und 126 vorhandene Warnungen |
| Servertests | 118/118, einschließlich eines tatsächlichen Socket.IO/SQLite-Ablaufs |
| Webtests | 51/51 |
| Playwright J1–J10 und Geo | **nicht nachgewiesen**: Chromium konnte in dieser Umgebung nicht installiert werden |
| GitHub Actions und Pull Request | **nicht nachgewiesen**: Push wurde vom automatischen Freigabecheck blockiert |

Der aktuelle lokale Stand ist noch nicht mergefertig. Fortsetzung und SHA des letzten
gepushten Commits stehen in `docs/CODEX_JEOPARDY_COMPLETION_PROGRESS.md`.
