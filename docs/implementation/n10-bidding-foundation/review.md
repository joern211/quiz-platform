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
