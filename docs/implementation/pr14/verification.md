# BASIS-STANDARDS — Prüfstand 20.10.2026

Maßgeblicher Abschlussumfang: [Review-Korrekturen vom 20.10.2026](review-fixes-2026-10-20.md).
Die acht Befunde am alten Head widerlegten dessen frühere Merge-Freigabe.
Die neue Freigabe verlangt CI und E2E am aktuellen Head.

Aktueller Produktcode/Teststand: PR14 nach [Review-Korrekturen](review-fixes-2026-10-20.md).
Lokale Umgebung: Node 24.19.0, pnpm 9.12.0, Lockfile unverändert installiert,
Prisma Client 5.22.0 generiert. GitHub verwendet die Projekt-.nvmrc (Node 22).

| Prüfung | Ausgeführt / Ergebnis |
|---|---|
| `corepack pnpm -r typecheck` | grün, alle Pakete |
| `corepack pnpm lint` | grün, 0 Fehler / 117 Warnungen |
| Server `build`, danach Web `build` | grün |
| Server Vitest auf frischer, migrierter/geseedeter SQLite-DB | 359/359, 39/39 Dateien, 0 skipped |
| Web Vitest | 77/77, 9/9 Dateien, 0 skipped |
| `prisma migrate deploy` auf frischer DB | alle 10 Migrationen angewendet |
| zweiter Deploy auf derselben DB | No pending migrations to apply |
| `migration.deploy.test.ts` | Basis → alle 5 PR14-Migrationen → Deploy erneut; Daten/IDs/Session/Score/Engine-Version erhalten; echter WID-v1/v2-Rejoin; executionToken/mutationStartedAt und receipted game:end/Replay geprüft; defekter Snapshot liefert ACK, separater Server bleibt erreichbar |
| `python3 docs/implementation/pr12/check-docs.py` | 1.292 IDs, 291 Herkunftsgruppen plus Split-Index, 20 Masterabschnitte, 19 Spielverträge und Links geprüft |
| `git diff --check` | grün |

## Browsernachweis

Die unveränderte vollständige Playwright-Suite wird in GitHub Actions ausgeführt
(Geo, Jeopardy, WID, Homepage; keine ausgeschlossenen Pflicht-Tests). Die lokale
Chromium-Installation konnte beschafft werden, der Browser beendet sich jedoch
vor der ersten Seite mit `process_singleton_posix.cc: socket() failed: Operation
not permitted`. Diese Laufzeit verbietet die benötigten Unix-Sockets.
Lokale Browserversuche gelten daher nicht als erfolgreiche Spieltests.

Verbindlicher GitHub-Nachweis: CI **und** E2E des exakten aktuellen PR-Heads:
https://github.com/joern211/quiz-platform/pull/14/checks

Ein grüner früherer Head ersetzt diesen Nachweis nicht. Der historische Head
`2e1055a` hatte einen roten WID-Test und einen flaky Geo-Test. Die aktuelle
Nacharbeit beseitigt den ungeprüften Ready-Übergang und setzt den im WID-Test
bereits beabsichtigten 90-s-Timeout über die unterstützte Playwright-API.
Verbleibende echte Fehler werden vor der Freigabe behoben; Tests werden nicht
übersprungen oder allein durch Wiederholen als behoben erklärt.

## Besonders geprüfte Fehlergrenzen

`audit14.regression.test.ts` und `reviewer14.test.ts`: verlorenes Receipt NACH
einer echten WID-Bewertung, zweiter Spieler danach, Wiederholung ohne zweite
Punktänderung; abgeschlossene Commands mit eigener alter Revision; ungültige
Envelope-Felder an Geo/Jeopardy/WID-Sockets; Config-Fehler nach CAS ohne
Partial-Commit; Kick nach Permission-Revoke; falscher Snapshot mit persistenter
Recovery, geheimnisfreier Viewer-Projektion und bestätigtem Spielende/Replay;
Prototype-Rollen an der echten Permission-Normalisierungsgrenze.

Frontend: gemeinsamer Intent-Lebenszyklus einschließlich verspäteter und
nicht finaler ACKs; alle drei Geo-Rollen mit Live-/Reload-Recovery; Host kann
auch ohne erste Frage beenden; Bereitschaft vor Subscribe-ACK gesperrt,
Update seriell, abgelehnter Versuch erneut bedienbar.


## Historischer GitHub-Nachweis vom 19.10. (kein Nachweis für die neue Nacharbeit)

Am Code-/Test-Head `c4bcc00b79de3e5a72368e9a23707010fb2ebdcb` sind CI und
vollständige E2E erfolgreich: [Run 39249235352](https://github.com/joern211/quiz-platform/actions/runs/39249235352).
**18/18 Browserfälle im ersten Versuch bestanden**, keine Retries/Flakes,
keine übersprungenen Tests; WID W1–W10 in 9,7 s, Gesamtlauf 55,1 s.
Nachfolgende Dokumentationsänderungen erhalten vor der Freigabe ebenfalls
CI/E2E am exakten aktuellen PR-Head; deren Live-Nachweis steht in den PR-Checks.
