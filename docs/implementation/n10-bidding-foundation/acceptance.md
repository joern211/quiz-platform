# N10 — Abnahme (Anforderungen → Nachweis)

Stand: 04.11.2026 (nach der Nachbesserung zur unabhängigen PR-Prüfung, `review.md` F; Prüfstand davor: Commit `5596c16`, CI 41557252040 grün mit 1592 Server-/735 Web-/45 E2E-Tests). Basis `main` @ `4d10e10fbe63d4afc454738c6a4bbc804c94da97` (N9 gemergt; beim Start per `git fetch` bestätigt). Post-Merge-CI 41549455618 beim Start: Job „CI“ **success**, Job „E2E“ **in_progress** (Ergebnis siehe unten, wenn abgerufen). **N10-Grundlagenpaket umgesetzt / reviewbereit** — nicht „Bietmechanik für alle Spiele fertig“. **0 neue echte Engine-Verbraucher.** Der vollständige Core-DoD nach Master §13.2 bleibt offen.

Head, PR-Nummer und die CI am **finalen** Head stehen in der PR-Beschreibung und im Abschlussbericht (ein Commit kann seinen eigenen Hash nicht enthalten). Die lokalen Läufe unten liefen am Codezustand des letzten Code-Commits; danach änderten sich nur Dokumente.

## Prüfläufe (lokal, nacheinander, ohne parallele Last)

| Prüfung | Befehl | Ergebnis |
|---|---|---|
| Typecheck | `pnpm typecheck` | Exit 0 — einschließlich der Harnesses (`harness/n9-dice`, `harness/n10-bidding`, je Server- und Web-Projekt) |
| Lint | `pnpm lint` | Exit 0 — 0 Fehler, 109 Warnungen (**identisch zum Ausgangswert**; `eslint` auf allen N10-Dateien ohne Befund); `git diff --check` ohne Befund |
| Build | `pnpm build` | Exit 0 (bekannte Chunk-Größen-Warnung); der gebaute Server lädt den Biet-Vertrag im Plain-Node-Strip-Modus (`gameErrorCode(new Error('BIDDING_VALUE_NOT_HIGHER'))` aus `dist` liefert den Code; die Selbstreferenz auf `@quiz/shared/numeric` löst Node über `exports`) |
| Server | `pnpm --filter @quiz/server test` | Exit 0 — **98 Dateien, 1608 Tests** (Ausgangswert N9: 95 / 1432; +176: `biddingPhase.test.ts` 155, `biddingPhase.cas.integration.test.ts` 21, `n10IndependentReview.test.ts` 3 — enthalten sind die neuen Abschnitte I (N5 → N10) und J (Abschlussreserve)) |
| Web | `pnpm --filter @quiz/web test` | Exit 0 — **59 Dateien, 754 Tests** (Ausgangswert N9: 55 / 685; +69: `BiddingPanel.test.tsx` 45 inkl. Retry-Ketten, `biddingIntake.test.ts` 14, `sendAttempts.test.ts` 5, `n10IndependentReview.test.tsx` 4 — Dateien sind 4: Panel, Intake, Versuchszustand, Prüfer) |
| E2E (Chromium) | `CI=true pnpm exec playwright test --config=playwright.config.ts --project=chromium` mit frischer SQLite-DB (`migrate deploy` + `db:seed`) | Exit 0 — **45 bestanden** (wie Ausgangswert). Die E2E-Suite enthält bewusst keine N10-Route. |
| N10-Harness | `node apps/web/harness/n10-bidding/check.cjs` | Exit 0 — **15 Szenarien** (neu S15: Ablehnung → genau eine Wiederholung; mehrfach am Endstand, zuletzt 20,4 s), getrennte Chromium-Kontexte (Bidder ×3, Performer ×3, Viewer, Display, Host, mitspielender Host als Performer) gegen die echte Domäne mit echter SQLite; keine Kindprozesse zurückgeblieben |
| Mutationsprüfung | `review.md` B und F | 16 Mutanten + Harness-Payload-Variante (B) und 12 weitere zur Nachbesserung (F: U1–U6, S1–S6), alle gefangen; Browsertreffer für M4a, M5, M7a (Harness), M12, U2; Arbeitsbaum danach sauber |
| Post-Merge-CI main (Start) | GitHub Actions 41549455618 | `completed/success` (beim späteren Abruf; beim Start war der E2E-Job noch `in_progress`) |
| GitHub-CI am letzten Head | siehe PR | nach dem Push zu prüfen; Zahlen und Joblogs stehen im Abschlussbericht |

## Ehrliche Grenzen der Nachweise
- **Echt:** SQLite aus den realen Migrationen, die gemeinsame CAS `saveGameStateIfRevision` (im Stand-in der **einzige** Wächter, M7b), echtes `runReceipted`/`CommandReceipt`, echte `GameDomainEvent`-Zeilen über `materializeGameEvent` (in derselben Transaktion direkt vor dem CAS-Schreiben, weil `saveGameStateIfRevision` das Event nur zusammen mit `persistRoundResult` für registrierte Engine-Slugs schreibt), die Einzelverbindungs-URL, ein zweiter Node-Prozess, echtes Chromium. **Nicht echt:** keine Engine (Stand-in-Zustand `{ phase, standIn, turnSequence, bidding }`), keine Route/Socket/Session/Admission (Aufrufer, Gate und N6-Stand sind Tabelleneinträge), kein Setup-Snapshot, keine Punkte.
- Im Rennen mehrerer `commandId`s und im Rennen „Gebot gegen Pass“ entscheidet die CAS (`GameStateConflictError`); welcher Wächter im Receipt-Pfad zuerst griff (`TURN_SEQ_*_STALE`, `STATE_CONFLICT`, `COMMAND_STATE_ADVANCED`), wurde nicht ausgewertet — die Tests lassen die bekannten Codes zu und prüfen den gespeicherten Endzustand.
- Chromium-Emulation (320/480/1280 px), **kein** iPhone/Safari-Hardwaretest, **kein** Screenreader-Test (NVDA/VoiceOver); JSDOM ist kein Layoutnachweis.
- Ein lesender zweiter Prozess ist kein nachgewiesener produktiver Wiederanlauf aller Routen. Der Prozessneustart im Harness (S14) startet nur den Harness-Server neu (derselbe SQLite-Stand, Gebot danach).
- Die Mutationsprüfung ist Eigenprüfung; ein unabhängiger Prüfer hat sie nicht wiederholt.

