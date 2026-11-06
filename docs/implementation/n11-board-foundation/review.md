# N11 — Zweite kritische Eigenprüfung (Review)

Nach dem ersten grünen Stand wurde der Diff aus Prüfersicht gelesen, je ein vollständiger Pfad „Absicht → Autorisierung → Bewegung → Commit → Projektion → Anzeige“ verfolgt (auch mit vertauschter Reihenfolge, doppelter Zustellung, veralteter Berechtigung und fehlender Zwischensicht), ein Browsernachweis gebaut und gezielt reversibel mutiert. **Produktfehler** und **Fehler der eigenen Messung/Testvorbedingung** sind getrennt aufgeführt. Es gab keinen unabhängigen zweiten Prüfer: das ist Eigenprüfung.

## A. Befunde
### A1. Produktfehler (gefunden und behoben)
| # | Befund | Ursache | Nachweis | Behebung |
|---|---|---|---|---|
| R1 | Ein Zug, der einen N8-Basisschritt schuldet (neuerer N6-Stand), konnte den **letzten** Folgeversionsschritt verbrauchen; danach hätte der Verbraucher den Zug nicht mehr beenden können (`advanceTurnSequence` braucht ebenfalls einen Schritt). Dasselbe Muster wie N10-04. | `moveFigure` prüfte nur `sequence.version + 1`. | Neuer Test (Folgeversion `MAX-1` mit neuerem Stand → `NO_ERROR` statt `BOARD_COUNTER_LIMIT`) war **vor** der Behebung rot; Mutation M8 (zurück auf `+1`) → rot | Reserve: `sequence.version + 2` bei geschuldetem Basisschritt (Basisschritt **und** Zugende müssen passen); Test zeigt, dass bei `MAX-2` beide Schritte wirklich nacheinander passen. |
| R2 | Harness deckte zwei Schutzmaßnahmen nicht ab (Mutation „Sperre an der Render-Closure“ und „Entzug löscht die Versionsuntergrenze“ blieben im Browser grün; Unit-Tests fingen sie). | Der Browserablauf hatte keinen Klick-Paar im **selben Task** und keine Kette „fremdes Paket → älteres eigenes Paket“. | Mutationen M16/M18 im Browser: `passed` vor, `FAILED 1 misses` nach der Ergänzung | Harness S3b (zwei Klicks in einem Task, genau ein Aufruf) und S9 (fremdes Paket, dann älteres eigenes Paket: nichts angezeigt, Untergrenze bleibt). |

Weitere Pfade, die ich bewusst durchging und **ohne** Befund schloss: Rollenmehrfachverwendung bei mehrwürfligen Profilen (ein weiterer Wurf ist ein neuer Wurf; Verbrauch ist an `diceId + rollCount` gebunden, ein Halten nach dem Zug ändert nur die Würfelversion und verbraucht nichts neu); Eigentümer-Rücksetzung auf ein volles Startfeld (durch die Ladeinvariante `START_CAPACITY` ausgeschlossen); Schlag auf Start-/Heimfeld (nie, `boardCapturableFields`); alte Antwort entsperrt neue Anfrage (Versuchsidentität, Komponententests + Browser); Doppelzustellung eines Pakets (am selben Punkt mit gleicher Freigabe akzeptiert, ändert nichts).

