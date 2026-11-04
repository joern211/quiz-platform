# N11 — Abnahme (Anforderungen → Nachweis)

Stand: 04.11.2026. Basis `main` @ `93305a864d855307e64c9dcab8d9675e1b4509a2` (N10 gemergt; main-CI 41819243936 `completed/success`). **N11-Grundlagenpaket umgesetzt / reviewbereit** — nicht „Raus damit! fertig“. **0 neue echte Engine-Verbraucher.** Core-DoD (Master §13.2) bleibt offen.
Finaler Head, PR-Nummer und die CI am **finalen** Head stehen in der PR-Beschreibung und im Abschlussbericht (ein Commit kann seinen eigenen Hash nicht enthalten). Die lokalen Läufe liefen am Codezustand `a69b8ac`/`fde945c` (danach nur Harness-Skript und Dokumente); alle lokal in der Cloud-Sitzung, **nicht** in GitHub-CI.

## Prüfläufe (lokal, Linux, Node 22.23.4, nacheinander)
| Prüfung | Befehl | Ergebnis |
|---|---|---|
| Alles | `pnpm check` (Typecheck, Lint, Test, Build) | Exit 0 |
| Typecheck | in `pnpm check` | grün, einschließlich Harness `harness/n11-board` (Server- und Web-Projekt) |
| Lint | in `pnpm check` | 0 Fehler, 109 Warnungen (**identisch zum Ausgangswert**, keine in N11-Dateien); `git diff --check` leer |
| Server | in `pnpm check` | **100 Dateien, 1679 Tests**, 3 übersprungen (vorbestehend) (Ausgangswert N10: 98 / 1608; +71 Tests: `boardState.test.ts` 51, `boardState.cas.integration.test.ts` 20) |
| Web | in `pnpm check` | **62 Dateien, 794 Tests** (Ausgangswert N10: 60 / 759; +35: `BoardView.test.tsx` 19, `boardIntake.test.ts` 16) |
| Build | in `pnpm check` | grün (bekannte Chunk-Größen-Warnung); der gebaute Server lädt den Brettvertrag im Plain-Node-Strip-Modus (`gameErrorCode`-Whitelist; `rate-limiter.integration.test.ts` startet `dist/app.js`) |
| E2E | `CI=true pnpm test:e2e -- --project=chromium` (frische SQLite: `migrate deploy` + `db:seed`) | **45 bestanden**, 0 Retries, 0 Skips (wie Ausgangswert). Die E2E-Suite enthält bewusst keine N11-Route. |
| N11-Harness | `node apps/web/harness/n11-board/check.cjs` | **15 Szenarien**, am Endstand 4 Läufe hintereinander grün (je ~17–18 s), danach keine Kindprozesse. Chromium (Playwright), getrennte Kontexte (Halter, anderer Spieler, Viewer), echte Domäne mit echter SQLite |
| Mutationsprüfung | `review.md` B | 23 Mutanten, alle gefangen; Browsertreffer für 10 davon; Arbeitsbaum danach sauber |
Warnungen/Fehler im Lauf: nur vorbestehende Logzeilen (Audio-Prozessor nicht verfügbar im Test, `[WebServer]`-Stacktraces der E2E-Prozesse beim Beenden); keine neuen.

## Ehrliche Grenzen der Nachweise
- **Echt:** SQLite aus den realen Migrationen, die gemeinsame CAS `saveGameStateIfRevision` (im Stand-in der **einzige** Wächter, M13), echtes `runReceipted`/`CommandReceipt`, echte `GameDomainEvent`-Zeilen über `materializeGameEvent` (in derselben Transaktion direkt vor dem CAS-Schreiben, wie in N9/N10 begründet), die Einzelverbindungs-URL, ein zweiter Node-Prozess, echtes Chromium. **Nicht echt:** keine Engine (Stand-in `{ phase, standIn, turnSequence, dice, board }`), keine Route/Socket/Session/Admission (Aufrufer, Gate, N6-Stand sind Tabelleneinträge), kein Setup-Snapshot, keine Punkte. **Harness/Stand-in ≠ Produktionspfad.**
- Konkurrenz im Receipt-Pfad: welcher Wächter zuerst greift (`STATE_CONFLICT`, `COMMAND_STATE_ADVANCED`, `BOARD_*_STALE`), wurde nicht ausgewertet; die Tests lassen die bekannten Codes zu und prüfen den gespeicherten Endzustand.
- Chromium-Emulation (320/480/1100 px), **kein** iPhone/Safari, **kein** Screenreader; JSDOM ist kein Layoutnachweis. Teammodus nur auf Domänenebene. Mutationen sind Eigenprüfung.

