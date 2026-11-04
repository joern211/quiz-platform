# N10 — Zweite kritische Eigenprüfung (Review)

Stand: 03.11.2026. Nach dem ersten grünen Lauf wurde der Diff aus Prüfersicht neu gelesen, ein Browsernachweis gebaut, gezielt reversibel mutiert und jeder Befund behoben. **Produktfehler** und **Fehler der eigenen Messung/Testvorbedingung** sind getrennt aufgeführt.

## A. Befunde der Eigenprüfung

### A1. Produktfehler (gefunden und behoben)

| # | Befund | Ursache | Nachweis | Behebung |
|---|---|---|---|---|
| P1 | **Sendesperre ließ zwei Absichten im selben Tick durch.** Im Browser lösten ein programmatischer Klick auf „Bieten“ und ein Klick auf „Passen“ im selben Task beide Aufrufe aus (`calls = BID, BID, PASS`: das Gebot **und** der Pass derselben Bindung). | Die Sperre lag nur im React-State; beide Handler liefen mit der Closure **desselben** Renders (State-only-Annahme war falsch — im JSDOM mit `act` zwischen den Klicks unsichtbar). | Harness S4 (rot vor, grün nach der Behebung); neuer Komponententest „two presses inside ONE tick“ (`act(() => { submit; pass.click() })`); Mutation M12 (Ref entfernt) → 5 Komponententests **und** Browser S4 rot | Sperre zusätzlich als Ref; eine `REJECTED`-Meldung löst **genau einmal je Meldung** (optionale `id`), nicht dauerhaft. |
| P2 | Wenn niemand am Zug ist (N8 `HELD` nach Rollenausfall), zeigte das Panel dem Bidder „Ein anderes Team ist am Zug.“ — falsch, es kann niemand bieten. | beim Entwurf von Szenario S10 aufgefallen (kein roter Test), Wortlaut folgte der Standardverzweigung | Komponententest „nobody is up“, Browser S10 (`Im Moment kann niemand bieten.`) | eigener Zustand `stalled` (OPEN ∧ `onTurn = null`) mit eigenem Text, ohne Steuerelemente. |
| P3 | Der Pass-Button hatte seine Folge („kannst nicht wieder einsteigen“) nur als Nachbartext. | Review aus Sicht assistiver Technik | Komponententest `aria-describedby` | `aria-describedby` auf den Hinweistext. |
| P4 | `BIDDING_NOT_BIDDER` war nach `authorizeTurnAction` unerreichbar (der N8-Halter ist durch die Passungsprüfung immer der gepinnte Bidder; ein Performer scheitert vorher mit `TURN_SEQ_NOT_CURRENT_ACTOR`). | toter Code/Code ohne Pfad | Codeprüfung; die Performer-Probe verlangt `TURN_SEQ_NOT_CURRENT_ACTOR` | Prüfung und Code entfernt. |

### A2. Fehler der eigenen Messung / Testvorbedingung (kein Produktfehler; unabhängiger Beleg statt angepasster Erwartung)

| # | Falsche Vorbedingung | Wie erkannt | Beleg / Korrektur |
|---|---|---|---|
| M-a | Browser S3: „Fokus bleibt im Eingabefeld“ wurde **nach** der Übergabe gemessen (`activeElement = BODY`). Das Feld verschwindet dort legitim, weil der Bidder nicht mehr am Zug ist. | Messung vs. Panelverhalten | Gemessen wird jetzt **während des Pending** (`holdSends`): Fokus bleibt im schreibgeschützten Feld (S3) bzw. auf dem `aria-disabled`-Pass-Button (S4). Restgrenze (Fokus auf `<body>` nach verschwindendem Feld) bleibt als UX-Punkt in `handoff.md` 11. |
| M-b | Komponententest „closed → invalid → altes ‚darf bieten‘“: das `CLOSED`-Fixture war schema-**ungültig** (kein Team als ausgestiegen markiert) und wurde vom strengen Intake korrekt verworfen; der Test sah dadurch scheinbar „Kontrolle zurück“. | Zwischenbehauptung „Closed-Sicht wird angezeigt“ ergänzt | Fixture korrigiert (`passed: ['T1','T3']`), Vorbedingung im Test geprüft. Der Intake war richtig. |
| M-c | Testhelfer riefen `currentTurnHolder` einer geschlossenen Folge auf (TypeError) statt den Domänencode zu prüfen (zwei Stellen: Abbruch, DB-Test). | Fehlermeldung `Cannot read properties of null` | Direkter Aufruf der Domäne mit explizitem `who`. |
| M-d | N5-Rollen-IDs in Großbuchstaben (`SecretInfoIdSchema` verlangt Kleinbuchstaben); Revisionszahl des DB-Tests (Fixture 4 + ein Commit = 5, nicht 6); CSS-Probe `\bwidth` traf `border-width`; zwei TypeScript-Typfehler in Tests (`last`). | Fehlschläge/Typecheck | jeweils Test/Probe korrigiert; keine Erwartung an ein Produktfehlverhalten angepasst. |

