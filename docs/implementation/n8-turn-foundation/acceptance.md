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

---

# Nachbesserungsrunde zu PR #38 (unabhängiger Prüfbericht, Ausgangspunkt `93b8797`)

Befunde: **N8-01** Empfängerbindung, **N8-02** neuere Eligibility-Basis in Kein-Op-Pfaden, **N8-03** Run-Bindung der N6-Daten (Ursache, Änderung, Nachweis, Grenzen: `review.md` Abschnitt H). Die sechs Gegenproben des Berichts laufen unverändert (nur das neue Pflichtfeld ergänzt): am alten Stand **6/6 rot** (Server 4, Web 2), jetzt **6/6 grün**.

## Prüfläufe der Nachbesserung (lokal, nacheinander, am Code-Stand nach den Korrekturen)

| Prüfung | Befehl | Ergebnis |
|---|---|---|
| Typecheck | `pnpm typecheck` | Exit 0 |
| Lint | `pnpm lint` | Exit 0 — 0 Fehler, 109 Warnungen (= Ausgangswert) |
| Build | `pnpm build` | Exit 0 |
| Server | `pnpm --filter @quiz/server test` | Exit 0 — **92 Dateien, 1264 Tests** (Ausgangswert 1173; N8 gesamt +91: `turnSequence.test.ts` 79, `turnSequence.cas.integration.test.ts` 8, `n8IndependentReview.test.ts` 4) |
| Web | `pnpm --filter @quiz/web test` | Exit 0 — **52 Dateien, 631 Tests** (Ausgangswert 584; N8 gesamt +47: `TurnStatusCard.test.tsx` 24, `turnIntake.test.ts` 21, `n8IndependentReview.test.tsx` 2) |
| E2E (Chromium) | `CI=true pnpm exec playwright test --config=playwright.config.ts --project=chromium`, frische SQLite-DB | Exit 0 — **45 bestanden** |
| N8-Harness | `node apps/web/harness/n8-turn/check.cjs` | **5 Läufe, 0 Probleme** (je ~9 s), neues Szenario **S1b** (fremdes Empfängerpaket in andere Browserkontexte zugestellt); Kindprozesse danach beendet |
| Mutationen | `review.md` F | **29 von 29** gefangen (21 erste Runde + R1–R8), 2 Harness-Gegenproben; Arbeitsbaum danach sauber |
| GitHub-CI am letzten Head | siehe PR / Abschlussbericht | nach dem Push zu prüfen |

Erstes Grün ≠ Abschluss: nach den Korrekturen folgte die zweite Eigenprüfung (Kein-Op-Pfade einzeln, mehrstufige Folgen, Empfängerwechsel, getrennte Team-/Mitgliederstände, Recovery) — dabei ergänzt: die ausdrückliche Operation `refreshEligibilityBasis` (kein bisheriger Weg, einen neueren Stand ohne weitere Wirkung festzuhalten).

## Anforderungen des Berichts → Nachweis

| Pflichtnachweis | Nachweis |
|---|---|
| N8-01: Alice → Bob, Alice-Paket liegt noch an; spätes Alice-Paket nach Bob; zwei Teammitglieder; Viewer/Display/Host; gleiche Projektion ohne Reset | `turnIntake.test.ts` „recipient binding (N8-01)“ (7), `TurnStatusCard.test.tsx` „recipient binding“ (6), Server-Test „names the recipient in EVERY packet“, Harness S1b |
| N8-02: alle drei Folgen; actor- und member-Basis unabhängig; Basisfortschreibung bewegt nichts; Recovery; gleicher Stand ohne Zusatzwechsel | `turnSequence.test.ts` „D3 … no-op paths“ (7), DB-Test „newer eligibility basis … persisted through the CAS“, `n8IndependentReview.test.ts` (3 der 4) |
| N8-03: Run-1-Track an Run-2-Folge; gleiches Run ok; Team-/Mitglieder-Track je fremd; nach Recovery | `turnSequence.test.ts` „D3 … run of the sequence“ (6), `n8IndependentReview.test.ts` (1 der 4) |

## Ehrliche Grenzen (neu)
- Fremdes **gültiges** Empfängerpaket ⇒ leere Anzeige (fail-closed), nicht „alte Sicht bleibt“ — bewusste Entscheidung, siehe `review.md` H.
- Abgelehnte Aufrufe speichern keine neuere Basis; `refreshEligibilityBasis` ist der ausdrückliche Weg. Jede BASIS-Änderung erhöht die lokale Version (laufende Spieleraktionen werden veraltet).
- Run-Bindung beweist nicht, dass es der richtige Track **derselben** Partie ist.
- Weiterhin: Stand-in-Zustand statt Engine, Chromium-Emulation statt iPhone/Safari.
