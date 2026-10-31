# G4 — Handoff

Basis: main `1f8fdcefe68d47bc0e9dbcb7a5d4cb5c9596120a` (G1–G3 gemergt; G3 per Squash, geprüft über
`answerAttempt.ts` und die G3-Doku). Branch `feature/g4-results-corrections-protection`, Draft-PR
[joern211/quiz-platform#26](https://github.com/joern211/quiz-platform/pull/26) gegen `main`.
Kein Stapel, PR21 nicht eingemischt. Dokumente: [matrix](matrix.md) · [limits](limits.md) · [review](review.md).

## Umgesetzt

- **D Limits:** Stufe 1 = datenbankfreie frühe Zulassung (Socket-Middleware) für alle Spiel-/`game:*`-Events und
  `room:command`; Stufe 2 = Token-Buckets je Raum + Teilnehmer + Aktionsgruppe in den Handlern (Replay-Budget); früher
  `RATE_LIMITED`-Abbruch ohne Mutation/Receipt/DB-Read; Aufräumen/Obergrenze; verständliche Client-Meldung.
- **E Fehler:** traceId-verknüpfte, bereinigte Diagnose; der `logger` ersetzt Error-Objekte (inkl. verschachtelter
  Felder) zentral durch eine sichere Beschreibung; `messageKey` nur stabiler Bezeichner; keine Zod-Texte aus Jeopardy.
- **B/C Ergebnisse/Korrekturen:** eindeutige Revisionseinordnung (API + UI); Abnahme-Tests für alle drei Spiele
  (Konsistenz, Gleichstand, Abbruch, Teamwertung, Konkurrenz, Doppel-Rücknahme, Partie-Isolation, Host-Transfer,
  Kick/Verlassen, Absturzfenster, Neustart). Die Kernmechanik (CAS, Ledger-Abgleich, Rücknahme-Sperre) war schon
  korrekt und wurde **nicht** neu geschrieben.
- **Eigenprüfung** (Block 5) und **Nachbesserungen nach zwei unabhängigen Prüfberichten** (R1–R3 + UI-Hinweis, N1 Befehls-ID bei `RATE_LIMITED`, N2 HTTP-Fehlerhandler): [review.md](review.md).

## Prüfstand

Siehe PR-Beschreibung (maßgeblich: Zahlen und CI-Link am jeweils aktuellen Head; frühere Läufe gelten nicht für spätere Commits).

## Remote-/CI-Stand

CI/E2E am jeweils aktuellen PR-Head: siehe PR-Beschreibung. Frühere Läufe gelten nicht für spätere Commits.
Eine erste CI war rot (zwei Lintfehler der G4-Testdatei, behoben in `8621ac4`).

## Offen / Grenzen

Lobby-Events/`room:subscribe` nicht in der frühen Zulassung · Receipt-Retention · `GET …/results` ohne Rate-Limit ·
neue Identität = neues Budget · Legacy-Befehle ohne Kontextfeld (G3) · Auswahlabgabe-DoD (G3) · Tie-Strategien
außer ALLOW_TIE · G5 nicht begonnen.

## Unmittelbar nächster Schritt

CI/E2E am PR-Head abwarten, Review des Nutzers, Merge durch den Nutzer. Danach G5 vom neuen main.