### A3. Entwurfsentscheidungen, die sich beim Bauen bestätigt oder präzisiert haben
- Die **wörtliche Auftragsprobe** (T1 3, T2 5, T1 passt, T3 8, T2 passt) ist unter dem Planungsvertrag `CYCLIC_SKIP_LEFT_AND_LEADER` **keine gültige Zugfolge** (nach T2s Gebot käme T3, nicht T1). Das ist gewollt: der Auftrag trennt Mechanik- und Planungsprüfung ausdrücklich; die Probe läuft auf `applyBid`/`applyPass`, der volle Pfad wird mit eigenen gültigen Folgen (3 und 4 Teams) geprüft.
- Der schließende Pass/Abbruch schreibt eine neuere N6-Basis **nicht** fest; das ist eine bewusste, dokumentierte Entscheidung (terminal), kein verschluckter Wissensstand — jeder nicht-terminale Erfolgspfad schreibt sie fest (Test + Mutation M8b).

## B. Mutationsprüfung (reversibel; je Mutation passende rote Assertionen; danach Produktstand wiederhergestellt, `git diff` leer)

| Mutation | Gefangen durch (Auswahl, ausgeführte Läufe) |
|---|---|
| M1 gleiches Gebot akzeptiert | 4 Domänentests rot (u. a. „jumps are allowed; equal and lower bids are rejected“) |
| M2 Mehrteam: Abschluss nach dem ersten Pass | 53 rot (u. a. wörtliches Beispiel, „three teams: the FIRST pass does not end“) |
| M3 falsches letztes Gegenteam (erster statt letzter Pass gegen den Gewinner) | 3 rot (u. a. 4-Teams-Beispiel, gefälschtes Ergebnis) |
| M4a Performer-/Host-Performer-Sicht leakt (STANDING für alle) | 4 Domänentests rot **und** Browser S1 rot |
| M4b mitspielender Host als `HOST`-Audience nach Host-Rolle beurteilt | 1 rot („a HOST who plays as PERFORMER gets NO extra view“) |
| M5 Zielbindung aus dem aktuellen Zustand statt aus der Absicht | 8 rot (Domäne + DB-Test, je Ebene) **und** Browser S6 rot |
| M6a Intake: Entzug löscht Versionswissen | 8 Intake-/Komponententests rot |
| M6b Sendesperre hängt an Objektidentität | 6 Komponententests rot |
| M7a Receipt-Payload entfernt (DB-Stand-in) | 1 rot (COMMAND_CONFLICT-Probe); zusätzlich **Harness-Server** mit `payload: {}`: Browser S12 rot (`same id + other operation` lieferte Replay) |
| M7b CAS-Schutz entfernt (erwartete Revision in der Transaktion gelesen) | 3 DB-Tests rot (Konkurrenz) |
| M8a neuere Berechtigungsbasis im expliziten Refresh verschluckt | 1 rot |
| M8b neuere Basis auf dem erfolgreichen Gebotspfad verschluckt | 3 rot |
| M11 terminale Prüfung geschwächt | 4 rot (Phasenmatrix, Wiederholung) |
| M12 Sperre im selben Tick entfernt (Ref) | 5 Komponententests rot **und** Browser S4 rot |
| M14 Führender darf wieder handeln | 1 rot |
| M15 N8-Halter weicht vom Plan ab, wird akzeptiert (zwei Wahrheiten) | 1 rot |
| M16 Übergabe per `COMPLETE` statt Override (Mitgliederrotation) | 6 rot (u. a. „NO bidder rotation“) |

