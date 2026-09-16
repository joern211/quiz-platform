# Online Quiz Plattform - Deployment Guide

## Inhaltsverzeichnis

1. [Voraussetzungen](#voraussetzungen)
2. [Lokale Entwicklung](#lokale-entwicklung)
3. [Docker Deployment](#docker-deployment)
4. [VPS/Server](#vpsserver)
5. [Cloud Platformen](#cloud-platformen)
6. [HTTPS & Domain](#https--domain)
7. [Backup & Restore](#backup--restore)

---

## Voraussetzungen

- **Node.js** 20+ (für lokale Entwicklung)
- **pnpm** 9+ 
- **Docker** & **Docker Compose** (für Container-Deployment)
- **Git**

### Node.js installieren (macOS)

```bash
# Mit Homebrew
brew install node@20

# Oder mit nvm
nvm install 20
nvm use 20
```

### pnpm installieren

```bash
npm install -g pnpm@9
```

---

## Lokale Entwicklung

### 1. Klonen & Installieren

```bash
git clone <repo-url>
cd online-quiz-plattform
pnpm install
```

### 2. Umgebung konfigurieren

```bash
cp .env.example .env
# .env bearbeiten mit sicheren Werten
```

### 3. Datenbank Setup

```bash
pnpm db:migrate
pnpm db:seed    # Optional: Demo-Daten
```

### 4. Starten

```bash
pnpm dev
```

Die App ist jetzt unter `http://localhost:5173` verfügbar.

### Verfügbare Scripts

| Script | Beschreibung |
|--------|--------------|
| `pnpm dev` | Startet Web & Server im Dev-Modus |
| `pnpm build` | Prod-Build für beide Apps |
| `pnpm start` | Startet Production-Server |
| `pnpm test` | Unit-Tests |
| `pnpm test:e2e` | End-to-End Tests |
| `pnpm db:migrate` | Datenbank-Migrationen |
| `pnpm db:seed` | Demo-Daten laden |
| `pnpm backup` | Backup erstellen |

---

## Docker Deployment

### Schnellstart

```bash
# Mit Docker Compose
docker-compose up -d

# Logs anzeigen
docker-compose logs -f app
```

### Angepasstes Docker Compose

```yaml
# docker-compose.override.yml
services:
  app:
    environment:
      - ADMIN_PASSWORD=your-secure-password
      - SESSION_SECRET=your-session-secret-min-32-chars
      - PUBLIC_APP_URL=https://your-domain.com
    ports:
      - "80:5173"  # HTTP
      # Oder für HTTPS:
      # - "443:5173"
```

### Daten sichern

Backups werden automatisch in `storage/backups/` erstellt.

```bash
# Manuell backup
docker-compose exec app pnpm backup

# Oder direkt
docker-compose exec app ./scripts/backup.sh
```

---

## VPS/Server

### 1. Server vorbereiten

```bash
# Als root
apt update && apt upgrade -y
apt install -y docker.io docker-compose git

# Docker starten
systemctl enable docker
systemctl start docker
```

### 2. Projekt installieren

```bash
# Als normaler User
git clone <repo-url> ~/quiz-platform
cd ~/quiz-platform

# Konfiguration
cp .env.example .env
nano .env  # Sichere Werte eintragen

# Starten
docker-compose up -d
```

### 3. Firewall konfigurieren

```bash
ufw allow 22    # SSH
ufw allow 80    # HTTP
ufw allow 443   # HTTPS
ufw enable
```

### 4. Auto-Start einrichten

```bash
# systemd service erstellen
sudo nano /etc/systemd/system/quiz-platform.service
```

```ini
[Unit]
Description=Online Quiz Platform
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/user/quiz-platform
ExecStart=/usr/local/bin/docker-compose up -d
ExecStop=/usr/local/bin/docker-compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable quiz-platform
sudo systemctl start quiz-platform
```

---

## Cloud Platformen

### Railway

```bash
# Railway CLI installieren
npm install -g @railway/cli

# Login
railway login

# Projekt initialisieren
railway init
railway up

# Variablen setzen
railway variables set SESSION_SECRET=your-secret
railway variables set ADMIN_PASSWORD=your-password
```

### Render

1. GitHub Repo verbinden
2. Build Command: `pnpm build`
3. Start Command: `pnpm start`
4. Umgebungsvariablen setzen

### Fly.io

```bash
# Fly CLI installieren
curl -L https://fly.io/install.sh | sh

# Login
fly auth login

# App erstellen
fly launch

# Secrets setzen
fly secrets set SESSION_SECRET=your-secret
fly secrets set ADMIN_PASSWORD=your-password

# Deploy
fly deploy
```

---

## HTTPS & Domain

### Option 1: Caddy (Automatisch HTTPS)

```yaml
# docker-compose.yml mit Caddy
services:
  app:
    # ... wie vorher

  caddy:
    image: caddy:2
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
    depends_on:
      - app

volumes:
  caddy_data:
```

```caddy
# Caddyfile
your-domain.com {
    reverse_proxy app:5173
}
```

### Option 2: Nginx + Let's Encrypt

```nginx
# /etc/nginx/sites-available/quiz
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:5173;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# SSL Zertifikat
apt install certbot python3-certbot-nginx
certbot --nginx -d your-domain.com
```

---

## Backup & Restore

### Automatisches Backup

Backups werden automatisch täglich erstellt (7 Tage Aufbewahrung).

### Manuell Backup

```bash
# Auf Server
./scripts/backup.sh

# Oder Docker
docker-compose exec app ./scripts/backup.sh
```

### Backup Restore

```bash
./scripts/restore.sh
```

### Remote Backup

```bash
# Mit rsync
rsync -avz user@server:/path/to/quiz-platform/storage/backups/ ./backups/

# Mit rclone (für S3, GCS, etc.)
rclone sync server:/backup/path/ local-backups/
```

---

## Troubleshooting

### App startet nicht

```bash
# Logs prüfen
docker-compose logs app

# Ports prüfen
netstat -tlnp | grep 5173
```

### Datenbank-Fehler

```bash
# Migration prüfen
docker-compose exec app npx prisma migrate status

# Reset (GEFAHR!)
docker-compose exec app npx prisma migrate reset
```

### WebSocket funktioniert nicht

- Prüfe ob `PUBLIC_APP_URL` korrekt gesetzt ist
- Prüfe Reverse Proxy WebSocket-Support

---

## Wartung

### Updates einspielen

```bash
git pull
docker-compose down
docker-compose build
docker-compose up -d
```

### Logs rotieren

```bash
# Docker
docker-compose logs --tail=100 > logs.txt

# Mit logrotate
sudo nano /etc/logrotate.d/quiz-platform
```

```text
/path/to/quiz-platform/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    notifempty
    create 0644 root root
}
```
