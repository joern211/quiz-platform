# Online Quiz Plattform - Architecture Decision Records

## ADR-001: Monorepo mit pnpm Workspaces

**Status:** Akzeptiert  
**Datum:** 2026-09-16

### Kontext
Wir brauchen eine klare Struktur für Frontend, Backend und gemeinsame Pakete.

### Entscheidung
pnpm Workspaces mit folgender Struktur:
- `apps/web` - React PWA
- `apps/server` - Node.js Backend
- `packages/shared` - Typen & Schemas
- `packages/ui` - Design System
- `packages/game-sdk` - Spiel-Engine Vertrag

### Konsequenzen
- Gemeinsame Abhängigkeiten werden effizient geteilt
- TypeScript-Projekte können direkt aufeinander verweisen
- Build-Reihenfolge ist klar definiert

---

## ADR-002: SQLite als Primärdatenbank

**Status:** Akzeptiert  
**Datum:** 2026-09-16

### Kontext
Für private Installationen brauchen wir eine einfache, dateibasierte Datenbank.

### Entscheidung
- SQLite für v1 (EinzeInutzer/ kleiner Server)
- Prisma als ORM
- PostgreSQL-Migration vorbereitet

### Konsequenzen
- Keine externe DB nötig für einfache Installationen
- Einfaches Backup (Datei kopieren)
- PostgreSQL bei Skalierung möglich ohne Code-Änderung

---

## ADR-003: Server als einzige Spielautorität

**Status:** Akzeptiert  
**Datum:** 2026-09-16

### Kontext
Clients könnten manipuliert werden, Punkte oder Timer falsch berechnen.

### Entscheidung
- Server verwaltet alle Spielzustände
- Clients senden nur Absichten
- Timer, Buzzer, Punkte werden serverseitig berechnet
- Clients erhalten Projektion ohne Geheimnisse

### Konsequenzen
- Keine Cheating-Möglichkeit über Client
- Konsistenter Zustand über alle Clients
- Etwas mehr Server-Last

---

## ADR-004: NNN-NNN Raumcodes

**Status:** Akzeptiert  
**Datum:** 2026-09-16

### Kontext
Raumcodes müssen eindeutig, leicht teilbar und kollisionsfrei sein.

### Entscheidung
- Format: `^\d{3}-\d{3}$` (z.B. `123-456`)
- Führende Nullen erlaubt
- Kryptografisch sicherer Zufall auf Server
- 30 Tage Sperrfrist für archivierte Codes

### Konsequenzen
- 999.999 mögliche Codes
- Leicht vorlesbar und eingebbar
- Keine Verwechslung mit alphanumerischen Codes

---

## ADR-005: Design Token System

**Status:** Akzeptiert  
**Datum:** 2026-09-16

### Kontext
Wir brauchen ein konsistentes Design mit Dark/Light Theme.

### Entscheidung
CSS Custom Properties mit folgendem System:

**Dark Theme:**
- Background: `#0e1116`
- Surface: `#0b1220`
- Accent: `#1dd4d4` (Cyan)

**Light Theme:**
- Background: `#ffffff`
- Surface: `#f7f7fb`
- Accent: `#a78bfa` (Lila)

### Konsequenzen
- Einfaches Theme-Switching
- Konsistente Farben überall
- Leicht erweiterbar

---

## ADR-006: Socket.IO für Echtzeit

**Status:** Akzeptiert  
**Datum:** 2026-09-16

### Kontext
Wir brauchen Echtzeit-Updates für Lobby, Spielzustände, Timer.

### Entscheidung
- Socket.IO über WebSocket
- Same-Origin (relative URLs)
- HTTP-only Session-Cookie Auth
- Typed Events mit gemeinsamen Schemas

### Konsequenzen
- Zuverlässige Verbindung mit Auto-Reconnect
- Fallback zu Long-Polling
- Einfache Auth-Integration

---

## ADR-007: Spiel-Engine Interface

**Status:** Akzeptiert  
**Datum:** 2026-09-16

### Kontext
Wir haben mehrere Spiele mit unterschiedlicher Logik.

### Entscheidung
Ein gemeinsames Interface:
```typescript
interface GameModule {
  manifest: GameManifest;
  setupSchema: ZodSchema;
  createInitialState(): State;
  handleCommand(ctx, state, cmd): TransitionResult;
  projectState(state, role): PublicState;
  serialize/deserialize: State;
}
```

### Konsequenzen
- Spiele sind isoliert und testbar
- Neue Spiele können einfach hinzugefügt werden
- Server kann Spiele dynamisch laden
