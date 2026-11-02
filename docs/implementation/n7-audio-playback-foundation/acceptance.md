# N7 — Abnahme

Base: `main` @ `1ac064f4933df90067bccd8dfb2c20115501c44e` (N1–N6 und PR #36 gemergt; main-CI-Lauf 41411675476 grün). Branch `claude/n7-audio-playback-foundation`. Der Head dieses Branches und der zugehörige CI-Lauf stehen in der PR-Beschreibung (ein Commit kann seinen eigenen Hash nicht enthalten); frühere grüne Läufe gelten nach einer weiteren Änderung nicht.

## 1. Akzeptanzstand (ehrlich)

* **Grundlage/Helfer vorhanden. 0 neue echte Engine-Verbraucher.** Kein Spiel, keine Seite, kein Socket-Ereignis, kein HTTP-Endpunkt, keine Migration, keine neue Pipeline.
* **Das vollständige Core-DoD nach Master §13.2 bleibt offen**, solange die dort verlangten unterschiedlichen echten Engine-Nutzungen fehlen. Das Song-Spiel ist **nicht** fertig; Punkte, Buzzer, Bewertung, Wiederöffnung, Ersatzclips und automatische Wiederholungen sind nicht entschieden und nicht umgesetzt (DEC-SNG-01 bleibt offen).
* Im zugesagten N7-Umfang wird die Grundlage als fertig gemeldet, weil: (1) der Serververtrag deterministisch geprüft ist, (2) der Browser den aktuellen autorisierten Plan einschließlich Autoplay-Sperre, Laden, Pause, Fortsetzung und spätem Wiedereinstieg umsetzt (Unit **und** echter Chromium), (3) alte Daten, Ereignisse, Timer, URLs und Promise-Rückmeldungen weder einen überholten Clip wiederbeleben noch einen neuen beschädigen können (Tests beider Modelle, Mutationen), (4) der Informationsschutz an der Auslieferungsgrenze der Projektion gilt (kein Resolver-Aufruf, keine Metadaten), (5) reale Browser-/Mediennachweise und die Eigenprüfung durchgeführt und in `review.md` dokumentiert sind, (6) die Checks des Endstands bestanden sind. Offene Voraussetzungen stehen in `handoff.md`; sie verhindern eine Fertigmeldung der **Engine-Anbindung**, nicht der Grundlage.

## 2. Ausgeführte Checks (Endstand, ruhige Maschine, nacheinander)

| Check | Ergebnis |
|---|---|
| `pnpm typecheck` | grün (shared, game-sdk, web, server) |
| `pnpm lint` | 0 Fehler (Warnungen unverändert zum Bestand) |
| `pnpm build` | grün |
| `pnpm --filter @quiz/server test` (Skript legt frische Testdatenbank an) | **88 Dateien, 1169 Tests grün** (davor 87 / 1086; +83 = `audioPlayback.test.ts`) |
| `pnpm --filter @quiz/web test` | **48 Dateien, 565 Tests grün** (davor 439; +126 = Uhr 14, Intake 26, Controller 63, Komponente 18, unabhängige Gegenproben 5) |
| Chromium-E2E wie in der CI (frische DB, `playwright test --project=chromium`) | **45 von 45 grün** |
| N7-Chromium-Harness `node apps/web/harness/n7-audio/check.cjs` (S1–S8 + Layout) | 3 Läufe an der ruhigen Maschine und 1 Lauf unter 6 CPU-Dauerschleifen: **je 0 Probleme** |

Stand dieser Tabelle: nach der Nachbesserung zu PR #37 (§7). Zum ersten Head `1cc8cb3` war es Server 88/1166, Web 47/526, Harness S1–S5.

Nicht ausgeführt: Safari/WebKit, Firefox, mobile Hardware, Produktionsnetz, echte Lautsprecherausgabe.

## 3. Gemessene Browserwerte (Playwright 1.63.0, Chromium 153.0.8010.12 Headless, Linux, 4 CPUs)

Gemessen wird der Abstand der `currentTime` des echten Elements zur Zielposition des Serverplans **zum selben Serverzeitpunkt** (Mittelpunkt des Probe-Roundtrips) und der Abstand zweier Kontexte.

| Lauf | max. Abweichung zum Plan | max. Abweichung zwischen zwei Kontexten | Proben |
|---|---|---|---|
| ruhig 1 | 70 ms | 3 ms | 24 |
| ruhig 2 | 95 ms | 9 ms | 24 |
| ruhig 3 | 66 ms | 5 ms | 24 |
| unter Last (6 Dauerschleifen) | 132 ms | 21 ms | 24 |
| (erster Head `1cc8cb3`: ruhig / unter Last) | 11–67 ms / 17 ms | ≤ 9 ms / 14 ms | 21 |

**CI-Toleranz 500 ms** (`N7_TOL_MS`): bewusst großzügig gegenüber den gemessenen ≤ 132 ms, weil CI-Runner langsamer sind und die Messung (Roundtrip der Probe, Timerjitter) selbst Millisekunden-Rauschen enthält; sie liegt oberhalb der Driftkorrektur-Toleranz (250 ms), damit eine korrekt arbeitende Korrektur nicht als Fehler zählt, und weit unter der Größenordnung „falsche Position“ (Sekunden). Es wird **keine** samplegenaue oder geräteübergreifend garantierte Synchronität behauptet.

Zusätzlich gemessen/assertiert: Pegel am Analyser (RMS > 0,02; gemessen ≈ 0,116) und Frequenz (440 ± 40 Hz; gemessen ≈ 430–441 Hz); vor dem Anker kein laufendes Element und kein Pegel (mindestens 10 Proben, assertiert); Spät-Zuschaltung landet bei > 2 s statt bei 0; Pause friert die Position (< 60 ms Bewegung in 1,5 s); Fortsetzen ab gespeicherter Position; Entzug gibt Element und Quelle frei (kein `src` im DOM); BLIND_HOST: **kein Audioobjekt**, **0 URL-Auflösungen**, Wiedergabe erst nach Öffentlichwerden.

Echtes Browser-Autoplay: Chromium lehnt `play()` ohne Nutzeraktivierung mit `NotAllowedError` ab (vorab in einem Minimalversuch bestätigt: Playwrights `page.evaluate` trägt selbst eine Nutzeraktivierung — daher beobachtet der Autoplay-Kontext nur mit Locator-Lesezugriffen und Wartezeit in Node). Die UI zeigt den verständlichen Text und die Aktion, **Tab + Enter** (echter Tastendruck) startet die Wiedergabe an der aktuellen Planposition (> 1,5 s), nicht am Clipanfang. Ein gemocktes `play()` bleibt ein Unit-Test; ein stummgeschaltetes Autoplay wurde nicht als Beleg verwendet (das Audio ist nicht stumm; der Pegel wird gemessen). **Safari/iOS ist ungeprüft.**

Layout: 320 / 390 / 1280 px × dunkel/hell mit langem deutschem Titel (überlanges Wort) im Autoplay-Zustand, zusätzlich der Fehlerzustand bei 320 px hell: kein horizontaler Überlauf, keine gekappten Elemente, Aktion vollständig sichtbar und ≥ 44 px, keine Popovers. Screenshots entstehen mit `check.cjs <Ausgabeordner>`.

## 3b. Reproduktion

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm build
pnpm --filter @quiz/server test
pnpm --filter @quiz/web test
# E2E wie in der CI: frische DB, dann playwright
node apps/web/harness/n7-audio/check.cjs [Ausgabeordner]   # startet Backend (Port 5196) und Vite (5197) selbst; benötigt ffmpeg
```

## 4. Ergebnis der separat behandelten main-CI-/ACK-Timeout-Untersuchung (Vorarbeit)

**Status: behoben und gemergt (PR #36, Squash `1ac064f`); die Ursache war *nicht* „CPU-Last“. Eine verbleibende Unsicherheit ist benannt.**

* **Test:** `g4Restart.integration.test.ts` › „Limits: the in-memory budget …“. Run 41366905419, Job 125028872219, `main` @ 21eb3a9.
* **Eingrenzung:** Der Timeout tritt im **60er-Burst** auf: die ca. 20 vom Ratenlimit angenommenen `geo:answer` erhalten >6 s keine Antwort (Test-ACK-Limit). Verbindungsaufbau, Restart, Resubscribe und der anschließende ACK waren nicht betroffen. Im Kindprozess-Log erscheinen die angenommenen Handler nach ≈5 s mit `PrismaClientKnownRequestError P1008` (SQLite-Sperre) → `INTERNAL_ERROR`.
* **Ursache (belegt):** Prismas Query-Engine führt SQLite-Aufrufe synchron auf ihren Worker-Threads (einer pro CPU) aus. Ein Schreibzugriff, der auf die SQLite-Schreibsperre wartet, blockiert einen Thread bis zum 5-s-Busy-Timeout. Hält eine interaktive Transaktion (`BEGIN IMMEDIATE`, Engine-Schreibpfad einer receipted Aktion) die Sperre und warten mindestens so viele Autocommit-Writer (Command-Receipt-INSERTs des Bursts) wie Threads, bleibt kein Thread für das nächste Statement der Transaktion. Sie läuft erst nach 5 s weiter. Der Fehler ist ein echter Produktfehler des Receipt-Burst-Pfads, kein reines Testproblem.
* **Reproduktion:** (a) im Suite-Kontext nur unter Last (drei getrennte Schleifen à 30 Iterationen je Lauf trafen den Fehler im 3., 4. bzw. 5. Lauf; mit Transaktions-Tracing: `BEGIN IMMEDIATE` ohne `COMMIT`, vier `INSERT … command_receipts` mit je 5 018–5 035 ms); (b) **deterministisch ohne Last** in einem eigenständigen Skript: ab so vielen gleichzeitigen Writern wie CPUs (4 CPUs: 4 Writer → Stall, 3 Writer → kein Stall); `connection_limit=40` hilft nicht, `connection_limit=1` behebt es.
* **Behebung (PR #36, getrennter Commit):** SQLite-URLs erhalten `connection_limit=1` (`persistence/sqliteUrl.ts`, Singleton in `persistence/prisma.ts`); die Writer warten im Pool statt Threads zu blockieren. Der Test selbst blieb **unverändert** (keine Lockerung, kein skip, kein höherer Timeout, kein Retry, keine Worker-Reduktion). Neuer Test: Burst mit mehr Writern als Threads gegen eine offene Transaktion — ohne Fix rot (P2028/P1008, 15 s), mit Fix grün (< 1 s).
* **Nachweise:** Originalszenario unter Last nach dem Fix: 6 Läufe = 180 Iterationen ohne Fehler/P1008 (vorher 3 Treffer in 12 Läufen); volle Server-Suite 87/1086 grün, E2E 45/45; main-CI-Lauf 41411675476 auf `1ac064f` grün.
* **Verbleibende Unsicherheit:** (1) Der CI-Log des fehlgeschlagenen Laufs enthält die Kindprozess-Meldung (P1008) nicht; die Zuordnung der CI-Ausfälle zu dieser Ursache stützt sich auf die identische Signatur (derselbe Test, dieselbe Phase, derselbe ACK-Timeout) und die lokale Reproduktion, nicht auf ein CI-Log. (2) Ein einzelner grüner main-Lauf nach dem Fix beweist die Behebung nicht; der Mechanismus ist es, der sie stützt. (3) Tests, die `globalThis.__prisma` mit eigenem `PrismaClient` überschreiben, behalten den Standard-Pool; sie fahren keinen Receipt-Burst gegen eine offene Transaktion.
* **Folge für N7:** keine; N7 berührt Datenbank und Receipt-Pfad nicht. Dieser Befund wird **nicht** als N7-Leistung ausgegeben.

## 5. Was N7 ausdrücklich nicht behauptet

* keine Safari-/Mobil-/Netzwerkaussage; keine Lautsprecherausgabe; keine samplegenaue Synchronität;
* kein Geheimnisschutz durch URL oder UI (ausgelieferte Bytes bleiben beim Empfänger);
* keine Aussage zu Punkten, Buzzer, Bewertung, Wiederöffnung, Ersatzclips, automatischen Wiederholungen;
* keine Änderung von `ContentMedia`, der Audio-Pipeline, des Medienpfads oder der G4-Engines.

## 7. Nachbesserung zu PR #37 (unabhängiger Prüfbericht, Befunde N7-01 bis N7-03)

Der Bericht fand am Head `1cc8cb3` drei P2-Befunde (URL-Erneuerung ohne Ordnung, lokales `ended` blockiert gültige Fortsetzung, Wiedergabe trotz fehlgeschlagener Positionierung) und fünf rote Gegenproben; die CI war grün, weil diese Gegenfälle nicht abgedeckt waren. Alle drei Befunde sind behoben; die fünf Gegenproben liegen als `n7IndependentReview.test.ts` im Repository und laufen grün (Probe 1 mit der nun verlangten Ordnungszahl). Details: `design.md` §11, `review.md` §9, `matrix.md` G.

* **Vertragsänderung (präzisiert, nicht abgeschwächt):** `source` trägt jetzt `renewal` (Ordnungszahl der Ausstellung); `projectAudioPlayback` nimmt `resolveSource` statt `resolveUrl`; neuer `createRenewalIssuer`. Weiterhin 0 Verbraucher, keine Migration, kein Endpunkt.
* **Browser (S6–S8, echtes Chromium):** Die Erneuerungsreihenfolge bleibt für die laufende Ressource wirkungslos; nachlaufendes `ended` nach Pause bei real am Ende stehendem Element und echtes lokales Ende vor dem autoritativen Ende; später Einstieg auf einem nicht seekbaren Stream: 20 Proben ohne laufendes Element, neutraler Fehler, Retry an der Planposition. Rot-Nachweise im Browser: N01, N02c, N03; **nicht** gefangen: N02d (nur Schicht 2 entfernt; Schicht 1 schützt).
* **Aussagen, die ich nicht mache:** keine Aussage zu Safari/iOS; keine Aussage, dass der produktive Medienpfad Range unterstützt, über das Lesen von `res.sendFile` hinaus (nicht durch N7 getestet); Erneuerungsfehler des Adapters sind nicht modelliert.
* **Verbleibende Unsicherheit der Nachbesserung selbst:** Die Schicht „Merker an die Plan-Entscheidung“ (N7-02) ist im echten Browser nicht isoliert prüfbar; sie ist nur durch Unit-Tests und die Unit-Mutation M25 belegt.