Ein kaputter Import/Build gilt nicht als Beleg: jede Mutation lief durch den Typecheck-freien Vitest-Lauf mit benannten Assertionen; M2 bricht zusätzlich an der Ladeinvariante (viele Folgefehler), die erste rote Assertion ist aber die fachliche.

## C. Historische Fehlermuster → Gegenproben

| Muster | Gegenprobe in N10 |
|---|---|
| N1 neue Props-/Feedbackidentität löscht die Sendesperre | `BiddingPanel.test.tsx` „identical props created anew, a re-render and a theme change“ (Zähler = Callback-Anzahl), M6b |
| N2/N4 unvollständige/alte Rückmeldung gilt als Wahrheit; LOCK/Entzug ohne Ersatz | Intake-Ketten; Entzug ohne Ersatzdaten zeigt „nicht verfügbar“, keine alte Berechtigung (Komponente, Browser S8) |
| N6/N7 Löschen sichtbarer Daten löscht Versionswissen; je neue Ebene | `biddingIntake.test.ts`: Snapshot, Bietversion, Folgeversion, Zug **je Ebene einzeln** (`null`-Zwischenstand), M6a |
| N7 Seek/Ack beweist keine Wirkung | Alle Browserchecks lesen den DB-Stand (`/api/state` aus SQLite), Empfängerwirkung am gerenderten Text **und** empfangenen JSON |
| N7 Wanduhr statt Zähler | Zähler aus gespeichertem Zustand; Neustarttest S14 erfindet keinen höheren Startwert (`basisVersion` bleibt); `Math.random`/`Date.now`-Spione in Domänentests |
| N8-01 recipientId nur im lokalen Schlüssel | `biddingProjectionMatches` vergleicht das empfangene Paket; A-Paket unter B-Erwartung auch innerhalb eines Teams (`b3`/`p3`), im Intake und in der Komponente |
| N8-02 No-op-/Erfolgspfade verwerfen neuere Eligibility | Domäne D (Gebot, nicht schließender Pass, expliziter Refresh), DB-Test, Browser S11, M8a/M8b; terminale Pfade bewusst anders (siehe A3) |
| N8-03 Quelle gegen eigenen Scope geprüft, Run verloren | `biddingRolesFromRoleDeal` vergleicht Run/Runde/Deal/Revision gegen **unabhängig erwartete** Werte; N8 prüft den Run je Ebene; DB-Test mit anderem Run |
| N9-01 Absicht nur mit lokalen Zählern | `scope`+`teamId`+Zähler Pflicht; Test je Ebene (Run, Runde, Bietinstanz, Sequenz, Roster, Rollenrevision) für Gebot **und** Pass in Domäne und DB, Browser S6 (verspätete Erstzustellung im Browser selbst), M5 |
| N9-02 Payload auskommentiert | Payload als echtes Feld; Harness-Dateien im Typecheck (`pnpm typecheck`); Konfliktproben für Operation/Wert/Ziel/Team/Zähler (DB + Browser S12), M7a inkl. Harness |
| N9-03 Versionsüberlauf erst nach Wirkung | Kapazität vor jeder Änderung (N8-Version/Zug/Entitlement, Schritte); Grenzen unterhalb/am Limit mit unverändertem Zustand (Domäne D) |

Mehrstufige Sichtketten (Domäne/Intake/Komponente/Browser): aktuelles Gebot → `null` → älteres; Pass/geschlossen → ungültig → altes „darf bieten“; Bidder → Performer (neue Rollenrevision) → spätes Bidder-Paket **desselben Teilnehmers** (Browser S7); A in altem Zug → B → A neu → alter Befehl; neue Berechtigungsbasis ohne Gebot → alter Stand; neutrale Sicht → Entzug → spätes freigegebenes Paket.

