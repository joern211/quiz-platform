# N9 — Zweite (adversariale) Eigenprüfung

Stand: 02.11.2026. Methode: Nach dem ersten grünen Lauf (Domäne, DB-Integration, Intake, Komponente, Browser) wurde der Diff aus Prüfersicht erneut gelesen, mehrstufige Ketten gebaut, **ähnliche Stellen außerhalb des zuerst gefundenen Pfads** geprüft und 17 kleine, einzeln zurückgenommene Mutationen ausgeführt. Grüne Tests allein gelten nicht als Beweis; eine Probe wurde nie an ein Produktverhalten angepasst. Jeder Messfehler steht getrennt von den Produktbefunden (Abschnitt C), mit Vorbedingung, unabhängigem Beleg und Korrektur.

## A. Befunde am Produkt oder an der Nachweiskette (gefunden, behoben)

| # | Befund | Ursache | Beleg | Behebung / Regressionsprobe |
|---|---|---|---|---|
| F1 | **Bedienung: Tastaturfokus ging nach jedem angewendeten Halten verloren.** Wer ein Würfel mit Leertaste hielt, konnte nicht sofort mit Enter freigeben. | Die Sendesperre setzte `disabled`; ein fokussiertes Element, das `disabled` wird, verliert den Fokus. | Browserszenario S4 (Messung am gerenderten DOM): nach dem angewendeten Halten `document.activeElement` = `BODY`; „Enter released die 3 again“ lief in den Timeout; Folgefehler S5/S6 (Würfel 3 blieb gehalten). | Sperre jetzt über `aria-disabled` (der Wächter ist die Bindungssperre im Code, nicht das Attribut), `.locked`-Stil. Regression: `DiceTray.test.tsx` (kein `disabled`, Fokus bleibt), Browser S4 (Fokus-Assertion **und** Zustellung vor dem nächsten Druck). Erneuter Lauf: 18 → 19 Szenarien grün. |
| F2 | **Nachweislücke: „echtes CAS“ war im Stand-in nie allein belegt.** | Der Stand-in-Commit prüfte die Revision selbst vor dem Schreiben; das bedingte `UPDATE` von `saveGameStateIfRevision` wäre redundant gewesen. | Gedankliche Mutation vor dem Lauf; dann M8a. | Eigene Vorprüfung entfernt (Test und Harness): das Primitiv ist der **einzige** Wächter. M8a (`where` ohne Revision) wird jetzt von 4 Tests gefangen. |
| F3 | **Nachweislücke: Schutz „Vorgang eines früheren Zugs (gleicher Spieler)“ nur von einem Unit-Test gefangen, vom Browser gar nicht.** | Die Harness-Zugwechsel ersetzten den Vorgang immer atomar; ein vergesslicher Verbraucher kam nirgends vor. | M3b: 1 roter Test; im Browser **überlebt**. | Host-Befehl „nur N8 weiterschalten“, Browserszenario S10b, DB-Test „vergisst die Würfel“. M3b jetzt in DB-Test, Unit-Test **und** Browser gefangen (Browser: der Server nahm auf dem Vorgang von Zug 1 einen Wurf an). |
| F4 | **Typfehler im Integrationstest** (geschlossene Aktionsliste `CRITICAL_COMMAND_ACTIONS`, ein Cast). | Vitest prüft keine Typen; `pnpm typecheck` schon. | `pnpm typecheck` → 2 Fehler. | Stand-in-Aktion `ROUND_ADVANCE` (wie bei N8; N9 führt keine neue Command-Art ein), Cast korrigiert. Typecheck Exit 0. |
| F5 | **Falsche Annahme im Entwurf:** das State-Event lasse sich über `saveGameStateIfRevision({ gameSlug })` mit einem Stand-in-Slug nutzen. | `gameSlug` schaltet auch `persistRoundResult` ein; `coreLifecyclePhase` wirft für unregistrierte Slugs `WRONG_GAME` (12 rote Tests im ersten DB-Lauf). | Fehlerausgabe, Quelltext `results.ts:54`, `lifecycle.ts:14`. | Der Stand-in ruft `materializeGameEvent` (dieselbe Funktion) direkt in derselben Transaktion auf; im Testkopf und in `handoff.md` dokumentiert. Kein N9-Produktfehler, aber eine Grenze des Nachweises. |
| F6 | **Lücke im ersten Satz DB-Tests:** der Absturz **nach** dem Commit und **vor** der Receipt-Fertigstellung (der eigentliche „verlorene Antwort“-Fall unterhalb des Receipt-Replays) war nicht belegt. | Der erste Satz prüfte nur „COMPLETED → Replay“. | Lesen von `runReceipted` (`FAILED` + `mutationStartedAt` → `retrySafetyVerdict` = `advanced`). | Zwei Tests: Absturz nach dem Commit (Wiederholung = `COMMAND_STATE_ADVANCED`, kein zweiter Handlerlauf, 5 statt 10 Ziehungen) und fachlicher Fehler **vor** dem Commit (Wiederholung läuft den Body erneut und scheitert gleich, kein Zufall). |
| F7 | **N8-02-Lücken:** die BASIS-Meldung war nur im Spielermodus und nur auf dem Wurfpfad belegt. | Erste Tests deckten den ersten Fall, nicht „gleiche Haltebelegung + neuerer Stand“ in der Datenbank und nicht die Teamebene. | Gedankliche Kette „Erfolgspfad ohne Änderung“ (genau das N8-02-Muster). | Teammodus-Test (beide Ebenen, nur Mitgliederebene, falsche Ebene) und DB-Test „Halten ohne Änderung persistiert die Basis“ (eine Revision, Folgeversion +1, Würfel bitgleich). M9 wird gefangen. |

