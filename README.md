# Online Quiz Plattform

⚠️ **Prototyp v0.3.0 – nur Geo-Quiz ist vollständig spielbar**

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
| **Geo-Quiz** | Multiple Choice mit Joker (50/50, Spy, Risk) | ✅ VOLLSTÄNDIG SPIELBAR |
| **Jeopardy** | 2 Boards, Abstauber | 🔶 IN ARBEIT |
| **Wer ist das?** | Fusionbilder erkennen | 🔶 GEPLANT |
| **Timeline** | Elemente einordnen | 🔶 GEPLANT |
| **Wer lügt am besten?** | Lügen & Abstimmung | 🔶 GEPLANT |
| **Erkenne den Song** | Musik-Buzzer | 🔶 GEPLANT |

Nur Geo-Quiz ist derzeit end-to-end spielbar. Andere Spiele sind Konzept-Scaffolds.

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

### 5. Datenbank seeden (optional, für Demo-Accounts)

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
pnpm start
```

### 8. Web Dev Server starten (optional, für Hot-Reload-Entwicklung)

```bash
pnpm dev
```

- Server läuft auf: `http://localhost:3001`
- Web Dev Server läuft auf: `http://localhost:5173` (proxied → 3001)

---

## 🐳 Docker

### Mit Docker Compose

```bash
# .env erstellen mit sicheren Secrets
cp .env.example .env

# SESSION_SECRET setzen (min. 32 Zeichen, zufällig)
# ADMIN_PASSWORD setzen (sicheres Passwort für Admin-Zugang)

# Container bauen und starten
docker-compose up --build -d

# Logs anzeigen
docker-compose logs -f

# Öffnen
open http://localhost:3001
```

### Docker Setup-Hinweise

1. **SESSION_SECRET** muss in `.env` gesetzt werden (min. 32 Zeichen!)
2. **ADMIN_PASSWORD** muss in `.env` gesetzt werden
3. Die Datenbank liegt in einem Volume (`quiz-data`)
4. Nach dem ersten Start: `docker-compose exec app pnpm db:seed` für Demo-Accounts

⚠️ **Dies ist ein Entwicklungs-Container. Für Produktion müssen weitere Sicherheitsmaßnahmen ergriffen werden (HTTPS, Firewall, etc.).**

---

## 👤 Demo-Accounts

### Moderator

```
E-Mail:    moderator@example.com
Passwort:  secret
```

⚠️ **Nur für lokale Entwicklung/Tests. Niemals in Produktion verwenden!**

### So nutzt man den Demo-Account

1. Starte Server (oder Docker)
2. Öffne `http://localhost:3001`
3. Klicke "Moderator Login" oder navigiere zu `/admin`
4. Login mit den obigen Zugangsdaten
5. Erstelle einen Geo-Quiz-Raum und starte ein Spiel

---

## ⚠️ Bekannte Einschränkungen

- **Nur Geo-Quiz spielbar**: Alle anderen Spiele sind Konzept-Scaffolds
- **SQLite Datenbank**: Nicht geeignet für horizontale Skalierung
- **Kein HTTPS**: Für Produktion muss ein Reverse Proxy mit TLS konfiguriert werden
- **Demo-Passwörter**: secret / admin123 nur für lokale Entwicklung
- **Docker-Volume**: Bei Verwendung von Docker Compose liegen Daten im Volume `quiz-data`
- **Keine E-Mail-Verifikation**: Passwort-Reset ohne echte E-Mail-Infrastruktur

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
| `ADMIN_USERNAME` | `admin` | Admin Benutzername |
| `ADMIN_PASSWORD` | - | Admin Passwort (DEV!) |
| `PUBLIC_APP_URL` | `http://localhost:3001` | Öffentliche URL |

---

## 💾 Backup & Restore

### Backup erstellen

```bash
# Automatisches Backup (erstellt timestamp-basiertes Backup)
pnpm backup

# Mit benutzerdefiniertem Pfad
BACKUP_DIR=./storage/backups pnpm backup
```

### Restore durchführen

```bash
# Interaktiver Restore (zeigt verfügbare Backups)
pnpm restore

# Mit benutzerdefiniertem Pfad
BACKUP_DIR=./storage/backups pnpm restore
```

### Docker Backup

```bash
# Backup im Container erstellen
docker-compose exec app bash -c "pnpm backup"

# Backups auf Host kopieren
docker cp quiz-platform-app-1:/app/storage/backups ./host-backups/
```

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

# Starten (Production)
pnpm start

# Oder mit Docker
docker-compose up -d
```

### ngrok (Temporär für Tests)

```bash
# Server starten
pnpm start

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
