# N11 — Abnahme (Anforderungen → Nachweis)

Stand: 04.11.2026. Basis `main` @ `93305a864d855307e64c9dcab8d9675e1b4509a2` (N10 gemergt; main-CI 41819243936 `completed/success`). **N11-Grundlagenpaket umgesetzt / reviewbereit** — nicht „Raus damit! fertig“. **0 neue echte Engine-Verbraucher.** Core-DoD (Master §13.2) bleibt offen.
Finaler Head, PR-Nummer und die CI am **finalen** Head stehen in der PR-Beschreibung und im Abschlussbericht (ein Commit kann seinen eigenen Hash nicht enthalten). Die lokalen Läufe unten liefen am Codezustand nach der Nachbesserung N11-01 (06.11.2026; letzter Code-/Testcommit, danach nur Dokumente); alle lokal in der Cloud-Sitzung, **nicht** in GitHub-CI. Stand davor (Erstabnahme, PR-Head `b832241`): Server 1679 / Web 794 / E2E 45 / Harness 15, GitHub-CI und E2E grün.

## Prüfläufe (lokal, Linux, Node 22.23.4, nacheinander)
| Prüfung | Befehl | Ergebnis |
|---|---|---|
| Alles | `pnpm check` (Typecheck, Lint, Test, Build) | Exit 0 |
| Typecheck | in `pnpm check` | grün, einschließlich Harness `harness/n11-board` (Server- und Web-Projekt) |
| Lint | in `pnpm check` | 0 Fehler, 109 Warnungen (**identisch zum Ausgangswert**, keine in N11-Dateien); `git diff --check` leer. (Ein Zwischenlauf hatte 12 Fehler in der übernommenen Prüfdatei — ungenutzte Importe/Helfer, behoben, Testkörper unverändert.) |
| Server | in `pnpm check` | **102 Dateien, 1707 Tests** (Ausgangswert N10: 98 / 1608; +99: `boardState.test.ts` 69, `boardState.cas.integration.test.ts` 25, Prüferdateien `n11-independent-review.test.ts` 4 und `n11-independent-cas-review.test.ts` 1) |
| Web | in `pnpm check` | **62 Dateien, 794 Tests** (Ausgangswert N10: 60 / 759; +35: `BoardView.test.tsx` 19, `boardIntake.test.ts` 16; unverändert zur Erstabnahme, das geschärfte Projektionsschema ließ alle Fixtures gültig) |
| Build | in `pnpm check` | grün (bekannte Chunk-Größen-Warnung); der gebaute Server lädt den Brettvertrag im Plain-Node-Strip-Modus (`gameErrorCode`-Whitelist; `rate-limiter.integration.test.ts` startet `dist/app.js`) |
| E2E | `CI=true pnpm test:e2e -- --project=chromium` (frische SQLite: `migrate deploy` + `db:seed`) | **45 bestanden**, 0 Retries, 0 Skips (wie Ausgangswert). Die E2E-Suite enthält bewusst keine N11-Route. |
| N11-Harness | `node apps/web/harness/n11-board/check.cjs` | **16 Szenarien** (neu S16 beschädigter Snapshot), am Endstand 2 Läufe hintereinander grün (je ~18 s), danach keine Kindprozesse. Chromium (Playwright), getrennte Kontexte (Halter, anderer Spieler, Viewer), echte Domäne mit echter SQLite |
| Mutationsprüfung | `review.md` B und F | 23 + 12 Mutanten (Erstabnahme + N11-01), alle gefangen; Browsertreffer für 11 davon; Arbeitsbaum danach sauber |
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

## Nachbesserung N11-01 (Prüfbericht 06.11.2026): Anforderungen → Nachweis
| Auftrag | Nachweis |
|---|---|
| Head geprüft, Gegenproben zuerst reproduziert | Head unverändert `b832241`; 5 Prüfer-Tests am alten Stand rot, SQLite-Ausgabe `revisionAfter: 6` (`review.md` F) |
| Ladeinvarianten aus Geometrie und `lastMove` (Schrittzahl = Routenabstand, Möglichkeit des Schlags) | `boardLastMoveIssues` (Shared); `boardState.test.ts` „N11-01“ (Schrittzahl, Richtung, 7 Schlagverletzungen); Mutationen N1, N2, N4, N5, N12 |
| Konsistenz Brett/N8/N9 bei Mutation **und** Projektion; Zug aus der Zukunft, Marker für noch nicht existierenden Wurf desselben Vorgangs | `assertBoardConsistent`; Domäne (5 Zielgruppen × 2 Freigaben, Zug), SQLite (3 Beschädigungen), Browser S16 (4); Mutationen N6–N10, N13 |
| Fehlercode/Recovery-Pfad, beim Laden nichts verändern | `BOARD_STATE_INVALID` über `gameErrorCode`; Eingabe eingefroren und unverändert; SQLite: Stand, Revision, Events, Receipts vorher = nachher |
| Positivkontrollen (neuerer Wurf desselben Vorgangs, späterer Zug mit neuem Vorgang, Receipt-Replay, Roundtrip) | Domäne „positive controls“, SQLite „positive control“ (zweiter Wurf desselben Vorgangs persistiert, alter Command bleibt Replay, keine neuen Events), Browser S16 (danach reguläre Welt) |
| Gegenproben übernommen, Testaufbau-Änderungen erklärt | `n11-independent-*.test.ts` (Körper unverändert; nur ungenutzte Importe/Helfer und ein `console.log` entfernt, siehe Kopfkommentar); Fixture-Korrektur im eigenen Zählertest (zweiter Vorgang im selben Zug war gegen N9), `review.md` F |
| SQLite-Reproduktion grün | Prüfer-Test `n11-independent-cas-review.test.ts`: `revisionBefore 5 = revisionAfter 5`, `a1` bleibt auf `t1` |