### A2. Fehler der eigenen Messung / Testvorbedingung (kein Produktfehler; Vorbedingung korrigiert, **keine** Erwartung an ein Fehlverhalten angepasst)
| # | Falsche Vorbedingung | Wie erkannt |
|---|---|---|
| M-a | Domäne: „eigene Figur auf vollem Ziel“ erwartete `['a2']` als legalen Zug; a2 auf `t3` überwirft das Heimfeld → leer ist richtig. | Fehlschlag, Routenrechnung nachvollzogen |
| M-b | Domäne: Test „Start-/Heimfeld nie schlagbar“ baute einen **ungültigen** Ausgangszustand (fremde Figur auf `ha`); die Ladeinvarianten wiesen ihn zu Recht ab. Ersetzt durch die direkte Probe auf `boardCapturableFields`. | `world()` warf `BOARD_STATE_INVALID` |
| M-c | Domäne: „neuer Zug derselben Person“ würfelte 2 und wollte `a2` auf das belegte `t2`; mit 1 → `t1`. | `BOARD_TARGET_ILLEGAL` |
| M-d | Domäne: fehlende Richtlinie ist `BOARD_POLICY_INVALID` (nicht `BOARD_ARGS_INVALID`) — meine Erwartung war falsch. | Fehlschlag |
| M-e | DB: der Entzug-Stand führte `knownIds` nur für die aktiven Spieler; N8 weist das als `ELIGIBILITY_MISMATCH` ab (Abdeckungsregel). | Fehlschlag |
| M-f | Intake: ein **breiteres** Paket am selben Stand der `NONE`-Sicht ist laut Entwurf zu verweigern; ich erwartete `ACCEPTED`. | Fehlschlag |
| M-g | Komponente: `getByRole('status', { name: '' })` traf mehrere Elemente; zwei Zählungen zählten Picker-Buttons mit. | Fehlschlag |
| M-h | Harness: `calls`/`settled`/`holdSends` blieben zwischen Szenarien an der Seite; Playwright wartet bei `aria-disabled` auf „enabled“ (`force`); S9 erwartete, dass ein älteres Paket die Anzeige leert — es lässt die bereits gezeigte **neuere** Sicht stehen (Entwurf). | Kaskadenfehler S3→S4/S6/S7/S8; erst nach Ursachenanalyse (`cleanPages()` je Szenario) behoben |
| M-i | `pnpm test` am frischen Checkout: `rate-limiter.integration.test.ts` braucht `dist/app.js` (Build vor Test, wie in CI); nach `pnpm build` grün. Kein N11-Fehler. | `ERR_MODULE_NOT_FOUND` |

## B. Mutationsprüfung (reversibel; Arbeitsbaum danach sauber, `git status` leer bis auf die gewollten Commits)
Server = `boardState.test.ts` + `boardState.cas.integration.test.ts` (71 Tests), Web = `src/board` + `BoardView.test.tsx` (35), H = Browserharness (15 Szenarien). Angegeben sind die **fehlschlagenden** Tests/Meldungen.

| Mutation | Server | Web | H |
|---|---|---|---|
| M1a Verbrauchsprüfung nur in `moveFigure` entfernt (die zweite Schicht in `apply` bleibt) | 2 rot | | |
| M1b Verbrauchsprüfung in `moveFigure` **und** `apply` entfernt (derselbe Wurf bewegt zwei Figuren) | 3 rot | | 1 rot (S5) |
| M2a Eigentumsprüfung in `moveFigure` entfernt | 3 rot | | |
| M2b fremde Figur darf ziehen (Züge für den **Eigentümer der Figur** berechnet, Prüfung entfernt) | 3 rot | | 1 rot (S12) |
| M3 Brett-/Zielbindung der Absicht (`assertBoardScope`) nicht verglichen | 3 rot | | 3 rot (S8) |
| M4 Schlag-Policy ignoriert | 2 rot | | |
| M5 Brettversion der Absicht nicht verglichen | 2 rot | | 1 rot |
| M6 Würfelvorgang eines früheren Zugs akzeptiert | 3 rot | | 1 rot (S10) |
| M7 N8-Basisschritt nie gemeldet | 3 rot | | — (nur Domäne/DB: der Browser löst den Basisschritt über den Host aus) |
| M8 Reserve für das Zugende entfernt (`+2` → `+1`) | 1 rot | | |
| M9 Ziele für jeden PLAYER (Halterprüfung der Projektion entfernt) | 1 rot | | 17 rot |
| M10 N8-Autorisierung aus `moveFigure` entfernt | 12 rot | | 15 rot |
| M11 Geschlagene Figuren werden nicht zurückgesetzt | 7 rot | | |
| M12 Ladeinvarianten (`stateIssues`) übersprungen | 20 rot | | |
| M13 CAS-Wächter ersetzt (erwartete Revision in der Transaktion gelesen; Stand-in) | 2 rot | | |
| M14 Herkunft aus dem **geladenen Zustand** statt aus der Absicht (Stand-in-Adapter) | 8 rot | | |
| M15 Receipt-Payload ohne Absicht (Stand-in) / (Harness-Backend) | 1 rot | | 1 rot (S7b) |
| M16 Sperre an der Render-Closure statt am Ref | | 1 rot | 1 rot (S3b) |
| M17 späte Ablehnung gibt jeden Versuch frei | | 1 rot | |
| M18 Entzug löscht die Versionsuntergrenze | | 2 rot | 1 rot (S9) |
| M19 Empfänger nicht verglichen (`boardProjectionMatches`) | | 3 rot | 1 rot |
| M20 Schema akzeptiert Ziele ohne Recht | | 1 rot | |
| M21 Brettversion im Intake nicht verglichen | | 1 rot | |