## D. Abweichungen vom Auftragsablauf (ehrlich)
- **Entwurf nach dem Domänencode ausformuliert.** Der Auftrag verlangt einen kurzen konkreten Entwurf vor der Umsetzung. Der Entwurf lag als Überlegung und in den Kopfkommentaren von `bidding.ts`/`biddingPhase.ts`; das vollständige Dokument `design.md` wurde erst danach geschrieben und beschreibt den Endstand. Es gab keinen separaten Entwurfs-Commit.
- **Post-Merge-CI von main** war beim Start im Job „CI“ erfolgreich, der Job „E2E“ lief noch; ein späterer Abruf ist in `acceptance.md` festgehalten.
- Kein unabhängiger zweiter Prüfer: die Mutationsprüfung und Messungen sind Eigenprüfung.

## E. Offen / Grenzen
Siehe `handoff.md` und `design.md` §9. Insbesondere: Planungsvertrag und Randfallpolicy sind unsere Policy; Fokus nach verschwindendem Feld; Chromium ≠ Safari/iPhone/Screenreader; Stand-in ≠ Engine; Neutralpaket-Metadaten; DEC-PCH-01 offen.


## F. Nachbesserung nach der unabhängigen PR-Prüfung (04.11.2026, Prüfbericht zu Commit `5596c16`)

Die sieben Gegenproben des Prüfers (`n10IndependentReview.test.ts` ×3 Server, `n10IndependentReview.test.tsx` ×4 Web) wurden **zuerst reproduziert**: am geprüften Stand alle sieben rot (Server: `prepare` weist Run 2 / Runde 2 nicht ab, BASIS nimmt den letzten Schritt; Web: drei statt zwei Aufrufe, Eingabe bleibt `readonly`, spätere Ablehnung gibt eine Wiederholung frei). Alle vier Befunde waren **Produktfehler** und echt; kein Befund war ein Fehler der Prüfmessung.

| Befund | Ursache | Behebung | Nachweis |
|---|---|---|---|
| **N10-01 [P2]** Eine Ablehnung gibt mehrere Wiederholungen frei; eine späte Promise-Ablehnung gibt eine laufende Wiederholung frei | `guard` las `rejected` aus der Closure des Renders (zweiter Klick im selben Task sah weiter `true`); `unlock` prüfte nur den Bindungsschlüssel | `sendAttempts.ts`: jede Sendung ist ein **Versuch mit Identität** (`a1`, `a2` …); die Entscheidung fällt am **aktuellen Ref-Zustand**; Berichte werden genau einmal verbraucht; Promise-Ablehnung und Berichte (mit `attemptId`) gelten nur für ihren Versuch; Gebot und Pass teilen eine Sperre je Bindung | Prüfer-Tests 1 und 4; `BiddingPanel.test.tsx` „retry chains“ (Pass→Bid und Bid→Pass nach Ablehnung, drei Ereignisse im selben Task, späte Ablehnung/Bericht eines alten Versuchs während einer laufenden Wiederholung, wiederholter alter Bericht, identischer Text mit `attemptId`/`id`); `sendAttempts.test.ts` (reiner Zustand); Browser **S15** (Aufrufe, die die Seite wirklich verlassen); U1–U4 |
| **N10-02 [P2]** Gebot bleibt nach Ablehnung im Pending | `NumberField` wartet auf Feedback für **seinen** Versuch; das Panel gab nur die eigene Sperre frei und ließ `attemptId`/Report-Identität fallen (zweite gleichlautende Ablehnung erschien als alt) | Der Versuch trägt die `NumberField`-attemptId; **alle** Rückmeldewege (Promise, Bericht mit/ohne `attemptId`, PENDING/ACCEPTED) münden in einen Versuchszustand, aus dem das NumberField-Feedback **abgeleitet** wird; Pass-ACK/alte Pass-Ablehnung erreichen die Zahleneingabe nicht | Prüfer-Tests 2 und 3 (nur Beschriftung des Retry-Buttons an N1 angepasst: „Erneut senden“); Tests „rejected promise releases … retry is really sent (call count)“, „identical text … each release their own attempt“, „PASS acknowledgement … neither releases nor confirms“; U5/U6 |
| **N10-03 [P2]** Der N5-Adapter verliert die Herkunft der Rollen | Ergebnis enthielt nur `rolesRevision`/`teams`; `prepareBiddingPhase` nahm Run/Runde unabhängig davon | Adapterergebnis trägt den **Ursprung** (Run, Runde, Deal-ID, Revision; nur Labels); `prepareBiddingPhase` nimmt Rollen als **ausdrücklich getrennte Eingänge** `N5_DEAL` (Ursprung wird gegen Run/Runde des Ziels und den **unabhängig erwarteten** Deal geprüft) und `RAW` (ungeprüft, nur für synthetische Tests/eigene Quellen); kombinierter Pfad `prepareBiddingPhaseFromRoleDeal` mit **einem** erwarteten Scope für Deal und Ziel; nichts Vertrauliches in Zustand oder Projektion | Prüfer-Test 5/6 (Eingang an den erweiterten Vertrag angepasst, Erwartung unverändert); `biddingPhase.test.ts` **I**: komplette Strecke N5 → N10 (zwei Deals derselben Partie, gleiche Teilnehmer, **gleiches Revisionslabel**, vertauschte Rollen), Positivkontrolle, Run/Runde/Deal-ID/Revision je einzeln, Projektion für den tatsächlichen Performer der neuen Runde (neutral, STANDING verweigert), alter Bidder kann nicht bieten, Leak-Probe (Fragmenttext, dritte Rolle, Deal-IDs); S1/S2 |
| **N10-04 [P3]** BASIS kann den letzten Schritt für den Abschluss verbrauchen | `refreshBiddingBasis`/`withholdBiddingHolder` reichten an N8 durch, ohne die Reserve zu beachten | `withClosingReserve`: ein **echter** Schritt braucht Version +2 und (bei `ACTIVE`) Entitlement +1; No-op verbraucht nichts; andere Fehler behalten ihren Code und ihre Reihenfolge; ein vom N8-Zähler nicht darstellbarer Schritt wird zu `BIDDING_COUNTER_LIMIT` statt `TURN_SEQ_STATE_INVALID`; `openBidding` verlangt die Abschlussreserve des Ausgangspaars; `abortBidding` aus HELD braucht keinen Entitlement-Schritt | Prüfer-Test 3; `biddingPhase.test.ts` **J** (Öffnen am Limit, BASIS knapp darunter/am Limit/auf MAX, Entitlement, HELD, Abbruch bleibt möglich, No-op, Fehlerreihenfolge); S3–S6 |

