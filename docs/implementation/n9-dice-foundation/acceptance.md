# N9 — Abnahme (Anforderungen → Nachweis)

Stand: 02.11.2026 (nach der Nachbesserung zur unabhängigen PR-Prüfung, `review.md` G). Basis `main` @ `5ed23b7b4710ddb47d8c14003437eeab29a8f3a5` (main-CI-Lauf 41502473539 grün; beim Start und vor dem Abschluss per `git fetch` geprüft: unverändert). **N9-Grundlagenpaket umgesetzt / reviewbereit** — nicht „Würfel-Core für alle Spiele fertig“. **0 neue echte Engine-Verbraucher.** Der vollständige Core-DoD nach Master §13.2 bleibt offen.

Head, PR-Nummer und die CI am **finalen** Head stehen in der PR-Beschreibung (ein Commit kann seinen eigenen Hash nicht enthalten). Die lokalen Läufe unten liefen am Codezustand des letzten Code-Commits; danach änderten sich nur Dokumente.

## Prüfläufe (lokal, nacheinander, ohne parallele Last)

| Prüfung | Befehl | Ergebnis |
|---|---|---|
| Typecheck | `pnpm typecheck` | Exit 0 — jetzt **einschließlich des Harness** (`apps/web/harness/n9-dice/tsconfig.json`, `tsconfig.web.json`; fehlendes Pflichtfeld wäre gemeldet worden, siehe N2-b) |
| Lint | `pnpm lint` | Exit 0 — 0 Fehler, 109 Warnungen (**identisch zum Ausgangswert**; `eslint` auf allen N9-Dateien ohne Ausgabe) |
| Build | `pnpm build` | Exit 0 (bekannte Chunk-Größen-Warnung); gebauter Server lädt `@quiz/shared/dice` im Plain-Node-Strip-Modus (`gameErrorCode`-Smoke am Head `19eabb8`; `DICE_COUNTER_LIMIT` ist dieselbe Whitelist-Mechanik und im Wire-Test aller Codes abgedeckt) |
| Server | `pnpm --filter @quiz/server test` (nach `pnpm build`) | Exit 0 — **95 Dateien, 1432 Tests** (Ausgangswert 1264 / 92 Dateien; +168: `diceTurn.test.ts` 144, `diceTurn.cas.integration.test.ts` 21, `n9IndependentReview.test.ts` 3) |
| Web | `pnpm --filter @quiz/web test` | Exit 0 — **55 Dateien, 685 Tests** (Ausgangswert 631 / 52 Dateien; +54: `DiceTray.test.tsx` 29, `diceIntake.test.ts` 23, `n9IndependentReview.test.tsx` 2) |
| E2E (Chromium) | `CI=true pnpm exec playwright test --config=playwright.config.ts --project=chromium` mit frischer SQLite-DB (`migrate deploy` + `db:seed`) | Exit 0 — **45 bestanden** (Ausgangswert 45). Die E2E-Suite enthält bewusst keine N9-Route. |
| N9-Harness | `node apps/web/harness/n9-dice/check.cjs` | Exit 0 — **26 Szenarien**, 3 Läufe am Endstand hintereinander (je ~25 s; zusätzlich 8 weitere grüne Läufe während der Nachbesserung, davon 3 mit rotem Ausreißer, siehe `review.md` C10/C11), danach keine Kindprozesse. Getrennte Browserkontexte (A, Teamkollege B, anderer Spieler C, Viewer) gegen die **echte** Domäne mit **echter SQLite**-Datei; neu: S10c (verspäteter Befehl vom Browser selbst zugestellt, 6 Fälle), S7b (Receipt-Konflikte); Layouts 320/1100 px × hell/dunkel × Akzentfamilien, lange Namen, Bewegung normal/reduziert |
| Mutationsprüfung | `review.md` E und G | 17 + 12 Mutanten, alle gefangen (Assertionen, Typfehler des Harness, ein benannter Absturzfall N1-a ersetzt durch N1-f); Browsertreffer für M1, M3b, M7, M13, N1-e, N1-f, N2-a; Arbeitsbaum danach sauber |
| GitHub-CI am letzten Head | siehe PR | nach dem Push zu prüfen; Zahlen und Joblogs stehen im Abschlussbericht |

