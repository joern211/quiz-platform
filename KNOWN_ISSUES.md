# Known Issues — v0.3.0

> Alle bekannten Fehler. FIXED = in diesem Branch behoben. OFFEN = noch nicht.
> Version: v0.3.0 · Branch: `gate-1-2-fixes` · Stand: 2026-09-16

---

## ✅ Behoben (FIXED)

### P0 – Blocker (behoben)

| ID | Problem | Status | Behoben |
|----|---------|--------|---------|
| P0-01 | JoinPage: kein Namensfeld; sendet nur `{pin}` statt `{displayName}` | ✅ FIXED | commit a7538ed |
| P0-02 | ModeratorSetupPage sendet `setup`, Server liest `setupSnapshotJson` | ✅ FIXED | commit a7538ed |
| P0-10 | Seed: `estimatedMinutes` vs `estimatedDurationMinutes`, `tags` als Array statt JSON | ✅ FIXED | commit a7538ed |
| P0-11 | Keine versionierten Migrationen im Repo | ✅ FIXED | commit a7538ed |
| API-002 | Raumerstellung: Frontend sendet `gameSlug`, Server braucht `gameDefinitionId` | ✅ FIXED | commit a7538ed |
| API-003 | Spielerbeitritt: `rejoinTokenVersion` fehlt bei Beitritt | ✅ FIXED | commit a7538ed |
| SEC-001 | Seed: Argon2 muss verifiziert werden | ✅ FIXED | commit 8f09d57 |
| SEC-009 | `Math.random()` für Raumcodes | ✅ FIXED | commit 8f09d57 |
| TECH-001 | Falsche relative Importpfade in Spielmodulen | ✅ FIXED | commit 8f09d57 |
| TECH-002 | Server-tsconfig ESM/commonjs-Widerspruch | ✅ FIXED | commit 8f09d57 |
| TECH-003 | Config liefert `PORT`, Server liest `port` | ✅ FIXED | commit 8f09d57 |
| TECH-004 | Vite + Backend auf gleichem Port 5173 | ✅ FIXED | commit 8f09d57 |
| TECH-009 | Keine initiale Migration | ✅ FIXED | commit a7538ed |
| API-005 | RoomsPage liest `data.rooms` statt `data` als Array | ✅ FIXED | commit f7a04c5 |

### Gate 1+2+3 Fixes (aus v0.2.1)

| ID | Problem | Status |
|----|---------|--------|
| TECH-005 | Produktionspfad `WEB_DIST_PATH` nicht explizit gesetzt | ✅ FIXED |
| TECH-006 | Docker Multi-Stage Build ohne prisma generate | ✅ FIXED |
| TECH-007 | Lockfile nicht reproduzierbar | ✅ FIXED |
| QA-001 | Web-tsconfig keine JSX-/CSS-Modul-Konfiguration | ✅ FIXED |
| QA-002 | Keine Tests; Vitest nicht CI-fähig | ✅ FIXED |
| QA-003 | E2E-Tests nur Sichtbarkeitsprüfungen | ✅ FIXED |
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

### P0 – Blocker (noch offen)

> Diese P0s sind die Kernblocker für Geo-Quiz end-to-end spielbar zu sein.

