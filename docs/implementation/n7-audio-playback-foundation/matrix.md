# N7 — Testmatrix und Grenze jedes Nachweises

Dateien: S = `apps/server/src/games/core/audioPlayback.test.ts`, I = `apps/web/src/audioPlayback/playbackIntake.test.ts`, C = `…/AudioPlaybackController.test.ts`, K = `…/serverClock.test.ts`, U = `apps/web/src/components/ServerAudioPlayer.test.tsx`, H = Chromium-Harness `apps/web/harness/n7-audio/check.cjs`.

Grenzen: Ein **Unit-Test mit Audio-Double** kann Rennen deterministisch auslösen, beweist aber nichts über echtes `HTMLMediaElement`-Verhalten. Der **echte Browser (H)** prüft Medienverhalten in Chromium, nicht Safari, Mobilgeräte oder Produktionsnetz. Der **Medienintegrationstest** (`media.integration.test.ts`, `audio.integration.test.ts`, unverändert) prüft Bytes, Header, Signatur und Inhaltsfreigabe, nicht das Abspielverhalten. Keiner ersetzt automatisch den anderen.

## A. Reine Serverlogik

| Risiko | Nachweis | Grenze |
|---|---|---|
| Vor Start / exakt Start / kurz vor Ende / exakt Ende / nach Ende (halboffenes Intervall) | S „Time formula and boundaries“ (Grenzen 4999/5000/5001/14 999/15 000/15 001/…) | rein rechnerisch; kein Medium |
| Pause vor Start (Anker eingefroren, 0 bzw. gespeicherter Offset), während Wiedergabe, an der Endgrenze | S „Transitions“ | – |
| Fortsetzen ab gespeichertem Offset, neuer Anker, nie 0 | S „resume sets a NEW anchor …“, „pause before a SCHEDULED resume …“ | – |
| Stop/Ende terminal, `settle` persistiert das Ende, abgelaufenes RUNNING nicht wiederbelebt | S „stop is terminal“, „time-expired RUNNING …“ | Entscheidung: Ablehnung `AUDIO_PLAYBACK_ENDED` statt stillem Umschreiben |
| Duplikate mit aktueller Version = kein-Op, veraltete Version abgewiesen, Instanzbindung, rückläufige Uhr | S „Duplicates and versions“ | lokale Planversion ≠ globale CAS; keine Exactly-once-Garantie |
| Ungültige Dauer/Position/Zeit/Version/Einheit (12.5, NaN, ∞, 2^53, String, über 1 800 000 ms), fehlende Bindung, Zusatzfelder | S „Validation“ | – |
| Serialisierung/Recovery, Determinismus, keine Uhr/Zufall | S „Determinism, serialisation, recovery“ (Spione auf `Date.now`, `Math.random`) | – |

## B. Freigaben und Versionen

| Risiko | Nachweis | Grenze |
|---|---|---|
| HOST, mitspielender HOST, BLIND_HOST, PLAYER (eigen/Team/fremd), VIEWER, DISPLAY × PUBLIC/HOST_PRIVATE/PLAYER_PRIVATE/TEAM_PRIVATE | S „Roles and phases“ (4 Regeln × 8 Empfänger, jeweils Release und Resolver-Aufrufe) | nutzt die vorhandene `canView`; die Rollen-/Phasenentscheidung `release` trifft der spätere Verbraucher |
| `NONE`/nicht berechtigt/terminaler Plan ruft keinen URL-Resolver auf | S „NONE: … never called“, „Roles …“ (`toHaveBeenCalledTimes(0)`), „TERMINAL plan …“ | der echte Signer (`signedUrl.ts`/`contentMediaUrl`) wird hier nicht ausgeführt |
| Private Marker erscheinen nicht in unerlaubter serialisierter Sicht; keine Metadatenfelder | S „Private markers …“, „imports nothing but zod“ | Refs sind opake Labels: ihre Form wird erzwungen, ihre Bedeutung nicht (siehe handoff) |
| PLAY → neuerer Entzug → altes PLAY; PLAY → null → altes PLAY | I (beide Fälle, Kette mit `undefined`/Müll), U „withdrawal silences … late older PLAY“ | – |
| Quellose gültige Sicht hebt die Version; fremde/ungültige hohe Version nicht | I „source-less view raises“, „invalid or foreign … cannot poison“ | – |
| Mindeststand des Aufrufers unabhängig; Kontextwechsel mit leerer Kenntnis | I „caller's own minimum“, „real context change“, U „context change“ | – |
| Alle Reihenfolgen | I „EXHAUSTIVE order check“ (7 776 Folgen) | Alphabet von 6 Eingaben, Länge 5 |

