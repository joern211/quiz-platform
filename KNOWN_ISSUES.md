# Known Issues — v0.3.0

> Alle bekannten Fehler. Gefixt = in diesem PR behoben. Offen = noch nicht.
> Version: v0.3.0-PR-Branch `gate-1-2-fixes` · Stand: 2026-09-16

---

## ✅ Behoben (Gate 1+2+3)

| ID | Problem | Fix |
|---|---|---|
| TECH-001 | Falsche relative Importpfade in Spielmodulen | `../../persistence/prisma.js` statt `../persistence/prisma.js` |
| TECH-002 | Server-tsconfig ESM/commonjs-Widerspruch | ✅ FIXED – `NodeNext` + `tsc` als alleiniges Build-Kommando; `resolveJsonModule` entfernt |
| TECH-003 | Config liefert `PORT`, Server liest `port` | Config normalisiert: beides `port` und `PORT` |
| TECH-010 | Socket: `handleRoomSubscription` nutzt `.then()` statt async/await | ✅ FIXED – room.ts ist jetzt `async function` mit `await` |
| TECH-004 | Vite + Backend auf gleichem Port 5173 | Vite 5173 → Proxy 3001; Backend 3001 |
| TECH-007 | Lockfile erlaubt nicht reproduzierbare Versionen | `minimumReleaseAge`-Policy geprüft; Versionen gepinnt |
| TECH-009 | Keine Migration eingecheckt | Initiale Migration erstellt |
| SEC-009 | `Math.random()` für Raumcodes | `crypto.randomInt()` |
| API-001 | Antwortformat `ApiResponse<T>` Frontend-seitig falsch gelesen | Zentraler API-Client; alle Seiten nutzen `json.data` |
| SOCK-003 | Registry importiert nicht exportierte Funktionen | ✅ FIXED – Registry nutzt handleGeoGame korrekt |
| API-005 | RoomsPage liest `data.rooms` statt `data` als Array | Korrigiert |
| FLOW-001 | Zuschauer-Redirect-Schleife `/zuschauen` | Eigene Einstiegsseite + Routen `/zuschauen/:code/lobby`, `/spiel`, `/ergebnis` |
| FLOW-002 | Ergebnisrouten fehlen | `ModeratorResultPage`, `PlayerResultPage`, `ViewerResultPage` |
| FLOW-005 | Mobile Navigation verschwindet | Hamburger-Menü mit Fokusführung und Escape |
| FLOW-006 | Kein „Zurück zum Raum" | Zentraler ActiveRoomContext (in v0.3.0 Gate 6) |
| SOCK-006 | Ready/Participation-ID-Verwirrung | Join-Antwort speichert `participationId` + `rejoinToken` getrennt |
| UI-008 | „kein Account nötig" enthielt chinesische Zeichen | Korrigiert; „kein Account nötig" |
| UI-010 | Externe Google Fonts (Datenschutz/Offline) | System-Fonts; Inter/Space Grotesk entfernt |
| UI-011 | Scrollen bei Routenwechsel ignoriert `prefers-reduced-motion` | Inline Scroll-Override deaktiviert |
| QA-003 | Kein Multiplayer-E2E-Test | Playwright mit `webServer`-Konfiguration |

---

## ⚠️ Offene Fehler — nach Priorität

### P0 – Blocker (noch offen, in Bearbeitung)

