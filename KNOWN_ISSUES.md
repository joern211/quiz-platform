# Known Issues — v0.2.1

> Dokumentation aller bekannten Fehler (nach Gate 1+2+3 behoben).
> Gefixt = in diesem PR behoben. Offen = für Gate 4+.

---

## ✅ In diesem PR behoben (Gate 1+2+3)

| ID | Problem | Fix |
|---|---|---|
| TECH-001 | Spielmodule: falsche relative Importpfade zu Prisma/Logger | Importpfade auf `../../persistence/prisma.js` korrigiert |
| TECH-002 | Server: ESM/TypeScript-Widerspruch | `NodeNext`, `type: module`, Build `tsc` |
| TECH-003 | Config: PORT vs port gemischt | Normalisierte Config + PORT=3001 |
| TECH-004 | Dev-Ports: Vite + Server auf 5173 kollidiert | Server: 3001, Vite-Proxy: 3001 |
| TECH-005 | Produktionspfad zum Web-Build falsch | `WEB_DIST_PATH` Env-Variable + smarter Fallback |
| TECH-006 | Docker Multi-Stage-Build fehlerhaft | Multi-Stage korrigiert, Server-Port 3001, Nicht-Root-User |
| TECH-007 | Lockfile nicht reproduzierbar (jsdom/dotenv fehlen) | Beide installiert |
| TECH-009 | Keine Migrationen | `prisma migrate dev --name init` ausgeführt |
| QA-001 | TypeScript: keine JSX-Konfiguration, CSS-Module fehlen | `jsx: react-jsx`, CSS-Module .d.ts deklariert |
| QA-002 | Unit-Tests: jsdom fehlt | jsdom `^25.0.0` in devDependencies |
| API-001 | HTTP: Frontend liest `data.rooms` statt `json.data.rooms` | `ApiResponse<T>` in `lib/api.ts` |
| API-002 | Frontend sendet `gameSlug`, Server erwartet `gameDefinitionId` | Server löst `gameSlug` → `gameDefinitionId` auf |
| API-003 | Spielerbeitritt: displayName fehlt, rejoinTokenVersion fehlt | Beides in Join-Endpoint ergänzt |
| API-004 | Öffentliche Räume nicht modelliert | `isPublic Boolean @default(true)` in Room |
| SEC-001 | Seed: SHA-256, Login: Argon2 | Seed auf Argon2id umgestellt |
| SEC-002 | Socket: keine Moderator-Autorisierung | `requireRoomRole()` Middleware |
| SEC-004 | Disconnect: keine Socket→Participation-Zuordnung | `SocketIdentity` Typ |
| SEC-005 | Math.random() für Raumcodes | `crypto.randomInt` |
| SEC-007 | Zod-Validierung nicht durchgängig | `http/middleware/validation.ts` |
| SOCK-001 | Client sendet nicht registrierte Events | Typisierte Socket-Events in `lib/socket.ts` |
| FLOW-001 | Zuschauer-Redirect-Schleife (`/zuschauen`) | Eigenständige Viewer-Routen für alle Phasen |
| FLOW-002 | Ergebnisrouten fehlen | Moderator/Player/ViewerResultPage + Routen registriert |
| FLOW-004 | Join: falsche Response-Parsing, kein prefill | `ApiResponse<T>`, RoomCode-Format, prefill von state |
| FLOW-005 | Mobile Navigation unsichtbar | Hamburger-Menü mit Slide-in Drawer, Fokus-Trap, Escape |
| FLOW-006 | Kein „Zurück zum Raum" | Aktiver Raum-Code aus localStorage im Header |
| TYPING-001 | 'AVANNING' → 'PLANNED' in Timeline-Manifest | Gefixt |
| VERSION-001 | Health 0.1.0 statt 0.2.1 | Gefixt |
| ENV-001 | .env.example WEB_DIST_PATH fehlt | Ergänzt |
| LOGGER-001 | config.LOG_LEVEL statt config.logLevel | Gefixt |
| MANIFEST-001 | hasCamera in Allgemeinwissen fehlt | Ergänzt |
| SEED-001 | estimatedMinutes/tags in seed falsch | `estimatedDurationMinutes`, tags als String[] |
| SEED-002 | INITIAL_ADMIN_PASSWORD bereits korrekt | Verified |

---

## 🔶 Noch offen (Gate 4–7)