Die ersten Läufe von M16/M18 waren im Browser **grün** (siehe R2) und wurden erst nach der Ergänzung der Harness-Szenarien rot — das ist der Beleg, dass die Szenarien die Schutzmaßnahme wirklich messen. Ein kaputter Import/Build gilt nicht als Beleg: jede Mutation lief durch benannte Assertionen.

## C. Historische Fehlermuster → Gegenproben
| Muster | Gegenprobe in N11 |
|---|---|
| N1 neue Props-/Feedbackidentität löscht die Sendesperre | `BoardView.test.tsx` „new props objects … theme change“, M16 |
| N2/N4 alte Rückmeldung gilt als Wahrheit; Entzug ohne Ersatz | Intake-Ketten; leere/fremde Sicht zeigt „nicht verfügbar“; Browser S9 |
| N6/N7 Löschen sichtbarer Daten löscht Versionswissen | `boardIntake.test.ts` (je Ebene einzeln, `null`/NONE-Zwischenstand), M18 |
| N8-01 recipientId nur im lokalen Schlüssel | `boardProjectionMatches`; A-Paket unter B-Erwartung (Intake, Komponente, Browser S9), M19 |
| N8-02 Erfolgspfade verwerfen neuere Eligibility | Domäne (Zug mit neuerem Stand meldet `sequenceBasisAdvanced`), DB-Test (ein Commit), M7 |
| N8-03 Run verloren | Run je Ebene über N8; DB-Test „another run“ |
| N9-01 Absicht nur mit lokalen Zählern | Pflicht: `scope`+`boardId`+`diceId`+5 Zähler; je Ziel-Ebene in Domäne, DB (5 Ziele, erstmalige Zustellung ohne Receipt) und Browser S8; M3/M14 |
| N9-02 Payload auskommentiert | Payload als echtes Feld `{ kind, intent }`; Harness im Typecheck; Konfliktproben für 11 Absichtsteile (DB) und Browser S7b; M15 |
| N9-03 Versionsüberlauf erst nach Wirkung | Kapazität vor jeder Änderung; Grenztests unter/am Limit; R1/M8 |
| N10-01/02 Ablehnung gibt mehrere Wiederholungen frei / späte Ablehnung | Versuchsidentität, Komponententests (Retry-Kette, späte Ablehnung/Annahme), M17 |
| N10-04 Reserve für den Abschluss | R1, `boardState.test.ts` „versions, N8 base progress and reserved steps“ |

## D. Abweichungen vom Auftragsablauf (ehrlich)
- Der Auftrag verlangt keinen separaten Entwurf; `design.md` wurde nach dem ersten Domänencode ausformuliert (Kopfkommentare von `board.ts`/`boardState.ts` enthielten ihn vorher).
- Kein unabhängiger zweiter Prüfer; Mutationen und Messungen sind Eigenprüfung.
- Das Master-Regelwerk liegt nicht im Checkout; gelesen wurde die mitgegebene Textfassung (§15.16, §13.2).

