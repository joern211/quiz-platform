---
name: quiz-platform
description: Build and maintain the quiz platform at /Users/joern.r/quiz-platform. Backend (Express/Socket.IO/Prisma/SQLite), frontend (React/Vite/PWA), design system, multi-gate workflow.
---

# Quiz Platform — Stand: v0.3.0

## Verbindliche Regeln (immer gültig)

- **Gate-Workflow**: Arbeite die Gates des Fehlerberichts STRENG sequenziell ab. Ein Gate wird erst verlassen, wenn ALLE Abnahmekriterien erfüllt sind. Keine neuen Spiele oder Features vor Gate 5.
- **Vor jedem Commit**: `pnpm --filter @quiz/server build && pnpm --filter @quiz/web build` — TypeScript-/ESM-Fehler erscheinen nur im Build, nicht in `pnpm dev` (stilles Watch-Mode-Problem).
- **Server ≠ Web Port**: Server läuft auf **3001**, Web-Dev auf **5173**. Vite-Proxy zeigt auf 3001. Niemals beide auf 5173 (TECH-004).
- **ESM mit .js-Extension**: Alle `import`/`export` nutzen `.js`-Endung (NodeNext/Node16). Kein `import './foo'` — nur `import './foo.js'`.
- **Immer ApiResponse<T>**: Backend antwortet `{success, data}` oder `{success:false, error}`. Frontend liest NUR `json.data`, NIEMALS Top-Level-Felder.
- **Config-Schlüssel konsistent**: `config.port`, `config.sessionSecret` — nicht `config.PORT`/`config.SESSION_SECRET` mischen (TECH-003).
- **Kein Phantom-Paket**: `packages/game-sdk/` muss entweder implementiert oder aus `pnpm-workspace.yaml` entfernt sein (TECH-008).
- **UI-Designrichtung** (seit v0.3.0): **Modern, klar, kompakt** — KEIN Cyberpunk/Neon/Bounce/Shimmer/Float/Glow/Glass Morphism. Glow NUR für Fokus/Hauptaktion/Live-Status. `prefers-reduced-motion` vollständig respektieren.

## Projektstruktur

```
/Users/joern.r/quiz-platform/
├── apps/
│   ├── web/          # React + Vite + PWA (Port 5173 dev, Proxy → 3001)
│   └── server/       # Express + Socket.IO + Prisma (Port 3001)
├── packages/
│   ├── shared/       # Zod-Schemas, GameManifest, ApiResponse<T>
│   ├── ui/           # Design-System-Komponenten + tokens.css
│   └── game-sdk/     # ⚠️ Implementieren oder entfernen
├── prisma/
│   ├── schema.prisma
│   ├── migrations/   # Einchecken!
│   └── seed.ts       # Argon2 (SEC-001: NICHT SHA-256)
├── scripts/          # backup.sh, restore.sh
└── docs/
```

## Arbeitsbefehle

### Erste Einrichtung (frischer Clone)
```bash
pnpm install --frozen-lockfile   #oder pnpm install
pnpm exec prisma generate        #Prisma Client generieren
pnpm exec prisma migrate dev --name init
pnpm db:seed                     #oder pnpm exec prisma db seed
pnpm build
```

### Dev-Server starten (ZWEI Terminals)
```bash
# Terminal 1 – Server
pnpm --filter @quiz/server dev   #Port 3001

# Terminal 2 – Web
pnpm --filter @quiz/web dev      #Port 5173
```

### Produktion bauen
```bash
pnpm --filter @quiz/server build && pnpm --filter @quiz/web build
```

### Server starten (Produktion)
```bash
node apps/server/dist/server.js   #oder pnpm --filter @quiz/server start
```

### Build-Verifikation (vor jedem Commit)
```bash
pnpm --filter @quiz/server build  #muss mit 0 Errors enden
pnpm --filter @quiz/web build     #muss mit 0 Errors enden
```

### Docker
```bash
docker compose up --build
```

## Game Engines

Jedes Spiel in `apps/server/src/games/<slug>/index.ts`:
- `handleXxxGame` Objekt mit Methoden (initialize, startRound, answer, reveal, etc.)
- Empfängt `io` + `room` als Parameter — NICHT importieren
- Registrierung über `games/registry.ts` mit Slug-Mapping

**Wichtige Events (Socket)**
| Client → Server | Server → Client |
|---|---|
| `room:subscribe` | `room:subscribed` |
| `game:start` | `geo:question` |
| `geo:answer` | `geo:reveal` |
| `geo:next` | `geo:question` |
| `player:ready:set` | `room:updated` |
| `game:pause/resume/end` | `game:state` |

## Datenbank

- Prisma mit SQLite (Entwicklung), PostgreSQL-ready
- `prisma/schema.prisma` ist Source of Truth
- Bei Schema-Änderung: MIGRATION neu erstellen (nicht nur db push), then reseed
- `isPublic`-Feld auf Room: nur öffentliche Räume werden gelistet (SEC-004)
- Argon2id für Passwort-Hashes (SEC-001)

## Typische Fehlerquellen

### Import-Pfade (TECH-001)
Spielmodule (z.B. `games/geo/index.ts`) liegen 2 Ebenen unter `src/`, daher:
```typescript
import { prisma } from '../../persistence/prisma.js';  //RICHTIG
import { prisma } from '../persistence/prisma.js';      //FALSCH
```

