# Midnight-UI — Handoff

- **Base:** `main` `975165e` (G5 / joern211/quiz-platform#28 gemergt, vor Beginn geprüft).
- **Branch:** `claude/laughing-gauss-hupzv6` (von der Umgebung vorgegeben statt `feature/ui-midnight`).
- **PR:** joern211/quiz-platform#29 (Draft → nach Abnahme reviewbereit). **Nicht gemergt**, Merge-Entscheidung beim Nutzer.
- **Nachbesserung nach Prüfbericht (Head `11c2a56`):** R1–R3 und N1–N7 in `review.md`. Produktstand nach Nachbesserung: `82b89f8`. CI am finalen Head: im PR verlinkt (nach Abschluss des Laufs eingetragen).
- *Historisch:* erste Abnahme `669ba59`, CI-Lauf 41261345998 grün (E2E 41/41) – gilt nicht mehr als aktueller Nachweis.

## Lokal ausgeführte Pflichtprüfungen (Nachbesserung, Commit `82b89f8`)

| Befehl | Ergebnis |
| --- | --- |
| `pnpm typecheck` | grün |
| `pnpm lint` | 0 Fehler, 109 Warnungen (identisch mit `main`) |
| `git diff --check origin/main` | leer |
| `pnpm build` | grün |
| `pnpm --filter @quiz/web test` | 35 Dateien, 210 Tests grün |
| `pnpm exec playwright test --config=playwright.config.ts --project=chromium` (CI=true) | 45/45 passed, kein Flaky; UI-6 zusätzlich 3× ohne Retry 12/12 |
| `pnpm --filter @quiz/server test` | lokal zuletzt am Stand `669ba59` (721/721); seitdem keine Server-/Shared-Änderung – aktueller Nachweis über CI am finalen Head |

## Geprüfte Zustände

Siehe `acceptance.md` (Nachweise) und `review.md` (Eigenprüfung B1–B14, Nachprüfung R1–R3, N1–N7).

## Echte Restgrenzen

- Kein Safari/iPhone-Hardwaretest; mobile Prüfung = Chromium-Emulation.
- Präferenz nur lokal im Browser (keine Account-Synchronisierung, folgt nicht auf andere Geräte) – so beauftragt.
- Content-Editor-Bestätigungen bleiben native `confirm()`-Dialoge.
- QR-Code der Host-Lobby nutzt weiterhin den externen Dienst `api.qrserver.com` (vorbestehend; Datenschutzentscheidung offen).
- 200 % Browser-Zoom nicht separat gemessen (über 768/390/320-px-Läufe abgedeckt).
- Info-Popup ist ein nicht-modaler Dialog: Tab verlässt ihn und schließt ihn (kein Focus-Trap, bewusst).

## Wiederaufnahme

Dev-Umgebung: `pnpm install --frozen-lockfile`, `pnpm prisma generate`, isolierte DB (`DATABASE_URL=file:/tmp/qp-dev-midnight.db`, migrate + seed), Server `pnpm --filter @quiz/server start` (3001), Web `pnpm --filter @quiz/web dev --host 127.0.0.1` (5173). Visuelle QA: `node docs/implementation/ui-midnight/qa-screens.js <out> dark lila desktop`.
Playwright-E2E nicht parallel zu eigenen Dev-Servern starten (Config startet eigene Server auf 3001/5173).
