# N7 — Eigenprüfung (kritische zweite Prüfung nach dem ersten Gelingen)

Das ist eine **Eigenprüfung** durch den Implementierer, keine unabhängige Prüfung. Jörns spätere externe Prüfung bleibt separat.

## 1. Vorgehen

1. Diff erneut gelesen aus Reviewer-Sicht (öffentliche Eingaben, Projektionen, Effects, Ressourcenwechsel, Cleanup-Pfade).
2. Zustands-/Übergangstabellen geschrieben (§2, §3) und über Zwischenzustände geprüft.
3. Die Fehler aus Kapitel 9 des Arbeitsauftrags einzeln durchgegangen (§4).
4. Aktiv versucht, den Vertrag zu brechen (§5): Promise-Reihenfolgen, verspätetes Laden, Entzug, Kontextwechsel, hohe fremde Versionen, neue gleiche Objekte, erschöpfende Reihenfolgeprüfung.
5. Gezielte lokal reversible Gegenversuche (§6): 23 Fehler eingebaut, Testlauf, Datei zurückgesetzt (`git status` danach sauber).
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