## B. Ketten, die ausdrücklich gebaut wurden
- neuer Wurf → null → älterer Wurf (Intake, Komponente, Browser S8); geschlossen/gesperrt → ungültig → alte aktive Sicht (Intake, Komponente); A Zug 1 → B Zug 2 → A Zug 3 → verspätetes A-Zug-1-Paket (Intake, Komponente, Browser S10); für A erzeugtes Paket unter erwartetem Empfänger B, auch im Team, auch bei `NONE` (Intake, Komponente, Browser S1b); identischer Zug + neuer N8-BASIS-Stand (Domäne F, Intake, Komponente, DB, Browser S11).
- Alle fünf Ordnungsebenen **einzeln** (nur älter / nur neuer): `diceIntake.test.ts` „every ordering level protects on its own“.
- Hold ↔ Roll aus demselben gespeicherten Stand in beiden Reihenfolgen (DB), nacheinander mit veralteter Würfelversion (Domäne, DB), Doppelklick, Wurf-nach-Halten und Halten-nach-Wurf in der UI auf derselben Bindung (Komponente).
- Späte Rückmeldung (Fehler) eines **alten** Zuges, während die Absicht eines **späteren** Zuges desselben Spielers gesperrt ist (Komponente und Browser S14, mit abgeschlossener Sendung als Messpunkt statt `sleep`).

## C. Messfehler (nicht Produktfehler)
| # | Probe / Messung | Vorbedingung, die falsch war | Unabhängiger Beleg | Korrektur |
|---|---|---|---|---|
| C1 | Baseline `pnpm --filter @quiz/server test` am unveränderten `main` mit einem roten Test (`rate-limiter.integration`) | Die Umgebung hatte `apps/server/dist` nicht gebaut; der Test startet `dist/app.js` | Fehlertext `ERR_MODULE_NOT_FOUND …/dist/app.js`; 1261 Tests bestanden + 3 übersprungen = 1264 (= CI-Zahl) | Vor dem finalen Lauf `pnpm build` (wie die CI). |
| C2 | Intake-Test „stateVersion über 1e9 ist ungültig“ | Der Vertrag begrenzt nur die **lokalen** Zähler (1e9); `stateVersion` ist die globale Revision (sicher, ganzzahlig, ≥ 0 — in N8 identisch) | `shared/dice.ts` `DiceStateVersionSchema`, `shared/turnSequence.ts` | Probe auf `diceVersion`/`sequenceVersion` > 1e9 geändert, Kommentar ergänzt. |
| C3 | Quelltext-Probe der Shared-Datei (keine `process.`, keine Parameter-Properties) | Regex traf das Wort „process.“ im Kommentar und `readonly` als Typmodifikator (`issues: readonly …[]`) | `grep` am Quelltext: Treffer nur im Kommentar | Kommentare vor der Probe entfernen; Regex nur für echte Parameter-Properties, **mit Positivkontrollen**. |
| C4 | Domänentest „keine Aktion bei N8 ohne Halter“ | Der Hilfsbau `callerOf` las den Halter einer Folge ohne Halter und warf beim Zusammenbau der Argumente | Fehlertext `Cannot read properties of null` aus dem Test, nicht aus dem Produkt | `callerOf` robust. |
| C5 | Komponententests: drei Fehler | `import.meta.url` ist in jsdom kein `file:`-URL; ein Rest-`set` nach `unmount`; ein synchroner Wurf aus dem Handler läuft als globaler Fehler durch | Fehlertexte der Testläufer | Pfade über `process.cwd()`, Rest entfernt, Fensterfehler im Test erwartet; zusätzlich eine unsinnige Vergleichszeile ersetzt (Vite-Warnung). |
| C6 | Browser S10b `delivered` | Der Helfer verglich die Zugnummer der Projektion mit der **N8**-Zugnummer; die Projektion trägt die des **Würfelvorgangs** (im Szenario bewusst verschieden) | Das Szenario selbst (Vorgang Zug 1, N8 Zug 5) | Vergleich mit `dice.binding.turnNumber`. |
| C7 | Browser S4 erste Messung | Enter wurde gedrückt, bevor die Seite die neue Bindung **erhalten** hatte | — (die zweite Messung wartet auf `delivered` und misst den Fokus separat: der Fokusverlust bleibt bestehen → F1) | Zustellung abwarten, Fokus getrennt messen. |

