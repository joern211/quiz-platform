# N10 — Abnahme (Anforderungen → Nachweis)

Stand: 03.11.2026. Basis `main` @ `4d10e10fbe63d4afc454738c6a4bbc804c94da97` (N9 gemergt; beim Start per `git fetch` bestätigt). Post-Merge-CI 41549455618 beim Start: Job „CI“ **success**, Job „E2E“ **in_progress** (Ergebnis siehe unten, wenn abgerufen). **N10-Grundlagenpaket umgesetzt / reviewbereit** — nicht „Bietmechanik für alle Spiele fertig“. **0 neue echte Engine-Verbraucher.** Der vollständige Core-DoD nach Master §13.2 bleibt offen.

Head, PR-Nummer und die CI am **finalen** Head stehen in der PR-Beschreibung und im Abschlussbericht (ein Commit kann seinen eigenen Hash nicht enthalten). Die lokalen Läufe unten liefen am Codezustand des letzten Code-Commits; danach änderten sich nur Dokumente.

## Prüfläufe (lokal, nacheinander, ohne parallele Last)

| Prüfung | Befehl | Ergebnis |
|---|---|---|
@@RUNS@@

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
