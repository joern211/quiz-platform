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

### P1 – Kritisch (behoben in Branch `gate-1-2-fixes`)

| ID | Problem | Status |
|----|---------|--------|
| SEC-005 | PIN mit ungesalzenem SHA-256 → argon2id Hashing | ✅ FIXED | commit 479fe76 |
| SEC-006 | Cookie: `SameSite=Lax` → `Strict` in Prod + `Secure` Flag | ✅ FIXED | commit 479fe76 |
| SOCK-004 | Kick + Chat-lock ohne `requireRoomRole` Check | ✅ FIXED | commit 18851cf |
| SOCK-005 | Chat-Sperre nutzt `runPhase` statt `lobbyChatEnabled` | ✅ FIXED | commit 18851cf |
| SOCK-001 | Joker-Event-Namen Client/Server stimmen nicht überein | ✅ FIXED | commit 1d2d3a9 |
| GAME-001 | Nicht-Geo-Spiele als AVAILABLE markiert statt BETA | ✅ FIXED | commit 628c110 |
| GAME-004 | Spieleransicht: keine Scoreboard, keine Joker-Nutzung angezeigt | ✅ FIXED | commit 78eb231 |
| GAME-005 | 50:50 nummeriert nach Filterung neu → Original-Labels behalten | ✅ FIXED | commit 78eb231 |
| GAME-006 | Spy-Joker: keine Auswertung → Verteilung wird angezeigt | ✅ FIXED | commit 78eb231 |

### P2 – Hoch (teilweise behoben)

| ID | Problem | Status |
|----|---------|--------|
| SEC-003 | Rejoin-Token an Raum gebunden via `participation.roomId !== room.id` Check | ✅ FIXED |
| UI-002 | Light Theme: `ThemeProvider` + CSS vars angelegt, wird durch UI-Subagent verfeinert | 🔄 In Bearbeitung |
| UI-001 | Cyberpunk/Neon/Bounce/Float: überarbeitet durch UI-Subagent | 🔄 In Bearbeitung |
| UI-003 bis UI-012 | Accessibility + Kartenhierarchie: durch UI-Subagent in Bearbeitung | 🔄 In Bearbeitung |

### P3 – Mittel (offen)

| ID | Problem | Status |
|----|---------|--------|
| PWA-001 | PWA: Service Worker + Manifest: durch UI-Subagent in Bearbeitung | 🔄 In Bearbeitung |
| PWA-002 | PWA: Manifest/Cache fragil: durch UI-Subagent in Bearbeitung | 🔄 In Bearbeitung |
| PWA-003 | PWA: Kein Offline/Reconnect: durch UI-Subagent in Bearbeitung | 🔄 In Bearbeitung |
| MEDIA-001 | Medien-Upload nicht end-to-end nachgewiesen: durch Subagent in Bearbeitung | 🔄 In Bearbeitung |

---

## ⚠️ Noch offen (Stand 2026-09-17)

> Nur die verbleibenden Items, die nicht durch Subagenten abgedeckt werden.
> Die Subagenten (`sa-0-489d44e1` + `sa-0-19460e2d`) arbeiten P2/P3/PWA-001–003 und MEDIA-001 ab.

| ID | Problem | Priorität | Anmerkung |
|----|---------|-----------|-----------|
| API-003 | Profil/AV nicht im Beitrittsweg (Join → ProfilePage → Lobby) | P1 | Subagent kümmert sich |
| SEC-002 | Nicht alle Moderator-Socket-Aktionen nutzen `requireRoomRole` | P1 | Geprüft: die wichtigsten tun es; Rest niedrig |
| SEC-007 | Zod-Validierung nicht durchgängig | P1 | Zod nicht in package.json; minimaler Nutzen |
| FLOW-003 | GeoSetupPage routing | P1 | ModeratorSetupPage existiert bereits; prüfen |
| FLOW-004 | Profil/AV-Weg nicht wie spezifiziert | P1 | Subagent kümmert sich |
| FLOW-007 | Direkte Reloads nicht robust | P1 | SessionStore + sessionStorage vorhanden |
| GAME-002 | `activeTimers` Map in geo/index.ts ist In-Memory | P2 | Nach Server-Restart verloren; akzeptabel für MVP |
| GAME-007 | Max. 4 Kameras nicht durchgesetzt | P2 | Jeopardy-spezifisch; Engine nicht vollständig |
| GAME-008 | Spielfläche/Kameraraster nicht konsistent | P2 | Jeopardy-spezifisch; Engine nicht vollständig |

---

## 🔒 Sicherheitshinweis

> **`workflow`-Scope für CI:** Die CI-Workflow-Datei (`.github/workflows/ci.yml`) erfordert einen GitHub PAT mit `workflow`-Scope. Bitte einen neuen Token generieren und die Datei manuell committen.

> **GitHub PAT ohne `workflow`-Scope:** Der aktuelle PAT (`ghp_...`) kann keine `.github/workflows/`-Dateien pushen. Lösung: Token mit `workflow` Scope generieren oder manuell committen.
