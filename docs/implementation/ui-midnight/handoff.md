# Midnight-UI — Handoff

- **Base:** `main` `975165e` (G5 / joern211/quiz-platform#28 gemergt, vor Beginn geprüft).
- **Branch:** `claude/laughing-gauss-hupzv6` (von der Umgebung vorgegeben statt `feature/ui-midnight`).
- **PR:** joern211/quiz-platform#29 (Draft → nach Abnahme reviewbereit). **Nicht gemergt**, Merge-Entscheidung beim Nutzer.
- **Produktstand / CI:** `669ba59` – CI-Lauf https://github.com/joern211/quiz-platform/actions/runs/41261345998 grün (Typecheck, Lint, Build, Server-Tests, Web-Tests, E2E 41/41 ohne Retry). Spätere Commits sind reine Doku und werden im PR genannt.

## Lokal ausgeführte Pflichtprüfungen (am Produktstand)

| Befehl | Ergebnis |
| --- | --- |
| `pnpm typecheck` | grün |
| `pnpm lint` | 0 Fehler, 109 Warnungen (identisch mit `main`) |
| `pnpm build` | grün |
| `pnpm --filter @quiz/server test` | 74 Dateien, 721 Tests grün |
| `pnpm --filter @quiz/web test` | 35 Dateien, 210 Tests grün (26 neu) |
| `pnpm exec playwright test --config=playwright.config.ts --project=chromium` | lokale Vollsuite: 40/41, UI-5 rot (Testfehler B13) → korrigiert, UI-1…5 danach 15/15 bei 3 Wiederholungen ohne Retry; CI-Vollsuite am Produktstand 41/41 |

## Geprüfte Zustände

Siehe `acceptance.md` (Nachweise) und `review.md` (Eigenprüfung, Befunde B1–B12).

## Echte Restgrenzen

- Kein Safari/iPhone-Hardwaretest; mobile Prüfung = Chromium-Emulation.
- Präferenz nur lokal im Browser (keine Account-Synchronisierung, folgt nicht auf andere Geräte) – so beauftragt.
- Content-Editor-Bestätigungen bleiben native `confirm()`-Dialoge.
- QR-Code der Host-Lobby nutzt weiterhin den externen Dienst `api.qrserver.com` (vorbestehend; Datenschutzentscheidung offen).
- 200 % Browser-Zoom nicht separat gemessen (über 768/390/320-px-Läufe abgedeckt).

## Wiederaufnahme

Dev-Umgebung: `pnpm install --frozen-lockfile`, `pnpm prisma generate`, isolierte DB (`DATABASE_URL=file:/tmp/qp-dev-midnight.db`, migrate + seed), Server `pnpm --filter @quiz/server start` (3001), Web `pnpm --filter @quiz/web dev --host 127.0.0.1` (5173). Visuelle QA: `node docs/implementation/ui-midnight/qa-screens.js <out> dark lila desktop`.
Playwright-E2E nicht parallel zu eigenen Dev-Servern starten (Config startet eigene Server auf 3001/5173).
