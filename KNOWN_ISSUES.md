# Known Issues — v0.3.1

> Alle bekannten Fehler. FIXED = in diesem Branch behoben. OFFEN = noch nicht.
> Version: v0.3.1 · Branch: `gate-1-2-fixes` · Stand: 2026-09-17

---

## ✅ Behoben (FIXED)

### P0 – Blocker (behoben in Branch `gate-1-2-fixes`)

| ID | Problem | Status | Behoben in |
|----|---------|--------|------------|
| P0-01 | JoinPage: kein Namensfeld; sendet nur `{pin}` statt `{displayName}` | ✅ FIXED | commit a7538ed |
| P0-02 | Spieleridentität: `localStorage` vs `sessionStorage` gemischt | ✅ FIXED | commit dc67c69 |
| P0-03 | Erste Geo-Runde startet nicht: `startRound()` nie aufgerufen | ✅ FIXED | commit bc27ac7 |
| P0-04 | Client/Server-Socket-Events widersprechen sich | ✅ FIXED | commits d0fd958, bc27ac7 |
| P0-05 | Setup wird doppelt JSON-serialisiert → 0 Fragen | ✅ FIXED | commit f688060 |
| P0-06 | Moderator ohne Token → Viewer statt MODERATOR; `game:start` → `WRONG_ROOM` | ✅ FIXED | commit d0fd958, f3586fc |
| P0-07 | Player sendet Antworten und Joker OHNE `rejoinToken` | ✅ FIXED | commit ac446f1 |
| P0-08 | Cross-Room `ready:set` und `profile:update` akzeptiert | ✅ FIXED | commit acfb025 |
| P0-09 | Unauthentifiziertes `room:resync` leakt Raum/Spieler | ✅ FIXED | commits bc27ac7, acfb025 |
| P0-10 | ViewerLimit erzwingt kein Maximum | ✅ FIXED | commit acfb025 |
| P0-11 | Gekickter Spieler kann mit altem Token wieder beitreten | ✅ FIXED | commit acfb025 |
| P0-12 | Gleichzeitige Antworten: beide Ack OK, nur eine persistiert | ✅ FIXED | commit bc27ac7 |
| P0-13 | Server-Timer `timerEndMs` wird `null` gesetzt | ✅ FIXED | commit bc27ac7 |
| P0-15 | Keine Produktionsmigration im Repo | ✅ FIXED | commit f42b4a4 |
| P0-16 | Root-Typecheck, Root-Test, Lint sind rot | ✅ FIXED | commits 5c86260, e8bcc18 |
| P0-17 | CI vollständig fehlt | ✅ FIXED | ci.yml in commit ac446f1 |
| P0-19 | Docker: `prisma generate` fehlt, Entry nicht `dist/server.js` | ✅ FIXED | Dockerfile überarbeitet |
| P0-20 | Pause/Resume: Player sieht keine gesperrten Inputs | ✅ FIXED | commit 1bb2870 |
| API-002 | Frontend sendet `gameSlug`, Server braucht `gameDefinitionId` | ✅ FIXED | commit a7538ed |
| API-003 | Spielerbeitritt: `rejoinTokenVersion` fehlt | ✅ FIXED | commit a7538ed |
| API-005 | RoomsPage liest `data.rooms` statt `data` als Array | ✅ FIXED | commit f7a04c5 |
| SEC-001 | Seed: Argon2 muss `argon2id` verwenden | ✅ FIXED | seed.ts |
| SEC-009 | `Math.random()` für Raumcodes | ✅ FIXED | rooms.ts |

### Gate A–E Infrastructure Fixes

| ID | Problem | Status |
|----|---------|--------|
| TECH-001 | Falsche relative Importpfade in Spielmodulen | ✅ FIXED |
| TECH-002 | Server-tsconfig ESM/commonjs-Widerspruch | ✅ FIXED |
| TECH-003 | Config liefert `PORT`, Server liest `port` | ✅ FIXED |
| TECH-004 | Vite + Backend auf gleichem Port 5173 | ✅ FIXED |
| TECH-005 | Produktionspfad `WEB_DIST_PATH` nicht explizit gesetzt | ✅ FIXED |
| TECH-006 | Docker Multi-Stage Build ohne prisma generate | ✅ FIXED |
| TECH-007 | Lockfile nicht reproduzierbar | ✅ FIXED |
| TECH-008 | `game-sdk` Phantom-Paket | ✅ FIXED |
| TECH-009 | Keine initiale Migration | ✅ FIXED |
| QA-001 | Web-tsconfig keine JSX-/CSS-Modul-Konfiguration | ✅ FIXED |
| QA-002 | Keine Tests; Vitest nicht CI-fähig | ✅ FIXED |
| QA-003 | E2E-Tests nur Sichtbarkeitsprüfungen | ✅ FIXED |
| QA-004 | CSS-Module-TypeScript-Declarationen fehlen | ✅ FIXED |
| API-001 | HTTP-Response `ApiResponse<T>` Client-seitig falsch gelesen | ✅ FIXED |
| API-004 | Öffentliche Räume: `isPublic`-Merkmal nicht verwendet | ✅ FIXED |
| API-006 | Slugs nicht kanonisch | ✅ FIXED |
| SEC-004 | Keine Socket-Disconnection-Logik | ✅ FIXED |
| FLOW-001 | Zuschauer-Redirect-Schleife | ✅ FIXED |
| FLOW-002 | Ergebnisrouten fehlen | ✅ FIXED |
| FLOW-005 | Mobile Navigation verschwindet | ✅ FIXED |
| FLOW-006 | Kein „Zurück zum Raum" | ✅ FIXED |
| SOCK-003 | Registry importiert nicht exportierte Funktionen | ✅ FIXED |
| SOCK-006 | Ready/Participation-ID-Verwirrung | ✅ FIXED |
| UI-008 | „kein Account nötig" enthielt chinesische Zeichen | ✅ FIXED |
| UI-010 | Externe Google Fonts (Datenschutz/Offline) | ✅ FIXED |
| UI-011 | Scrollen bei Routenwechsel ignoriert `prefers-reduced-motion` | ✅ FIXED |

