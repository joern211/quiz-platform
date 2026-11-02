# N8 — Erweiterte Zugverwaltung, Spielerreihenfolge und Teamrotation: Entwurf

Base: `main` @ `6c42f55cbe1cacf35e6912b7fd02e7fc9ded4bff` (N7 = PR #37 gemergt; main-CI-Lauf 41452225297 `completed/success`, beim Start per `git fetch` und GitHub-Actions-Abfrage geprüft, unverändert). Arbeitsbranch `claude/new-session-atou75` (vom Sitzungsrahmen vorgegeben), frisch von `origin/main`.
Status: **Entwurf vor der Implementierung.** Er wird beim Abschluss gegen den Endstand abgeglichen (Abweichungen stehen dann in `review.md`).

Quellen: Arbeitsauftrag N8 (02.11.2026); `Master_Regelwerk.txt` §§2.1–2.3, 3.1–3.5, 4.15, 5.12, 5.15–5.21, 5.24, 5.29–5.33, 13.2, 15.6, 15.9, 16.4–16.5 (gelesen, nicht umgesetzt: Spielregeln); N6-/N7-Dokumente und -Code als Muster. Es gibt **keine** AGENTS.md/CLAUDE.md im Checkout.

## 1. Was unverändert weiterverwendet wird — und warum eine zusätzliche Abstraktion nötig ist

Unverändert (kein Byte geändert): `CoreTurnSchema`/`createTurn`/`activeTurn`/`advanceTurn`/`requireWinningTurn` (`roundFlow.ts`, Einzel-Antwortbesitzer in Jeopardy und Wer ist das?, gespeicherte Zustände und `invariants.ts` bleiben kompatibel), `shuffleServer` (einziger Zufall), N6 (`participationTrack.ts`: Aktivstatus, Track-Version, `activeActorIds`, `participationScopeOf`), `visibility.canView`/`ProjectionAudience`, `saveGameStateIfRevision`, `runReceipted`, `game-sdk` State-Events, Midnight-Tokens.

Warum eine Abstraktion: `CoreTurn` ist `{mode, order, index, cycle}` — ein Zeiger auf **einen** Besitzer. Es fehlt (a) eine **Identität des einzelnen Zuges** (derselbe Spieler kann mehrfach nacheinander zuständig sein; `index` + Spieler-ID identifizieren keinen Zug), (b) eine **lokale Version**, (c) ein **zweistufiger Teamzug** (äußere Teamfolge + innerer Mitgliedszeiger je Team), (d) ein expliziter Zustand für „noch nicht begonnen / angehalten / kein geeigneter Akteur / geschlossen“, (e) ein **kontrollierter Override** mit Evidenz. Ein `CoreTurn` kann nichts davon tragen, ohne seinen strikten Schema-Vertrag (`.strict()`, persistierte Altzustände) zu brechen.

**Keine zweite Turn-Wahrheit:** Der neue Zustand `TurnSequenceState` ersetzt `CoreTurn` nirgends und wird nirgends parallel zu ihm in denselben Engine-State geschrieben. Für den **Spielerkreis** (Einheit `PLAYER`) ist die Abbildung exakt und per Test belegt: `{mode, order, index: position, cycle}` ist ein gültiger `CoreTurn`, und die Suche nach dem nächsten geeigneten Spieler liefert dieselbe Position/denselben Zyklus wie N6 `findNextActiveTurn` (Äquivalenztest über alle Statusmuster; kein zweites Lebensmodell). Der `CoreTurn` bleibt der Einzelbesitzer nach einem Buzz; die Folge ist der Mehrspieler-Zug. Ein späterer Verbraucher entscheidet, welche der beiden Strukturen sein State trägt.

## 2. Typen und Zustände

**Einheit** (`unit`): `PLAYER` (äußerer Kreis = Spieler-IDs) oder `TEAM` (äußerer Kreis = Team-IDs; zusätzlich je Team eine gepinnte Mitgliederliste). Genau eine Einheit je Folge; Teamzug ist Spieler + sein Team **im Zug**, keine globale Captain-Rolle.

**`TurnSequenceState`** (serverprivat, JSON-tauglich, strikt, exakte Schlüssel, `schemaVersion: 1`):

| Feld | Bedeutung |
|---|---|
| `runIndex`, `sequenceId`, `rosterRevision`, `unit` | **Scope**: Run, opake Folgen-ID, opake gepinnte Roster-/Konfigurationsrevision, Einheit. Kein `roundId` — die Folge überdauert Runden (siehe §5). |
| `mode` | Aufzeichnung, **wie** die äußere Reihenfolge einmalig entschieden wurde (`FIXED` · `RANDOM` · `ROTATING_START` · `CUSTOM_HOST_ORDER`). Wird nach der Vorbereitung nie wieder ausgewertet. |
| `order` | äußere Reihenfolge (Spieler- bzw. Team-IDs), **entschieden und gespeichert** |
| `teams` | nur `TEAM`: je Team `{ teamId, members[], cursor }` — gepinnte Mitgliederreihenfolge und eigener Rotationszeiger (`cursor` = Index des Mitglieds, das beim nächsten Zug des Teams zuerst geprüft wird) |
| `phase` | `READY` · `ACTIVE` · `HELD` · `NO_ELIGIBLE` · `CLOSED` |
| `version` | **lokale Folgeversion**, Start 0, +1 je echter Änderung |
| `turnNumber` | **Zugidentität**: 0 solange kein Zug begonnen hat, danach streng +1 je neu begonnenem Zug (auch wenn derselbe Spieler wieder dran ist) |
| `completedTurns` | echte Zugabschlüsse (`COMPLETE`); übersprungene Positionen und `SKIP` zählen nicht |
| `cycle` | Zahl der Überschreitungen des Endes der äußeren Reihenfolge (Konvention von `advanceTurn`/`findNextActiveTurn`) |
| `position` | Index in `order` des aktuellen bzw. zuletzt zuständigen Eintrags (`null` vor dem ersten Zug) |
| `memberIndex` | nur `TEAM`: Index des zuständigen Mitglieds in `teams[position].members` (sonst `null`) |
| `entitlementRevision` | zählt **nur** Wechsel „darf jemand handeln?“ (`phase === 'ACTIVE'` ändert sich) |
| `eligibility` | zuletzt **festgeschriebene** Eligibility-Basis je Ebene `{ trackId, rosterRevision, version }` (N6-Track-Version, serverprivat, nie projiziert) |
| `lastOverride` | `null` oder `{ atMs, fromTurnNumber, toTurnNumber }` — minimale serverprivate Evidenz, **kein** Grund-Text |

**Zustände** und Invarianten (beim Erzeugen **und** beim Laden geprüft; Verstoß ⇒ ganzer Zustand abgewiesen, nichts repariert):
- `READY`: vorbereitet, `turnNumber 0`, `position null`, kein Halter. Vor Beginn keine Handlungserlaubnis.
- `ACTIVE`: genau ein Halter bei `(position, memberIndex)`; nur dann „darf handeln“.
- `HELD`: Zug und Halter bestehen weiter, aber der Halter wurde ausdrücklich als **nicht mehr berechtigt** festgehalten (Zwischenzustand, §4). **Niemand** handelt.
- `NO_ELIGIBLE`: kein geeigneter Akteur gefunden — ausdrücklicher neutraler Zustand: kein Halter, kein Sieger, kein Team-KO, keine erfundene Spieler-ID. `position` bleibt der Fortsetzungsbezug (`null`, falls schon der Start nichts fand).
- `CLOSED`: terminal, kein Halter. Kein Neubeginn; ein neuer Durchlauf braucht eine **neue** Instanz (`prepare…` mit neuer `sequenceId`).
- Ganzzahlen sind sicher, nichtnegativ und durch `TURN_SEQUENCE_MAX_COUNTER` (1 000 000 000) begrenzt; `position < order.length`; `members` je Team 1–100, alle Spieler-IDs eindeutig über alle Teams; `cursor < members.length`; `order` ↔ `teams`-IDs deckungsgleich; `turnNumber ≥ completedTurns`; zwischen `version` und den übrigen Zählern wird **keine** Beziehung erfunden (nur Bereichsprüfung).

**Teilnehmer-/Teamroster und Berechtigung — drei Ebenen, nie vermischt:**
- **A** gepinnte Folge/Mitgliedschaft = `order` + `teams` (hier).
- **B** aktuelle Admission/Session/Teamzuordnung/Rechte/Pause/Phase = **nur** beim Verbraucher; `authorizeTurnAction` verlangt sie als ausdrückliche, vom Aufrufer gesetzte Eingabe (`caller`, `gate`) und ersetzt sie nicht.
- **C** Gameplay-Teilnahme = `TurnEligibility`, aus N6 abgeleitet (`eligibilityFromParticipation`) oder ausdrücklich übergeben; gebunden an Track-ID, Rosterrevision und **Track-Version**.

**`TurnEligibility`**: `{ actors: Basis & { activeIds }, members: (Basis & { activeIds }) | null }` mit `Basis = { trackId, rosterRevision, version }`. `PLAYER`: `members` muss `null` sein. `TEAM`: `actors` ist der Team-Track (Status je Team), `members` der Teilnehmer-Track (Status je Spieler) — **zwei Tracks, weil N6 gemischte Akteursarten verbietet**. Ein Team ist **geeignet** ⇔ Team aktiv **und** mindestens ein Mitglied aktiv. Ein Team ohne geeignetes Mitglied wird übersprungen (kein Team-KO, keine Umverteilung, kein Verbrauch seines Rotationszeigers).

**Eligibility-Stand (Stale-Schutz):** Jede Operation mit Eligibility vergleicht mit der zuletzt festgeschriebenen Basis: andere `trackId`/`rosterRevision` ⇒ `TURN_SEQ_ELIGIBILITY_MISMATCH`; **kleinere** Version ⇒ `TURN_SEQ_ELIGIBILITY_STALE`. Ein älterer Stand kann so keinen inzwischen ausgeschiedenen Spieler wieder handlungsfähig machen. Gleiche Version ⇒ gleicher Track-Stand (N6-Version ist je Track streng monoton; ein Aufrufer, der bei gleicher Version andere Daten liefert, verletzt den N6-Vertrag — nicht erkennbar, dokumentiert).

## 3. Reihenfolge — Vorbereitung getrennt vom Übergang

Zwei getrennte Schritte; der zweite ist rein deterministisch.

1. `decideTurnOrder({ mode, ids, … , shuffle? })` — **einziger** Ort mit Zufall (Adapterfunktion):
   - `FIXED`: `ids` unverändert (nur validiert).
   - `RANDOM`: **einmal** `shuffle(ids)` (Standard = vorhandenes `shuffleServer`; injizierbar für Tests); das Ergebnis wird als Permutation geprüft (kein Verlust/Duplikat).
   - `ROTATING_START`: `previousStartId` ist **Pflichtschlüssel**: `null` = ausdrücklich erster Durchlauf (Reihenfolge unverändert, `ids[0]` startet); eine ID = Start des Vorgängers → der **nachfolgende** Eintrag der Reihenfolge `ids` startet (dieselbe Rotation wie `createTurn`, per Test gleichgesetzt); eine **unbekannte** oder leere ID ⇒ `TURN_SEQ_PREVIOUS_START_INVALID` (kein geratener Ersatz, kein stilles Zurückfallen auf Index 0).
   - `CUSTOM_HOST_ORDER`: `customOrder` muss eine **Permutation** von `ids` sein; unbekannte, fehlende und doppelte Einträge werden mit code-only Issues abgelehnt; keine Sortierung, keine Reparatur. Der Client schickt nie einen Gesamtzustand — nur diese explizite Reihenfolge, die der Server prüft.
2. `prepareTurnSequence({ … order, teams?, mode })` — übernimmt das **bereits entschiedene** Ergebnis, ruft keinen RNG, keine Uhr, sortiert nichts. Mitgliederreihenfolgen entscheidet der Aufrufer ebenso vorab (je Team ein Aufruf von `decideTurnOrder`); **Startmitglied = erstes Element der vorbereiteten Mitgliederliste, `cursor` startet bei 0** (ausdrückliche vorbereitete Daten; keine Regel, die je Runde neu auslost oder nach Namen sortiert).

Rejoin, Replay, Projektion, Rerender, Laden und Wiederherstellung rufen weder `decideTurnOrder` noch `shuffle` auf (Test: Zufallsquelle mit Zähler, Aufrufzahl 0).

## 4. Übergangstabelle

Alle Operationen sind rein: `(state, args) → { state, changed, transition }`; bei **jedem** Fehler bleibt alles unverändert. Prüfreihenfolge einheitlich: gespeicherter Zustand → Argumentform → **Scope** → Terminal (`CLOSED`) → **Folgeversion** (`expectedVersion`) → **Zugbezug** (`expectedTurnNumber`) → Phase → Eligibility → Ziel. Ein veralteter Wiederholungsaufruf wird **nie** angenommen, nur weil er harmlos aussieht (Versionsprüfung vor jeder „identisch/kein-Op“-Erkennung).

| Operation | Kontext | Vorbedingung | Ergebnis | `version` | `turnNumber` | Wiederholung |
|---|---|---|---|---|---|---|
| `startTurnSequence` | Scope, `expectedVersion`, Eligibility | `READY` | `ACTIVE` bei erstem geeignetem Eintrag (Suche ab Position 0 einschließlich, höchstens ein Umlauf) **oder** `NO_ELIGIBLE` | +1 | 0→1 bzw. bleibt 0 | gleiche Version ⇒ `TURN_SEQ_VERSION_STALE`; mit neuer Version ⇒ `TURN_SEQ_ALREADY_STARTED` |
| `advanceTurn` `COMPLETE` | Scope, `expectedVersion`, `expectedTurnNumber`, Eligibility | `ACTIVE` | zuständiges Team: **innerer Zeiger +1 (genau einmal)**; `completedTurns` +1; Suche ab `position+1` (aktuelle Position zuletzt) → `ACTIVE` neuer Zug oder `NO_ELIGIBLE` | +1 | +1 bzw. unverändert | alte Version ⇒ `VERSION_STALE`; alter Zug ⇒ `TURN_STALE`; `HELD` ⇒ `TURN_SEQ_HELD`; `NO_ELIGIBLE` ⇒ `NO_CURRENT` |
| `advanceTurn` `SKIP` | wie oben | `ACTIVE`, `HELD` oder `NO_ELIGIBLE` | **kein** Abschluss: Zeiger und `completedTurns` unverändert; Suche wie oben (aus `NO_ELIGIBLE` = erneute Suche; bleibt es `NO_ELIGIBLE` ⇒ `changed:false`, keine neue Version) | +1 (oder unverändert) | +1 bzw. unverändert | wie oben |
| `withholdCurrentHolder` | Scope, `expectedVersion`, `expectedTurnNumber`, Eligibility | `ACTIVE` **und** Halter laut Eligibility **nicht** mehr geeignet (sonst `TURN_SEQ_HOLDER_STILL_ELIGIBLE`) | `HELD`; Halter/Zug bleiben | +1 | unverändert | bereits `HELD` (aktuelle Version/Zug) ⇒ `changed:false` |
| `overrideTurn` | Scope, `expectedVersion`, `expectedTurnNumber`, Ziel `{ playerId, teamId? }`, Eligibility, `now`, `reason?` | `ACTIVE`, `HELD` oder `NO_ELIGIBLE` | Ziel geprüft (bekannt, zum richtigen Team, geeignet) → neuer Halter, **neuer Zug**, `position`/`memberIndex` auf das Ziel; **kein** Abschluss, **kein** Zeiger bewegt | +1 | +1 | Ziel = aktueller Halter in `ACTIVE` ⇒ `changed:false` (kein Zug, keine Version); in `HELD` mit jetzt geeignetem Ziel ⇒ echte Änderung (`ACTIVE`, neuer Zug) |
| `closeTurnSequence` | Scope, `expectedVersion` | beliebig außer `CLOSED` | `CLOSED`, kein Halter | +1 | unverändert | bereits `CLOSED` ⇒ `changed:false` (nach Scope/Version-Prüfung) |
| `authorizeTurnAction` | Scope, `expectedVersion`, `expectedTurnNumber`, `caller`, `gate`, Eligibility | `ACTIVE` | nur Lesen: `true` oder **Code** | — | — | — |
| `projectTurnSequence` | Audience, Scope, `release`, `stateVersion` | — | strikte Allowlist-Projektion | — | — | — |

`transition` (serverprivat) trägt `{ kind, versionBefore/After, turnBefore/After, phaseBefore/After, … , reason }` für das spätere State-Event/Audit der Engine — **nie** an Clients, Logs oder öffentliche Historie. Gescheiterter Aufruf und `changed:false` erzeugen kein Event.

Alle anderen Zustandsübergänge, die oben nicht stehen, sind **ungültig** und liefern einen festen Code: `READY` + `advance/withhold/override/authorize` ⇒ `TURN_SEQ_NOT_STARTED`; `CLOSED` + alles außer Wiederholung von `close` ⇒ `TURN_SEQ_CLOSED`; `HELD` + `COMPLETE`/`authorize` ⇒ `TURN_SEQ_HELD`; `NO_ELIGIBLE` + `COMPLETE`/`withhold`/`authorize` ⇒ `TURN_SEQ_NO_CURRENT`.

### Der Zwischenzustand „Halter nicht mehr berechtigt“
Wird der aktuelle Halter zwischen zwei Aktionen ausdrücklich nicht mehr berechtigt (N6-Ausscheiden, Kick/Leave auf Ebene B, Teamwechsel nicht erlaubt …), gilt:
1. `authorizeTurnAction` lehnt ihn **sofort** ab (`TURN_SEQ_ACTOR_NOT_ELIGIBLE`), **ohne** dass vorher etwas gespeichert wurde — die Sperre hängt an der aktuell übergebenen Eligibility, nicht an einem Effect oder an Verbindungsstatus.
2. Der Verbraucher kann den Zwischenzustand **ausdrücklich festhalten**: `withholdCurrentHolder` ⇒ `HELD` (sichtbar projiziert, niemand handelt, lokale Version und `entitlementRevision` steigen — jede offene Aktion des Halters ist damit ungültig).
3. **Ausdrücklich** wählt eine Serveraktion den nächsten Akteur: `advanceTurn(SKIP)` (Suche nach dem nächsten geeigneten) oder `overrideTurn` (Ziel nennen). Weder ein Disconnect noch ein Reconnect noch ein Timer in der Folge löst das aus.
Ein bloßer **Disconnect** ändert nichts (die Folge kennt keinen Verbindungsstatus); er verändert weder Reihenfolge noch Zähler noch Zustand.

## 5. Versionen, Zugidentität, Eligibility-Stand, Snapshot — vier getrennte Ebenen

| Ebene | Wo | Zweck | Wann neu |
|---|---|---|---|
| lokale **Folgeversion** `version` | `TurnSequenceState` | Reihenfolge der Änderungen **dieses** Bausteins; Basis der Konkurrenzabwehr | jede echte Änderung +1 |
| **Zugidentität** `turnNumber` | `TurnSequenceState` | an **welchen konkreten Zug** eine Aktion gebunden ist | nur ein neu begonnener Zug (Advance, Override, Start); **nicht** bei `HELD`, `close`, Anzeige-/Metadatenänderung |
| **Eligibility-/Berechtigungsstand** | `eligibility` (N6-Track-Version, privat) + `entitlementRevision` (projiziert) | an welchen Berechtigungsstand die Zulassung gebunden ist | Basis: jede festgeschriebene Änderung mit neuerer N6-Version; `entitlementRevision`: nur wenn „darf jemand handeln?“ kippt |
| globale `stateVersion` + `commandId`/Receipt | Engine-State/CAS/`CommandReceipt` | atomare Spielzustandsänderung, Wiederholung derselben Befehlsabsicht | pro Commit |

Der Helfer allein garantiert **keine** Exactly-once-Verarbeitung. Der spätere Verbraucher liest den Game-State bei `stateVersion S`, ruft die Operation mit `expectedVersion = state.version` und `expectedTurnNumber` des **Clients**, und committet die neue Folge **zusammen mit** dem State-Event in **einem** CAS auf `S` (`saveGameStateIfRevision`) unter dem Receipt des Befehls. Alte `commandId`s werden bei Timeout/`RATE_LIMITED` nicht ersetzt.

**Rundengrenze / Lebensdauer:** Eine Folge ist an **Run** und eigene `sequenceId` gebunden, **nicht** an eine Runde. Ein `roundId`-Wechsel setzt Rotation und Zugzähler nicht zurück; ob eine Folge über mehrere Runden gilt, bestimmt der Verbraucher, indem er sie über Runden trägt oder eine neue Instanz (neue `sequenceId`, ausdrücklich neu vorbereitet — ggf. mit `ROTATING_START` und dem Vorgänger-Start) anlegt. Eine UI-Komponente, die remountet, legt keine fachliche Folge an. Neuer Run, Konfigurationswechsel oder Rematch = ausdrücklich neue Bindung.

## 6. Rotation, Zyklus, Override — exakt

**Spielerzug (`PLAYER`):** Suche ab `position+1` (bei `start`: ab 0 einschließlich), geprüft werden höchstens `order.length` Positionen, die aktuelle Position als **letzte** (ein einziger geeigneter Spieler findet sich nach einem vollen Umlauf wieder — neuer Zug, gleicher Spieler, kein Sieg). `cycle` += Zahl der überschrittenen Enden (Konvention von `advanceTurn`).

**Teamzug (`TEAM`):** Äußere Suche wie oben über Teams; ein Team ist geeignet, wenn es aktiv ist **und** mindestens ein aktives Mitglied hat. Innere Suche im gewählten Team: ab `cursor` (einschließlich) bis zum ersten aktiven Mitglied (höchstens `members.length` Positionen). Der **gewählte** Index wird `memberIndex`. **`cursor` bleibt dabei unverändert.** Erst `COMPLETE` setzt `cursor = (memberIndex + 1) mod members.length` — **nur** für dieses Team, **genau einmal**. Daraus folgt: übersprungene (inaktive) Mitglieder und Teams verbrauchen nichts; `SKIP`, `HELD`, `override` bewegen keinen Zeiger; andere Teams behalten ihren Stand.

Beispiel (festgeschrieben, unabhängig als Orakel gegengerechnet): T1=[A,B], T2=[C,D,E] ⇒ T1/A, T2/C, T1/B, T2/D, T1/A, T2/E, T1/B, T2/C … Jedes Team bekommt dieselbe Zahl **äußerer** Züge unabhängig von der Mitgliederzahl.

**Zykluszählung:** `cycle` zählt Wraps des äußeren Zeigers; `completedTurns` zählt echte Abschlüsse; `turnNumber` zählt begonnene Züge; übersprungene Positionen erhöhen nur `cycle` (wenn sie das Ende queren), nie `completedTurns`.

**Override — genau:**
- verändert: Halter (Spieler, im Teammodus sein Team), `position`, `memberIndex`, `turnNumber` +1, `version` +1, ggf. `entitlementRevision`, `lastOverride`, `eligibility`-Basis;
- verändert **nicht**: `completedTurns`, **alle** `cursor`, `cycle`, Punkte (nicht vorhanden). Der verdrängte Halter hat keinen Zug abgeschlossen; sein Team-Zeiger zeigt weiter auf ihn, er ist beim nächsten Teamzug des Teams wieder „der Nächste“.
- Fortsetzung: nach dem überschriebenen Zug geht es von der Position des **Ziels** weiter (nächster Eintrag); wird ein früherer Eintrag gewählt, wandert der Zeiger zurück, `cycle` ändert sich erst wieder beim Überschreiten des Endes.
- Alte offene Aktionen sind ungültig: `turnNumber` und `version` ändern sich.
- Ziel unbekannt ⇒ `ACTOR_UNKNOWN`; Spieler gehört zu anderem Team ⇒ `TEAM_MEMBER_MISMATCH`; nicht geeignet ⇒ `ACTOR_NOT_ELIGIBLE`; identisch ⇒ kontrolliert `changed:false`.
- `reason` (≤ 300 Zeichen, getrimmt) und `atMs` gehen nur in `transition`/`lastOverride` (ohne Grund). Der bestehende Audit-/Eventpfad der Engine wird nicht ersetzt. Öffentliche Projektionen enthalten nie Grund, `lastOverride`, Zeiger, Eligibility.

## 7. Projektionen und Grenzen zur Engine-Anbindung

`@quiz/shared/turnSequence` (clienttauglich, strip-only, nur `zod`): Vertrag, Grenzen, Fehlercodes (`TURN_SEQ_*`, nur Codes), Kontextschlüssel, Passungsprüfung. `projectTurnSequence(audience, state, { scope, release, stateVersion })`:

- **Freigabepolitik `release`** (Pflicht, ohne Default): `NONE` = nur Ordnungsebenen (Scope, `stateVersion`, `sequenceVersion`, `turnNumber`, `entitlementRevision`), **kein** Status, **kein** Halter, **keine** Reihenfolge · `CURRENT` = zusätzlich Zustand, **aktueller Halter** (Spieler, im Teammodus Team + Spieler) und `you` (nur eigene Sicht) · `ORDER` = zusätzlich die **äußere** Reihenfolge (Spieler- oder Team-IDs, Position, Zyklus). **Teammitgliederlisten, Rotationszeiger, Eligibility, Lebenswerte, Rollen, Override-Gründe sind in keiner Stufe projizierbar.**
- Die vier Ordnungszähler sind **opake Zähler**, sie verraten keine Spieler. Ihre Veröffentlichung ist gewollt, damit auch ein **Entzug** (`NONE`) gegen älteres Wissen einordenbar bleibt (wie N7). Die Teilnehmerzahl wird nicht mitgeliefert; `cycle` nur bei `ORDER`.
- `you` = `{ holdsTurn, teamHoldsTurn|null, canAct }` über `canView` (`PLAYER_PRIVATE` / `TEAM_PRIVATE`): ein mitspielender Host/Admin ist `PLAYER`; HOST/VIEWER/DISPLAY bekommen **kein** `you`. `canAct` ist eine **Anzeigehilfe**, keine Serverberechtigung; eine selbst übergebene Spieler-/Team-ID ist kein Nachweis — Audience, `participantId`, `teamId` müssen vom Verbraucher aus der **aktuell zugelassenen** Session/Teamzuordnung stammen.
- Eingabe: strikte Allowlist, Re-Check gegen das Clientschema, nie eine `ZodError`.

**Client:** `turnIntake` (rein) mit **getrennten** Merkern `seenStateVersion`, `seenSequenceVersion`, `seenTurnNumber`, `seenEntitlement` (nur Zahlen + Release, überleben Entzug/`null`/ungültig) und `held` (sichtbare Daten). Mindeststand `minStateVersion` kommt vom **eigenen** Snapshot-Kanal, nie aus dem eintreffenden Paket. Älter in **irgendeiner** Ebene ⇒ stale. Fremde/ungültige Pakete bewegen nichts. Kontextwechsel ⇒ leerer Merker (ein Slot, kein Archiv). Komponente `TurnStatusCard`: Midnight-Tokens, Text statt nur Farbe, lange Namen, 320 px; optionaler Callback `onAdvance(binding)` (Anwendungs-Callback, keine lokale Mutation), Sendesperre je **konkreter Zugbindung** (`turnNumber`+`sequenceVersion`) — überlebt neue Props-Objekte, Themewechsel, Remount-freie Updates; ein neuer Zug öffnet sie wieder.

**Grenzen (nicht N8):** keine Engine, Route, Socket-Ereignisfamilie, Spielseite, Tabelle/Migration, GamePermission, Setup-UI; keine Punkte-/Sieger-/Lebensverlustregel; keine automatische Niederlage/Sieger/Spielende bei Disconnect, letztem Teilnehmer oder leerem Aktivfilter; `roundFlow.ts`/Jeopardy/Wer-ist-das unverändert. Ein Test-/Entwicklungsharness (außerhalb `src/`, nie ausgeliefert) ist **kein** Engine-Verbraucher.

## 8. Testmatrix und begrenzter Integrationsnachweis

| Block (Prüfkatalog) | Datei | Inhalt |
|---|---|---|
| A Vorbereitung | `turnSequence.test.ts` | FIXED/RANDOM/ROTATING_START (erster Durchlauf, Vorgänger, ungültig, Parität zu `createTurn`)/CUSTOM; doppelte/unbekannte/fehlende IDs; Zähler/Index/Version-Grenzen; leere Konfiguration; RNG genau einmal, nie bei Lesen/Replay/Projektion/Laden |
| B Einzelspielerfolge | dito | A→B→C→A mit Zyklen/Identitäten; Einzelakteur (neuer Zug, kein Sieg); Inaktive überspringen ohne Umsortierung; `NO_ELIGIBLE`; Disconnect/Rejoin ohne Wirkung; 0 Leben unter KEEP_ACTIVE aktiv; Äquivalenz zu N6 `findNextActiveTurn` |
| C Teamrotation | dito | ungleiche Teams über mehrere Umläufe gegen **unabhängiges Orakel** (Warteschlangen statt Zeiger); je Team eigener Zeiger; ein/mehrere/inaktives Mitglied, inaktives Team, Team ohne geeignete Mitglieder; kein Zusatzzug wegen größeren Teams; Handlungsberechtigung (anderes Mitglied, fremdes Team, Viewer/Display/Host) |
| D Aktionen, Override | dito | doppelter Weiter-Befehl, veraltete Aktion nach vollem Umlauf (Zug 7 A → B → A), Pause/Phase/Entzug, `HELD`, Override auf zulässig/identisch/unbekannt/inaktiv/falsches Team, alte Aktion danach ungültig, kein doppelter Verbrauch |
| E Projektion/Client | `turnSequence.test.ts`, `turnIntake.test.ts`, `TurnStatusCard.test.tsx` | Allowlist, keine Geheimnisse (serialisiert), jede Ordnungsebene mit leerem Zwischenzustand, fremde hohe Version, unabhängiger Mindeststand, Kontextwechsel, Wrapper/Remount/Themewechsel ohne Mutation, Sendesperre je Zug |
| F Recovery | `turnSequence.test.ts`, `turnSequence.cas.integration.test.ts` | JSON-/SDK-Roundtrip; neuer Prozess/Adapter (Zufall 0 Aufrufe); beschädigter Zustand abgelehnt; **reale SQLite-CAS-Konkurrenz** über `saveGameStateIfRevision`, echtes `runReceipted` (parallel/seriell), persistierte Version, Anzahl der Änderungen, Zeiger genau einmal bewegt |
| G Browser | `apps/web/harness/n8-turn/check.cjs` | echte Statuskomponente, **zwei getrennte Chromium-Kontexte** (Empfänger A/B) mit Test-Backend, das die **echte** Server-Domain bindet; Warten auf tatsächlich zugestellten Zug/Version; alter Zug stellt nichts wieder her; 320 px/Desktop, hell/dunkel, lange Namen, Tastatur |

**Ehrliche Grenzen vorab:** CAS/Receipt wird auf echter SQLite mit `saveGameStateIfRevision` und `runReceipted` geprüft, der Zustand liegt als Stand-in-JSON in `RoomGameState` (**keine** echte Engine); es gibt keine Socket-/Neustart-Auslieferung. Das Harness ist Chromium-Emulation, **kein** iPhone-Hardwaretest; JSDOM ist kein Layoutnachweis.