### UI (Gate 4 — P1/P2)
| ID | Problem | P |
|---|---|---|
| UI-001 | Cyberpunk/Neon/Bounce-Effekte zu viel | P1 |
| UI-002 | Light Theme nicht systematisch (Header Hardcoded Dark) | P1 |
| UI-003 | Überladene Kartenhierarchie | P2 |
| UI-004 | Card semantisch nur ein div, whole-card klickbar aber Tastatur | P1 |
| UI-005 | InfoPopup: keine Fokusverwaltung, kein Escape | P2 |
| UI-006 | Modal: unvollständige Barrierefreiheit | P2 |
| UI-007 | Status nicht assistiv (aria-live) | P2 |
| UI-008 | HomePage: falscher Text, erfundene Zahlen | P1 |
| UI-009 | Inline-Styles in HomePage | P2 |
| UI-010 | Externe Google Fonts (Datenschutz + Offline) | P3 |
| UI-011 | Smooth scroll ignoriert Reduced Motion | P3 |
| UI-012 | Rolle/CTA-Hierarchie nicht eindeutig | P2 |

### Games (Gate 5 — P0/P1)
| ID | Problem | P |
|---|---|---|
| GAME-001 | Nur Geo hat vollständige UI; andere als BETA/PLANNED | P0 |
| GAME-002 | Engines: Zustände teilweise in In-Memory Maps | P0 |
| GAME-003 | Rollenprojektionen: Lösungslecks drohen | P0 |
| GAME-004 | Spieleransicht: keine PlayerBar/Rang in allen Phasen | P1 |
| GAME-005 | 50:50: Buchstaben nach Filterung neu nummeriert | P1 |
| GAME-006 | Spy-Joker: keine nutzbare Auswertung | P2 |
| GAME-007 | Max 4 Kameras nicht serverseitig durchgesetzt | P1 |
| GAME-008 | Spielfläche nicht konsistent | P2 |

### Socket (Gate 5 — P0/P1)
| ID | Problem | P |
|---|---|---|
| SOCK-002 | Engines senden an falsche Socket-Räume | P0 |
| SOCK-003 | Registry nicht ausführbar (fehlende Engine-Exports) | P0 |
| SOCK-004 | Moderator-Lobby: Raum schließen, Kick, QR-Code fehlen | P1 |
| SOCK-005 | Chat-Sperre missbraucht Spielzustand | P1 |
| SOCK-006 | Bereitschaft/Beteiligung falsch ermittelt | P1 |

### Flow (Gate 3+ — P1)
| ID | Problem | P |
|---|---|---|
| FLOW-003 | GeoSetupPage/JeopardySetupPage unerreichbar | P1 |
| FLOW-004 | Profil-/AV-Weg nicht vollständig (Kamera/Geräte wählen) | P1 |
| FLOW-007 | Direkte Reloads nicht robust (Resync nach Reload) | P1 |

### API/Security (Gate 2+ — P0/P1)
| ID | Problem | P |
|---|---|---|
| SEC-003 | Raumabonnement nicht ausreichend geschützt | P0 |
| SEC-006 | CSRF/Cookie-Schutz nicht nachgewiesen | P1 |
| SEC-008 | Unsicheres Default-Secret bei Produktion | P1 |
| API-005 | Raumliste nicht live (keine Socket-Updates) | P1 |
| API-006 | Slugs nicht kanonisch (verschiedene Schreibweisen) | P1 |

### Katalog/Inhalte (Gate 3+ — P1/P2)
| ID | Problem | P |
|---|---|---|
| CAT-001 | Drei widersprüchliche Katalogquellen | P1 |
| CAT-002 | Erfundene Spielzahlen | P1 |
| CAT-003 | Mock-API mit 300ms Timeout statt echte Anfrage | P2 |
| CAT-004 | Info-Karten: unvollständige Regeln (3–5 Regeln fehlen) | P2 |

### PWA/Medien (Gate 7 — P2)
| ID | Problem | P |
|---|---|---|
| PWA-001 | PWA-Plugin nicht konfiguriert | P2 |
| PWA-002 | Manifest/Cache fragil | P2 |
| PWA-003 | Kein Offline/Reconnect-Kommunikation | P2 |
| MEDIA-001 | Medien-Upload nicht end-to-end getestet | P1 |

### Sonstiges
| ID | Problem | P |
|---|---|---|
| SOCKET-002 | handleRoomSubscription .then() return | P2 |
| QA-003 | E2E: kein Multiplayer-Ablauf, kein 3-Browser-Test | P1 |
| REGISTRY-002 | Jeopardy/Timeline/Song/Luegen/Weristdas sind Stubs | P2 |

---

## Nächste Schritte

| Gate | Inhalt | Priorität |
|------|--------|-----------|
| **Gate 4** | UI-System: Dark/Light Tokens, Cyberpunk-Effekte abbauen, Zugänglichkeit, Light Theme auf jeder Route | P1 |
| **Gate 5** | Geo als vollständiger vertikaler Schnitt — Playwright E2E mit 3 Browsern (Moderator/Spieler/Zuschauer) | P0 |
| **Gate 6** | Jeopardy → Wer ist das? → Timeline → Wer lügt? → Erkenne den Song (je BETA → AVAILABLE) | P1 |
| **Gate 7** | PWA, Docker-Production, Backup/Restore, Deployment-Doku | P2 |