| ID | Problem | Status | Blocking |
|----|---------|--------|----------|
| **P0-03** | Erste Geo-Runde startet nicht: `handleGeoGame.startRound()` wird nie aufgerufen | 🔴 OPEN | Gate 9 |
| **P0-04** | Client/Server-Socket-Events widersprechen sich (`game:start` vs `geo:question`, etc.) | 🔴 OPEN | Gate 7, 9 |
| **P0-05** | `requireRoomRole()` existiert, wird aber nirgends verwendet → keine Moderator-Prüfung | 🔴 OPEN | Gate 7 |
| **P0-06** | `room:subscribe`: Zuschauer ohne Prüfung; `allowViewers`, PIN, Limit fehlen | 🔴 OPEN | Gate 8 |
| **P0-07** | Cross-Room-Manipulation möglich; Broadcasts in client-genannten Raum | 🔴 OPEN | Gate 7 |
| **P0-08** | Disconnect/Rejoin: `handleDisconnect()` nur Kommentar; `connected` nie zurückgesetzt | 🔴 OPEN | Gate 7 |
| **P0-09** | Socket wird mit `autoConnect: false` erstellt und nie `.connect()` aufgerufen | 🔴 OPEN | Gate 7 |
| **P0-12** | Docker: `ADMIN_PASSWORD` vs `INITIAL_ADMIN_PASSWORD` in docker-compose.yml | 🔴 OPEN | Gate 5 |
| **P0-13** | Tests: `@testing-library/jest-dom` fehlt; Vitest sammelt E2E auf; keine Unit-Tests Server | 🔴 OPEN | Gate 4 |
| **P0-14** | Ergebnis-Seiten lesen nur `sessionStorage` → nach Spielende leer | 🔴 OPEN | Gate 9 |
| **P0-15** | Zuschauerfluss: `/zuschauen/${code}` navigiert auf nicht-existente Routen | 🔴 OPEN | Gate 8 |
| **P0-16** | Serverseitiger Timer: `timerStartMs`/`timerEndMs` werden `null` gesetzt; kein Timeout | 🔴 OPEN | Gate 9 |
| **P0-17** | Reveal ohne Moderator-Prüfung; nicht idempotent; nicht transaktional | 🔴 OPEN | Gate 9 |
| **P0-18** | Spiel startet mit 0 Spielern → `minPlayers` wird nicht erzwungen | 🔴 OPEN | Gate 7 |

### P1 – Kritisch (offen)

| ID | Problem |
|----|---------|
| API-003 | Spielerbeitritt: Profil/AV nicht in Beitrittsweg integriert |
| SEC-002 | Socket-Moderationsaktionen: keine Autorisierung |
| SEC-004 | Socket-Mapping, Disconnect/Recconnect, `connected`-Status |
| SEC-005 | PIN mit ungesalzenem SHA-256; keine Rate-Limits |
| SEC-006 | CSRF-/Cookie-Härtung fehlt |
| SEC-007 | Zod-Validierung nicht durchgängig |
| SOCK-001 | Client sendet nicht registrierte Events |
| SOCK-004 | Moderator-Lobby: tote Funktionen (`room:kick`, „Raum schließen") |
| SOCK-005 | Chat-Sperre missbraucht `runPhase` |
| FLOW-003 | GeoSetupPage und JeopardySetupPage unerreichbar |
| FLOW-004 | Profil/AV-Weg nicht wie spezifiziert |
| FLOW-007 | Direkte Reloads nicht robust |
| GAME-001 | Nur Geo teilweise angebunden; andere Spiele nur Gerüste |
| GAME-002 | Engines: Zustand teilweise In-Memory statt serverpersistent |
| GAME-003 | Rollenprojektionen: kein Schutz vor Lösungsleaks |
| CAT-001 | Widersprüchliche Katalogquellen |
| CAT-002 | Erfundene Spielzahlen |
| CAT-003 | Mock-API mit `setTimeout(300)` statt echtem Katalog |

### P2 – Hoch (offen)

| ID | Problem |
|----|---------|
| TECH-005 | Produktionspfad `WEB_DIST_PATH` nicht explizit gesetzt |
| TECH-006 | Docker-Versprechen nicht nachgewiesen |
| TECH-008 | `game-sdk` Phantom-Paket |
| SEC-003 | Rejoin-Token nicht sicher an Raum gebunden |
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
| TECH-007 | Lockfile reproduzierbar? |
| PWA-001 | PWA-Plugin vs handgeschriebener Worker |
| PWA-002 | Manifest/Cache fragil |
| PWA-003 | Kein Offline/Reconnect |
| MEDIA-001 | Medien-Upload nicht end-to-end nachgewiesen |
