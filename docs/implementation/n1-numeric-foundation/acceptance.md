# N1 — Abnahme (tatsächlich ausgeführte Prüfungen)

Base: `main` @ `2082265`. Branch `claude/new-session-3mw74c`. **Code-Head der Abschlussläufe: `654315ddc903598a8faa0e708d1a8f6b78487678`** (R1-Nachbesserung). Frühere Stände: `f71ef2c` (Erstabnahme, CI grün, Run 41301733968), `422854f` (Strip-only-Fix). Spätere Commits nach `654315d` ändern nur Dokumentation. Node v22.23.4, pnpm 9.12.0 (`packageManager`), Lockfile unverändert (`--frozen-lockfile`).

## Lokal ausgeführt (Container, isolierte Test-DBs `/tmp/quiz-server-test.db`, `/tmp/test-e2e.db`)

| Prüfung | Ergebnis |
|---|---|
| `pnpm typecheck` | 0 Fehler |
| `pnpm lint` | 0 Fehler, 109 Warnungen — identisch zur Base, keine aus neuen Dateien |
| `pnpm build` (Server `tsc` + Web `vite build`) | erfolgreich |
| `pnpm --filter @quiz/server test` | **76 Dateien, 763 Tests bestanden, 0 übersprungen** (Base laut Auftrag: 721; +42 = 29 `numeric.test.ts` + 13 `numericSubmission.test.ts`; R1 betrifft nur das Web-Feld, Serverstand unverändert) |
| `pnpm --filter @quiz/web test` | **36 Dateien, 235 Tests bestanden** (Base 210; +25 `NumberField.test.tsx`: 15 ursprüngliche + 3 R1-Gegenfälle des Reviews + 7 zusätzliche R1-Regressionen) |
| `pnpm exec playwright test --project=chromium` | **45 von 45 bestanden** (3,2 min) |
| `git diff --check origin/main` | sauber |
| `vitest list` | neue Testdateien werden von den Projekt-Testbefehlen erfasst |

**R1-Rot/Grün-Nachweis (Web):** Die drei Gegenfälle des Reviews sind am Stand `f71ef2c` rot (3 fehlgeschlagen, 15 grün); mit dem Fix `654315d` sind alle 25 Tests grün. Gegen den alten Komponentencode (Datei aus `f71ef2c` eingesetzt) schlagen 14 von 25 Tests fehl (8 R1-bezogen, 6 wegen der erweiterten Signatur `onSubmit(value, attemptId)`), danach wiederhergestellt.

Hinweis zu einem Zwischenlauf (Erstabnahme): Ein früherer Serverlauf am Stand davor (`fe9341c`) hatte `rate-limiter.integration` mit „Server startup timed out“ (759 bestanden, 3 übersprungen). Ursache war ein echter Fehler im neuen Code (siehe `review.md` Befund 3), kein vorbestehender Flake; nach der Korrektur ist die Datei grün und es gibt keine Skips. Die ERROR/WARN-Zeilen im Serverlog stammen aus bestehenden Negativtests (STATE_INVARIANT_FAILED, Asset-Repair).

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

## CI am gepushten Head

**Code-Head `654315ddc903598a8faa0e708d1a8f6b78487678`: Jobs `CI` und `E2E` erfolgreich** — https://github.com/joern211/quiz-platform/actions/runs/41303819026 (Typecheck, Lint, Build, Server-/Web-Tests, Playwright chromium; Checkout als synthetischer Merge in `main` @ `2082265`, laut GitHub konfliktfrei). Der Browser-Layoutlauf wurde für R1 **nicht** wiederholt (die Korrektur betrifft Zustandslogik, nicht Layout/CSS); der Nachweis dazu sind die Komponenteninteraktionstests.

Der Head des letzten Doku-Commits (diese Datei) ändert keinen Produktcode; sein CI-Ergebnis steht in der PR-Beschreibung (hier nicht fortgeschrieben, damit dieser Eintrag keinen weiteren Head erzeugt).
