# N8 — Abnahme (Anforderungen → Nachweis)

Stand: 02.11.2026. Basis `main` @ `6c42f55cbe1cacf35e6912b7fd02e7fc9ded4bff` (main-CI-Lauf 41452225297 grün; vor dem Abschluss erneut per `git fetch` geprüft: unverändert). **N8-Grundlagenpaket umgesetzt / reviewbereit** — nicht „Turn-Core für alle Spiele fertig“. **0 neue echte Engine-Verbraucher**; Master §13.2 (Core-DoD) offen.

Head, PR-Nummer und die CI am **finalen** Head stehen in der PR-Beschreibung (ein Commit kann seinen eigenen Hash nicht enthalten). Die lokalen Läufe unten liefen am Code-Inhalt des Commits `Übergabedokument` bzw. identisch danach; nach ihnen änderten sich nur das Harness-Skript (Messfehler S7, siehe `review.md` T6) und Dokumente.

## Prüfläufe (lokal, nacheinander, ohne parallele Last)

| Prüfung | Befehl | Ergebnis |
|---|---|---|
| Typecheck | `pnpm typecheck` | Exit 0 |
| Lint | `pnpm lint` | Exit 0 — 0 Fehler, 109 Warnungen (**identisch zum Ausgangswert**; `eslint` auf allen N8-Dateien ohne Ausgabe) |
| Build | `pnpm build` | Exit 0 (bekannte Chunk-Größen-Warnung); gebauter Server lädt `@quiz/shared/turnSequence` im Plain-Node-Strip-Modus (`gameErrorCode` Smoke) |
| Server | `pnpm --filter @quiz/server test` | Exit 0 — **91 Dateien, 1244 Tests** (Ausgangswert 1173; +71: `turnSequence.test.ts` 64, `turnSequence.cas.integration.test.ts` 7) |
| Web | `pnpm --filter @quiz/web test` | Exit 0 — **51 Dateien, 616 Tests** (Ausgangswert 584; +32: `TurnStatusCard.test.tsx` 18, `turnIntake.test.ts` 14) |
| E2E (Chromium) | `CI=true pnpm exec playwright test --config=playwright.config.ts --project=chromium` mit frischer SQLite-DB (`migrate deploy` + `db:seed`) | Exit 0 — **45 bestanden** (Ausgangswert 45). Die E2E-Suite enthält bewusst keine N8-Route. |
| N8-Harness | `node apps/web/harness/n8-turn/check.cjs` | Exit 0, **0 Probleme** — 5 Läufe am Endstand hintereinander (je ~9 s), Kindprozesse danach beendet. 5 getrennte Browserkontexte (A, B, C, E, Viewer) gegen die **echte** Server-Domain, 4 Layout-Kombinationen (320/1280 px × hell/dunkel, sehr lange Namen). Zuvor 3 Läufe mit 1 Problem (Messfehler S7, `review.md` T6). |
| Mutationsprüfung | `review.md` F | 21 von 21 Mutanten gefangen, 1 Harness-Gegenprobe (5 Meldungen); Arbeitsbaum danach sauber |
| GitHub-CI am letzten Head | siehe PR | **nach dem Push zu prüfen** (Ergebnis im Abschlussbericht) |

## Ehrliche Grenzen der Nachweise
- **Echt:** SQLite aus den realen Migrationen, die gemeinsame CAS `saveGameStateIfRevision`, echtes `runReceipted`/`CommandReceipt`, die Einzelverbindungs-URL, ein zweiter Node-Prozess, echtes Chromium. **Nicht echt:** keine Engine (Stand-in-Zustand `{phase, turnSequence}` in `RoomGameState`, Test-Handler), kein `gameSlug`/Event, keine Route/Socket; Harness-Backend mit Empfänger-Tabelle statt Session.
- In den beobachteten Läufen entschied bei gleichzeitigen Absichten **immer** die CAS (`Game state revision conflict`); der domänenseitige Abbruch (`TURN_SEQ_VERSION_STALE`) wurde im Test „late intent … SAME holder“ belegt, nicht im Rennen. Ob unter anderer Last die Domäne zuerst greift, ist offen — beide Pfade enden ohne zweiten Zug.
- Chromium-Emulation, **kein** iPhone/Safari-Hardwaretest; JSDOM ist kein Layoutnachweis.

## Anforderungen → Nachweis

| Auftrag | Nachweis |
|---|---|
| §1/§12 main-/CI-Abgleich, neuer Branch, keine Force-Pushes, keine Secrets | `handoff.md`, dieser Kopf |
| §4 Entwurf vor Implementierung | `design.md` (Commit vor dem ersten Code); Abweichungen/Ergänzungen: `review.md` F1 (Abdeckung `knownIds`), F2 (Namen) |
| §5.1 Identität, Vorbereitung, RANDOM einmal, CUSTOM validiert, ROTATING_START | Tests Block A (Rotation = `createTurn` je Vorgänger, `null` = erster Durchlauf, ungültiger Vorgänger, CUSTOM-Issues, Zufall genau einmal, Quelltext-Test) |
| §5.2 Zustände/Invarianten, ein Umlauf, Einzelakteur, `NO_ELIGIBLE`, terminal | Blöcke B/D, Übergangstabelle D2, Recovery (31 Beschädigungen) |
| §5.3 drei Ebenen, N6, Stale-Schutz, Disconnect ohne Wirkung, Entzug zwischen Aktionen | B (N6-Adapter, KEEP_ACTIVE/ELIMINATE, 320-Fälle-Äquivalenz), D (Entzug/`HELD`/ausdrückliches `SKIP`), F1-Test, Harness S4 |
| §5.4 Teamzug, innere Rotation | C (Beispiel, Orakel, Zeigerverlauf, ungleiche Teams, inaktive Mitglieder/Teams, Berechtigung) |
| §5.5 Override | D „override“ (neuer Zug, kein Abschluss, kein Zeiger, Ziele geprüft, identisch, alte Aktionen ungültig, Grund nur in `transition`) |
| §6 Versionen, Duplikate, Konkurrenz, Recovery | D/D2 (pure Gegenprobe), `turnSequence.cas.integration.test.ts` (echte DB), F (JSON/SDK/zweiter Prozess) |
| §7 Projektion, Intake, Karte, Informationsrechte | E (Allowlist, 9 Audiences × 3 Freigaben, Leaks), `turnIntake.test.ts`, `TurnStatusCard.test.tsx`, Harness |
| §8 historische Fehler | `review.md` C (Tabelle mit Codepfad und Gegenbeweis) |
| §9 Prüfkatalog A–G | siehe `design.md` §8 und `review.md`; G: Harness S1–S9 |
| §10 zweite Eigenprüfung | `review.md` (Befunde F1/F2, Übergangstabelle, aktive Gegenfälle, Orakel, Mutationen) — Eigenprüfung, keine unabhängige |
| §11 Matrix/Doku | `matrix.md`, `g5-consumer-acceptance/matrix.md` (Abschnitt 5, historischer Stand gekennzeichnet), `handoff.md` |