## Anforderungen → Nachweis
| Auftrag | Nachweis |
|---|---|
| §1 Basis/CI/Quellen | `design.md` Kopf, `handoff.md` |
| §2 Zustand, Validierung (doppelte IDs, unbekannte Felder/Eigentümer, ungültige Konfiguration, unmögliche Positionen) | `boardState.test.ts` Beschädigungstabelle (25 Fälle) + `prepareBoard`; DB-Test beschädigter Snapshot |
| §2 Ziele, deterministischer Übergang, Schlagen + Rücksetzung atomar, Heimfeld, Ziel bei Anwendung erneut geprüft | Domäne „positive paths“, „the pure transition“ (Gegenproben auf `captured`/`steps`/`to`/Eigentümer) |
| §2 N8/N6/N9, Wurf nur einmal, abgelehnter Zug verbraucht nichts, Retry ohne zweite Bewegung | Domäne „spent roll“, DB-Test (Wurf verbraucht, Receipt-Replay), Browser S5/S7 |
| §2 Ursprung der Absicht (Run, Brett, Folge, Zug, Wurf; gleiche Zähler in anderem Kontext), N8-Basis, Reserve | Domäne „foreign and stale“ + „versions“, DB-Test (5 Ziele, erstmalige Zustellung), Browser S8, S11, M3/M7/M8/M14 |
| §2 Grenze Brettübergang ↔ Adapter; ein Commit; abgewiesener/verlorener Schreibversuch ohne Teilzustand; Recovery ohne erneutes Bewegen | `design.md` §4, `handoff.md`; DB-Test (Fehler vor Commit, Absturz nach Commit, zweiter Prozess), Browser S13 (Neustart) |
| §2 Projektion, Anzeige, Intake, Tastatur, schmaler Viewport, Theme | `projectBoard`-Tests (Leak-Probe, Empfänger), `BoardView.test.tsx`, `boardIntake.test.ts`, Browser S1, S6, S14 |
| §4 Positivpfade (normal, Schlag, Heim, kein Ziel, zwei Figuren, neuer Zug, Reload/Neustart) | Domäne, DB, Browser S2/S4/S10/S12/S13 |
| §4 Fremde/alte Zustände (Figur, Viewer/Host, Team, Entzug, Pause, anderes Brett/Run, alter Wurf, fehlende/gemischte Versionen, verspätete Erstaktion ohne Receipt) | Domäne, DB (`it.each` 5 Ziele ohne Receipt), Browser S8/S10/S12 |
| §4 Konkurrenz/Wiederholung (zwei Ziele, gleiche commandId identisch/verändert, Fehler vor/Antwort nach Commit; Zustand + Events + Receipt zusammen) | DB-Test (je Fall Revision, Events, Receipts gelesen), Browser S7/S7b |
| §4 Clientverhalten (Doppelklick, Alternativziele, Retry, späte Bestätigung/Ablehnung, fremde/leere Sicht dann älteres Paket, Untergrenze) | `BoardView.test.tsx`, `boardIntake.test.ts`, Browser S3/S3b/S7/S9 |
| §4 Versions-/Zustandsgrenzen | Domäne „versions“ (BASIS ohne Bewegung, erschöpfte Zähler, fehlende Reserve), Beschädigungstabelle |
| §4 Zweite Prüfung + Gegenversuche | `review.md` |
| §5 Doku, Matrix, Übergabe | dieses Verzeichnis, `../g5-consumer-acceptance/matrix.md` Zeile N11 (H, 0 Verbraucher) |
