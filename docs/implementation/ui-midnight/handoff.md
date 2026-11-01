# Midnight-UI — Handoff

- **Base:** `main` `975165e` (G5 / joern211/quiz-platform#28 gemergt, vor Beginn geprüft).
- **Branch:** `claude/laughing-gauss-hupzv6` (von der Umgebung vorgegeben statt `feature/ui-midnight`).
- **PR:** joern211/quiz-platform#29 (Draft → nach Abnahme reviewbereit). **Nicht gemergt**, Merge-Entscheidung beim Nutzer.
- **Head / CI:** siehe Abschnitt „Finaler Stand“ (wird am letzten Commit aktualisiert).

## Geprüfte Zustände

Siehe `acceptance.md` (Nachweise) und `review.md` (Eigenprüfung, Befunde B1–B12).

## Echte Restgrenzen

- Kein Safari/iPhone-Hardwaretest; mobile Prüfung = Chromium-Emulation.
- Präferenz nur lokal im Browser (keine Account-Synchronisierung, folgt nicht auf andere Geräte) – so beauftragt.
- Content-Editor-Bestätigungen bleiben native `confirm()`-Dialoge.
- QR-Code der Host-Lobby nutzt weiterhin den externen Dienst `api.qrserver.com` (vorbestehend; Datenschutzentscheidung offen).
- 200 % Browser-Zoom nicht separat gemessen (über 768/390/320-px-Läufe abgedeckt).

## Wiederaufnahme

Dev-Umgebung: `pnpm install --frozen-lockfile`, `pnpm prisma generate`, isolierte DB (`DATABASE_URL=file:/tmp/qp-dev-midnight.db`, migrate + seed), Server `pnpm --filter @quiz/server start` (3001), Web `pnpm --filter @quiz/web dev --host 127.0.0.1` (5173). Visuelle QA: `node docs/implementation/ui-midnight/qa-screens.cjs <out> dark lila desktop`.
Playwright-E2E nicht parallel zu eigenen Dev-Servern starten (Config startet eigene Server auf 3001/5173).
