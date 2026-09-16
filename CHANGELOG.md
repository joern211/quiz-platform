# Changelog

Alle wesentlichen Änderungen werden hier dokumentiert.

## [0.3.0] - 2026-09-16

### Status: PROTOTYP – noch nicht produktionsreif

> Nur Geo-Quiz hat einen vollständigen End-to-End-Ablauf (Stand: 2026-09-16).
> Andere Spiele sind `PLANNED` oder `BETA`.

### Neue Features

- **P0-01** JoinPage: Namensfeld hinzugefügt; `{displayName}` statt nur `{pin}`; Room-Code mit Auto-Format `NNN-NNN`
- **P0-02** ModeratorSetupPage: sendet `setupSnapshotJson` statt `setup`; Server speichert korrekt
- **P0-03** Geo-Engine: `startRound()` wird nach `initialize()` automatisch aufgerufen → erste Runde startet
- **P0-04** Socket-Events vereinheitlicht: Client/Server verwenden dieselben Event-Namen
- **P0-05** `requireRoomRole()` jetzt an allen Moderator-Endpoints angebunden
- **P0-06** `room:subscribe`: Zuschauer-Login, PIN, `allowViewers`, Limit geprüft
- **P0-07** Cross-Room-Schutz: alle Aktionen prüfen `socket.data.roomId`
- **P0-08** Disconnect: `connected=false` wird in DB und an alle Clients broadcastet
- **P0-09** Socket-Verbindung: `connectSocket()` wird beim Mount aufgerufen
- **P0-10** Seed: `estimatedMinutes`, `JSON.stringify(tags)`, Argon2
- **P0-11** Initiale Migration erstellt und eingecheckt
- **P0-12** Docker: pnpm-Filter korrigiert, `WEB_DIST_PATH=/app/web`, `INITIAL_ADMIN_PASSWORD`
- **P0-13** Tests: `@testing-library/jest-dom`, Vitest CI-Modus, E2E ausgeschlossen
- **P0-14** Ergebnis-Seiten: API/Resync statt nur `sessionStorage`
- **P0-15** Zuschauer: korrekte Routen `/zuschauen/:code/lobby|spiel|ergebnis`
- **P0-16** Serverseitiger Timer: `timerStartMs`/`timerEndMs` in DB; `setTimeout` schließt Eingaben
- **P0-17** Reveal: idempotent mit Transaktion; Moderator-autorisiert; keine Doppelpunktzahl
- **P0-18** Mindestspielerzahl: `GameDefinition.minPlayers` wird bei Start geprüft

### Infrastructure

- Initiale Prisma-Migration eingecheckt (`prisma/migrations/`)
- `@testing-library/jest-dom` hinzugefügt
- `test:run` → `vitest run` (CI); `test:watch` separat
- Root-Build baut Web + Server
- `db:generate`, `db:migrate:dev`, `db:migrate:deploy` Scripts
- `packages/game-sdk`: Game-Engine-Typen implementiert
- Einheitliche Versionsnummer: `0.3.0`

### Socket-Sicherheit

- `socket.data` speichert Identität: `{participationId, roomId, role, displayName}`
- Jeder mutierende Event zentral autorisiert
- Rejoin-Token nur für Participation in diesem Raum gültig

---

## [0.2.1] - 2026-09-16

### Gate 1+2 Fixes

- TECH-001/002/003/004: Build, TS, ESM, Ports repariert
- SEC-001: Argon2 statt SHA-256 im Seed
- SEC-009: `crypto.randomInt()` für Raumcodes
- API-001: Zentraler `ApiResponse<T>` Client
- SOCK-003: Registry korrigiert
- FLOW-001/002/005/006: Navigation, Ergebnis-Routen, Mobile Nav

---

## [0.2.0] - 2026-09-16

### UI-Redesign

- Google Fonts: Inter + Space Grotesk
- Gamified Startseite mit animierten Cards
- Glass Morphism, Neon Glows, Page Transitions
- Buzzer mit Pulse-Glow, Scoreboard, Toast Notifications
- Responsive Grid-Layouts

---

## [0.1.0] - 2026-09-16

### Initial

- Monorepo mit pnpm Workspaces
- packages/shared, packages/ui, packages/game-sdk
- Prisma Schema, Backend (Express+Socket.IO), Frontend (React+Vite+PWA)
- Geo-Quiz, Jeopardy, Wer ist das?, Timeline, Wer lügt am besten?, Erkenne den Song
- Docker, Backup/Restore Scripts