Eine unabhängige Messung vorweg (Ausgangswerte): `typecheck` Exit 0; Server 1261 bestanden + 3 übersprungen bei einem roten Test, der `apps/server/dist/app.js` braucht (Umgebung ohne Build — Messfehler C1, nicht Produkt); Web 631.

## Ehrliche Grenzen der Nachweise
- **Echt:** SQLite aus den realen Migrationen, die gemeinsame CAS `saveGameStateIfRevision` (im Stand-in der **einzige** Wächter, M8a), echtes `runReceipted`/`CommandReceipt`, echte `GameDomainEvent`-Zeilen über `materializeGameEvent`, die Einzelverbindungs-URL, ein zweiter Node-Prozess (Zufall dort gesperrt, Positivkontrolle), echtes Chromium. **Nicht echt:** keine Engine (Stand-in-Zustand `{phase, turnSequence, dice}`, Test-Handler), keine Route, kein Socket, keine Admission/Session (Empfängertabelle im Harness; `caller`/`gate` sind Tabelleneinträge), kein `setupSnapshot`. `saveGameStateIfRevision` allein schreibt das Event nur für die drei registrierten Engine-Slugs (siehe `review.md` F5).
- **Zufall:** kein Seed-Core. Reproduzierbarkeit aus einem Seed ist **nicht** gegeben und wird nicht behauptet. Unter Konkurrenz ziehen beide Absichten (10 Aufrufe, 1 gespeichert).
- Bei gleichzeitigen Absichten aus **demselben geladenen Stand** entschied die CAS (`GameStateConflictError`, im Test fest geprüft). Im Rennen mehrerer `commandId`s durch den Receipt-Pfad sind `DICE_VERSION_STALE`, `STATE_CONFLICT`/`COMMAND_STATE_ADVANCED` und der Revisionsfehler der CAS gleichermaßen zugelassen; **welcher** Wächter dort in den Läufen tatsächlich zuerst griff, wurde nicht gemessen und hängt von der Last ab. Entscheidend und geprüft: genau ein gespeichertes Ergebnis.
- Chromium-Emulation, **kein** iPhone/Safari-Hardwaretest, **kein** Screenreader-Test (NVDA/VoiceOver); JSDOM ist kein Layoutnachweis. Die Animation wird im Browser über einen Bildfolge-Sampler gemessen, nicht visuell bewertet.
- Ein lesender zweiter Prozess ist kein nachgewiesener produktiver Wiederanlauf aller Routen. Der Prozessneustart im Harness (S16) startet nur den Harness-Server neu.

## Anforderungen → Nachweis