## C. Browsercontroller und asynchrone Rennen

| Risiko | Nachweis | Grenze |
|---|---|---|
| `play()` erfüllt/abgelehnt nach Pause, Stop, Ende, Entzug, neuem Clip, Unmount | C „Asynchronous races“ beide Modelle (`rejectOnPause`: ja/nein) | Double; das Worst-Case-Modell (späte Erfüllung startet den Ton) ist absichtlich strenger als reale Browser |
| Alte `loadedmetadata`/`canplay`/`error`/`ended` nach Quellenwechsel | C „old loadedmetadata … after a source change“ (Listener entfernt **und** Wächter) | – |
| Alte Cleanup-/Promise-Reaktion von A verändert B nicht | C „A.play() pending → clip B loaded“ | – |
| Neue Wrapperobjekte, gleiche Snapshotversion, Uhrticks, Themewechsel starten nicht neu | C „equal input is a no-op“, U „no second play() … theme change (StrictMode)“ | – |
| StrictMode/Unmount hinterlassen keine Doppelinstanz/Timer/Listener | C „start → stop → start“, U „unmount releases …“ | – |

## D. Zeit und Laden

| Risiko | Nachweis | Grenze |
|---|---|---|
| Client-Wanduhr Minuten vor/zurück; monotone Fortschreibung | K „not touched by the wall clock“ (+9/−7 min, `Date.now` nie aufgerufen) | – |
| Verspätetes Laden/Join → aktuelle Position, nicht 0; Join nach Ende startet nicht; Hintergrund-Wakeup | C „LATE first delivery“, „metadata arriving later“, „joining after the end“, „waking from background“; H S1 (B tritt 2,5 s nach dem Anker bei) | H: Chromium |
| Metadaten fehlen/unbrauchbar, kein unkontrollierter Seek | C „unusable media state“ | – |
| Driftkorrektur innerhalb der Grenzen, keine Dauerschleife | C „drift correction stays inside its documented bounds“ (3 Fälle) | Toleranz 250 ms ist begründet, nicht bewiesen |
| Vor dem Anker nichts hörbar | C „never starts before the anchor“; H S1 (~25 Proben vor dem Anker: kein laufendes Element, kein Pegel) | – |

## E. URLs und Fehler

| Risiko | Nachweis | Grenze |
|---|---|---|
| URL-Erneuerung desselben Clips bewahrt den Plan | C „renewed URL … same clip“; H S3 (Version unverändert, Position > vorher) | – |
| Ältere Erneuerung ersetzt eine neuere nie (R1 beginnt, R2 beginnt, R2 kommt, R1 kommt; auch bei gleichem Snapshot-/Planstand); Plan/Pause bleibt erhalten; Entzug/Clipwechsel während der Erneuerung bleibt wirksam | I „N7-01“ (u. a. erschöpfend über alle Reihenfolgen), U „N7-01 through the component“, S „N7-01 (server side)“, n7IndependentReview Probe 1; H S6 (echtes Chromium, Reihenfolge durch das Skript erzwungen) | Ordnung durch die vom Aussteller vergebene Zahl; Fehlschläge der Erneuerungsanfrage sind Sache des Adapters |
| Altes Erneuerungsergebnis nach Kontext-/Clipwechsel verworfen | U „context change …late renewal“ | – |
| Alter Medienfehler markiert neuen Clip nicht | C „an old error cannot mark a new clip broken“ | – |
| Autoplay blockiert / Aktivierung rechtzeitig / nach Ende, Pause, Stop, Entzug nichts | C „autoplay blocked …“, „activation after … starts nothing“, „time-expired clip not restarted“; U Button; H S2 (echte Chromium-Ablehnung + Tastatur-Enter) | Chromium; Safari nicht geprüft |
| Lokales Laden/Retry/ended verändert keine globalen Regeln | C „local ended/failure/retry never changes the server plan“; H S4 (`state.version` unverändert) | – |

