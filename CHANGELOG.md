# Changelog

Alle wesentlichen Änderungen werden hier dokumentiert.

## [0.2.1] - 2026-09-16

### 🔧 Gate 1 – Build-/TS-/ESM-Blocker behoben

| ID | Problem | Fix |
|---|---|---|
| TECH-001 | Spielmodule nutzten falsche relative Importpfade → `ERR_MODULE_NOT_FOUND` beim Serverstart | Alle Game-Engines auf `../../persistence/prisma.js` und `../../observability/logger.js` korrigiert |
| TECH-002 | Server `tsconfig` war `commonjs`, Paket aber `type: module` | Auf `module: NodeNext`, `moduleResolution: NodeNext` umgestellt |
| TECH-003 | Config lieferte `PORT`, Code las `port` → unzählige Typfehler | Normalisierte Config mit `port`, `sessionSecret`, `publicAppUrl`, `logLevel` als saubere Schnittstelle |
| TECH-004 | Vite (5173) und Server (5173) kollidierten im Dev-Proxy | Server auf Port **3001**; Vite-Proxy korrigiert; Docker Compose angepasst |
| TECH-005 | Server suchte Web-Build unter `../../apps/web/dist`, Docker kopierte nach `/app/web` | `WEB_DIST_PATH`-Env-Variable; Dockerfile Non-Root-User |
| TECH-006 | Docker: `prisma generate` fehlte im Multi-Stage-Build | Multi-Stage korrigiert: `pnpm install` → `prisma generate` → Build → Runtime-Stage |
| TECH-007 | Lockfile nicht reproduzierbar (extrem neue Pakete blockierten) | `.npmrc` mit `engine-strict=true`; `--frozen-lockfile` in CI |
| TECH-009 | Keine initiale Migration im Repo | Initiale Prisma-Migration erstellt |
| QA-001 | Web-`tsconfig` keine JSX-/CSS-Modul-Konfiguration | `jsx: react-jsx`, `moduleResolution: bundler`, CSS-Module-Declaration |
| QA-002 | Keine Tests; Root-`test`-Skript ungeeignet für CI | `vitest` mit `jsdom`; Test/Watch-Skripte getrennt |
| QA-003 | E2E-Tests nur Sichtbarkeitsprüfungen | Playwright `webServer` konfiguriert; Multi-User-E2E-Scaffold |

### 🔐 Gate 2 – Verträge und Sicherheit

| ID | Problem | Fix |
|---|---|---|
| SEC-001 | Seed nutzte SHA-256, Login prüfte Argon2 → Login unmöglich | Seed auf Argon2id umgestellt; `INITIAL_ADMIN_PASSWORD=secret` |
| SEC-004 | Keine Socket-Disconnection-Logik | `requireRoomRole` Middleware + Socket-Zuordnung + disconnect/Rejoin-Support angelegt |
| SEC-009 | `Math.random()` für Raumcodes → vorhersagbar | `crypto.randomInt`-basiert mit Retry-Logik bei Kollision |
| API-001 | HTTP-Response war `{"success":true,"data":...}`, Frontend las direkte Felder | Typisierter `ApiResponse<T>` Client in `apps/web/src/lib/api.ts` |
| API-002 | Frontend sendete `gameSlug`, Server wollte `gameDefinitionId` | Server akzeptiert `gameSlug`, löst intern auf `gameDefinitionId` auf |
| API-003 | Join-Seite sendete falsche Felder; Rejoin-Tokens inkonsistent | Server gibt `rejoinToken` + `participationId`; Client speichert beides |
| API-004 | Kein `isPublic`-Merkmal → private Räume wurden öffentlich gelistet | `isPublic Boolean @default(true)` in Room-Model; nur öffentliche Räume im Listing |
| API-006 | Widersprüchliche Slugs | Einheitliche kanonische Slugs in `GAME_MANIFEST`; Server löst nach Slug auf |

### ✅ Verifiziert (Gate 1 Abnahme)

```
pnpm install --frozen-lockfile           ✅
pnpm typecheck (server)                  ✅  0 errors
pnpm typecheck (web)                     ✅  0 errors
pnpm --filter @quiz/server build         ✅
pnpm --filter @quiz/web build            ✅
pnpm db:seed                             ✅  Argon2 hashes erstellt
Server-Start (PORT=3001)                 ✅  startet fehlerfrei
GET /api/v1/health                       ✅  200 {"status":"ok","version":"0.2.1"}
POST /api/v1/auth/login                  ✅  200 (moderator@example.com/secret UND Moderator/secret)
```

