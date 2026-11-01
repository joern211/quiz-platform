# N1 — Handoff

Status: **N1-Vorbereitung implementiert und geprüft; noch kein produktiver Numeric-Spielverbraucher, vollständige Core-DoD offen.**

- Base: `main` @ `2082265a3f0bcab5c2eb4459280c506798a4ea2d` (Midnight-UI, PR #29). `main` war beim Start unverändert; kein konkurrierender Numeric-Branch (einziger offener PR: #21, Plan-Dokument).
- Branch: `claude/new-session-3mw74c` (vom System vorgegeben statt `feature/n1-numeric-foundation`), direkt von `main`.
- Gepushter Stand: siehe PR (Draft). Produktcode zuletzt in `422854f`; danach nur Dokumentation.
- Neue/geänderte Dateien: `packages/shared/src/numeric.ts` (+ Export `./numeric` in `packages/shared/package.json`), `apps/server/src/games/core/numericSubmission.ts`, `core/errors.ts` (+ `NUMERIC_*`), Tests `core/numeric.test.ts`, `core/numericSubmission.test.ts`, `apps/web/src/components/NumberField.{tsx,module.css,test.tsx}`, diese Doku.
- Offene Jobs: keine laufenden. Die temporäre Browser-Fixture wurde gelöscht; Skripte lagen im Session-Scratchpad.
- Nächster Schritt: Nutzer entscheidet über Review/Merge dieses begrenzten Pakets und die offenen Punkte in `decisions.md`. Erst danach ein eigener Engine-Auftrag (z. B. „Schätz mal“), der `matrix.md` §3 abarbeitet und die dort genannten Nachweise am echten Verbraucher erbringt. Vorher ist N1 nicht als Numeric-Core-DONE zu melden.
- Zu beachten für spätere Arbeit: Code in `packages/shared` wird von `dist/app.js` per Node im Strip-only-Modus als TypeScript geladen → keine Enums, keine Parameter-Properties (Regressionstest vorhanden).