## F. Reale Integration (Chromium)

| Risiko | Nachweis |
|---|---|
| Zwei getrennte Kontexte, echtes Audioelement, deterministische Töne (440 Hz) | H S1 |
| Zielplan und Medienzustand pro Kontext abgewartet | H `waitUntil` auf Status und `paused`, Messung gegen den Serverplan zum selben Serverzeitpunkt |
| Pause/Fortsetzen/Entzug/Stop wirken am Medium; Positionstoleranz | H S1 (Toleranz 500 ms; gemessen siehe acceptance) |
| 320 px und Desktop, hell/dunkel, lange Texte, Tastatur | H S5 (6 Kombinationen + Fehlerzustand 320 px hell), S2 (Tab + Enter) |
| Metadatenbereinigung und Medienauth bleiben wirksam | unverändert: `audio.integration.test.ts` (ffmpeg/ffprobe, Metadaten-Marker), `media.integration.test.ts`; H verwendet `normalizeAudio` und liest dessen `duration` |

## G. Nachbesserung nach der unabhängigen Prüfung (PR #37)

| Befund | Nachweis | Grenze |
|---|---|---|
| N7-02: nachlaufendes `ended` nach Pause; früher lokaler EOF; neuer Fortsetzungsplan überwindet das lokale Ende | C „N7-02“ (6 Tests: Ereignis vor und nach Übernahme des neuen Plans, Element meldet `ended === false`, echtes Ende bleibt final ohne Schleife/Neustart bei 0, Stop/Ende/Entzug bleiben still, ended bei nicht erwartetem Playback wird nie gemerkt), n7IndependentReview Proben 2–3; H S7 (Pause + real am Ende stehendes Element + nachlaufendes ended, danach Fortsetzen mit Pegelmessung; echtes Ende einer 8-s-Datei unter 12-s-Plan: final, kein Neustart, kein neues Element) | Schicht „an die Plan-Entscheidung gebunden“ nur auf Unit-Ebene belegt: ein Fortsetzen hinter dem Medienende ist im echten Browser nicht abspielbar |
| N7-03: kein hörbarer Start, solange die Positionierung nicht verifiziert ist | C „N7-03“ (u. a. werfender Setter, wirkungsloser Seek, gespacte Setterversuche, begrenzter Timeout → Error/Retry, `seekable`-Bereiche, asynchroner Seek und geklemmtes Ergebnis, Clip endet während des Wartens, Entzug/Pause/Clipwechsel, neuer Plan/Erneuerung/Aktivierung während des Wartens, unmittelbarer Start unverändert), n7IndependentReview Proben 4–5; H S8 (Stream ohne Range: 20 Proben, nie ein laufendes Element; neutraler Fehler; Retry an der Planposition) und S1/S2 (bestehender Start, Tastaturaktivierung) | Doubles bilden asynchrone Seeks und Klemmen nach; reales Seek-Verhalten nur in Chromium gemessen |
| Gegenversuche | review.md §9.3 (M24–M35 Unit; N01/N02c/N02d/N03 im echten Browser) | – |
