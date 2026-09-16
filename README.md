# Online Quiz Plattform

⚠️ **Prototyp – noch nicht produktionsreif**

![Version](https://img.shields.io/badge/version-0.3.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-20+-green)

**Repository:** [https://github.com/joern211/quiz-platform](https://github.com/joern211/quiz-platform)

---

## 🎯 Überblick

Die Online Quiz Plattform ist eine **moderne React/TypeScript PWA** mit Node.js/Express/Socket.IO Backend. Spiele mit Freunden über einen Link - kein Download erforderlich.

### Kernfeatures

- 📱 **PWA** - Auf Handy & Desktop installierbar
- 🎮 **Mehrspieler-Spiele** - Aktuell: Geo-Quiz (spielbar)
- 👥 **Multiplayer** - Bis 10 Spieler, 50 Zuschauer
- 🎯 **Moderator-System** - Eigene Räume erstellen und verwalten
- 🌙 **Dark/Light Theme** - Cyan Dark & Lila Light
- 💾 **Persistenz** - SQLite Datenbank
- 🐳 **Docker** - Container-Deployment möglich

---

## 🎮 Spiele

⚠️ **Status:**

| Spiel | Beschreibung | Status |
|-------|--------------|--------|
| **Geo-Quiz** | Multiple Choice mit Joker (50/50, Spy, Risk) | 🔶 BETA – spielbar |
| **Jeopardy** | 2 Boards, Abstauber | 🔶 PLANNED |
| **Wer ist das?** | Fusionbilder erkennen | 🔶 PLANNED |
| **Timeline** | Elemente einordnen | 🔶 PLANNED |
| **Wer lügt am besten?** | Lügen & Abstimmung | 🔶 PLANNED |
| **Erkenne den Song** | Musik-Buzzer | 🔶 PLANNED |

Nur Geo-Quiz ist derzeit end-to-end spielbar. Andere Spiele sind Engine-Scaffolds.

---

## 🚀 Setup

### Voraussetzungen

- Node.js 20+
- pnpm 9+
- (Docker für Container-Deployment)

### 1. Klonen

```bash
git clone https://github.com/joern211/quiz-platform.git
cd quiz-platform
```

### 2. Abhängigkeiten installieren

```bash
pnpm install --frozen-lockfile
```

### 3. Prisma Client generieren

```bash
pnpm db:generate
```

### 4. Datenbank migrieren

```bash
pnpm db:migrate:deploy
```

### 5. Datenbank seeden (optional)

```bash
pnpm db:seed
```

> Dies erstellt Demo-Accounts (siehe unten).

### 6. Web-App bauen (für Produktion/Server)

```bash
pnpm build
```

### 7. Server starten

```bash
pnpm --filter @quiz/server run
```

### 8. Web Dev Server starten (für Entwicklung)

```bash
pnpm --filter @quiz/web dev
```

- Server läuft auf: `http://localhost:3001`
- Web Dev Server läuft auf: `http://localhost:5173` (proxied → 3001)

---

## 🐳 Docker

### Mit Docker Compose

```bash
# .env erstellen mit SESSION_SECRET
cp .env.example .env
# SESSION_SECRET setzen (min. 32 Zeichen)

# Container starten
docker-compose up --build

# Öffnen
open http://localhost:3001
```

### Hinweise zu Docker

- **Initial Admin Passwort:** `secret` (DEV ONLY – in Produktion ändern!)
- **Dockerfile** verwendet Multi-Stage-Build mit `prisma generate`
- **SESSION_SECRET** muss in `.env` gesetzt werden vor dem Start
- Die Datenbank liegt in einem Volume (`quiz-data`)

⚠️ **Dies ist ein Entwicklungs-Container. Für Produktion müssen weitere Sicherheitsmaßnahmen ergriffen werden (HTTPS, etc.).**

---

## 👤 Demo-Account

### Moderator

```
E-Mail:    moderator@example.com
Passwort:  secret
```

⚠️ **Nur für lokale Entwicklung/Tests. Niemals in Produktion verwenden!**

### So nutzt man den Demo-Account

1. Starte Server und Web (oder Docker)
2. Öffne `http://localhost:3001`
3. Klicke "Moderator Login" oder navigiere zu `/admin`
4. Login mit den obigen Zugangsdaten
5. Erstelle einen Geo-Quiz-Raum und starte ein Spiel

---

## 📁 Projektstruktur

```
quiz-platform/
├── apps/
│   ├── web/              # React PWA (Vite)
│   └── server/           # Node.js Backend (Express + Socket.IO)
├── packages/
│   ├── shared/           # Gemeinsame Typen & Schemas
│   ├── ui/               # Design System
│   ├── game-sdk/         # Spiel-Engine Interface
│   └── test-utils/       # Test-Helfer
├── prisma/
│   ├── schema.prisma     # Datenbankschema
│   ├── seed.ts           # Demo-Daten
│   └── migrations/       # Versionierte Migrationen
├── scripts/
│   ├── backup.sh         # Backup-Skript
│   └── restore.sh        # Restore-Skript
└── storage/
    └── database/         # SQLite-Datenbank
```

---

## 🔧 Konfiguration

### Umgebungsvariablen

Kopiere `.env.example` nach `.env`:

```bash
cp .env.example .env
```

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `PORT` | `3001` | Server Port |
| `DATABASE_URL` | `file:./storage/database/quiz.db` | SQLite Pfad |
| `SESSION_SECRET` | - | Session Geheimnis (min. 32 Zeichen!) |
| `INITIAL_ADMIN_PASSWORD` | `secret` | Initiales Admin Passwort (DEV!) |
| `PUBLIC_APP_URL` | `http://localhost:3001` | Öffentliche URL |

---

## 🧪 Tests

```bash
# TypeScript Check
pnpm typecheck

# Server Tests
pnpm --filter @quiz/server test

# Web Tests
pnpm --filter @quiz/web test

# E2E Tests (Playwright)
pnpm test:e2e
```

---

## 📦 Deployment

### Railway

```bash
railway login
railway init
railway up
```

### VPS/Server

```bash
# Bauen
pnpm build

# Starten
docker-compose up -d
```

### ngrok (Temporär für Tests)

```bash
# Server starten
pnpm --filter @quiz/server run

# In neuem Terminal
ngrok http 3001
```

---

## 🔐 Sicherheit

- ✅ Argon2id Passwort-Hashing
- ✅ HTTP-only Session Cookies
- ✅ Serverseitige Spielautorität
- ✅ Rate-Limiting
- ✅ Input-Validierung (Zod)

⚠️ **Hinweis**: Dies ist ein Prototyp. Für Produktion müssen weitere Maßnahmen implementiert werden (HTTPS, CSRF-Protection, etc.).

---

## 📝 Lizenz

MIT License

---

## 🙏 Danke

- [Socket.IO](https://socket.io/) - Echtzeitkommunikation
- [Prisma](https://prisma.io/) - Datenbank-ORM
- [Radix UI](https://radix-ui.com/) - Accessibility Komponenten
- [Vite](https://vitejs.dev/) - Build Tool
