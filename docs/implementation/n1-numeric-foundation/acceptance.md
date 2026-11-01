# N1 — Abnahme (tatsächlich ausgeführte Prüfungen)

Base: `main` @ `2082265`. Branch `claude/new-session-3mw74c`. Produktcode-Stand der lokalen Abschlussläufe: `422854f` (alle späteren Commits ändern nur Dokumentation). Node v22.23.4, pnpm 9.12.0 (`packageManager`), Lockfile unverändert (`--frozen-lockfile`).

## Lokal ausgeführt (Container, isolierte Test-DBs `/tmp/quiz-server-test.db`, `/tmp/test-e2e.db`)

| Prüfung | Ergebnis |
|---|---|
| `pnpm typecheck` | 0 Fehler |
| `pnpm lint` | 0 Fehler, 109 Warnungen — identisch zur Base, keine aus neuen Dateien |
| `pnpm build` (Server `tsc` + Web `vite build`) | erfolgreich |
| `pnpm --filter @quiz/server test` | **76 Dateien, 763 Tests bestanden, 0 übersprungen** (Base laut Auftrag: 721; +42 = 29 `numeric.test.ts` + 13 `numericSubmission.test.ts`) |
| `pnpm --filter @quiz/web test` | **36 Dateien, 225 Tests bestanden** (Base 210; +15 `NumberField.test.tsx`) |
| `pnpm exec playwright test --project=chromium` | **45 von 45 bestanden** (3,2 min) |
| `git diff --check origin/main` | sauber |
| `vitest list` | neue Testdateien werden von den Projekt-Testbefehlen erfasst |

Hinweis zu einem Zwischenlauf: Ein früherer Serverlauf am Stand davor (`fe9341c`) hatte `rate-limiter.integration` mit „Server startup timed out“ (759 bestanden, 3 übersprungen). Ursache war ein echter Fehler im neuen Code (siehe `review.md` Befund 3), kein vorbestehender Flake; nach der Korrektur ist die Datei grün und es gibt keine Skips. Die ERROR/WARN-Zeilen im Serverlog stammen aus bestehenden Negativtests (STATE_INVARIANT_FAILED, Asset-Repair).

## Browser-Nachweis des Zahlenfelds (lokal, kein CI-Gate)

Eine **nicht eingecheckte** Fixture (separate Vite-Instanz, nie als Route ausgeliefert, nach dem Lauf gelöscht) renderte `NumberField` in fünf Zuständen (leer mit Einheit, sehr langes Label und lange Einheit, retryable Fehler, pending, bestätigt/negativ). Chromium-Mobile-Emulation, Viewports **320/390/430 px × Hell/Dunkel × alle 6 Akzentfamilien = 36 Kombinationen**:
- kein horizontaler Überlauf (gemessen gegen `documentElement.clientWidth`/`scrollWidth`), kein Element rechts außerhalb;
- Eingabefeld ≥ 51 px, Button ≥ 50 px hoch;
- keine Konsolen-/Seitenfehler;
- Tastaturfokus: 3-px-Outline; Eingabe `-12,5` bleibt im Entwurf, Enter löst die Validierung/Abgabe aus;
- zwei Screenshots (320 dunkel/lila, 390 hell/orange) visuell geprüft; dabei Befund „doppelter Punkt im Einheitenhinweis“ gefunden und behoben (`review.md`).

## Echte Grenzen (nicht behauptet)

- **Kein echter Engine-Verbraucher.** Kein Socket-, Auth-, CAS-, Receipt-, DB-/Neustart-, Rejoin-/Resync-/Recovery- oder echter Projektionsnachweis für Zahlenantworten. Die Domainfunktionen sind mit reinen Funktionen, JSON-Roundtrip und dem vorhandenen SDK-Replay (`createStateEvent`/`applyStateEvent`) getestet, nicht über einen Raum.
- Projektion: Host-Blind, PLAYER, fremder PLAYER, VIEWER, DISPLAY vor/nach Reveal sind für `projectNumericRound` getestet (Domainfunktion), **nicht** über Socket/Rejoin.
- Der Browserlauf ist lokal und nicht Teil der CI; es gibt keinen echten iPhone-/Safari-Nachweis (Chromium-Emulation ersetzt ihn nicht).
- Zwei-Engines-Kriterium Master §13.2: **nicht erfüllt**.

## CI am gepushten PR-Head

Wird nach dem letzten Push am PR-Head geprüft; Ergebnis und Link stehen in der PR-Beschreibung und in der Abschlussmeldung (hier nicht fortgeschrieben, damit dieser Eintrag nicht einen weiteren Doku-Commit und damit einen neuen Head erzeugt).
