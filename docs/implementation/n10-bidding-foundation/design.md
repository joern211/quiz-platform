# N10 — Gemeinsame Biet-/Gebotsgrundlage (Pass-Logik, Rollen-Geheimhaltung, Wiederherstellung): Entwurf und Vertrag

Base: `main` @ `4d10e10fbe63d4afc454738c6a4bbc804c94da97` (N9 = PR #39 gemergt; beim Start per `git fetch` bestätigt, Branch `claude/new-session-nupoo1` frisch davon). Der CI-Lauf 41549455618 der Post-Merge-Commits war beim Start im Job „CI“ **erfolgreich** (Typecheck, Lint, Build, Server-/Webtests), der Job „E2E“ lief noch; das Ergebnis wird hier nicht vorweggenommen (siehe `acceptance.md`).
Quellen: Arbeitsauftrag N10 (03.11.2026); `Master_Regelwerk_3.txt` §§2–4, 5.12–5.24, 5.29–5.33, 12.7, 13.2, **15.9 vollständig**; N8-/N9-Dokumentation und Quellcode. Es gibt **keine** AGENTS.md/CLAUDE.md im Checkout (nur `SKILL.md` mit Projektregeln: `.js`-Importendungen, kein Glow, `prefers-reduced-motion`). Dieses Dokument ist **nach** dem Domänencode in den Dateiköpfen ausformuliert worden (siehe `review.md` §F); es beschreibt den Endstand.

**Grundlagenpaket, Stufe H. 0 neue echte Engine-Verbraucher.** Testadapter, Harness und Komponente sind keine Verbraucher. Der Core-DoD (Master §13.2) bleibt offen.

## 1. Was wiederverwendet wird — und was wirklich ergänzt wird

Unverändert wiederverwendet: N1 (`numeric.ts`: `NumericValue`, `validateNumericValue`, `projectNumericPublicInput`, `NumberField` — **eine** Parserlogik), N8 (`turnSequence.ts`: `authorizeTurnAction`, `overrideTurnSequence`, `closeTurnSequence`, `withholdCurrentHolder`, `refreshEligibilityBasis`, Zugidentität `turnNumber`, Eligibility aus N6), N5 (`secretRoleDeal.ts` als *Quelle* der Rollenzuordnung, über einen kleinen Adapter), `visibility.ts`, `saveGameStateIfRevision`, `runReceipted`, `game-sdk`-State-Events, Midnight-Tokens, `@quiz/ui` `Button`.

Nicht verwendet, mit Grund: `submitOnce` (`numericSubmission.ts`) ist eine **einmalige** Abgabe, kein wiederholter Bietverlauf — nicht umgebogen. `secretRoleDeal` ist ein **unveränderlicher** Deal, kein Bid-Ledger — es wird bei keinem Gebot etwas neu ausgeteilt; der Deal liefert nur die gepinnte Rollenzuordnung. `advanceTurnSequence(COMPLETE)` wird **nicht** verwendet (siehe §5).

Neu (klein, begründet):
- `packages/shared/src/bidding.ts` (`@quiz/shared/bidding`, clienttauglich, Strip-only, importiert nur `zod` und `@quiz/shared/numeric`): Zahlenprofil, Projektion `NEUTRAL`/`STANDING`, strikte Absichten, Codes, Kontextbindung.
- `apps/server/src/games/core/biddingPhase.ts`: serverprivater Zustand, reine Übergänge, N8-Verbindung, Projektion.
- `apps/server/src/games/core/biddingRoles.ts`: Bidder/Performer aus einem N5-Deal mit unabhängig erwartetem Run/Runde/Deal/Revision.
- Fehlercodes `BIDDING_*` in die zentrale Whitelist (`errors.ts`).
- Web: `biddingIntake.ts` (reiner Intake), `sendAttempts.ts` (reiner Versuchszustand der Sendungen, §8), `BiddingPanel` (Komponente), Chromium-Harness `harness/n10-bidding`.
- `packages/shared/tsconfig.json`: `rootDir: ./src`. Grund: `bidding.ts` importiert den N1-Zahlenvertrag über den Paketnamen (statt ihn zu duplizieren); TypeScript braucht für diese Selbstreferenz ein eindeutiges Projektwurzelverzeichnis. Plain Node löst die Selbstreferenz über `exports` (im gebauten Server geprüft, siehe `acceptance.md`).

Keine neue Command-, Event-, Receipt-, Timer-, Zufalls- oder Persistenzplattform, keine Migration, keine Route, kein Socket, kein `GameManifest`-Status, kein Eintrag in `CRITICAL_COMMAND_ACTIONS`.

## 2. Zustände, Identitäten, Konfiguration, Zahlenvertrag

**Pinning (unveränderlich je Instanz):** `runIndex`, `roundId`, opake `biddingId`, `rolesRevision` (Label der gepinnten Bidder/Performer-Zuordnung; mit N5-Deal als Quelle = Revision des Deals — die **Herkunft** des Deals wird bei der Vorbereitung gegen Run/Runde des Ziels und den unabhängig erwarteten Deal geprüft, siehe unten), `binding { sequenceId, rosterRevision }` der N8-Teamfolge, `numeric` (effektives Zahlenprofil), `category` (Kategorielabel oder `null`), `teams` in **Planungsreihenfolge** (das erste Team beginnt) mit je **einem** Bidder und **einem** Performer. IDs sind Labels (Regex, begrenzt), keine kodierten Gebote/Kategorien/Hashes. Eine neue Runde/Partie/ein Roster-/Rollenwechsel ist **eine neue Instanz** mit neuer `biddingId`; Nachrücker erben nichts.

**Zahlen (N1):** ein Gebot ist ein kanonisches `{ units, scale }` (Skala 0 oder 1, `units` sichere Ganzzahl, max. 15 Stellen). Profil = N1-Eingabekonfiguration mit zusätzlich `min ≥ 1` (positiv) und `boundsDisclosure: PUBLIC` (der Bieter muss den erlaubten Bereich kennen). `BIDDING_NUMERIC_POSITIVE_INTEGER` = 1…999 ohne Einheit; weitere Skalen/Einheiten nur ausdrücklich konfiguriert. Start- und Folgegebote werden **abgewiesen, nie gerundet/geklemmt/erhöht**: falsche Skala, NaN/Infinity, Bruch, unsichere Ganzzahl, String/Locale-Text, unbekannte Schlüssel → `BIDDING_VALUE_INVALID`; außerhalb des Bereichs → `BIDDING_VALUE_OUT_OF_RANGE`; Folgegebot nicht **strikt** höher → `BIDDING_VALUE_NOT_HIGHER` (Vergleich auf kanonischen Ganzzahlen, kein Float). Sprünge sind erlaubt, kein Zwang zu +1. Ein `suggested min/max` aus einer Aufgabe ist **kein** Limit, solange es nicht ausdrücklich ins Profil geschrieben wird. Locale ist nur Darstellung (UI-Text → N1-Parser → kanonisches Objekt auf dem Draht).

**Technische Grenzen:** 2…16 Teams, höchstens 200 akzeptierte Schritte (Gebote+Pässe), Zähler ≤ 1 000 000 000, Kategorie ≤ 80 Zeichen, Labels ≤ 80, IDs ≤ 200. Ein Gebot wird nur angenommen, solange danach jedes noch beteiligte Nicht-Führungsteam noch passen könnte (`BIDDING_STEP_LIMIT`) — die Bietphase ist immer beendbar; nichts wird geklemmt.

**Phasen:** `PREPARED` (kein Gebot, kein Gewinner, **kein** fingiertes Höchstgebot 0) → `OPEN` → `CLOSED` (regulär, mit Ergebnisgrundlage) oder `ABORTED` (ausdrücklich, **ohne** Ergebnis); `ABORTED` ist auch aus `PREPARED` möglich. Terminal bleibt terminal; ein neuer Durchlauf ist eine neue Instanz.

**Zustand (serverprivat, strikt validiert, beim Laden vollständig nachgespielt):**
`kind, schemaVersion, runIndex, roundId, biddingId, rolesRevision, binding, category, numeric, teams, phase, version, stepCount, leader {teamId, units}|null, passedTeamIds[], history[], result|null, endReason|null`. `history` hat je akzeptierter Aktion einen Eintrag: `BID {step, turnNumber, teamId, playerId, units}` oder `PASS {…, againstTeamId, againstUnits}` (der damalige Führende). Beim Laden wird die Historie von Null nachgespielt (Gebot strikt höher, Führender gibt nicht ab, kein Handeln nach Ausstieg/Ende, Reihenfolge/Zug streng steigend); `leader`, `passedTeamIds`, `version`, `stepCount`, `phase` und `result` müssen exakt dazu passen, sonst `BIDDING_STATE_INVALID` (code-only), **nie** repariert, sortiert, geraten oder auf eine leere Bietphase zurückgesetzt.

## 3. Übergangstabelle

| Aktion | erlaubt in | Wirkung (genau eine Zustandsänderung, `version` +1) | Ablehnungen (Auswahl) |
|---|---|---|---|
| `prepareBiddingPhase` / `prepareBiddingPhaseFromRoleDeal` | — | `PREPARED`, Version 0, nichts gesetzt. Rollen kommen als **ausdrücklich getrennte Eingänge**: `N5_DEAL` (geprüftes Adapterergebnis **mit Ursprung** Run/Runde/Deal-ID/Revision; Run/Runde des Ziels und der unabhängig erwartete Deal werden dagegen geprüft — ein korrektes Ergebnis eines anderen Runs/einer anderen Runde/eines anderen Deals, auch mit gleichen Teilnehmern und gleichem Revisionslabel, wird abgewiesen) oder `RAW` (Ursprung nicht geprüft, Sache des Aufrufers, für synthetische Tests). Der kombinierte Pfad nimmt **einen** erwarteten Scope für Deal **und** Ziel. Der Ursprung wird verglichen, nicht gespeichert und nie projiziert | `BIDDING_CONFIG_INVALID` (Teams, Profil, Doppelbelegung, Labels, Ursprung ≠ Ziel), `BIDDING_ARGS_INVALID` |
| `openBidding` | `PREPARED` | `OPEN`; N8-Folge muss passen (TEAM, gleiche Reihenfolge, **ein** Mitglied je Team = Bidder, `ACTIVE`, Halter = erstes Team) **und** muss die Abschlussreserve mitbringen (Version +1, Entitlement +1; sonst `BIDDING_COUNTER_LIMIT`) | `BIDDING_SEQUENCE_MISMATCH`, `BIDDING_ALREADY_OPEN`, `BIDDING_ENDED`, `BIDDING_SCOPE_STALE`, `BIDDING_VERSION_STALE` |
| `placeBid` / `applyBid` | `OPEN` | Team wird Führender mit dem Wert; Historie +1; (voller Pfad) N8-Übergabe im selben Aufruf | `BIDDING_NOT_OPEN`/`ENDED`, Wert-Codes, `BIDDING_TEAM_PASSED`, `BIDDING_LEADER_CANNOT_ACT`, `BIDDING_TURN_STALE`, `BIDDING_STEP_LIMIT`, `BIDDING_COUNTER_LIMIT`, N8-`TURN_SEQ_*` |
| `passBidding` / `applyPass` | `OPEN`, **mindestens ein akzeptiertes Gebot** | Team steigt für diese Bietphase aus; bleibt **genau ein** Team → im selben Schritt `CLOSED` + Ergebnisgrundlage (+ N8-Folge geschlossen), sonst Übergabe | wie Gebot, zusätzlich `BIDDING_PASS_BEFORE_FIRST_BID` |
| `abortBidding` | `PREPARED`, `OPEN` | `ABORTED` mit Endgrund (`HOST_ABORTED`/`TECHNICAL_ABORT`), **kein** Ergebnis; N8-Folge geschlossen | `BIDDING_ABORT_NOT_AUTHORIZED` (Recht ist eine ausdrückliche Serverfakt-Eingabe), `BIDDING_ENDED` (nach regulärem Ende), Wiederholung bei aktueller Version = `changed:false` |
| `refreshBiddingBasis` | `OPEN` | nur N8-BASIS-Schritt (neuerer N6-Stand); Gebote unberührt; gleicher Stand = No-op **ohne Verbrauch**; ein echter Schritt erhält die Abschlussreserve | `TURN_SEQ_ELIGIBILITY_STALE/MISMATCH`, Phasen-Codes |
| `withholdBiddingHolder` | `OPEN` | N8 → `HELD` (Bidder am Zug nicht mehr berechtigt); Gebote unberührt; **kein** Pass, kein Gewinner; erhält die Abschlussreserve | `TURN_SEQ_HOLDER_STILL_ELIGIBLE`, Phasen-Codes |

Ein Pass ist **kein** N6-Lebensverlust und **kein** globales Ausscheiden; kein ParticipationTrack wird angefasst.

## 4. Vier Ordnungsebenen plus Gebotshöhe — nicht voneinander ableitbar

1. **Gebotshöhe** (`units`) — der Wert; keine Version.
2. **Bietzustandsversion `version`** — lokal, +1 je echter Änderung dieser Bietphase (Öffnen, Gebot, Pass, Abbruch; der schließende Pass ist **eine** Änderung). `stepCount` zählt nur akzeptierte Gebote/Pässe (Index der Evidenz).
3. **Bietaktions-/Zugidentität `turnNumber`** — die N8-Zugnummer, in der die Aktion gemacht wurde. Jede Übergabe ist ein neuer Zug; ein Team-/Spieler-Id allein bezeichnet keinen Zug. In der Evidenz je Eintrag gespeichert, streng steigend.
4. **Rollen-/Berechtigungsrevision** — `rolesRevision` und `rosterRevision` (gepinnte Zuordnung, Teil des Ziels) sowie die **N8-Folgeversion** `sequenceVersion` (ein neuerer N6-Stand erhöht sie ohne neuen Zug und ohne Änderung der Gebote).
5. **Globale Snapshotversion `stateVersion`** — nur im Projektionspaket und als unabhängiges `minStateVersion` im Browser.

## 5. Wer handelt — Abbildung auf N8, Planungsvertrag, Randfallpolicy

**Eine Wahrheit für „wer ist dran“: die N8-Teamfolge.** Der Bietzustand hält **keinen** Halterzeiger. Jedes akzeptierte Gebot/Passen übergibt im **selben Aufruf** mit `overrideTurnSequence` (der **Server** benennt das Ziel; neuer Zug, Folgeversion +1, neuere Eligibility-Basis wird mit festgeschrieben, **keine** Mitgliederrotation, kein `completedTurns`, keine Cursoränderung — ein Gebot ist kein abgeschlossener Teamzug, `COMPLETE` wird nie benutzt). Ein regulärer Abschluss/Abbruch schließt die Folge im selben Aufruf. N8 bleibt dabei die Berechtigungsquelle: `authorizeTurnAction` läuft **zuerst** (Zustand, Scope, Version, Zug, Phase, Gate, Rolle `PLAYER`, Halter-Identität, Halter-Eligibility); danach prüft N10 Bietphase, Version und dass der N8-Halter **genau** das Team ist, das der Plan nennt (`BIDDING_SEQUENCE_MISMATCH` sonst — z. B. nach einem externen Override). Die N8-Folge ist je Bietphase eigens (`sequenceId` im Ziel), wird mit ihr geschlossen und nicht wiederverwendet; `biddingTurnSequenceInput` erzeugt die passende Vorbereitung (unit TEAM, **ein** Mitglied je Team: der gepinnte Bidder). Performer sind nie Mitglied der Biet-Folge und nie handlungsfähig.

**SCHEDULING-VERTRAG `CYCLIC_SKIP_LEFT_AND_LEADER` (technische Policy, keine bestätigte Masterregel):** nach einer Aktion kommt das nächste Team in der vorbereiteten Reihenfolge (zyklisch, höchstens eine Runde) an die Reihe, das noch beteiligt und **nicht** der aktuelle Führende ist. Ausgestiegene Teams bleiben draußen; der Führende wartet auf Konkurrenz und muss weder sich selbst überbieten noch gegen sich passen. Die Startreihenfolge ist die vorbereitete Teamreihenfolge (Startteam/-bidder rotiert zwischen Runden durch eine **neue** Vorbereitung, nicht durch ein Gebot). Eine andere Reihenfolge wäre ein anderer, ausdrücklich vorbereiteter Vertrag. Die **wörtliche Gegenprobe** des Auftrags (T1 3 → T2 5 → T1 passt → T3 8 → T2 passt) prüft die **Mechanik-Ebene** (`applyBid`/`applyPass` kennen keine Reihenfolge) und ist **keine** gültige Zugfolge dieses Vertrags; gültige Mehrteam-Zugfolgen (3 und 4 Teams, mehrere Erhöhungen/Pässe) prüft der volle Pfad separat.

**Randfallpolicy (unsere, als solche gekennzeichnet; der Master legt sie nicht fest):**
- *Passen vor dem ersten akzeptierten Gebot:* **abgelehnt** (`BIDDING_PASS_BEFORE_FIRST_BID`). So endet eine Bietphase nie ohne gültiges Gebot, und „letztes verbleibendes Team ohne Gebot“ ist nicht erreichbar (der Ladevorgang weist einen solchen Zustand trotzdem ab). Ein Startteam, das nicht bieten kann/will, blockiert die Bietphase bis zu einem Gebot oder einem ausdrücklichen Abbruch.
- *Disconnect, Kick, Leave, fehlende Rolle:* **keine** automatische Aktion. Ein nicht mehr berechtigter Bidder am Zug blockiert (`TURN_SEQ_ACTOR_NOT_ELIGIBLE`/`HELD`); ist der **nächste** Bidder nicht berechtigt, wird die Übergabe und damit das Gebot abgelehnt (Zustand unverändert, nichts halb gespeichert). Aufgelöst wird nur durch einen **ausdrücklich berechtigten Abbruch** oder eine neue Instanz mit neuer Zuordnung. Spätere Moderationsentscheidungen/Wertungen bleiben offen.
- *Administrativer Frühabbruch:* `ABORTED`, kein Gewinner, kein Ziel; die letzte Führung bleibt serverprivate Evidenz und wird **nicht** projiziert.

## 6. Pass-Evidenz und Ergebnisgrundlage (keine Punkte)

`biddingResultBasisOf` (und das mit dem regulären Ende gespeicherte `result`, das beim Laden **neu aus der Evidenz abgeleitet** und verglichen wird) liefert: Gewinnerteam, Höchstgebot/Leistungsziel, **das** Bidder/Performer-Paar des Gewinnerteams, das **zuletzt gegen den endgültigen Gewinner** ausgestiegene Team (letzter Pass, dessen `againstTeamId` der Gewinner ist) samt Schritt, sowie alle früheren Pässe mit dem Team, gegen das sie gemacht wurden (für die spätere feste Wertung „frühere Teams 0“). Reihenfolge = gespeicherte monotone Schritte, keine Zeitstempel. Nicht „irgendein letztes ausgeschiedenes Team“: Beispiel 4 Teams `T1 3, T2 5, T3 7, T4 9; T1, T2 passen gegen T4; T3 12; T4 passt gegen T3` → Gewinner T3 (12), Gegenteam **T4**, früher T1/T2 (gegen T4). Die spätere Wertung (Erfolg +2, Misserfolg +1 nur für das maßgebliche Gegenteam, frühere 0, keine Minuspunkte) wird **nicht** implementiert und nicht neu zur Freigabe gestellt.

## 7. Informationsmatrix (Projektionen) und Metadatenentscheidung

Strikte Varianten, `release` je Zielgruppe **ohne Default** vom Server gewählt:
- `NEUTRAL`: nur Labels (`scope`), `recipientId`, `stateVersion`, Phase `PREPARED|OPEN|ENDED`, `you { performer }`. **Kein** Kategorietext, Gebot, Ziel, Teamliste, Zähler, Ergebnis. Wer das Paket bekommt, hat die verbotenen Felder nicht — CSS/disabled/Löschen im Browser ist kein Schutz.
- `STANDING`: zusätzlich Kategorie, Zahlenprofil mit Grenzen, Teams `IN/PASSED`+`leading`, Führender+Höchstgebot, Team am Zug (nur wenn die N8-Folge mit dem Plan übereinstimmt), Endstand, bei regulärem Ende Gewinner mit **seinem** Paar, eigene Hinweise `you`. **Nie** Pass-Reihenfolge, Historie, Gegenteam-Referenz, Eligibility, Rollenlisten anderer Teams, Task-Text.

| Zielgruppe | Während des Bietens | Nach Abschluss | Nach Abbruch |
|---|---|---|---|
| gepinnter Bidder (PLAYER) | `STANDING` + `you` (Bieten/Passen nur am Zug) | `STANDING` mit Gewinner/Paar | `STANDING` ohne Führung/Ergebnis |
| Performer, sonstige Spieler | `NEUTRAL` („Dein Partner verhandelt gerade.“) — `STANDING` wird **verweigert** (`BIDDING_RELEASE_FORBIDDEN`) | `NEUTRAL` „beendet“ (kein Gewinner, kein Reveal) | `NEUTRAL` „beendet“ |
| Host, der als Performer mitspielt | wie Performer (auch als `HOST`-Audience mit gepinnter Teilnehmer-ID: wird nach der Spielrolle beurteilt) | wie Performer | wie Performer |
| Host ohne Mitspielen (nicht blind) | `STANDING` ohne `you` | dito | dito |
| Blinder Host | `NEUTRAL` (STANDING verweigert) | | |
| VIEWER, DISPLAY | `STANDING` ohne `you` (ausdrückliche Wahl des Servers) | dito | dito |

**Metadatenentscheidung (offen dokumentiert, keine zusätzliche Geheimregel behauptet):** Das neutrale Paket trägt als einzige Ordnungsinformation die globale `stateVersion`; **keine** Bietversion, Zugnummer oder Schrittzahl. Die globale Version steigt aber bei jeder Snapshot-Änderung, ein Performer könnte daraus „es passiert etwas“ ableiten. Ob selbst das geheim sein soll, ist **nicht** entschieden; sollte es so sein, braucht der Verbraucher einen gröberen Ordnungszähler für Neutralpakete. **DEC-PCH-01** (darf ein Viewer den Task-Prompt sehen?) bleibt **offen und unberührt**: kein Task-Text existiert in irgendeiner Projektion; nach dem Bieten wird ein Task/Ziel erst über einen ausdrücklichen Freigabepfad des späteren Verbrauchers sichtbar (ein Bietergebnis ist kein pauschales Reveal).

Rollenwechsel: derselbe Teilnehmer, Bidder → Performer, ist eine **neue Bietphase mit neuer `rolesRevision`** — ein neuer Intake-Kontext; ein spätes Bidder-Paket der alten Bietphase ist fremd und zeigt nichts.

## 8. Vollständige Herkunft der Befehle, atomare Persistenz, Testmatrix

**Absicht = Ziel + Team + Zähler, alles Pflicht** (`BiddingActionBindingSchema`): `scope { runIndex, roundId, biddingId, sequenceId, rosterRevision, rolesRevision }`, `teamId` (nur **erwarteter** Zielbezug, keine Berechtigung; verglichen mit dem Team der Session → `BIDDING_TEAM_MISMATCH`), `turnNumber`, `sequenceVersion`, `biddingVersion`; ein Gebot trägt zusätzlich **einen** kanonischen Wert. Es gibt **kein** Schema, das Sieger, Führenden, Höchstgebot oder Historie vom Client annimmt. `BiddingPanel` bildet die Absicht aus der **angezeigten** Sicht und gibt dem Callback als zweites Argument die Identität **dieser Sendung** (`{ attemptId }`); Transport/Adapter bewahren sie; `biddingActionArgsFromIntent` leitet die Prüfargumente **ausschließlich aus der Absicht** ab; der Server vergleicht sie mit dem geladenen vertrauenswürdigen Zustand (Bietphase: `BIDDING_SCOPE_STALE`; N8: Run/Sequenz/Roster/Einheit/Version/Zug). Caller, Gate, Eligibility und Server-Uhr (nur als Beleg der Übergabe) kommen aus der Servergrenze. Receipt-Payload = `{ kind: 'BID'|'PASS', intent }` (Operation + vollständiges Ziel + Zähler + Wert); gleiche `commandId` + anderes → `COMMAND_CONFLICT`.

**Atomarer Pfad für den späteren Verbraucher:** ein Commit mit (a) neuem Bietzustand, (b) neuer N8-Folge (Übergabe oder Schließen; der Eligibility-Stand eines nicht-terminalen Erfolgspfads wird dabei mit festgeschrieben, N8-02), (c) State-Event, (d) globalem CAS (`saveGameStateIfRevision` auf der geladenen Revision), (e) Receipt. Bricht ein Teil ab, gilt nichts davon.

**Terminale Erfolgspfade und neuere Berechtigungskenntnis:** der schließende Pass und der Abbruch schreiben einen neueren N6-Stand **nicht** fest — die geschlossene N8-Folge autorisiert nichts mehr, der Stand lebt in N6 weiter. Jeder nicht-terminale Erfolgspfad (Gebot, nicht schließender Pass, `refreshBiddingBasis`) schreibt ihn fest; es gibt keinen lesenden Helfer, der still mutiert.

**Kapazität vor Wirkung:** N8-Folgeversion (+2 für Übergabe und späteres Schließen, +1 beim schließenden Pass/Abbruch), Zugnummer (+1) und Entitlement-Revision (+1) werden **vor jeder Änderung** geprüft (`BIDDING_COUNTER_LIMIT`); Schrittlimit mit Reserve (`BIDDING_STEP_LIMIT`). **Die Abschlussreserve gilt für jeden schreibenden Pfad (N10-04):** Gebot/Pass-Übergabe (Version +2, Zug +1, Entitlement +1), nicht schließender Pass, **BASIS** und **HELD** (eigener Schritt + ein weiterer Versionsschritt für das Schließen; Entitlement +1, solange die Folge `ACTIVE` ist — ACTIVE→HELD und ACTIVE→CLOSED kippen es, HELD→CLOSED nicht), `openBidding` (die Folge muss schließbar sein). Ein echter No-op (gleiche Basis, bereits HELD mit gleicher Basis) verbraucht nichts und braucht keine Reserve; jeder andere Fehler behält seinen Code; ein Schritt ohne Reserve — oder einer, den der N8-Zähler gar nicht mehr darstellen könnte — ist `BIDDING_COUNTER_LIMIT` bei unverändertem Zustand. Kein Wrapping, Clamping oder Ersatzkontext.

| Bereich | Nachweis |
|---|---|
| Profil/Zahlen/Grenzen, beschädigte Zustände (30 Fälle) | `biddingPhase.test.ts` A, C, G |
| 2/3/4 Teams, wörtliches Beispiel, falsches letztes Gegenteam, Terminalität | `biddingPhase.test.ts` C, D |
| Rechte/Rollen/Gate/Zielbezug/Ursprung der Absicht je Ebene, N8-Schritte | `biddingPhase.test.ts` D |
| Abbruch, HELD, kein geratener Gewinner | `biddingPhase.test.ts` E |
| Projektionen/Leak-Probe/Empfänger/Rollenwechsel | `biddingPhase.test.ts` F |
| N5-Adapter | `biddingPhase.test.ts` H |
| Echte SQLite-CAS/Receipts/State-Events, Konkurrenz, Absturz, zweiter Prozess | `biddingPhase.cas.integration.test.ts` |
| Intake-Ketten | `biddingIntake.test.ts` |
| Komponente: Aufrufanzahl, Sperre, Fokus, Neutral-DOM | `BiddingPanel.test.tsx` |
| Browser (mehrere Kontexte, echte Serverprojektion, DB-Nachlesen) | `harness/n10-bidding/check.cjs` |

**Sendeversuche (N10-01/02, `sendAttempts.ts`):** jede erlaubte Sendung ist ein **Versuch** mit eigener Identität neben der Zielbindung. Die Entscheidung, ob gesendet wird, fällt am **aktuellen Zustand in einem Ref**, nie an der Closure eines Renders (mehrere Klicks im selben Task senden einmal). Ein Versuch gehört genau einer Bindung; Gebot und Pass teilen **eine** Sperre je Bindung. Promise-Ablehnung und Anwendungsberichte (`feedback`: `bindingKey`, optional `attemptId`, optional `id`, Status, Text) gelten **nur für ihren Versuch**; ein später Bericht/eine späte Ablehnung eines älteren Versuchs gibt eine laufende Wiederholung nicht frei. Ein Bericht wird **genau einmal verbraucht** (begrenzte Signaturliste); ein gleichlautender neuer Bericht bleibt über `attemptId`/`id` unterscheidbar, Berichte ohne beides gelten höchstens einmal. Das `NumberField` ist an denselben Versuch gebunden (seine `attemptId` wird mitgeführt): jede Ablehnung — Promise oder Bericht — macht denselben Entwurf wieder editierbar und sendbar (Beschriftung „Erneut senden“ nach N1); ein Pass-ACK oder eine alte Pass-Ablehnung gibt die Zahleneingabe weder frei noch bestätigt sie. Die commandId einer Absicht bleibt bei der Wiederholung gleich; die serverseitige CAS-/Receipt-Absicherung ist unverändert.

## 9. Offene Spielentscheidungen und Pflichten des Verbrauchers (Kurzliste; Details in `handoff.md`)

Offen (nicht von N10 entschieden): Planungsreihenfolge als Masterregel; Verhalten bei Ausfall einer Rolle jenseits von „Blockade + berechtigter Abbruch“; Wertung eines Abbruchs/fehlenden Gebots; neutrale Metadaten (§7); DEC-PCH-01; Aufgabenfreigabe nach dem Bieten; Timer-Auswahl; Rotationsregel Startteam/Rollen zwischen Runden (N10 nimmt nur die fertige Zuordnung); Challenge-Durchführung und Wertung (nicht im Umfang).
