# G5 — Abnahme (Ausführung und Ergebnisse)

Produktstand: `0830ccb418266f729ea4443c26952043641bcf11` (Branch `claude/new-session-7pw835`, Base main `bafbc61`). Danach nur Doku-Commits.
Umgebung: Node v22.23.4, pnpm 9.12.0, frozen Lockfile, Prisma generiert, ffmpeg vorhanden, Playwright-Chromium (vorinstalliert), temporäre SQLite-DBs (`/tmp/quiz-server-test.db`, `/tmp/test-e2e.db`), Bedingungen wie `.github/workflows/ci.yml`.

| Befehl | Ergebnis |
| --- | --- |
| `pnpm typecheck` | grün |
| `pnpm lint` | 0 Fehler, 109 Warnungen (wie Base) |
| `pnpm build` | grün |
| `pnpm --filter @quiz/server test` | 73 Dateien, **714** Tests grün (Base: 708/710 im selben Lauf, 2 rot — siehe review.md) |
| `pnpm --filter @quiz/web test` | 34 Dateien, **179** Tests grün |
| Playwright chromium (Seed gemäß CI) | **35** grün (34 Bestand + M4b) |

Nicht ausgeführt: separate Doku-/Schema-Skripte (im Repo keine über die obigen hinausgehenden Pflichtskripte gefunden, nicht gesondert gesucht). Pflichtnachweise nicht geskippt.
GitHub-CI/E2E am PR-Head: im PR #28 zu lesen; ältere Läufe gelten nicht.

## Fünf PR15–19-Schwerpunkte
Siehe [matrix.md](matrix.md): 7.1 Admission-Isolation (R, neuer Test), 7.2 Viewer-Kapazität (R, bestehend), 7.3 Recovery-Evidenz (R, neuer Gegenfall), 7.4 Null Punkte (R, UI-Test neu), 7.5 Medien-Neustart (R, M4b neu).

## Drei Verbraucher
Die Pflichtabläufe W/J/WID wurden **nicht** vollständig neu durchgespielt; belegt über die bestehenden G1–G4-Integrations- und Restarttests sowie die E2E-Spiele (geo, jeopardy, weristdas), die am Produktstand grün laufen. Eine neue, eigene Durchgangsprüfung je Spiel über alle Rollen erfolgte nur in den hier genannten Gegenfällen.

## Risiko: ACK-Timeout (PR26)
Nicht aufgetreten (Baseline und Schlusslauf). Ursache weiterhin nicht belegt.
