# Online Quiz Plattform

**Eine moderne Spieleplattform für Freundesgruppen**

![Version](https://img.shields.io/badge/version-0.2.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-20+-green)

## 🎯 Überblick

Die Online Quiz Plattform ist eine **moderne React/TypeScript PWA** mit Node.js/Express/Socket.IO Backend. Spiele mit Freunden über einen Link - kein Download erforderlich.

### Kernfeatures

- 📱 **PWA** - Auf Handy & Desktop installierbar
- 🎮 **6 Kernspiele** - Geo-Quiz, Jeopardy, Wer ist das?, Timeline, Wer lügt am besten?, Erkenne den Song
- 👥 **Multiplayer** - Bis 10 Spieler, 50 Zuschauer
- 🎯 **Moderator-System** - Eigene Räume erstellen und verwalten
- 🌙 **Dark/Light Theme** - Cyan Dark & Lila Light
- 💾 **Persistenz** - SQLite Datenbank, automatische Backups
- 🐳 **Docker** - Sofort einsatzbereit

## 🚀 Schnellstart

### Option 1: Docker (Empfohlen)

```bash
# Klonen
git clone https://github.com/your-username/online-quiz-plattform.git
cd online-quiz-plattform

# Starten
docker-compose up -d

# Öffnen
open http://localhost:5173
```

### Option 2: Lokale Entwicklung

```bash
# Abhängigkeiten installieren
pnpm install

# Datenbank migrieren
pnpm db:migrate

# Starten
pnpm dev
```

## 📁 Projektstruktur

```
online-quiz-plattform/
├── apps/
│   ├── web/              # React PWA
│   └── server/           # Node.js Backend
├── packages/
│   ├── shared/           # Gemeinsame Typen & Schemas
│   ├── ui/               # Design System
│   └── game-sdk/         # Spiel-Engine Vertrag
├── prisma/
│   └── schema.prisma     # Datenbankschema
├── scripts/
│   ├── backup.sh         # Backup-Skript
│   └── restore.sh        # Restore-Skript
└── storage/              # Daten & Uploads
```

## 🎮 Spiele

| Spiel | Beschreibung | Status |
|-------|--------------|--------|
| **Geo-Quiz** | Multiple Choice mit Joker | ✅ Komplett |
| **Jeopardy** | 2 Boards, Abstauber | ✅ Komplett |
| **Wer ist das?** | Fusionbilder erkennen | ✅ Komplett |
| **Timeline** | Elemente einordnen | ✅ Komplett |
| **Wer lügt am besten?** | Lügen & Abstimmung | ✅ Komplett |
| **Erkenne den Song** | Musik-Buzzer | ✅ Komplett |

Mehr Spiele folgen in späteren Versionen.

## 🔧 Konfiguration

Kopiere `.env.example` nach `.env` und passe an:

```bash
cp .env.example .env
```

### Wichtige Variablen

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `PORT` | `5173` | Server Port |
| `DATABASE_URL` | `file:./storage/database/quiz.db` | SQLite Pfad |
| `SESSION_SECRET` | - | Session Geheimnis (Pflicht!) |
| `ADMIN_PASSWORD` | `admin123` | Initiales Admin Passwort |

## 🧪 Tests

```bash
# Alle Tests
pnpm test

# E2E Tests
pnpm test:e2e

# TypeScript Check
pnpm typecheck
```

## 📦 Deployment

### Railway

```bash
# Mit Railway CLI
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

### ngrok (Temporär)

```bash
# Server starten
pnpm start

# In neuem Terminal
ngrok http 5173
```

## 🔐 Sicherheit

- ✅ Argon2id Passwort-Hashing
- ✅ HTTP-only Session Cookies
- ✅ Serverseitige Spielautorität
- ✅ Rate-Limiting
- ✅ Input-Validierung (Zod)
- ✅ CSRF-Schutz

## 📝 Lizenz

MIT License - frei für eigene Projekte.

## 🙏 Danke

- [Socket.IO](https://socket.io/) - Echtzeitkommunikation
- [Prisma](https://prisma.io/) - Datenbank-ORM
- [Radix UI](https://radix-ui.com/) - Accessibility Komponenten
- [Vite](https://vitejs.dev/) - Build Tool