Beim Umbau fand ich **einen eigenen Fehler**: die erste Fassung des Abbruchs verlangte den Entitlement-Schritt auch aus `HELD` und scheiterte am Test „HELD keeps the closing reserve“ (Abbruch nach `ACTIVE→HELD` am Entitlement-Limit); Ursache war die zu grobe Reserve, behoben auf „nur bei `ACTIVE`“.

**Neue Mutationen (alle gefangen, Arbeitsbaum danach sauber):** U1 Promise-Ablehnung ignoriert die Versuchsidentität (4 rot) · U2 Entscheidung am Render-State statt am Ref (3 rot **und** Browser S4, S15) · U3 Bericht mehrfach wirksam (2 rot) · U4 Bericht gilt für jeden Versuch (3 rot) · U5 NumberField-Feedback ohne attemptId (2 rot) · U6 Promise-Ablehnung gibt die Zahleneingabe nicht frei (5 rot) · S1 Herkunft nicht gegen Run/Runde geprüft (2 rot) · S2 erwarteter Deal nicht geprüft (1 rot) · S3 BASIS ohne Reserve (3 rot) · S4 HELD ohne Reserve (1 rot) · S5 No-op verbraucht Reserveprüfung (2 rot) · S6 Öffnen ohne Reserve (1 rot).

**Grenzen der Nachbesserung (ehrlich):** Ein Bericht **ohne** `attemptId` und `id` ist nur durch seinen Inhalt identifiziert und wirkt höchstens einmal — eine Anwendung, die denselben Text für mehrere Versuche meldet, muss eine `id` oder die erhaltene `attemptId` mitgeben (Vertrag in `handoff.md`). Die Herkunft eines `N5_DEAL`-Ergebnisses wird gegen das Ziel verglichen, aber ein **absichtlich gefälschtes** Ergebnisobjekt (Ursprung von Hand gesetzt) ist ein Aufruferfehler, den kein reiner Helfer authentifizieren kann — dafür ist der kombinierte Pfad (Deal wird geladen und geprüft) die vorgesehene Eintrittsstelle. `git diff --check` meldete eine zusätzliche Leerzeile am Ende von `biddingTestFixtures.ts`; bereinigt.