## Anforderungen → Nachweis

| Auftrag | Nachweis |
|---|---|
| §1 main-/CI-Abgleich, neuer Branch, kein Force-Push, keine Secrets | `handoff.md`, dieser Kopf |
| §3 Bestandsaufnahme, §4 Entwurf | `design.md` (Endstand; nachträglich ausformuliert, siehe `review.md` D) |
| §5.1 Identität, Konfiguration, Zahlenvertrag, feste Codes, Grenzen | `biddingPhase.test.ts` A, C (Profil, 16 ungültige Werte, Skala, Grenzen, Locale = nur Darstellung), G (30 beschädigte Zustände) |
| §5.2 Zustände, Gebote, Ende, Pass; Randfälle ausdrücklich | C, D, E (Pass vor dem ersten Gebot abgelehnt, Abbruch, terminale Wiederholung, HELD, kein geratener Gewinner) |
| §5.3 Ergebnisgrundlage, Pass-Evidenz, wörtliche Gegenprobe | C (T3 gewinnt mit 8, Gegenteam T2, T1 früher gegen T2; 4-Teams-Beispiel), G (Ergebnis wird beim Laden neu abgeleitet), M3 |
| §5.4 Rollen innerhalb der Teams, N8, aktuelle Berechtigungen, N6/N5-Bezug | D (keine Bidder-Rotation, Override statt COMPLETE, eine Zugwahrheit), H (N5-Adapter, Rotation = neue Bietphase), M15/M16 |
| §6 Geheimhaltung, Projektionen, Empfängerbindung | F (Allowlist, Leak-Probe über alle Zielgruppen × Phasen, Host-Performer, Rollenwechsel), Browser S1/S5/S7/S9 (empfangenes JSON **und** DOM) |
| §7.1 Vollständige Herkunft der Absicht | D (je Ebene, Bid und Pass), DB-Test (6 Ziele × Bid/Pass, verspätete Erstzustellung), Browser S6, M5 |
| §7.2 Idempotenz und CAS (5 Pflichtfälle) | `biddingPhase.cas.integration.test.ts`: zwei Gebote; Gebot gegen Pass; zwei Pässe vor dem Abschluss; Commit ohne Antwort / Absturz vor Receipt; alte Absicht nach neuer Bietphase |
| §7.3 Wiederherstellung und Kapazität | G (JSON-Roundtrip, SDK-Replay, beschädigt), DB-Test (zweiter Prozess), D (Kapazität vor Wirkung) |
| §8 UI, Intake, Bedienung | `BiddingPanel.test.tsx`, `biddingIntake.test.ts`, Browser S3/S4 (Tastatur/Fokus/Doppelklick), S13 (Layout, Themes, Kontrast, Fokusring, lange Namen) |
| §9 zweite Prüfung, Mutationen, historische Muster | `review.md` |
| §10 Checks, Dokumentation, Arbeitsstand | dieses Dokument, `matrix.md`, `handoff.md`, zentrale Matrix (`../g5-consumer-acceptance/matrix.md` Abschnitt 5) |

## Nachbesserung (Prüfbericht 04.11.2026): Anforderungen → Nachweis

| Befund | Nachweis |
|---|---|
| N10-01 [P2] mehrere Wiederholungen nach einer Ablehnung / späte Ablehnung gibt eine Wiederholung frei | Prüfer-Tests (`n10IndependentReview.test.tsx` 1, 4), `BiddingPanel.test.tsx` „retry chains“, `sendAttempts.test.ts`, Browser S15, Mutationen U1–U4 |
| N10-02 [P2] Gebot bleibt nach Ablehnung im Pending | Prüfer-Tests 2, 3 (Retry-Button-Beschriftung an N1 angepasst), Tests mit tatsächlichem erneutem Submit (Aufrufzahl), Mutationen U5/U6 |
| N10-03 [P2] N5-Adapter verliert die Herkunft | Prüfer-Tests (`n10IndependentReview.test.ts` 1–2, Eingang an `roles: { source: 'N5_DEAL', … }` angepasst), `biddingPhase.test.ts` I, Mutationen S1/S2 |
| N10-04 [P3] BASIS verbraucht die Abschlussreserve | Prüfer-Test (`n10IndependentReview.test.ts` 3), `biddingPhase.test.ts` J, Mutationen S3–S6 |

Finaler Commit, Head-SHA und die CI am finalen Head stehen in der **PR-Beschreibung** (ein Dokument kann den Hash seines eigenen Commits nicht enthalten); die Läufe oben liefen am Codezustand `1398694` (danach nur Dokumente).
