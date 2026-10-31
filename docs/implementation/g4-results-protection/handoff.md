# G4 — Handoff

Basis: main `1f8fdcefe68d47bc0e9dbcb7a5d4cb5c9596120a` (G1–G3 gemergt; G3 per Squash, geprüft über
`answerAttempt.ts` und die G3-Doku). Branch `feature/g4-results-corrections-protection`, Draft-PR
[joern211/quiz-platform#26](https://github.com/joern211/quiz-platform/pull/26) gegen `main`.
Kein Stapel, PR21 nicht eingemischt. Dokumente: [matrix](matrix.md) · [limits](limits.md) · [review](review.md).

## Umgesetzt

- **D Limits:** zentraler Token-Bucket je Raum + Teilnehmer + Gruppe (kein IP-Limiter) in allen kritischen
  Spielaktionen, Ergebnis-Command/-Read, `game:core:read` und den drei Resyncs; Replay- und Ablehnungsbudget;
  früher `RATE_LIMITED`-Abbruch ohne Mutation/Receipt; Aufräumen/Obergrenze; verständliche Client-Meldung.
- **E Fehler:** traceId-verknüpfte, bereinigte Diagnose (Ergebnis-/Recovery-/Core-Read-Pfade), `messageKey` nur
  stabiler Bezeichner, keine Zod-Texte aus Jeopardy.
- **B/C Ergebnisse/Korrekturen:** eindeutige Revisionseinordnung (API + UI); Abnahme-Tests für alle drei Spiele
  (Konsistenz, Gleichstand, Abbruch, Teamwertung, Konkurrenz, Doppel-Rücknahme, Partie-Isolation, Host-Transfer,
  Kick/Verlassen, Absturzfenster, Neustart). Die Kernmechanik (CAS, Ledger-Abgleich, Rücknahme-Sperre) war schon
  korrekt und wurde **nicht** neu geschrieben.
- **Eigenprüfung** (Block 5) mit Befunden/Behebung: [review.md](review.md).

## Prüfstand (lokal, Code-Head `1e3db52`; danach nur Doku)

| Befehl | Ergebnis |
| --- | --- |
| `pnpm typecheck` | sauber |
| `pnpm lint` | 0 Fehler, 109 Warnungen (= Stand von main, keine neuen) |
| `pnpm build` | erfolgreich |
| `pnpm --filter @quiz/server test` | 71 Dateien, 683 Tests bestanden |
| `pnpm --filter @quiz/web test` | 33 Dateien, 169 Tests bestanden |
| Playwright-E2E (nach `ci.yml`, frische DB) | 34 bestanden |

Die sechs ursprünglichen G3-Reproduktionen und ihre Anschlussfälle (`g3Submission.integration.test.ts`)
liefen im Gesamtlauf unverändert grün.

## Remote-/CI-Stand

CI/E2E am jeweils aktuellen PR-Head: siehe PR-Beschreibung. Frühere Läufe gelten nicht für spätere Commits.
Eine erste CI war rot (zwei Lintfehler der G4-Testdatei, behoben in `8621ac4`).

## Offen / Grenzen

Lifecycle-/Room-/Recovery-Sockets nicht im neuen Limiter · Receipt-Retention · `GET …/results` ohne Rate-Limit ·
neue Identität = neues Budget · Legacy-Befehle ohne Kontextfeld (G3) · Auswahlabgabe-DoD (G3) · Tie-Strategien
außer ALLOW_TIE · G5 nicht begonnen.

## Unmittelbar nächster Schritt

CI/E2E am PR-Head abwarten, Review des Nutzers, Merge durch den Nutzer. Danach G5 vom neuen main.