## D. Historische Claude-Fehlermuster: Gegenprobe und Mutation
| Muster | Gegenprobe in N9 | Mutation |
|---|---|---|
| **N1** neue Objektidentität löschte die Sendesperre | `DiceTray.test.tsx`: Doppelklick mit **neu erzeugten** Props (JSON-Kopie), Re-Render, Themewechsel; maßgeblich die Callback-Anzahl; Browser S6 (echter Doppelklick) und S14 (Sperre über mehrere 120-ms-Projektionsobjekte) | M7: 1 Unit- + 1 Browsertreffer |
| **N2/N4** alte/unvollständige Rückmeldung als vollständige Wahrheit | Intake: null/undefined/ungültig/fremd ersetzen nichts durch eine alte Berechtigung; Browser S8 | M6 (9 rote Tests) |
| **N6** Entfernen sichtbarer Daten entfernt Versionswissen | Ketten neu→null→älter, geschlossen→ungültig→alt; `NONE`/geschlossen heben das Wissen an; fremde/ungültige Pakete vergiften nicht | M6 |
| **N7** dieselbe Lücke bei einer zusätzlichen Ebene | fünf Ebenen einzeln; Kontext = Sequenz (nicht je Vorgang), sonst wäre A1→B2→A3→A1 ein Neuanfang; fremde `diceId` im selben Zug | M14 (2), M15 (1) |
| **N7** angeforderter Seek = gelungener Seek | Browser liest **immer** den DB-Stand (Werte, Haltebelegung, Wurfzahl, Version, Revision, Receipts, Ziehungen) statt eines Labels; Klick/Animation beweisen nichts | M1 im Browser: 11 Meldungen aus der Datenbank- und Anzeigeprüfung |
| **N7** Wanduhr als Zähler | Domäne ruft keine Uhr (Spy auf `Date.now`/`hrtime`, alle Funktionen eingefroren); Neustart S16: gleiche Werte/Versionen/Basis aus der Datenbank, `draws` 0, Basisversion aus dem **gespeicherten** Stand statt eines höheren Werts | — |
| **N8-01** recipientId nur im lokalen Schlüssel | Empfänger in **jedem** Paket (auch `NONE`); A-Paket unter B-Erwartung inkl. Team und positive Kontrolle (Domäne, Intake, Komponente, Browser S1b mit echten Paketen aus dem Server) | M5 (5) |
| **N8-02** gültige No-op-Pfade verwarfen neue Basis | `sequenceBasisAdvanced` auf jedem erfolgreichen Pfad, auch `changed:false`; im selben Commit persistiert (DB); Lesefunktion bleibt rein (Eingabe eingefroren) | M9 (4) |
| **N8-03** Run ging über eine Bausteingrenze verloren | Run im Vorgangszustand, in `openDiceTurn`, `assertDiceScope`/`assertCurrentTurn` und über N8 `authorizeTurnAction`/Eligibility; Test „anderer Run“ mit denselben Spieler-IDs (Scope, Eligibility, Vorgang). Mutationsgrenze: die Run-Prüfung der Würfelschicht ist zweifach vorhanden (Scope **und** aktueller Zug); das Entfernen **einer** Stelle bleibt wirkungsgleich — bewusst redundante Schichten, kein toter Test | — |

