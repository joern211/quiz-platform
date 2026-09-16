# Changelog

Alle wesentlichen Änderungen werden hier dokumentiert.

## [0.3.0] - 2026-09-16 (IN ARBEIT)

### Status: PROTOTYP – noch nicht produktionsreif

> Nur Geo-Quiz hat einen vollständigen End-to-End-Ablauf (Stand: 2026-09-16).
> Andere Spiele sind `PLANNED` oder `BETA`.
> Branch: `gate-1-2-fixes` mit uncommitted P0-Fixes.

---

### ✅ Abgeschlossen (committed)

| ID | Beschreibung |
|----|--------------|
| P0-01 | JoinPage: Namensfeld; `{displayName}` statt nur `{pin}`; Room-Code mit Auto-Format `NNN-NNN` |
| P0-02 | ModeratorSetupPage: sendet `setupSnapshotJson` statt `setup` |
| P0-10 | Seed: `estimatedMinutes`, `JSON.stringify(tags)`, Argon2 |
| P0-11 | Initiale Migration erstellt und eingecheckt |
| P0-13 | Tests: `@testing-library/jest-dom`, Vitest CI-Modus |

### 🔄 In Bearbeitung (uncommitted fixes in working tree)

| ID | Beschreibung | Dateien |
|----|--------------|---------|
| P0-03 | `startRound()` wird nach `initialize()` automatisch aufgerufen | geo/index.ts |
| P0-04 | Socket-Events vereinheitlicht | game.ts, geo/index.ts |
| P0-05 | `requireRoomRole()` an Moderator-Endpoints angebunden | game.ts, auth.js |
| P0-06 | `room:subscribe`: Zuschauer-Login, PIN, `allowViewers`, Limit geprüft | room.ts |
| P0-07 | Cross-Room-Schutz: alle Aktionen prüfen `socket.data.roomId` | game.ts, room.ts |
| P0-08 | Disconnect: `connected=false` in DB und broadcastet | room.ts |
| P0-09 | Socket-Verbindung: `connectSocket()` beim Mount aufgerufen | socket.ts |
| P0-12 | Docker: `WEB_DIST_PATH=/app/web`, `INITIAL_ADMIN_PASSWORD` | Dockerfile, docker-compose.yml |
| P0-14 | Ergebnis-Seiten: API/Resync statt nur `sessionStorage` | ModeratorGamePage.tsx, PlayerGamePage.tsx |
| P0-15 | Zuschauer: korrekte Routen `/zuschauen/:code/lobby\|spiel\|ergebnis` | App.tsx |
| P0-16 | Serverseitiger Timer: `setTimeout` schließt Eingaben | geo/index.ts |
| P0-17 | Reveal: idempotent mit Transaktion; Moderator-autorisiert | geo/index.ts |
| P0-18 | Mindestspielerzahl: `minPlayers` wird bei Start geprüft | game.ts |

### 🔧 Infrastructure

- Initiale Prisma-Migration eingecheckt (`prisma/migrations/`)
- `@testing-library/jest-dom` hinzugefügt
- `test:run` → `vitest run` (CI); `test:watch` separat
- Root-Build baut Web + Server
- `db:generate`, `db:migrate:dev`, `db:migrate:deploy` Scripts
- `packages/game-sdk`: Game-Engine-Typen implementiert
- Einheitliche Versionsnummer: `0.3.0`

### 🔐 Socket-Sicherheit

- `socket.data` speichert Identität: `{participationId, roomId, role, displayName}`
- Jeder mutierende Event zentral autorisiert
- Rejoin-Token nur für Participation in diesem Raum gültig

### 🎮 Spielstände

| Spiel | Status | Anmerkung |
|-------|--------|-----------|
| **Geo-Quiz** | 🔶 BETA | Engine vollständig; Socket-Integration + P0-Fixes in Bearbeitung |
| **Jeopardy** | 🔶 PLANNED | Engine-Scaffold vorhanden |
| **Wer ist das?** | 🔶 PLANNED | Engine-Scaffold vorhanden |
| **Timeline** | 🔶 PLANNED | Engine-Scaffold vorhanden |
| **Wer lügt am besten?** | 🔶 PLANNED | Engine-Scaffold mit In-Memory-State |
| **Erkenne den Song** | 🔶 PLANNED | Engine-Scaffold vorhanden |

---

## [0.2.1] - 2026-09-16

### Gate 1+2 Fixes

| ID | Problem | Fix |
|----|---------|-----|
| TECH-001/002/003/004 | Build, TS, ESM, Ports | Repariert |
| SEC-001 | Argon2 statt SHA-256 im Seed | ✅ |
| SEC-009 | `crypto.randomInt()` für Raumcodes | ✅ |
| API-001 | Zentraler `ApiResponse<T>` Client | ✅ |
| SOCK-003 | Registry korrigiert | ✅ |
| FLOW-001/002/005/006 | Navigation, Ergebnis-Routen, Mobile Nav | ✅ |

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
