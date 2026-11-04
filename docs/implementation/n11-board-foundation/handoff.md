# N11 — Übergabe (Wiederaufnahme)

Stand: 04.11.2026.
- **Basis:** `main` @ `93305a864d855307e64c9dcab8d9675e1b4509a2` (N10 = PR #40 gemergt, main-CI 41819243936 grün), beim Start per Abfrage geprüft.
- **Branch:** `claude/new-session-kynlwj` (vom Sitzungsrahmen vorgegeben, stand beim Start auf `origin/main`). **Finaler Head, PR und CI am finalen Head:** `acceptance.md` und PR-Beschreibung (ein Commit kann seinen eigenen Hash nicht enthalten).
- **Offene Jobs/Dateien:** keine. Das Harness startet und beendet seine Kindprozesse selbst; die Mutationen sind einzeln zurückgenommen.

## Was N11 liefert (und was nicht)
`BoardState` (Felder mit Kapazität, eine Route je Eigentümer Start→Heim, Figuren), `moveFigure` (N8-Berechtigung zuerst, gespeicherter N9-Wurf, serverseitig abgeleitete Ziele, Schlagen mit atomarer Rücksetzung nur per Adapter-Policy, Wurfverbrauch im Brettzustand), `projectBoard`, `@quiz/shared/board`, `boardIntake`, `BoardView`, DB-Integrationstest und Chromium-Harness. **Stufe H, 0 echte Verbraucher, Core-DoD (Master §13.2) offen.** Formulierung: **N11-Grundlagenpaket umgesetzt/reviewbereit** — nicht „Raus damit! fertig“.

## Invarianten (nicht aufweichen)
1. Der Client nennt nur `figureId` und `to` (+ vollständige Herkunft). Schritte, Treffer, Rücksetzposition, Eigentum und Ergebnis kommen aus dem gespeicherten Wurf und dem Brett.
2. `moveFigure` prüft N8 **zuerst**; jede Ablehnung ändert und verbraucht nichts.
3. Herkunft (Run, Folge, Roster, Einheit, Brett, Wurfvorgang, Zähler) kommt aus der **Absicht** (`boardActionArgsFromIntent`), nie aus dem geladenen Zustand.
4. Ein Wurf (`diceId + rollCount`) bewegt höchstens eine Figur; der Verbrauch liegt im Brettzustand (`lastMove`).
5. Bewegung + Rücksetzung = ein Zustandsübergang; geschlagene Figuren gehen immer zum Start ihres Eigentümers (Ladeinvariante `START_CAPACITY`).
6. Geometrie und `capture` sind ausdrückliche Daten ohne Plattformdefault.
7. Beschädigte Zustände werden als Ganzes abgewiesen (`BOARD_STATE_INVALID`), nie repariert, nie neu bewegt.

## Verbindliche Pflichten des Runtime-Adapters
1. **Ein Commit:** Brettzustand (enthält den Wurfverbrauch) + bei `sequenceBasisAdvanced` N8 `refreshEligibilityBasis` + State-Event + globales CAS (`saveGameStateIfRevision`) + Receipt. Beim Zugwechsel: N8-Übergang + `closeDiceTurn` + `openDiceTurn` (neue `diceId`) + Event + CAS + Receipt. Vergisst der Verbraucher das Schließen, verweigert `moveFigure` den alten Vorgang trotzdem (`BOARD_TURN_STALE`) — das ersetzt die Atomarität nicht.
2. **Berechtigung:** `caller` (Rolle `PLAYER`, `participantId`, `teamId`) nur aus der aktuell zugelassenen Session; `gate` aus eigenen aktuellen Fakten (Zulassung, Phase, Pause); `eligibility` aus den N6-Tracks. Nie aus Payload, UI-Flags, `you.canMove` oder `targets`.
3. **Policy:** `{ capture }` und die Geometrie kommen aus der Spielkonfiguration (DEC-BRD-01), nie vom Client.
4. **Receipt-Payload:** semantische Operation + **vollständige** Absicht (`{ kind, intent }`); `CRITICAL_COMMAND_ACTIONS` um die Brettaktion ergänzen. Dieselbe Absicht wird mit derselben `commandId` wiederholt (die UI tauscht sie nicht aus). Eine Ablehnung muss die Rückmeldung an `BoardView` **ablehnen** (rejected Promise), sonst bleibt die Bindung gesperrt.
5. **Zähler:** bei `BOARD_COUNTER_LIMIT` ist das Brett/die Folge erschöpft (praktisch unerreichbar); nicht klemmen, nicht wrappen.
6. **Zugende/Zusatzwurf:** der Zug endet nicht von selbst (weder nach dem Zug noch bei „kein legales Ziel“). Ob nach einem Zug ein weiterer Wurf erlaubt ist (N9-Profil mit `maxRolls > 1`), entscheidet die Engine; der Brettzustand behandelt jeden neuen Wurf als unverbraucht.
7. **Projektion:** `release` je Zielgruppe bewusst wählen (`NONE`/`FIGURES`, ohne Default); Audience und `recipientId` nur aus der Session; `stateVersion` = Version des Gesamt-Snapshots. Die UI bekommt `expected` (Scope, `boardId`, `recipientId`, unabhängiges `minStateVersion` aus dem eigenen Snapshotkanal).
8. **Recovery:** Laden validiert streng; ein beschädigtes Brett läuft über den vorhandenen Fehlerpfad (`gameErrorCode` → `BOARD_STATE_INVALID`); kein erneutes Würfeln/Bewegen/Schlagen beim Laden.
9. **Logging:** Fehler nur als Code (`BOARD_*`, `TURN_SEQ_*`, `DICE_*`); keine Figuren-, Feld- oder Schrittwerte in Logs.

## Offene Spielregeln (brauchen Freigabe, nicht von N11 entschieden)
Brettgröße/Heimfeldgröße, Figurenzahl, **Eintrittsregel** (nicht modelliert), Überwurf am Heimfeld (hier: kein Zug), Treffer nur exakt vs. Überfahren, Stapeln (Kapazität), geschützte Felder, Schlagzwang, Zusatzwurf, Teamregeln (hier: Eigentümer = Team), Sieg/Punkte, Timeout, Animationstiefe (DEC-BRD-01).

## Reproduzierbare Gegenproben
Siehe `review.md` B und die Befehle in `acceptance.md`. Kurz: `cd apps/server && npx vitest run src/games/core/boardState.test.ts src/games/core/boardState.cas.integration.test.ts`; `cd apps/web && npx vitest run src/board src/components/BoardView.test.tsx`; `node apps/web/harness/n11-board/check.cjs [outDir]`. Mutationen: die Ersetzungen aus `review.md` B einzeln einspielen, die genannten Tests müssen rot werden, danach `git checkout -- <Datei>`.

## Ehrliche Grenzen
Der DB-Nachweis nutzt einen Stand-in-Zustand (`{ turnSequence, dice, board }`) und einen Test-Handler, keine Engine; das Browserharness ersetzt die Session durch eine Empfängertabelle und kennt Host-Befehle (`reset`, `place`, `roll`, `endTurn`, …), die nur dort existieren. Layout nur im Chromium-Emulator (320/480/1100 px, hell/dunkel, lange Namen), **nicht** auf einem iPhone/Safari; kein Screenreader-Test. Teammodus nur auf Domänenebene getestet. Ein lesender zweiter Prozess ist kein nachgewiesener produktiver Wiederanlauf aller Routen.