| Auftrag | Nachweis |
|---|---|
| §1 main-/CI-Abgleich, neuer Branch, keine Force-Pushes, keine Secrets | `handoff.md`, dieser Kopf |
| §4 Entwurf vor Implementierung | `design.md` (eigener Commit vor dem ersten Code); Abweichungen: `review.md` F |
| §5.1 Identität, Konfiguration (5×W6/3/Halten, 1×W6/1/ohne Halten, begrenzt, nicht gerundet) | `diceTurn.test.ts` A (19 Konfigurationsfälle, Profile frozen, Kopie, Bindung aus dem Serverzustand) |
| §5.2 Zustände/Übergänge, keine Werte vor dem ersten Wurf, Halten/Freigeben als Zielbelegung, alle gehalten, Schließen terminal, stabile Positionen | B/C/D (wörtlicher Haltefall `[1,2,3,4,5]` → `[6,2,6,4,6]` mit drei Ziehungen, gleiche Augen auf verschiedenen Positionen, 13 ungültige Ziele, `DICE_NOTHING_TO_ROLL` ohne RNG, Schließen/Wiederholen/kein Wiederöffnen), Browser S2–S6 |
| §5.3 N8 und aktuelle Berechtigung, BASIS ohne Zurücksetzen, neuer Zug entwertet alte Absichten | E (Spieler/Teamkollege/Host/Viewer/Display/Pause/Phase/HELD/anderer Run/späterer Zug/Override), F (BASIS, Limit unverändert), DB-Tests, Browser S10/S10b/S11/S13 |
| §6.1 Serverzufall, keine Verzerrung, Validierung vor RNG, Trennung Entscheidung/Anwendung | B (`randomInt(1, sides+1)`, kein `Math.random`/Uhr, RNG-Zähler 0 bei jeder Ablehnung), H (`applyDecidedDiceRoll`, kein Client-Schema für Werte), M4/M19 |
| §6.2 Ergebnisse sind die Wahrheit; Random-/Seed-Bestand offen benannt | H (Replay), DB-Test (Event-Replay), zweiter Prozess, `handoff.md` 1, `matrix.md` |
| §6.3 Atomar/Konkurrenz: gleiche `commandId`, zwei Roll-Absichten, Hold gegen Roll, späterer Zug, Wiederherstellung nach Commit, zweiter Prozess | `diceTurn.cas.integration.test.ts` (16), ehrliche RNG-Zählung (10 berechnet, 1 gespeichert), Absturz vor/nach Commit |
| §7.1 Vertrag, Projektion, Empfängerbindung, Sehen ≠ Handeln | I (Allowlist, Leak-Probe, `you` nur PLAYER, Teammodus, strenges Schema), Intake/Komponente/Browser S1b |
| §7.2 Versionswissen, Ketten, jede Ebene einzeln | `diceIntake.test.ts` (23), `DiceTray.test.tsx`, Browser S8/S10/S11, M5/M6/M14/M15 |
| §7.3 Bedienung, Animation, Sendesperre | `DiceTray.test.tsx` (29), Browser S4/S6/S12/S14/S17, F1, M7/M13 |
| §8.1 aussagekräftige Tests, Browserfälle (Rollen, Halten, Folgewurf, Doppelklick, verspätete Zustellung, Empfängerwechsel, Reload, neuer Zug desselben Spielers, alter Animationscallback) | S1–S14, S10b, S17 (Zustellung je Empfänger abgewartet, nicht `sleep`; Sperrfenster über abgeschlossene Sendungen gemessen) |
| §8.2 historische Fehler | `review.md` D |
| §8.3 Gegenproben und Mutationen | `review.md` B/E |
| §9 Checks, Dokumentation, Wiederaufnahme | Prüfläufe oben; `design.md`, `matrix.md`, `review.md`, `acceptance.md`, `handoff.md` (Wiederaufnahmestand); zentrale Matrix N1–N9 (`g5-consumer-acceptance/matrix.md` Abschnitt 5) |
| Nachbesserung N9-01 (Ursprung der Absicht), N9-02 (Receipt-Payload im Harness), N9-03 (Zählerkapazität vor RNG) | `review.md` G; Domäne K/K2, DB-Tests (verspätete Erstzustellung, Receipt-Konflikt), Komponente (Ursprung, zwei Kontexte), Browser S10c/S7b, Typprüfung des Harness, Mutationen N1-a…N3-c |
| §10 Abschlussbericht | PR-Beschreibung und Chat-Abschluss |

## Wo die unabhängige Prüfung zuerst hinsehen sollte
1. `packages/shared/src/dice.ts` — der gesamte Client-Vertrag (kein Schema, das Werte vom Client nimmt; Projektionsinvarianten; **Ursprung der Absicht**: `DiceActionBindingSchema`/`DiceHoldIntentSchema`).
2. `apps/server/src/games/core/diceTurn.ts` — Reihenfolge der Prüfungen in `rollDice`/`setDiceHeld` (N8 zuerst, Kapazität, Zufall zuletzt), `diceActionArgsFromIntent`, `applyDecidedDiceRoll`, `projectDiceTurn`.
3. `apps/server/src/games/core/diceTurn.cas.integration.test.ts` — Kopfkommentar (was echt, was Stand-in), `persist` (CAS als einziger Wächter), „späterer Zug desselben Spielers“, „vergisst die Würfel“, Absturz nach dem Commit, zweiter Prozess.
4. `apps/web/src/dice/diceIntake.ts` + `DiceTray.tsx` — Kontext = Sequenz, Ebenenordnung, Sperre je Bindung, `aria-disabled` (F1).
5. `apps/web/harness/n9-dice/check.cjs` Szenarien S4, S7b, S10b, S10c, S11, S14 und `server.ts` (Datenbank-Lesepfad, `persist`, Receipt-Payload).
6. `docs/implementation/n9-dice-foundation/review.md` (Befunde F1–F7, Abschnitt G zur unabhängigen PR-Prüfung, Messfehler C1–C12, Mutationstabellen).