## E. Mutationen (je eine, einzeln zurückgenommen, danach `git diff` je Datei leer)
Ein Treffer zählt nur bei **Assertion**-Fehlern; ein Lade-/Transformfehler würde als „ungültig“ gelten (keiner trat auf). Läufe am Produktcode von Commit `5fe1360` (seitdem nur Tests/Harness/Typfehler geändert, Produktdateien unverändert).

| ID | Mutation | Datei | Rote Tests (Domäne + DB / Web) | Browser |
|---|---|---|---|---|
| M1 | gehaltene Position wird neu gewürfelt | `diceTurn.ts` | **50** | **11** Meldungen (S5 …) |
| M2 | Wurflimit umgangen (beide Prüfungen) | `diceTurn.ts` | **3** (der strenge Ladevorgang fängt den Zustand zusätzlich) | — |
| M3a | alte Würfelversion akzeptiert | `diceTurn.ts` | **6** | — |
| M3b | Vorgang eines früheren Zugs akzeptiert | `diceTurn.ts` | **2** (vorher 1, siehe F3) | **3** (vorher überlebt) |
| M4 | Replay/Restore würfelt neu | `diceTurn.ts` | **31** | — |
| M5 | Empfängerbindung fehlt | `shared/dice.ts` | **5** (Web) | — |
| M6 | Entzug löscht Versionswissen | `diceIntake.ts` | **9** (Web) | — |
| M7 | Props-Wechsel löscht die Sendesperre | `DiceTray.tsx` | **1** (Web) | **1** (S14) |
| M8a | CAS-Schutz entfernt (`UPDATE` ohne Revision) | `state.ts` | **4** | — |
| M8b | Receipt-Replay abgeschaltet | `commands.ts` | **2** | — |
| M9 | neuere Berechtigungskenntnis verschluckt (N8-02) | `turnSequence.ts` | **4** | — |
| M10 | gleiche Haltebelegung erzeugt einen Effekt | `diceTurn.ts` | **3** | — |
| M13 | späte Rückmeldung entsperrt jede Bindung | `DiceTray.tsx` | **1** (Web) | **2** (S14) |
| M14 | Zugebene im Intake entfernt | `diceIntake.ts` | **2** (Web) | — |
| M15 | Folgeversion im Intake entfernt | `diceIntake.ts` | **1** (Web) | — |
| M18 | N8-Berechtigung fehlt | `diceTurn.ts` | **12** | — |
| M19 | Zufall vor der Validierung gezogen | `diceTurn.ts` | **100** | — |

Zu „BASIS-Update setzt das Wurflimit zurück“: der Würfelzustand hat **keinen** Codepfad, der auf eine Folgeversion reagiert; der Satz ist eine Eigenschaft des Verbrauchers und wird durch Tests belegt (Domäne F: Limit nach BASIS unverändert; DB; Browser S11: Wurf 2 setzt Wurf 1 fort), nicht durch eine künstliche Mutation. Die ihm nächste echte Mutation ist M9.

## F. Abgleich Entwurf ↔ Endstand
- Wie entworfen: Konfigurationen, Zustände, fünf Ebenen, Zufall nur in `rollDice`, `applyDecidedDiceRoll`, Zielbelegung, `NONE/VALUES`, Kontext = Sequenz, Sperre je Bindung (Roll und Hold teilen sie), Animation nur CSS.
- Abweichungen: (1) Sperre mit `aria-disabled` statt `disabled` (F1). (2) State-Event im Stand-in über `materializeGameEvent` statt `gameSlug` (F5). (3) CAS-Primitiv als einziger Wächter im Stand-in (F2). (4) `CRITICAL_COMMAND_ACTIONS` nicht erweitert (Stand-in `ROUND_ADVANCE`), im Entwurf nicht erwähnt, in `handoff.md` ergänzt. (5) Harness: Host-Befehle `endTurnN8Only` und `script` (nur dort).

## G. Hinweise außerhalb des Auftrags (nicht geändert)
- N8 `TurnStatusCard` nutzt ebenfalls `disabled={locked}`. Dort verschwindet der Knopf nach dem angewendeten Zugwechsel ohnehin; ein Fokusverlust wie in N9 wurde nicht gemessen und N8 wurde **nicht** angefasst.
- Lint: 109 Warnungen wie vor N9 (keine aus N9-Dateien).