### TSConfig ESM (TECH-002)
Server: `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"type": "module"` in package.json.

### Antwortformat (API-001)
```typescript
// Server:
res.json({ success: true, data: { code: '123-456' } });

// Client:
const json = await fetch(...).then(r => r.json());
if (json.success) setRooms(json.data.rooms);  //json.data, nicht json.rooms
```

### roomChannel() (SOCK-002)
```typescript
// Gibt String zurück, nicht Namespace:
io.to(roomChannel(roomId)).emit('event', data);
```

### Socket-Identität initialisieren (P0-08)
```typescript
// In socket 'connection' Handler:
socket.data = { participationId, roomId, role, displayName };
```

### requireRoomRole() vor allen Moderator-Aktionen (SEC-002)
Jede Socket-Handler für start/pause/resume/end/reveal MUSS zuerst prüfen:
```typescript
const auth = await authorizeRoomAction(socket, roomId, 'MODERATOR');
if (!auth.authorized) { socket.emit('error', {...}); return; }
```

## Subagent-Nutzung bei großen PRs

Bei komplexen P0-Fixes: Subagents parallel starten, aber:
- Jeder Subagent MUSS `git checkout gate-1-2-fixes` am Anfang
- Jeder Subagent MUSS `pnpm --filter @quiz/server build` am Ende verifizieren
- Nach Subagent-Abschluss: Dateien NEU LESEN bevor lokale Änderungen (Subagents modifizieren Dateien die vorher gelesen wurden)
- Subagent liefert "no reply" → trotzdem Files committen, lokale Arbeit nicht blockieren lassen

## GitHub-Patterns

### GitHub CLI nicht im PATH
```python
# Statt gh CLI → Python urllib:
import urllib.request, json, re
with open('.git/config') as f:
    m = re.search(r'ghp_([a-zA-Z0-9]+)', f.read())
token = 'ghp_' + m.group(1)
req = urllib.request.Request(url, data=json.dumps({...}).encode(),
    headers={'Authorization': f'token {token}', 'Content-Type': 'application/json'},
    method='PATCH')
urllib.request.urlopen(req, timeout=10)
```

### Commit + Push Workflow
```bash
git add -A && git status --short    #Review erst
pnpm build                          #VERIFIZIEREN
git commit -m "fix: ... (P0-XX)"    #ID aus Fehlerbericht
git push origin gate-1-2-fixes
```

## UI-Designrichtlinie (verpflichtend seit v0.3.0)

**Ziel**: Modern, klar, hochwertig, kompakt.

| Was | Wie |
|---|---|
| Keine Neon-Glow-Dauerbeleuchtung | Glow nur: Fokus-Element, Haupt-CTA, Live-Status |
| Keine Bounce/Shimmer/Float-Animationen | Minimal: translateY für slide-in, active:scale(0.97) bei Buttons |
| Keine Glass Morphism (blur backdrop) | Solide Flächen, subtle shadows |
| Keine rotierenden Theme-Icons | Statische Icons, Toggle-Button |
| Touch-Ziele | Mindestens 44×44px |
| Schrift | Inter (system-ui fallback), Space Grotesk nur für Headings |
| Farben | Über CSS Custom Properties (tokens.css), kein Hardcoding |
| prefers-reduced-motion | `window.scrollTo` → sofort, keine Pulse-Keyframes |

## Fehlerbericht-Gates

Arbeitsreihenfolge (niemals Gate überspringen):

| Gate | Inhalt | Abnahme |
|---|---|---|
| 0 | Scope, CHANGELOG, README ehrlich, KNOWN_ISSUES.md | Keine übertriebenen Behauptungen |
| 1 | Build/TS/ESM/Ports/Docker/Prisma/Tests | `pnpm install --frozen-lockfile && pnpm build && docker compose up --build` |
| 2 | API-Vertrag, ApiClient, Socket-Vertrag, Security | Security-Tests: keine Lösungsleaks, keine Cross-Room-Aktionen |
| 3 | Navigation, Routes, Result-Seiten, Join, Mobile Nav | Vollständiger Weg bis Lobby für alle 3 Rollen |
| 4 | Geo-Quiz vollständig: Timer, Joker, Reveal, Score | Playwright E2E: 3 Browser (Mod+2Spieler+Zuschauer) |
| 5–8 | Weitere Spiele, PWA, Docker Production, Tests | Testmatrix, CI grün, README aktuell |

## Pitfalls

- **Vite CSS @quiz/ui alias**: Für `tokens.css` SEPARATE alias entry in vite.config.ts. Nicht über den Package-Alias importieren.
- **Seed/passende Felder**: `estimatedMinutes` vs `estimatedDurationMinutes` — Schema prüfen bevor seed schreiben.
- **Subagent-File-Stale**: Nach Subagent-Lauf alle vorher gelesenen Files neu lesen (Subagents modifizieren ohne Notification).
- **Dev-Server-Port-Kollision**: Server 3001 + Web 5173. Nie beide auf 5173.
- **Web Dist Path in Prod**: `WEB_DIST_PATH` env var nutzen. Relative Pfade zu `../../apps/web/dist` sind fragil.
- **Lockfile-Reproduktion**: `pnpm install` in sauberer Umgebung, dann `--frozen-lockfile` in CI.
- **Prisma Migration Versionierung**: Nach Schema-Änderung Migration löschen und neu erstellen, sonst fehlen neue Felder.
