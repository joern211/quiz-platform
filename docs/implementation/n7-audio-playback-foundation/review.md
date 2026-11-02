# N7 — Eigenprüfung (kritische zweite Prüfung nach dem ersten Gelingen)

Das ist eine **Eigenprüfung** durch den Implementierer, keine unabhängige Prüfung. Jörns spätere externe Prüfung bleibt separat.

## 1. Vorgehen

1. Diff erneut gelesen aus Reviewer-Sicht (öffentliche Eingaben, Projektionen, Effects, Ressourcenwechsel, Cleanup-Pfade).
2. Zustands-/Übergangstabellen geschrieben (§2, §3) und über Zwischenzustände geprüft.
3. Die Fehler aus Kapitel 9 des Arbeitsauftrags einzeln durchgegangen (§4).
4. Aktiv versucht, den Vertrag zu brechen (§5): Promise-Reihenfolgen, verspätetes Laden, Entzug, Kontextwechsel, hohe fremde Versionen, neue gleiche Objekte, erschöpfende Reihenfolgeprüfung.
5. Gezielte lokal reversible Gegenversuche (§6; nach dem Bericht zu PR #37 ergänzt in §9.3): 23 Fehler eingebaut, Testlauf, Datei zurückgesetzt (`git status` danach sauber).
6. Gefundene Fehler behoben, Test ergänzt, benachbarte Übergänge erneut geprüft (§7).

## 2. Übergangstabelle Serverplan (Zustand × Aktion; „kein-Op“ = `changed:false`, gleiche Version)

Alle Zeilen setzen eine passende `expectedVersion` voraus; **jede** Aktion mit veralteter Version → `AUDIO_PLAYBACK_VERSION_STALE`, auch eine, die sonst ein kein-Op wäre.

| Zustand | start | pause | resume | stop | settle | Lesen/Projektion |
|---|---|---|---|---|---|---|
| READY | → RUNNING (Anker ≥ now) | `TRANSITION_INVALID` | `TRANSITION_INVALID` | → STOPPED | `TRANSITION_INVALID` | stumm, Position 0 |
| RUNNING, vor Anker (`now < anchor`) | kein-Op (Anker bleibt) | → PAUSED, Position = Ankerposition (0 bzw. gespeicherter Offset) | kein-Op | → STOPPED | `TRANSITION_INVALID` | SCHEDULED, Ziel = Ankerposition |
| RUNNING, aktiv (`anchor ≤ now < end`) | kein-Op | → PAUSED, Position = Ziel(now) | kein-Op | → STOPPED | `TRANSITION_INVALID` | PLAYING |
| RUNNING, zeitlich abgelaufen (`now ≥ end`) | `ENDED` | `ENDED` | `ENDED` | `ENDED` | → ENDED (persistiert) | ENDED, Quelle fehlt |
| PAUSED | `TRANSITION_INVALID` | kein-Op | → RUNNING, neuer Anker, **gespeicherte** Position | → STOPPED | `TRANSITION_INVALID` | PAUSED |
| STOPPED | `TERMINAL` | `TERMINAL` | `TERMINAL` | kein-Op | `TRANSITION_INVALID` | STOPPED, Quelle fehlt |
| ENDED | `TERMINAL` | `TERMINAL` | `TERMINAL` | `TERMINAL` | kein-Op | ENDED, Quelle fehlt |

Weitere Zeilen: ungültig (`STATE_INVALID` beim Laden, `ARGS_INVALID`/`TIME_INVALID` für Eingaben), fremder Kontext (`SCOPE_INVALID`, vor allem anderen), rückläufige Uhr (`TIME_INVALID`). Zwischenzustandspfade, die getestet sind: RUNNING(future) → PAUSED → RUNNING(future) → PAUSED (Offset bleibt 3000); PAUSED → RUNNING → ENDED(zeitlich) → settle → alle Aktionen `TERMINAL`.

## 3. Übergangstabelle Browser (Eingabe × Zwischenzustand)

`seen` = höchste beobachtete (Snapshot-, Planversion) des Kontexts (nur Zahlen), `held` = abspielbare Projektion.

| Eingabe | Wirkung auf `seen` | Wirkung auf `held` / Medium |
|---|---|---|
| gültig, passend, neuer | steigt | ersetzt; neue Quelle → neue Ressource, gleiche Quelle → nur Plan neu bewertet |
| gleicher Stand, gleiche/engere Freigabe (z. B. erneuerte URL) | gleich | neue URL → nur Ressource getauscht, Anker bleibt |
| gleicher Stand, **weitere** Freigabe | gleich | verworfen (STALE) |
| älter (Snapshot oder Plan) | unverändert | unverändert (keine Wiederbelebung); ein noch gehaltener neuerer Stand bleibt |
| gültig mit `NONE` | steigt | `held = null` → Element pausiert, Quelle entfernt, Listener/Timer ab |
| `null` / `undefined` / ungültig | unverändert (kein Vergiften) | `held = null` wie Entzug; Versionskenntnis bleibt |
| fremder Kontext (auch mit riesiger Version) | unverändert | wie ungültig |
| unter `minStateVersion` des Aufrufers | unverändert | wie ungültig; der Mindeststand kommt **nie** aus der eingehenden Projektion |
| Kontextwechsel (Run, Runde, Playback-ID, Revision) | beginnt leer; kein Archiv | altes Element freigegeben, spätes Ereignis/Erneuerung des alten Kontexts ist „fremd“ |
| terminaler Plan (`source: null`) | steigt | kein Element, nichts wird geladen; vorhandenes Element wird freigegeben |
| späte Zustellung (Plan hat begonnen) | – | Position = jetzt gültige Zielposition, nie 0 |
| spätes Laden (Metadaten nach Startzeit) | – | Seek erst nach `loadedmetadata`, auf Zielposition zum Eintrittszeitpunkt |
| Autoplay abgelehnt | – | lokaler Zustand `AUTOPLAY_BLOCKED`; neuer Plan → `play()` neu versucht |
| Aktivierung (Nutzergeste) | – | `play()` synchron in der Geste auf der **aktuellen** Position; nach Ende/Pause/Stop/Entzug nichts |
| Medienfehler | – | lokaler Zustand `ERROR`; Retry lädt dieselbe Quelle neu, Plan/Identität bleiben |
| Uhr ohne Basis | – | `AWAITING_CLOCK`, kein Start |

## 4. Die früheren Fehler (Kapitel 9) — Codepfad und Beweis

| Fall | Analoger Mechanismus in N7 | Verhindernder Codepfad | Beweis (Test) |
|---|---|---|---|
| 9.1 N1: neue Objektidentität löschte eine laufende Sperre | neue Projektionsobjekte, Rerender, Uhrtick, Theme dürfen kein neues `play()` auslösen; ein alter Rückruf darf die aktuelle Operationsbindung nicht aufheben | `apply()` vergleicht einen **stabilen Schlüssel** (ohne `stateVersion`/`serverNowMs`); `playOp` je Versuch, ein überholter Versuch fasst weder Flags noch Element der aktuellen Operation an | Controller „equal input is a no-op“ (25 neue Objekte + 20 Ticks: `playCalls`/`loadCalls`/Seeks/Elementzahl unverändert); Komponente „no second play() … theme change (StrictMode)“ zählt Wirkung, nicht Text; „late rejection of an overtaken attempt“ (3 Fehlerarten) |
| 9.2 N2: altes LOCKED ohne Versuchszuordnung / bestätigter Inhalt von Entwurf verdrängt | alte Pause-/Play-/Fehlerereignisse nach lokalem Status; Status ohne Ersatzquelle darf validierte Quelle nicht ersetzen | Listener und Promise-Rückmeldungen prüfen Generation **und** Element (`this.res === res`, `playOp`); Teardown entfernt Listener; Entzug (`NONE`) ist als eigener Fall `RELEASE_NONE` erkennbar; ein quellloser Folgeplan (terminal) ersetzt nie eine Quelle, sondern beendet bewusst | „old loadedmetadata/canplay/error/ended after a source change“; „A’s late fulfilment/rejection/cleanup … B“ (beide `play()`-Modelle); Intake „terminal projection … late older PLAY“ |
| 9.3 N4: Bestätigung mit optional fehlenden Nutzdaten ging verloren | Serverplan, bekannte Freigabe und lokaler Erfolg sind verschiedene Tatsachen; Folge-Updates ohne Ersatzplan löschen nichts zufällig; RUNNING beweist kein Browseraudio | Projektion trennt `release`/`source`/`plan`; LOAD_ONLY hält Quelle ohne Plan; Intake hält `seen` getrennt von `held`; lokaler Status ist ein eigenes Feld; `AWAITING_CLOCK`/`LOADING`/`AUTOPLAY_BLOCKED` statt „spielt“ | Intake „consecutive updates: LOAD_ONLY after PLAY keeps a source but drops the plan“; Controller „PRELOADED then PLAY: same resource“; Harness misst `paused/currentTime/rms/freq` statt Label |
| 9.4 N6: Löschen der Anzeige löschte die Versionskenntnis | PLAY → Entzug/`null` → altes PLAY | `IntakeMemo` hält `seen*` getrennt von `held`; Entzug setzt nur `held = null` | Intake: „PLAY v9 → NONE v10 → PLAY v9“, „PLAY v9 → null → PLAY v8“, Kette mit `undefined`/Müll, quelllose Sicht hebt die Version, fremder Kontext vergiftet nicht, **erschöpfende** Prüfung aller 7 776 Folgen der Länge 5 |
| 9.5 Medien-Recovery: ACK auf Socket A ordnet nicht Socket B | Play-/Pause-Befehl oder ACK beweist nicht, dass beide Browser den Plan angewendet haben | Der Browser wertet den Plan aus der **eigenen** Projektion aus; der Harness wartet je Kontext auf genau die erwartete Medienwirkung (`waitUntil` auf `paused`, Status, Position), kein `sleep` als Reihenfolgeannahme zwischen Verbindungen | `check.cjs` S1: pro Kontext Zielzustand abwarten, dann Position gegen den Serverplan zum selben Serverzeitpunkt messen; die verbleibenden festen Wartezeiten sind Beobachtungsfenster (z. B. „1,5 s nichts bewegt“), keine Synchronisation |
| 9.6 Audiofixtures: Zufall erzeugte korrekte Deduplizierung | verschiedene Töne müssen deterministisch verschieden sein | Harness: Frequenz je Clip fest (440 / 660 Hz), keine Zufallsquelle; Dedup/200-vs-201 bleibt Sache des vorhandenen `audio.integration.test.ts` und wird von N7 weder geändert noch behauptet | Server-Test „reads no clock, no random source“ (Spion auf `Date.now`/`Math.random`); Harness-Serverdatei ohne Zufall |
| 9.7 UI: sichtbares Ergebnis am falschen Gegenfall geprüft | echte DOM-Grenzen, lange Texte, tatsächliche Medienwirkung | Midnight-Tokens, `overflow-wrap`, `min-width: 0`, Buttons ≥ 44 px; Harness misst `scrollWidth`/`clientWidth`, gekappte Elemente, Button-Rechtskante bei 320/390/1280 px, hell/dunkel, mit einem langen deutschen Titel, der ein überlanges Wort enthält; Medienwirkung am Element und AnalyserNode | `check.cjs` S5 (6 Kombinationen + Fehlerzustand 320 px hell) mit Screenshots, **und** Funktionsprüfung S1–S4 |
| 9.8 Grün allein bewies den Vertrag nicht | Tests aus dem Vertrag ableiten, Mutationen nicht mit Abdeckung verwechseln | Erwartungen aus dem Vertrag (Zeitformel, Tabellen §2/§3) hergeleitet; Mutationen als zusätzliche Probe (§6); Testzahlen werden nicht als Abdeckung ausgegeben | Eigenprüfung selbst: zwei gefundene **Lücken im ersten Testbestand** (M6, M22) und ein Fehler im Harness-Hilfscode (`checkOnPlan` lieferte immer „bestanden“, aufgefallen an `samples: 0`) |

## 5. Aktive Brechversuche

* **Promise-Reihenfolgen** (beide Modelle: „Browser bricht `play()` bei `pause()` ab“ und Worst-Case „späte Erfüllung startet den Ton“): Pause, Stop, Ende, Entzug, Unmount, neuer Clip, Pause→Resume mit noch offenem ersten Versuch, späte Ablehnung (`NotAllowedError`/`AbortError`/`NotSupportedError`) des überholten Versuchs.
* **URL-/Snapshot-Reihenfolgen:** späte Erneuerung des alten Clips nach Kontextwechsel mit höherer Version (fremd → nichts); gleicher Stand mit weiterer Freigabe (verworfen); alle Folgen aus {PLAY v8, PLAY v9, NONE v10, null, PLAY v11, fremd v99} der Länge 5 (7 776) mit den Invarianten „abspielbar nie älter als bereits Akzeptiertes“, „nie ≤ ein gesehener Entzug“, „fremder Kontext ändert nichts“.
* **Verzögertes Laden / Hintergrund:** Metadaten nach der Startzeit; Join nach Ende; Schlaf (Uhr springt, Timer feuern nicht) mit `resync()`; Autoplay-Aktivierung nach Pause/Stop/Ende/Entzug und nach zeitlichem Ende.
* **Freigabe:** Entzug während `play()`; BLIND_HOST mit HOST_PRIVATE; alle Rollen × alle Sichtbarkeitsregeln; Resolver-Spion (Aufrufe 0 für nicht berechtigte Empfänger, `NONE` und terminale Pläne).
* **Eingaben:** Sekunden statt Millisekunden (12.5), NaN, Infinity, `2^53`, Strings, `null`; erweiterte Felder (`title`, `artist`, `storagePath`, `cover`, `mediaSession`) im Zustand und in der Projektion; absolute/protokollrelative/`javascript:`-URLs.
* **Uhr:** Wanduhr ±9/−7 Minuten (`Date.now` wird nicht aufgerufen), rückläufige monotone Uhr, unmögliche Samples, kein Sample.

## 6. Gezielte lokal reversible Gegenversuche (tatsächlich ausgeführt)

Jeder Eingriff wurde in die Quelldatei eingefügt, die betroffenen Testdateien liefen, die Datei wurde zurückgesetzt. Spalte „Ergebnis“ = Anzahl scheiternder Tests.

| # | Eingriff | Ergebnis |
|---|---|---|
| M1 | Intake ohne Versionsordnung | gefangen (7) |
| M2 | Entzug vergisst auch die Versionskenntnis | gefangen (4) |
| M3 | ungültiger/fremder Kontext hebt die bekannte Version | gefangen (2) |
| M4 | Mindeststand des Aufrufers wird nicht erzwungen | gefangen (3) |
| M5 | spät erfülltes `play()` eines überholten Versuchs wird nicht pausiert | gefangen (7) |
| M6 | späte Ablehnung nicht an den aktuellen Versuch gebunden | **zunächst nicht gefangen** → Test ergänzt → gefangen (1) |
| M7 | Start springt immer auf 0 | gefangen (3) |
| M8 | Driftkorrektur ohne Cooldown/Limit | gefangen (1) |
| M9 | jedes `apply` ersetzt die Ressource | gefangen (4) |
| M10 | fehlende Uhrbasis wird durch eine Zahl ersetzt | gefangen (1) |
| M11 | Teardown pausiert das Element nicht | gefangen (4) |
| M12 | Teardown behält Listener | gefangen (13) |
| M12b | Teardown behält Listener **und** der Listener-Wächter fehlt | gefangen (13) |
| M13 | Phase ignoriert den Anker (kein „vor dem Start“) | gefangen (4) |
| M14 | Ziel kann vor dem Anker unter die gespeicherte Position fallen | gefangen (3) |
| M15 | zeitlich abgelaufenes RUNNING wird nicht abgelehnt | gefangen (2) |
| M16 | Freigabe wird nicht durch die Sichtbarkeitsregel eingeschränkt | gefangen (4) |
| M17 | URL wird auch für `NONE` aufgelöst | gefangen (7) |
| M18 | wiederholtes `pause` ist kein kein-Op | gefangen (1) |
| M19 | veraltete `expectedVersion` wird akzeptiert | gefangen (1) |
| M20 | terminaler Plan löst weiterhin eine URL auf | gefangen (2) |
| M21 | Komponente füttert den Controller nicht | gefangen (7) |
| M22 | Status eines entzogenen Clips wird angezeigt | **zunächst nicht gefangen** → Test ergänzt → gefangen (1) |
| M23 | nur der Listener-Wächter (Generation/Element) entfernt, Listener werden weiter beim Teardown entfernt | **nicht gefangen** — bewusst: zweite, redundante Schutzschicht; die Listener-Entfernung (M12) ist die tragende Schicht und wird geprüft |

Abgrenzung: 22 gefangene Eingriffe belegen, dass diese Schutzmechanismen jeweils von mindestens einem Test erzwungen werden. Sie belegen **nicht** vollständige Abdeckung.

## 7. Befunde und Korrekturen

| # | Befund | Ursache | Korrektur | Nachweis |
|---|---|---|---|---|
| R1 | Ein STOPPED/ENDED-Plan trug weiterhin eine Quelle. Ein später Zuschauer hätte die Datei grundlos geladen; für sie wäre eine URL aufgelöst worden („nicht vorsorglich signieren“, Auftrag 7.1). | Projektion und Schema kannten nur „PLAY = Quelle + Plan“. | Ein terminaler Plan trägt Plan und Dauer, **keine** Quelle: Schema in beide Richtungen, Projektion löst keine URL auf, Controller hält kein Element und lädt nichts (ein vorhandenes wird freigegeben). | Server „TERMINAL plan … NO source … no URL resolved“ (3 Fälle + Schema), M20; Controller „TERMINAL plan releases the element“ und „late joiner … creates no element“; Intake „terminal projection“; Harness S1 weiter grün (STOPPED/Entzug) |
| R2 | Eine frühere Autoplay-Ablehnung blieb über Planwechsel bestehen; nach Pause/Fortsetzen wurde nicht erneut versucht, obwohl der Nutzer inzwischen interagiert haben kann. | `blocked` wurde nur durch die Aktivierung gelöscht. | Ein neuer Plan ist eine neue Entscheidung: `blocked` wird beim Planwechsel gelöscht, `play()` wird neu versucht; eine erneute Ablehnung führt wieder in `AUTOPLAY_BLOCKED`. | Controller „after an autoplay refusal a NEW plan …“ |
| R3 | `audioPlayback.test.ts` lief unter vitest, aber nicht unter `tsc` (`pnpm typecheck` rot). | Ein untypisierter Hilfsparameter (`extra: object`) verlor den Typ von `startAtMs`; vitest prüft keine Typen. | generischer Helfer; ein Test-Cast für den absichtlich falschen Eingabewert. | `pnpm typecheck` grün (server, web, shared) |
| R4 | Harness-Hilfscode `checkOnPlan` lieferte immer „bestanden“ (`if (!expect(...))` – `expect` gibt nichts zurück). | Fehlannahme über den Rückgabewert der eigenen Hilfsfunktion. | explizite Prüfung; Zähler `samples` im Ausgabeprotokoll. Der erste Lauf mit korrigiertem Code deckte außerdem vier zu strenge/ungenaue Erwartungen auf (Signalpegel direkt nach dem Start, willkürliche Positionsschwellen), die am **Messverfahren**, nicht am Produktcode lagen und angepasst wurden. | Ausgabe `samples: 21`, Läufe mit 0 Problemen |
| R5 | M6/M22 (siehe §6): der erste Testbestand fing die späte Ablehnung eines überholten Versuchs und den Render-Frame nach Entzug nicht. | fehlende Gegenfälle. | zwei Tests ergänzt. | M6/M22 gefangen |

Nach den Korrekturen wurden benachbarte Übergänge erneut geprüft (alle Test-Dateien, Harness drei Läufe, Mutationen M6/M22 erneut).

## 8. Verbleibende Grenzen

* Nur **Chromium** (Playwright 1.63.0, Headless, lokal 4 CPUs) wurde gemessen; Safari, mobile Hardware und Produktionsnetzwerke sind nicht geprüft. Safari bindet das Abspielen strenger an die Geste des **jeweiligen Elements**; der Aktivierungspfad (`play()` synchron in der Geste) ist dafür vorbereitet, aber nicht belegt.
* Die Uhr nimmt symmetrische Laufzeit an (Fehler ≤ RTT/2). Asymmetrische Mobilfunkstrecken können den Versatz über die gemessenen Werte hinaus verschieben.
* Der Harness ersetzt den geschützten Medienpfad durch einen Stand-in-Pfad; Signatur und Inhaltsfreigabe bleiben im vorhandenen `media.integration.test.ts` und werden hier nicht erneut belegt.
* Der Mediennachweis misst ein MP3 aus der vorhandenen Pipeline. Hörbarkeit am Lautsprecher ist nicht geprüft (Pegel/Frequenz am AnalyserNode).
* Wiedergabeposition ist Chromium-/Decoder-abhängig; die Driftkorrektur ist eine Toleranz, kein Beweis samplegenauer Synchronität.

## 9. Nachprüfung nach dem unabhängigen Bericht zu PR #37 (Befunde N7-01 bis N7-03)

Auch das ist Eigenprüfung. Die externe Prüfung hat drei Funktionsfehler gefunden, die meine erste Eigenprüfung (§1–§8) **nicht** gefunden hat und die die grüne CI nicht abdeckte. Die Ursachen lagen in Annahmen, die ich nicht gegengeprüft hatte: (N7-01) Generation = Ordnung, (N7-02) ein Ereignis gehört der Ressource statt der Plan-Entscheidung, (N7-03) ein Setter ohne Ausnahme = Position erreicht.

### 9.1 Befunde, Korrekturen, Nachweise

| Befund | Ursache | Korrektur | Rot → Grün | Verbleibende Grenze |
|---|---|---|---|---|
| N7-01 [P2] ältere Erneuerung überschrieb eine neuere URL | keine Ordnung der Ausstellung; Intake nahm bei gleichem Paar jede Quelle an | Ordnungszahl `renewal` im Vertrag, `createRenewalIssuer`, `resolveSource`, Intake behält die Quelle mit der höheren Zahl und nimmt den Rest der Projektion trotzdem an | Probe 1 rot (`sig=old` statt `sig=new`) → grün; Komponenten-Test mit echtem R1/R2-Ablauf; Browser S6 (rot ohne Ordnung: 2 Probleme) | Fehlschläge der Erneuerungsanfrage gehören dem Adapter (nicht modelliert) |
| N7-02 [P2] lokales `ended` blockierte Fortsetzung | `localEnded` für die ganze Ressource | zwei Schichten: Ereignis zählt nur bei erwartetem Playback und `el.ended !== false`; Merker an den Plan-Schlüssel gebunden | Proben 2–3 rot (`playCalls` 1 statt 2) → grün; Browser S7 (rot mit dem Verhalten vor der Korrektur: Fortsetzen unterdrückt, Elementposition 12 s statt ≈ 5,8 s) | Schicht 2 nur auf Unit-Ebene (Browser kann hinter dem Medienende nicht fortsetzen) |
| N7-03 [P2] hörbarer Start trotz fehlgeschlagenem/wirkungslosem Seek | `seek()` verschluckte die Ausnahme, `play()` unbedingt | Protokoll `position()` (design.md §11), stiller Wartezustand, begrenzter ereignisgerechter Retry mit aktuellem Ziel, Timeout → neutraler Fehler | Proben 4–5 rot (`playCalls` 1 statt 0) → grün; Browser S8 (rot ohne Verifikation: 17 von 20 Proben mit laufendem Element) | Chromium-Verhalten für Range-lose Streams ist gemessen (`seekable = [0,0]`), andere Browser nicht |

Alle fünf Gegenproben des Berichts laufen grün (`n7IndependentReview.test.ts`). Eine Änderung am Test: Probe 1 trug keine Ordnungszahl; sie bekam `renewal: 1/2`, weil der präzisierte Vertrag sie verlangt. Die Aussage der Probe (älter darf nicht ersetzen) ist unverändert und ohne die Durchsetzung rot (M24).

### 9.2 Zusätzliche Übergangs- und Reihenfolgeprüfungen

* N7-01: alle 6 Reihenfolgen dreier Erneuerungen (die höchste Zahl bleibt); URL-Text, Signaturtext, `serverNowMs` und Ankunft ohne Einfluss; eine neuere Pause trägt eine ältere URL und wird trotzdem angenommen; LOAD_ONLY mit älterer Zahl; Entzug/Clipwechsel/terminal nach einer Erneuerung; gleiche Zahl mit anderer URL.
* N7-02: Ereignis vor und nach Übernahme des neuen Plans; `ended === false`; wiederholte gleiche Pläne mit neuen Snapshotversionen, Ticks und `resync()` löschen den Schutz nicht; Stop/Ende/Entzug nach lokalem Ende bleiben still.
* N7-03: werfender Setter, ignorierter Seek, asynchroner Seek mit geklemmtem Ergebnis, Ziel nicht in `seekable`, Clipende während des Wartens, Entzug/Pause/Clipwechsel (alte `seeked`/`progress`-Ereignisse wirkungslos), neuer Plan mit anderem Offset während des Wartens (neues Ziel), Erneuerung während des Wartens (frischer Warte-Timer), Aktivierung während des Wartens, Setterversuche gespaced.

### 9.3 Gegenversuche (tatsächlich ausgeführt, lokal rückgängig gemacht)

Unit (Web-Testdateien, je ein eingefügter Fehler): M24 Intake ohne Erneuerungsordnung (gefangen, 9) · M25 lokales Ende bleibt für die Ressource (Schicht 2, gefangen, 2) · M26 jedes ended wird gemerkt (gefangen, 2) · M27 ohne Planprüfung (gefangen, 1) · M28 ohne Elementprüfung (gefangen, 1) · M29 Start ohne verifizierte Positionierung (gefangen, 10) · **M30 laufender Seek wird ignoriert (zuerst NICHT gefangen** — mein Test-Double meldete `currentTime` während des Seeks noch den alten Wert, das echte Element meldet die angeforderte Position; Double korrigiert → gefangen, 2) · M31 Setterergebnis nicht zurückgelesen (gefangen, 4) · M32 `seekable` nicht geprüft (gefangen, 1) · M33 keine Abstände zwischen Setterversuchen (gefangen, 2) · M34 kein Timeout (gefangen, 1) · M35 gleiche Zahl ersetzt die Quelle (gefangen, 1).

Echter Browser (Harness): N01 ohne Erneuerungsordnung → rot (S6) · N02c Verhalten vor der Korrektur → rot (S7: Fortsetzen unterdrückt) · **N02d nur Schicht 2 entfernt → NICHT gefangen** (Schicht 1 schützt; im Browser nicht trennbar) · N03 ohne verifizierte Positionierung → rot (S8: 17 von 20 Proben mit laufendem Element).

### 9.4 Weitere Befunde der Nachprüfung

| # | Befund | Folge |
|---|---|---|
| R6 | Mein Test-Double bildete asynchrones Seeking falsch ab (M30 ungefangen). | Double korrigiert (`currentTime` = angeforderte Position, solange `seeking`); der Test fängt M30. |
| R7 | Die Harness-Probe für N7-02 verlangte „Element am Ende“, das Element meldete während des Seeks noch `ended === false`. | Probe wartet auf `seeked`, dann Ereignis; die Vorbedingung wird als Behauptung geprüft. |
| R8 | Eine Mutation (N02d) blieb im Browser ungefangen, weil zwei Schichten dasselbe schützen. | als Grenze dokumentiert (matrix G, design §11), nicht als Abdeckung ausgegeben. |

## 10. Nachprüfung 2 (Head 84821b2): N7-01-Rest [P2] und N7-04 [P3]

Auch das ist Eigenprüfung. Die externe Nachprüfung fand an meiner N7-01-Korrektur den Fehler, den ich aus N6 kannte und hier wieder gemacht hatte: die Ordnungskenntnis stand im gleichen Zustand wie die Nutzdaten (`held.source`) und ging mit deren Löschen verloren. Meine erste Gegenprüfung hatte nur Reihenfolgen **ohne** leere Zwischenansicht getestet.

| Befund | Ursache | Korrektur | Rot → Grün | Grenze |
|---|---|---|---|---|
| N7-01-Rest [P2] U20 → null/undefined/ungültig → U10 lud die ältere URL wieder | höchste Nummer nur in `memo.held.source` | `seenRenewal` als Zahl im Memo (überlebt leere/ungültige/fremde Sichten, keine URL, neuer Kontext beginnt leer); Quelle `< seenRenewal` wird nie gehalten, Plan/Versionen werden trotzdem übernommen; Controller hält ohne Quelle kein Element und zeigt neutral die Wiederbeschaffung (`retry` ruft `onRenewUrl`) | 3 Proben des Prüfers rot → grün (`n7RecheckIndependent.test.ts`); Intake: 4 Zwischenzustände, aktuelle/neuere Quelle danach, Pause/Stop nach leerer Sicht, fremde hohe Nummer, neuer Kontext, Entzug, **erschöpfend 5^5 Folgen** mit null/ungültig; Controller (RUNNING/PAUSED/LOAD_ONLY ohne Quelle); Komponente (kein Audioobjekt mit der alten URL, Retry, danach U21 an der gültigen Position) | Wiederbeschaffung ist die Anfrage an die Anwendung (`onRenewUrl`); deren Ausgang ist nicht modelliert |
| N7-04 [P3] Issuer „neustartfest“ | eine neue Instanz kennt frühere Nummern nicht; die Wanduhr ist kein persistierter Zähler | Anschluss `last()` / `createRenewalIssuer(last)`; Behauptung auf das Garantierte reduziert (Instanz streng wachsend; über Neustart nur mit wiederhergestelltem Wert oder nicht rückwärts laufender Uhr) | Probe des Prüfers rot (99 000 < 100 000) → Wiederherstellungsfall grün; die unbedingte Form bleibt als **dokumentierte Grenze** (Test erwartet den niedrigeren Wert) | keine Persistenz und kein Zeitdienst in N7; Pflicht des späteren Adapters |

Die Probe des Prüfers für den Issuer ist angepasst: sie prüft jetzt den Fall **mit** wiederhergestelltem Wert (grün) und hält die unbedingte Form als dokumentierte Grenze fest, statt eine Garantie zu behaupten, die ohne gespeicherten Zähler nicht gegeben werden kann.