## E. Offen / Grenzen
Siehe `handoff.md`. Insbesondere: Stand-in ≠ Engine; Chromium ≠ Safari/iPhone/Screenreader; Policy (`capture`) und Geometrie sind Testdaten; kein Eintrittsregel-Modell; Teammodus ist nur auf Domänenebene getestet (kein DB-/Browsertest mit Teams).

## F. Nachbesserung nach der unabhängigen PR-Prüfung (06.11.2026, Prüfbericht zu Head `b832241`)

Die zwei Prüfdateien (`n11-independent-review.test.ts` 4 Tests, `n11-independent-cas-review.test.ts` 1 SQLite-Test) wurden **zuerst unverändert übernommen und reproduziert**: am geprüften Head alle **fünf rot** (`expected [Function] to throw an error` bzw. `expected null to be an instance of Error`), die SQLite-Probe lieferte exakt `{"revisionBefore":5,"revisionAfter":6,"positionAfter":"t2","persistedRollCount":1}`. Der PR-Head war unverändert. Der Befund ist ein **echter Produktfehler**, kein Fehler der Prüfmessung.

### N11-01 [P2] — widersprüchliche letzte Bewegung übersteht die Recovery und umgeht den Wurfverbrauch
**Ursache (zwei Lücken):** (1) Die Ladeinvarianten prüften von `lastMove` nur Position, Vorwärtsrichtung und Start der Geschlagenen — nicht Schrittzahl = Routenabstand und nicht die grundsätzliche Möglichkeit eines Schlags auf diesem Feld. (2) Brett, N8 und N9 wurden beim Zusammenführen nie auf unmögliche Kombinationen geprüft; die Verbrauchssperre verglich nur `diceId`/`rollCount` mit dem aktuellen Wurf, ein beschädigter Marker galt damit als „Wurf unverbraucht“.

**Behebung:**
- `boardLastMoveIssues` (`@quiz/shared/board`, **eine** Implementierung für Server-Laden und Client-Projektionsschema): `steps` = Routenabstand von `from` nach `to` auf der Route des Bewegten; `to` strikt vorwärts; Schlag nur auf einem **vollen** Feld (Zahl der Geschlagenen = Kapazität), Opfer eines **anderen** Eigentümers, das dort stehen konnte (Feld auf seiner Route) und jetzt auf seinem Start steht. (Start-/Heimfelder sind laut Geometrieregeln exklusiv; ein Schlag dort scheitert damit schon an „Feld auf der Route des Opfers“. Eine eigene Klausel dafür war von dieser nicht unterscheidbar — Mutation blieb grün — und wurde entfernt, statt eine nicht prüfbare Regel zu behalten.)
- `assertBoardConsistent(board, sequence, dice)` (nur lesend; `BOARD_STATE_INVALID` mit Code `LASTMOVE_CONFLICT`): Zug aus der Zukunft der gebundenen N8-Folge; Marker nennt **diesen** Würfelvorgang, aber einen anderen Zug als den, zu dem der Vorgang gehört, oder eine Wurfnummer, die der Vorgang noch nicht gemacht hat; Marker **dieses Zuges** nennt einen anderen Vorgang (N9: ein Vorgang je Zug — sonst sähe der aktuelle Wurf unverbraucht aus). Angewandt in `moveFigure` (nach der N8-Autorisierung und der Zielbindung, damit ein nicht Berechtigter den N8-Grund und nicht den Schaden erfährt) und in `projectBoard` (jede Freigabe, jede Zielgruppe — der Recovery-/Projektionspfad). Der Fehler läuft über den bestehenden Weg (`gameErrorCode` → `BOARD_STATE_INVALID`).
- Zusätzlich in `applyDecidedBoardMove`: ein Wurf, der nicht neuer ist als die letzte Bewegung (älterer Zug oder `rollCount <=` desselben Vorgangs), gilt als verbraucht.
- Beim Laden wird nichts verändert, repariert oder „als unbenutzt“ behandelt.