| ID | Problem | Status |
|---|---|---|
| **P0-01** | JoinPage: kein Namensfeld; sendet nur `{pin}` statt `{displayName}`; Code ohne Bindestrich an Server | ✅ FIXED 2026-09-16 |
| **P0-02** | ModeratorSetupPage sendet `setup`, Server liest `setupSnapshotJson` → leerer Snapshot | ✅ FIXED 2026-09-16 |
| **P0-03** | Erste Geo-Runde startet nicht: `handleGeoGame.startRound()` wird nie aufgerufen | 🔄 Fix in Bearbeitung |
| **P0-04** | Client/Server-Socket-Events widersprechen sich (`game:start` vs `geo:question`, etc.) | 🔄 Fix in Bearbeitung |
| **P0-05** | `requireRoomRole()` existiert, wird aber nirgends verwendet → keine Moderator-Prüfung | 🔄 Fix in Bearbeitung |
| **P0-06** | `room:subscribe`: Zuschauer ohne Prüfung; `allowViewers`, PIN, Limit fehlen | 🔄 Fix in Bearbeitung |
| **P0-07** | Cross-Room-Manipulation möglich; Broadcasts in client-genannten Raum | 🔄 Fix in Bearbeitung |
| **P0-08** | Disconnect/Rejoin: `handleDisconnect()` nur Kommentar; `connected` nie zurückgesetzt | 🔄 Fix in Bearbeitung |
| **P0-09** | Socket wird mit `autoConnect: false` erstellt und nie `.connect()` aufgerufen | 🔄 Fix in Bearbeitung |
| **P0-10** | Seed: `estimatedMinutes` vs `estimatedDurationMinutes`, `tags` als Array statt JSON | ✅ FIXED – seed.ts korrigiert |
| **P0-11** | Keine versionierten Migrationen im Repo | ✅ FIXED – Initiale Migration erstellt |
| **P0-12** | Docker: pnpm-Filter, fehlendes `WEB_DIST_PATH`, falsches Secret, `ADMIN_PASSWORD` vs `INITIAL_ADMIN_PASSWORD` | 🔄 Fix in Bearbeitung |
| **P0-13** | Tests: `@testing-library/jest-dom` fehlt; Vitest sammelt E2E auf; keine Unit-Tests Server | 🔄 Fix in Bearbeitung |
| **P0-14** | Ergebnis-Seiten lesen nur `sessionStorage` → nach Spielende leer | 🔄 Fix in Bearbeitung |
| **P0-15** | Zuschauerfluss: `/zuschauen/${code}` navigiert auf nicht-existente Routen | 🔄 Fix in Bearbeitung |
| **P0-16** | Serverseitiger Timer: `timerStartMs`/`timerEndMs` werden `null` gesetzt; kein Timeout | 🔄 Fix in Bearbeitung |
| **P0-17** | Reveal ohne Moderator-Prüfung; nicht idempotent; nicht transaktional | 🔄 Fix in Bearbeitung |
| **P0-18** | Spiel startet mit 0 Spielern → `minPlayers` wird nicht erzwungen | 🔄 Fix in Bearbeitung |

### P1 – Kritisch (offen, geplant)

| ID | Problem |
|---|---|
| API-002 | Raumerstellung: Frontend sendet `gameSlug`, Server braucht `gameDefinitionId` oder slug-Auflösung | ✅ FIXED – rooms.ts löst gameSlug → id |
| API-003 | Spielerbeitritt: `rejoinTokenVersion` fehlt bei Beitritt | ✅ FIXED – rooms.ts setzt `rejoinTokenVersion: 1` |
| API-003 | Spielerbeitritt: Profil/AV nicht in Beitrittsweg integriert |
| API-004 | Öffentliche Räume: `isPublic`-Merkmal beim List-Endpoint nicht verwendet |
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

### P2 – Hoch (offen, geplant)

| ID | Problem |
|---|---|
| TECH-005 | Produktionspfad `WEB_DIST_PATH` nicht explizit gesetzt |
| TECH-006 | Docker-Versprechen nicht nachgewiesen |
| TECH-008 | `game-sdk` Phantom-Paket |
| SEC-001 | Seed: Argon2 muss verifiziert werden |
| SEC-003 | Rejoin-Token nicht sicher an Raum gebunden |
| API-006 | Slugs nicht kanonisch |
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

### P3 – Mittel (offen, geplant)

| ID | Problem |
|---|---|
| TECH-007 | Lockfile reproduzierbar? |
| PWA-001 | PWA-Plugin vs handgeschriebener Worker |
| PWA-002 | Manifest/Cache fragil |
| PWA-003 | Kein Offline/Reconnect |
| MEDIA-001 | Medien-Upload nicht end-to-end nachgewiesen |
