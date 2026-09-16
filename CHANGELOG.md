# Changelog

Alle wesentlichen Änderungen werden hier dokumentiert.

## [0.1.0] - 2026-09-16

### Hinzugefügt

- **Projektstruktur**: Monorepo mit pnpm Workspaces
- **packages/shared**: Gemeinsame Typen, Zod-Schemas, Event-Envelopes
- **packages/ui**: Design System mit Dark/Light Theme (Cyan/Lila)
- **packages/game-sdk**: Spiel-Engine Interface
- **Prisma Schema**: User, Room, Participation, MediaAsset, Quiz-Modelle
- **Backend**: Express + Socket.IO + TypeScript
- **Frontend**: React + Vite + PWA
- **Auth**: Moderator-Login mit Argon2id und HTTP-only Sessions
- **Geo-Quiz**: Vollständige Engine mit Timer, Joker, Reveal
- **Jeopardy**: Engine mit 2 Boards, Abstauber, Bewertung
- **Wer ist das?**: Fusionbilder-Engine mit Hinweis
- **Timeline**: Einordnungs-Engine mit Leben/KO
- **Wer lügt am besten?**: Abstimmungs-Engine
- **Erkenne den Song**: Audio-Buzzer-Engine
- **Docker**: Dockerfile und docker-compose.yml
- **Scripts**: backup.sh, restore.sh, import-legacy.sh
- **Dokumentation**: README, ADR, Deployment Guide, Spielregeln

### Geplant für 0.2.0

- [ ] Admin-UI für Inhaltsverwaltung
- [ ] Teams & Eventserien
- [ ] Weitere Spiele aus dem Katalog
- [ ] WebRTC Kamera-Support
- [ ] PostgreSQL-Migration