**Positivkontrollen** (reguläre Zustände bleiben gültig): ein neuerer Wurf **desselben** Vorgangs nach einem älteren, verbrauchten ist verwendbar (Domäne **und** SQLite, mit Projektion `spent:false` und Zielen); ein späterer N8-Zug mit **neuem** Vorgang bleibt gültig (auch für dieselbe Person); ein bestätigter identischer Command bleibt ein Receipt-Replay (SQLite: `replayed:true`, ein Effekt, keine neuen Events); normale Bewegung, Schlag (Kapazität 1 und 2), Heimfeld (schrittweise und direkt) überstehen den JSON-Roundtrip und projizieren gültig.

**Nachweis:** Prüfer-Gegenproben unverändert grün; `boardState.test.ts` Abschnitt „N11-01“ (Schrittzahl, Richtung, 7 Schlagverletzungen, Marker-Zukunft/-Zug/-Vorgang, Zug aus der Zukunft für Projektion × 5 Zielgruppen × 2 Freigaben und Zug, Eingabe eingefroren und unverändert, N8-Grund zuerst, Positivkontrollen); `boardState.cas.integration.test.ts` (3 Beschädigungen über echte SQLite: Position, Revision, Events, Receipts unverändert, Fehlercode, Projektion verweigert; Positivkontrolle); Browser **S16** (4 Beschädigungen: Zug als `BOARD_STATE_INVALID` abgewiesen, Position/Revision/Events unverändert, Projektionsendpunkt ohne Brettdaten, Ansicht „nicht verfügbar“ ohne Steuerung, danach neue reguläre Welt mit Steuerung; ohne die Prüfung im Produktpfad ist S16 rot).

**Mutationen zu N11-01 (alle gefangen, Arbeitsbaum danach sauber):** N1 Schrittzahl nicht verglichen (5 rot) · N2 Zahl der Geschlagenen ≠ Kapazität akzeptiert (2) · N4 Opferroute egal (2) · N5 Opfer muss nicht auf dem Start stehen (1) · N6 Zug aus der Zukunft akzeptiert (1) · N7 Marker für noch nicht gemachten Wurf akzeptiert (4) · N8 Marker mit anderem Zug am selben Vorgang akzeptiert (1) · N9 Projektion ohne Konsistenzprüfung (5) · N10 Zug ohne Konsistenzprüfung (6) · N11 `apply` akzeptiert älteren Wurf (1) · N12 Laden ohne die gemeinsamen Regeln (13) · N13 Marker dieses Zuges mit anderem Vorgang akzeptiert (1) · Browser: N9+N10 zusammen → S16 rot.

**Beim Umbau gefunden (eigene Fehler):** (a) mein erster „ha“-Fall wurde bereits von der Schrittzahl abgewiesen und prüfte die Schlagregel gar nicht (Schrittzahl korrigiert, danach hängt die Abweisung allein an der Schlagregel); (b) die Klausel „Marker dieses Zuges nennt anderen Vorgang“ fehlte zunächst, weil ein älteres Test-Fixture (`dice-2` im selben Zug 1) sie verletzte — das Fixture war selbst gegen N9 („ein Vorgang je Zug“) und wurde auf einen späteren Zug umgestellt, die Prüfung blieb; (c) SQLite-Test: eine lokal beschädigte Platte lässt sich nicht über den Brettparser lesen, den ich für Intent und Positionsprüfung benutzt hatte — der Intent kommt jetzt aus dem Stand vor der Beschädigung, Positionen aus den Rohdaten.

**Grenze (ehrlich):** Ein Marker, der durch einen **plausiblen** Marker eines früheren Zuges ersetzt wurde (richtige Form, früherer Zug, früherer Vorgang), ist aus dem Zustand allein nicht von einer echten Historie zu unterscheiden; das erfordert die Ereignishistorie (State-Events) und liegt beim Runtime-Adapter. Die Prüfung erkennt jeden Marker, der **im Widerspruch** zu Brett, N8 oder N9 steht.
