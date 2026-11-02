# N9 — Gemeinsame Würfelgrundlage (Halten, Zugbindung, Wiederherstellung): Entwurf

Base: `main` @ `5ed23b7b4710ddb47d8c14003437eeab29a8f3a5` (N8 = PR #38 gemergt; main-CI-Lauf 41502473539 `completed/success`, beim Start per `git fetch` und GitHub-Actions-Abfrage geprüft, unverändert). Arbeitsbranch `claude/new-session-ioz44y` (vom Sitzungsrahmen vorgegeben), frisch von `origin/main`.
Status: **Entwurf vor der Implementierung.** Abweichungen im Endstand stehen in `review.md`.

Quellen: Arbeitsauftrag N9 (02.11.2026); `Master_Regelwerk_3.txt` §§2, 4.15, 5.12, 5.15–5.24, 5.29–5.33, 13.2, 15.16, 16.2–16.5, 16.9–16.11, 16.16–16.17 (gelesen, **nicht** umgesetzt: Yacht-Wertung, Brettregeln). Es gibt **keine** AGENTS.md/CLAUDE.md im Checkout (nur `SKILL.md` mit Projektregeln: `.js`-Importendungen, kein Glow, `prefers-reduced-motion`).

## 1. Was wiederverwendet wird — und was wirklich ergänzt wird

Unverändert: N8 (`turnSequence.ts`: `authorizeTurnAction`, Zugidentität `turnNumber`, lokale Folgeversion, Eligibility/N6, `projectTurnSequence`), `visibility.canView`/`ProjectionAudience`, `saveGameStateIfRevision` (CAS), `runReceipted`, `game-sdk` State-Events, `node:crypto.randomInt` (der einzige vorhandene sichere Zufallspfad; `shuffleServer` benutzt ihn bereits), Midnight-Tokens, `@quiz/ui` `Button`.

**Bestandsaufnahme Random/Seed (Master §5.16):** Es gibt **keinen** Random-/Seed-Core. Es gibt `shuffleServer` (`roundFlow.ts`, `randomInt`) und Einzelaufrufe von `randomInt`/`randomUUID` für Codes und Tokens. Kein `randomSeed`, kein persistierter RNG-Zustand, kein Seed-Replay. N9 baut **keinen** Seed-Core: die Wahrheit sind die **gespeicherten Ergebnisse** (Werte, Haltebelegung, Wurfzahl). Reproduzierbarkeit aus einem Seed wird nicht behauptet.

Neu (klein, begründet):
- `packages/shared/src/dice.ts` (`@quiz/shared/dice`): client-sicherer Vertrag (nur zod, strip-only, ohne relative Imports wie die N5–N8-Dateien): Konfiguration, Projektion, Absichten, Codes.
- `apps/server/src/games/core/diceTurn.ts`: serverprivater Zustand und reine Übergänge; Zufallsadapter (`randomInt`, injizierbar nur als Funktionsargument).
- Eine **additive** Funktion in `turnSequence.ts` (`turnEligibilityAdvancesBasis`, rein lesend): damit ein Würfelaufruf dem Verbraucher meldet, dass der mitgelieferte N6-Stand **neuer** ist als die N8-Basis (N8-02: ein erfolgreicher „Kein-neuer-Zug“-Pfad darf neue Berechtigungskenntnis nicht verlieren).
- Fehlercodes `DICE_*` in die zentrale Whitelist (`errors.ts`).
- Web: `diceIntake.ts` (reiner Intake), `DiceTray` (Komponente), Chromium-Harness.

Keine neue Command-, Event-, Receipt-, Zufalls- oder Persistenzplattform. Keine Migration, keine Route, kein Socket, kein `GameManifest`-Status.

## 2. Zustände, Identitäten, Konfiguration, Positionen, Übergänge

**Konfiguration** (unveränderlich im Zustand, strikt, begrenzt): `{ diceCount 1..10, sides 2..20, maxRolls 1..10, holdAllowed }`; `holdAllowed` verlangt `maxRolls ≥ 2` (sonst wäre Halten nie benutzbar → abgewiesen, nicht korrigiert). Zwei ausdrückliche Konstanten, **eine** Implementierung:
- `DICE_CONFIG_FIVE_D6_HOLD` = 5 × W6, 3 Würfe, Halten erlaubt (Grundlage für Yacht).
- `DICE_CONFIG_SINGLE_D6` = 1 × W6, 1 Wurf, Halten deaktiviert (einfaches Profil für einen späteren Brettverbraucher).
Werte außerhalb der Grenzen, Nicht-Ganzzahlen, unbekannte Schlüssel → `DICE_CONFIG_INVALID`/`DICE_ARGS_INVALID`.

**Zustand `DiceTurnState`** (serverprivat, serialisierbar, strikt validiert beim Laden und nach jedem Übergang):
`kind, schemaVersion, runIndex, diceId (opak), binding { sequenceId, rosterRevision, unit, turnNumber, playerId, teamId|null }, config, phase, version, rollCount, values (number[]|null), held (boolean[]), lastRolled (number[])`.
- Würfel sind **Positionen** `0..diceCount-1`. `values[i]` gehört zu Position `i`, immer. Nie nach Augenwert sortiert.
- `values` ist `null` vor dem ersten Wurf (keine 0, kein Platzhalter). Danach exakt `diceCount` Ganzzahlen `1..sides`.
- `held[i]` ist die Haltebelegung. `lastRolled` = die Positionen, die im **letzten** Wurf neu gezogen wurden (nur Anzeige/Animationsziel; wird beim Halten nicht verändert).
- Phasen (klein): `PREPARED` (kein Wurf), `IN_PROGRESS` (1 ≤ Wurf < Limit), `EXHAUSTED` (Wurf = Limit), `CLOSED` (terminal). Die Kreuzinvarianten (Phase ↔ Wurfzahl ↔ Werte ↔ Haltebelegung ↔ `lastRolled` ↔ `version ≥ rollCount`) werden beim Laden geprüft; ein beschädigter Zustand wird als Ganzes abgewiesen (`DICE_STATE_INVALID`, nur Code-Issues), nie repariert.

**Übergänge** (jeder echte Übergang: lokale `version` +1; sonst `changed:false`):
| Aktion | erlaubt in | Wirkung |
| --- | --- | --- |
| `rollDice` | PREPARED, IN_PROGRESS | zieht Werte **nur** für nicht gehaltene Positionen; `rollCount`+1; Phase → IN_PROGRESS bzw. EXHAUSTED |
| `setDiceHeld` (ausdrückliche **Zielbelegung** `held: number[]`) | IN_PROGRESS mit `holdAllowed` | setzt die Belegung exakt; `[]` = „alle freigeben“; gleiche Belegung → `changed:false`; verbraucht keinen Wurf, ändert keine Werte |
| `closeDiceTurn` | PREPARED, IN_PROGRESS, EXHAUSTED | → CLOSED; wiederholtes Schließen beim aktuellen Stand = `changed:false`; kein Wiederöffnen |
Ablehnungen: PREPARED+Halten → `DICE_NOT_ROLLED`; EXHAUSTED+Wurf/Halten → `DICE_ROLLS_EXHAUSTED`; Profil ohne Halten → `DICE_HOLD_DISABLED`; CLOSED → `DICE_CLOSED`; alle Würfel gehalten → `DICE_NOTHING_TO_ROLL` (**kein** RNG-Aufruf, kein verbrauchter Wurf, keine automatische Wertung/Zugbeendigung); ungültige Indizes (unbekannt, doppelt, negativ, gebrochen, nicht-numerisch, > diceCount Einträge) → `DICE_HOLD_INVALID`.
Öffnen: `openDiceTurn` liest den **aktuellen** N8-Zug (Phase `ACTIVE`, sonst `DICE_SEQUENCE_NOT_ACTIVE`) und bindet Run, Sequenz, Roster, Einheit, `turnNumber`, Halter-Spieler und (Teammodus) Team **aus dem Serverzustand**, nie aus der Absicht.

## 3. Die fünf Ordnungsebenen (nicht voneinander ableitbar)

1. **Würfelzustandsversion `version`** — lokal, +1 je echter Änderung dieses Vorgangs (Wurf, Halteänderung, Schließen).
2. **Wurfnummer `rollCount`** — nur +1 je Wurf; zusätzlich Teil der Roll-Absicht (`expectedRollCount`): ein Wurf kann nie Wurf Nr. n+1 erzeugen, wenn der Client Nr. n sah.
3. **N8-Zugidentität `turnNumber`** — +1 je tatsächlich begonnenem Zug. Der Würfelvorgang gehört zu genau einem Zug (`binding.turnNumber`). Derselbe Spieler im späteren Zug ist ein anderer Zug.
4. **N8-Folgeversion `sequenceVersion`** — der **aktuelle** lokale Zähler der N8-Folge. Ein N6-BASIS-Update erhöht ihn, ohne neuen Zug und **ohne** den Würfelzustand anzufassen. Eine Absicht trägt den Wert, den der Client sah; `authorizeTurnAction` vergleicht ihn.
5. **Globale Snapshotversion `stateVersion`** — Version des Gesamt-Snapshots; im Browser nur als unabhängiges `minStateVersion` aus dem eigenen Snapshotkanal.

Die Absichtsbindung ist `{ turnNumber, sequenceVersion, diceVersion, rollCount }` (+ `held` bei Halten). Veraltet in **irgendeiner** Ebene → abgewiesen, kein RNG. **Lebensdauer ≠ Aktualität:** Ein BASIS-Update im selben Zug macht alte Absichten veraltet (`TURN_SEQ_VERSION_STALE`), der Würfelzustand (Werte, Haltebelegung, verbrauchte Würfe) bleibt unverändert; nach erneuter Synchronisation gilt dieselbe Würfelmenge weiter. HELD/Recovery in N8 öffnet keinen neuen Würfelvorgang. Ein neuer N8-Zug (auch Override) macht jede alte Absicht unbrauchbar (`TURN_SEQ_TURN_STALE`/`DICE_TURN_STALE`), selbst wenn derselbe Spieler wieder zuständig ist.

**Atomare Verbindung für den späteren Verbraucher** (nicht in N9 verdrahtet, hier dokumentiert): Zugwechsel = ein Commit mit (a) N8-Übergang (`advanceTurnSequence`/`overrideTurnSequence`), (b) `closeDiceTurn` des alten Vorgangs, (c) `openDiceTurn` mit dem **neuen** N8-Zustand und neuer `diceId`, (d) State-Event, (e) globales CAS, (f) Receipt. Bricht ein Teil ab, gilt nichts davon.

## 4. Zufallsadapter versus reine Anwendung

- **Entscheidung** (`rollDice`, nur serverseitig): nach **allen** Prüfungen genau `k` Aufrufe der Quelle, `k` = Anzahl nicht gehaltener Positionen. Standardquelle: `node:crypto.randomInt(1, sides + 1)` (unverzerrt, kein Modulo, kein `Math.random`, keine Uhr, kein Seed, kein Clientwert). Die Quelle ist nur als Funktionsargument injizierbar (Tests); es gibt keine Wunschzahl-API. Rückgabewerte der Quelle werden geprüft (Ganzzahl, Bereich) → sonst `DICE_RANDOM_INVALID`, ohne Klemmen und ohne erneutes Ziehen.
- **Reine Anwendung** (`applyDecidedDiceRoll`): nimmt ein **bereits entschiedenes** Ergebnis (`indices`, `values`) an, prüft Version, Wurfnummer, dass `indices` exakt die aktuell nicht gehaltenen Positionen sind, und dass Werte im Bereich liegen; ruft weder RNG noch Uhr. Diese Schnittstelle ist serverprivat; es gibt im Shared-Vertrag **kein** Schema, das Werte vom Client annimmt (die Roll-Absicht ist strikt ohne `values`).
- Gleich hohe alte und neue Werte sind ein gültiges Ergebnis; es wird nicht nachgezogen.
- Projektion, Rejoin, Resync, Neustart, State-Event-Replay lesen nur gespeicherte Ergebnisse.
- **Ehrliche Aussage zu RNG-Aufrufen unter Konkurrenz:** In einem Stand-in-Handler (laden → `rollDice` → CAS) berechnen zwei konkurrierende Wurfabsichten beide ein Ergebnis (zwei Quellenaufrufe-Sätze); das CAS lässt höchstens **ein** Ergebnis festschreiben, das andere wird verworfen. „Ein angewandter Wurf“ heißt nicht „global ein RNG-Aufruf“. N9 hat keine automatischen Konfliktretries; eine bestätigte `commandId` wird nie durch einen neuen Wurf ersetzt (Receipt).

## 5. Validierung vor dem Zufallsaufruf; Duplikate und CAS-Konflikte

Reihenfolge in `rollDice`/`setDiceHeld`: Würfelzustand laden (strikt) → Argumentform → **`authorizeTurnAction` (N8)**: N8-Zustand, Scope, geschlossen, Folgeversion, Zugnummer, Folgephase, Gate (Zulassung/Phase/Pause), Rolle, Halter-Identität, Halter-Eligibility → Würfelbindung (Run/Sequenz/Roster/Einheit/`diceId`, Zug und Halter gegen den aktuellen N8-Zug) → `CLOSED` → Würfelversion → Wurfnummer → Phase/Profil/Wurflimit → Zielbelegung → „nichts zu würfeln“ → **erst dann** RNG → Anwendung. Jede frühere Ablehnung verbraucht keinen produktiven Zufallsaufruf (Zählertests mit Fake-Quelle).

- Gleiche `commandId`: der Receipt-Pfad (`runReceipted`) liefert das gespeicherte Ergebnis, der Handler läuft nicht erneut.
- Neue `commandId` mit alter Bindung: `DICE_VERSION_STALE`/`DICE_ROLL_STALE`/`TURN_SEQ_*_STALE`.
- Zwei verschiedene Absichten auf demselben erwarteten Stand: höchstens eine wird festgeschrieben (CAS), die andere `STATE_CONFLICT`.
- Halten gegen Wurf: jede Halteänderung erhöht `version`; ein Wurf mit der alten Version scheitert, ein Halten mit der alten Version scheitert — nie Mischen aus altem Haltesatz und neuem Ergebnis.
- N8-02: `sequenceBasisAdvanced` im Ergebnis jedes erfolgreichen Aufrufs. Ist es `true`, **muss** der Verbraucher im selben Commit `refreshEligibilityBasis` (N8) persistieren; das erhöht die N8-Folgeversion, nicht den Würfelzustand.

## 6. Projektionen, Empfängerbindung, UI-Sendesperren

Release (**ohne Default**, vom Server je Zielgruppe gewählt): `NONE` (nur Bindung und Ordnungszähler) oder `VALUES` (zusätzlich Konfiguration, Phase, Werte, Haltebelegung, `lastRolled`, Halter, `you`). Nie projiziert: Seeds/RNG-Zustände (es gibt keine), zukünftige Würfe, Sessiondaten, Eligibility-Rohdaten, Gründe, Teammitgliederlisten, Rotationszeiger. `you` (`holdsTurn`, `teamHoldsTurn`, `canRoll`, `canHold`) nur für eine PLAYER-Audience (ein mitspielender Host wird als PLAYER projiziert); Sehen ist nicht Handeln; Zuschauer/Display/Host ohne Mitspielen erhalten kein `you`. `recipientId` steht in **jedem** Paket (auch `NONE`); der Intake vergleicht ihn mit dem unabhängig erwarteten Empfänger (auch im Team). Die Handlungshinweise stammen aus dem **aktuellen** N8-Zustand (`projectDiceTurn` bekommt ihn mit): ist der N8-Zug weitergegangen, sind `canRoll`/`canHold` `false`.

**Intake** (`diceIntake.ts`, ein Slot je Kontext = Run/Sequenz/Roster/Einheit/Empfänger — **bewusst nicht** je `diceId`, damit ein neuer Zug dieselbe Versionskenntnis fortführt): getrenntes Versionswissen je Ebene: `stateVersion`, `sequenceVersion`, `turnNumber` (immer monoton) sowie `diceVersion` und `rollCount` (monoton **innerhalb** desselben Zuges; ein höherer Zug beginnt einen neuen Würfelvorgang). Ein Paket mit anderer `diceId` bei gleicher Zugnummer ist fremd (ignoriert, kein Vergiften). Ungültig/null/fremd/Entzug entfernt die angezeigten Daten, **nicht** das Versionswissen. Ein gültiges `NONE`/geschlossenes Paket hebt das Wissen an.

**Komponente `DiceTray`:** Würfel als Positionen mit Text („Würfel 2: 6, gehalten“), Halten per Tastatur/`aria-pressed` (Zustand nicht nur über Farbe), Wurf-Button nur wenn `you.canRoll`. Sendesperre je **konkrete Bindung** (`Kontext|turnNumber|sequenceVersion|diceVersion|rollCount`): **eine** Absicht pro Bindung, Wurf **und** Halten teilen sie (Doppelklick, Wurf-nach-Halten und Halten-nach-Wurf auf derselben Bindung senden nichts Zweites); eine neue Bindung (neue Projektion) ist eine neue Sperre; abgelehnte Zusage (`rejected`) entsperrt genau diese Bindung; neue Props-Objekte, Theme-Wechsel und Re-Render entsperren nichts. Keine Aktion bei Mount/Rejoin/Theme/Props. Animation: **nur CSS** (keine Timer, kein `animationend`-Handler, keine Zufallszahlen im DOM), die angezeigten Werte sind sofort die der Projektion, `prefers-reduced-motion` schaltet sie ab; ein `role="status"`-Text nennt den Stand einmal je Projektion.

## 7. Testmatrix und Grenzen

| Bereich | Nachweis |
| --- | --- |
| Konfiguration/Argumentgrenzen, beschädigte Zustände | `diceTurn.test.ts` (Tabellen ohne Reparatur) |
| Haltefall wörtlich (`[1,2,3,4,5]`, halte 1 und 3, neu `[6,6,6]` → `[6,2,6,4,6]`), gleiche Augen auf verschiedenen Positionen | `diceTurn.test.ts` |
| RNG-Zähler (0 Aufrufe bei jeder Ablehnung; genau `k` bei Erfolg; `randomInt(1,sides+1)`; kein `Math.random`/Uhr) | `diceTurn.test.ts` |
| Rechte/Pause/Phase/alter Zug/Run/Team/Viewer/Host (über N8) | `diceTurn.test.ts` |
| BASIS-Update im selben Zug: Würfel/Wurflimit bleiben, neue Bindung nötig | `diceTurn.test.ts` |
| Reine Funktionen: keine Eingabemutation, keine Uhr, kein RNG; JSON-Roundtrip; SDK-State-Event-Replay | `diceTurn.test.ts` |
| Projektion: Leak-Probe, Empfänger, kein `you` für Viewer/Display/Host | `diceTurn.test.ts` |
| Echte SQLite-CAS/Receipts, zweiter Prozess, Konkurrenz | `diceTurn.cas.integration.test.ts` |
| Intake-Ketten (neu→null→älter, geschlossen→ungültig→alt, A1→B2→A3→A1-spät, A-Paket unter B-Erwartung inkl. Team, BASIS) | `diceIntake.test.ts` |
| Komponente: Aufrufanzahl, späte ACKs, Props/Theme, Tastatur, Animation | `DiceTray.test.tsx` |
| Browser (mehrere Kontexte, echte Serverprojektion, DB-Nachlesen) | `harness/n9-dice/check.cjs` |

Grenzen (werden im Review/Abnahme ehrlich wiederholt): Der DB-Nachweis nutzt einen **Stand-in-Zustand** und einen Test-Handler, keine Engine. Das Browserharness ersetzt die Session durch eine Empfängertabelle. Chromium ist kein Safari-/iPhone-Nachweis, die schmale Ansicht ist Emulation. Ein lesender zweiter Prozess ist kein produktiver Wiederanlauf aller Routen. **0 neue echte Engine-Verbraucher; Core-DoD (Master §13.2) bleibt offen.**

---
Abgleich mit dem Endstand (Abweichungen, Befunde der zweiten Prüfung, Mutationen): `review.md`. Anforderungen → Nachweis und Prüfläufe: `acceptance.md`. Übergabepflichten: `handoff.md`.
