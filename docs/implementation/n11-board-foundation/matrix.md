# N11 — Bestandsmatrix

Legende: **R** real vorhanden und von einem echten Aufrufer genutzt · **H** Baustein vorhanden, Runtime-Integration offen · **O** offen (Engine-/Integrationsentscheidung) · **S** bewusst nicht Teil von N11.
Bezugsstand: `main` @ `93305a864d855307e64c9dcab8d9675e1b4509a2`. Echte neue Verbraucher dieses Pakets: **0**. „Aufrufer“ ist bei den neuen H-Bausteinen ausschließlich Test/Harness; Stand-in-Handler und Browserharness sind keine echten Verbraucher. Geplanter Verbraucher „Raus damit!“ (`board-race`) zählt nicht.

| Anforderung | Vorhandener Baustein / echter Aufrufer | Lücke | N11-Änderung | Nachweis | Offen für echte Engine |
|---|---|---|---|---|---|
| Brett-/Figurenzustand, Eigentümer, Positionen, Start/Bahn/Heim | — | gab es nicht | `BoardState` + `boardGeometryIssues` (strikt, beim Laden validiert, nie repariert) | `boardState.test.ts` (Beschädigungstabelle 25 Fälle, `prepareBoard`, N11-01: letzte Bewegung und Konsistenz Brett/N8/N9) | Brettlayout/Figurenzahl (DEC-BRD-01) |
| Zulässige Ziele, deterministischer Zug, Schlagen + Rücksetzung atomar, Heimfeld | — | gab es nicht | `legalBoardMoves`, `applyDecidedBoardMove`, `moveFigure`; Policy `capture` vom Adapter | Domäne (normal, Schlag, FORBIDDEN, Heimfeld, Überwurf = kein Zug, kein legales Ziel, Kapazität 2) | Schlag-/Heimfeldregeln, Eintritt, Stapeln, Schlagzwang, Zusatzwurf |
| Zug (N8), Teilnahme (N6), gespeicherter Wurf (N9) | N8 `authorizeTurnAction`, N6 über Eligibility, N9 `DiceTurnState` (H) | kein Verbraucher des Wurfs | Wurf wird gelesen (Summe der Werte), **im Brettzustand verbraucht** (`diceId`+`rollCount`) | Domäne (Rechte, Pause, Entzug, Team), DB-Test, Browser S5/S10/S12 | `caller`/`gate`/`eligibility` aus der echten Session/N6 |
| Ursprung der Absicht (Ziel + Zähler), Wurf nur einmal | N9-01-Muster | — | Absicht trägt `scope`, `boardId`, `diceId`, 5 Zähler; `boardActionArgsFromIntent` | Domäne, DB (5 Ziele, erstmalige Zustellung ohne Receipt), Browser S8, M3/M14 | Serveradapter ruft ausschließlich die Absicht ab |
| Konkurrenz, Duplikate, Recovery (CAS/Receipt/Events) | `saveGameStateIfRevision`, `runReceipted`, `materializeGameEvent` (R) | kein Nachweis für Figurenzüge | Stand-in-Handler im Test; Brett + Wurfverbrauch + Basisschritt in **einem** Commit | `boardState.cas.integration.test.ts` (20), Browser S7/S13, M13/M15 | echter Handler, Route/Socket |
| N8-Basisfortschritt und Reserve | N8 BASIS (H) | — | `sequenceBasisAdvanced`; Reserve für das Zugende (R1) | Domäne, DB (ein Commit; BASIS allein), Browser S11, M7/M8 | Verbraucher persistiert die Folge im selben Commit |
| Projektion, Anzeige, Intake | `visibility.ts` (R), `DiceTray`/`diceIntake` (Muster) | gab es nicht | `projectBoard`, `boardIntake.ts`, `BoardView` | `BoardView.test.tsx` (19), `boardIntake.test.ts` (16), Browser S1–S14 | Einbindung, `minStateVersion` aus dem eigenen Snapshotkanal |
| Fehlercodes ohne Inhalte | `core/errors.ts` `PUBLIC_CODES` (R) | — | `BOARD_*` ergänzt | DB-Test (`gameErrorCode`) | `appError.ts`-Abbildung |
| Command-Aktionen | `CRITICAL_COMMAND_ACTIONS` (R, geschlossen) | keine Brettaktion | **nicht berührt** (Stand-in nutzt `ROUND_ADVANCE`) | — | Verbraucher ergänzt seine Aktion |
| Sieg, Punkte, Zugende, Timeout, Turnier/Olympia | — | — | **nicht berührt** (S) | — | S |
| Zwei echte Engines (Master §13.2) | — | **0** | — | — | **Core-DoD offen** |
