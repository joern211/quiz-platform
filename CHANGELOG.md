# Changelog

Alle wesentlichen Änderungen werden hier dokumentiert.

## [0.2.0] - 2026-09-16

### UI/UX — Komplettes Redesign

- **Google Fonts**: Inter + Space Grotesk als Display-Font für moderne, athletische Typografie
- **Ganzflächig klickbare GameCards**: Overlay-Link-Trick mit `::after`-Shine-Sweep und Neon-Glow-Hover
- **Gradient-Buttons**: Shimmer-Sweep-Animation auf Hover, `cubic-bezier(0.34, 1.56, 0.64, 1)` Spring-Übergänge
- **Glass Morphism Header**: `backdrop-filter: blur(20px)`, semi-transparente Backgrounds
- **Cyberpunk Dark Theme**: Neon-Glows auf Akzentelementen, Subtle-Noise-Textur im Background
- **Page Transitions**: `cubic-bezier(0.22, 1, 0.36, 1)` Slide-In pro Route, Keyed `<main>` für React
- **Stagger Entrance**: Listenelemente erscheinen gestaffelt mit Delay 0.05s–0.55s
- **Playful Buzzer**: Pulse-Ring-Animation, Shine-Sweep, Winner-Glow, Spring-Transform
- **Scoreboard Pop-Animation**: Punkte fliegen mit Scale+Bounce ein bei Änderung
- **Rank Badges**: Gold/Silber/Bronze mit Glow-Text-Shadow für Top-3
- **Toast Slide-In**: `cubic-bezier` Bounce-in von rechts, Auto-Exit-Animation
- **Modal Spring-Entry**: Scale 0.92 → 1 + Translate-Y, Blur-Backdrop
- **Kategorie-Cards**: Emoji als halbtransparente Background-Deko, Hover-Scale+Rotate
- **Ambient Float**: CSS `@keyframes float` für dekorative Elemente
- **Room-Code Anzeige**: Large Monospace mit Neon-Text-Shadow in der Lobby

### Code-Qualität

- **CSS-Variablen aufgeräumt**: Keine harten Werte, konsistente `--space-*` + `--radius-*` Nutzung
- **Alle Pages modernisiert**: GamePage, CategoryPage, RoomsPage, ModeratorSetupPage, ModeratorLobbyPage
- **Footer versioniert**: v0.2.0 Badge mit Pill-Style

### Performance

- **FOUC-Schutz**: Theme vor dem Render in `<head>` via Inline-Script gesetzt
- **SVG-Favicon**: Inline als data-URI, kein Extra-Request
- **Font preconnect**: Google Fonts mit `preconnect` + `crossorigin` optimiert

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