---

## ⚠️ Offene Fehler (OPEN)

### P0 – Blocker (nach v0.3.1 noch offen)

> Alle im Re-Audit vom 17.09.2026 dokumentierten P0s sind behoben. Verbleibende offene Punkte sind P1/P2/P3.

| ID | Problem | Status | Blocking |
|----|---------|--------|----------|
| *(keine)* | — | — | — |

### P1 – Kritisch (offen)

| ID | Problem |
|----|---------|
| API-003 | Spielerbeitritt: Profil/AV nicht in Beitrittsweg integriert |
| SEC-002 | Socket-Moderationsaktionen: keine Autorisierung (teilw. behoben via `requireRoomRole`) |
| SEC-005 | PIN mit ungesalzenem SHA-256; keine Rate-Limits |
| SEC-006 | CSRF-/Cookie-Härtung fehlt |
| SEC-007 | Zod-Validierung nicht durchgängig |
| SOCK-001 | Client sendet nicht registrierte Events |
| SOCK-004 | Moderator-Lobby: tote Funktionen (`room:kick`, „Raum schließen") |
| SOCK-005 | Chat-Sperre missbraucht `runPhase` |
| FLOW-003 | GeoSetupPage und JeopardySetupPage unerreichbar |
| FLOW-004 | Profil/AV-Weg nicht wie spezifiziert |
| FLOW-007 | Direkte Reloads nicht robust |
| GAME-001 | Nur Geo vollständig angebunden; andere Spiele nur Gerüste |
| GAME-002 | Engines: Zustand teilweise In-Memory statt serverpersistent |
| GAME-003 | Rollenprojektionen: kein Schutz vor Lösungsleaks |
| CAT-001 | Widersprüchliche Katalogquellen |
| CAT-002 | Erfundene Spielzahlen |
| CAT-003 | Mock-API mit `setTimeout(300)` statt echtem Katalog |

### P2 – Hoch (offen)

| ID | Problem |
|----|---------|
| SEC-003 | Rejoin-Token nicht sicher an Raum gebunden (teilw. behoben via `kickedAt` + Token-Rotation) |
| GAME-004 | Spieleransicht zeigt nicht alle nötigen Infos |
| GAME-005 | 50:50 nummeriert Antworten nach Filterung neu |
| GAME-006 | Spy-Joker: keine nutzbare Auswertung |
| GAME-007 | Max. 4 Kameras nicht durchgesetzt |
| GAME-008 | Spielfläche/Kameraraster nicht konsistent |
| UI-001 | UI-Richtung „playful/Cyberpunk" widerspricht gewünschtem Look |
| UI-002 | Light Theme nicht systematisch umgesetzt |
| UI-003 | Überladene Kartenhierarchie |
| UI-004 | GameCard: Semantik, Tastatur, verschachtelte Links |
| UI-005 | InfoPopup: Fokus, Escape, Fokus-Trap |
| UI-006 | Modal: Barrierefreiheit unvollständig |
| UI-007 | Statusänderungen nicht assistiv angekündigt |
| UI-009 | Inline-Styles und doppelte Basissysteme |
| UI-012 | Rolle/CTA-Hierarchie nicht konsistent |

### P3 – Mittel (offen)

| ID | Problem |
|----|---------|
| PWA-001 | PWA-Plugin vs handgeschriebener Worker |
| PWA-002 | Manifest/Cache fragil |
| PWA-003 | Kein Offline/Reconnect |
| MEDIA-001 | Medien-Upload nicht end-to-end nachgewiesen |

---

## 🔒 Sicherheitshinweis

> **`workflow`-Scope für CI:** Die CI-Workflow-Datei (`.github/workflows/ci.yml`) wurde in Commit `ac446f1` angelegt, konnte aber nicht gepusht werden, da der verwendete PAT keinen `workflow`-Scope hat. Bitte einen neuen PAT mit `workflow`-Scope generieren und die Datei manuell committen.