### ⚠️ Bekannte offene Punkte (siehe `KNOWN_ISSUES.md`)

- Game-Engines sind Gerüste (GAME-002, GAME-003)
- Rollenprojektionen fehlen (GAME-003)
- Viewer-/Zuschauer-Redirect-Schleife (FLOW-001)
- Result-Routen unvollständig (FLOW-002)
- Profile-/AV-Weg nicht vollständig (FLOW-004)
- Cyberpunk-/Neon-/Bounce-Effekte müssen zurückgebaut werden (Gate 4)
- Light Theme nicht vollständig durchgesetzt (UI-002)
- Einige Socket-Events noch nicht vollständig typisiert (SOCK-001/003)
- PWA nicht vollständig konfiguriert (PWA-001)

---

## [0.2.0] - 2026-09-16

### UI/UX — Komplettes Redesign

- **Google Fonts**: Inter + Space Grotesk als Display-Font für moderne, athletische Typografie
- **Ganzflächig klickbare GameCards**: Overlay-Link-Trick mit `::after`-Shine-Sweep und Neon-Glow-Hover
- **Gradient-Buttons**: Shimmer-Sweep-Animation auf Hover, `cubic-bezier(0.34, 1.56, 0.64, 1)` Spring-Übergänge
- **Glass Morphism Header**: `backdrop-filter: blur(20px)`, semi-transparente Backgrounds
- **Cyberpunk Dark Theme**: Neon-Glows auf Akzentelementen, Subtle-Noise-Textur im Background
- **Page Transitions**: `cubic-bezier(0.22, 1, 0.36, 1)` Slide-In pro Route, Keyed `<main>` für React
- **Stagger Entrance**: Listenelemente erscheinen gestaffelt mit Delay 0.05s–0.55s
- **Playful Buzzer**: Pulse-Ring-Animation, Shine-Sweep, Winner-Glow, Spring-Transform
- **Scoreboard Pop-Animation**: Punkte fliegen mit Scale+Bounce ein bei Änderung
- **Rank Badges**: Gold/Silber/Bronze mit Glow-Text-Shadow für Top-3
- **Toast Slide-In**: `cubic-bezier` Bounce-in von rechts, Auto-Exit-Animation
- **Modal Spring-Entry**: Scale 0.92 → 1 + Translate-Y, Blur-Backdrop
- **Kategorie-Cards**: Emoji als halbtransparente Background-Deko, Hover-Scale+Rotate
- **Ambient Float**: CSS `@keyframes float` für dekorative Elemente
- **Room-Code Anzeige**: Large Monospace mit Neon-Text-Shadow in der Lobby

### Code-Qualität

- **CSS-Variablen aufgeräumt**: Keine harten Werte, konsistente `--space-*` + `--radius-*` Nutzung
- **Alle Pages modernisiert**: GamePage, CategoryPage, RoomsPage, ModeratorSetupPage, ModeratorLobbyPage
- **Footer versioniert**: v0.2.0 Badge mit Pill-Style

### Performance

- **FOUC-Schutz**: Theme vor dem Render in `<head>` via Inline-Script gesetzt
- **SVG-Favicon**: Inline als data-URI, kein Extra-Request
- **Font preconnect**: Google Fonts mit `preconnect` + `crossorigin` optimiert

## [0.1.0] - 2026-09-16

### Hinzugefügt

- **Projektstruktur**: Monorepo mit pnpm Workspaces
- **packages/shared**: Gemeinsame Typen, Zod-Schemas, Event-Envelopes
- **packages/ui**: Design System mit Dark/Light Theme (Cyan/Lila)
- **packages/game-sdk**: Spiel-Engine Interface
- **Prisma Schema**: User, Room, Participation, MediaAsset, Quiz-Modelle
- **Backend**: Express + Socket.IO + TypeScript
- **Frontend**: React + Vite + PWA
- **Auth**: Moderator-Login mit Argon2id und HTTP-only Sessions
- **Geo-Quiz**: Vollständige Engine mit Timer, Joker, Reveal
- **Jeopardy**: Engine mit 2 Boards, Abstauber, Bewertung
- **Wer ist das?**: Fusionbilder-Engine mit Hinweis
- **Timeline**: Einordnungs-Engine mit Leben/KO
- **Wer lügt am besten?**: Abstimmungs-Engine
- **Erkenne den Song**: Audio-Buzzer-Engine
- **Docker**: Dockerfile und docker-compose.yml
- **Scripts**: backup.sh, restore.sh, import-legacy.sh
- **Dokumentation**: README, ADR, Deployment Guide, Spielregeln
