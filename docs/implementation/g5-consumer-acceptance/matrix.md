# G5 — Mechanik-, Verbraucher- und Nachweismatrix

Base: main `bafbc61`. Stufen: **R** im benannten Teilumfang in einer echten Engine verwendet · **H** Helper/Schema ohne volle Integration · **O** im Kern nicht als vollständiger Baustein vorhanden · **S** bewusst später. Verbraucher: W = Wissensduell, J = Jeopardy, WID = Wer ist das?.
**Core-DoD-Spalte** bewertet nur das Kriterium „von mindestens zwei unterschiedlichen echten Engines erfolgreich genutzt“ **für den genannten Teilumfang**, nicht die übrigen DoD-Punkte (Master §13.2). Prüfstand: Codeprüfung der genannten Aufrufer (Zeilen am Base-Stand `bafbc61`) und Ausführung der genannten Tests; die G1–G4-Matrizen ([G1](../g1-command-contract/matrix.md), [G2](../g2-runtime-flow/matrix.md), [G3](../g3-submission-judging/matrix.md), [G4](../g4-results-protection/matrix.md)) sind die Detailquellen, hier fortgeführt und nicht neu implementiert.

## 1. Kernbausteine nach Teilumfang

| Teilumfang | Quelle | Runtime-Aufrufer | Verb. | Aktion / Recht / Phase (serverseitig) | Persistenz · Recovery | Secret | Nachweis (Test) | Stufe | Zwei-Engines |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Command-Hülle: commandId, Protokollversion, Recht, Replay/CAS, Receipts | Master §5.17/§5.19; G1 | `runReceipted` (`core/commands.ts`) in allen Handlern | W, J, WID | Guard vor Mutation, `CLIENT_VERSION_UNSUPPORTED` vor Mutation | `CommandReceipt`, Replay nach Neustart | Fehlertexte ohne Inhalte | `contract/{geo,jeopardy,wer-ist-das}.contract.test.ts` (4 Fälle je Engine; **WID neu in G5**), `g4Restart.integration.test` | R | ja (3) |
| Event-Core + State-Version | §5.18/§5.19; G2 | `materializeGameEvent` (`core/events.ts`) | W, J, WID | CAS auf `RoomGameState.revision` | `GameDomainEvent` je Run/Version | — | `g2Runtime`, `g2Restart`, `runtime.integration` | R | ja (3) |
| Config-Snapshot + Engine-Version | §5.22/§5.24 | `ENGINE_VERSIONS` (`core/config.ts`) | W, J, WID | unbekannte Version → kontrolliert abgelehnt | Snapshot beim Start | — | Contract-Fall 4 (3 Engines), `weristdas/recovery.integration` „inkompatible Engine-Version“, `config.integration` | R | ja (3) |
| Timer (Countdown, Pause, Lock) | §5.5; G2 | W: `createTimer`/`pauseTimer` `geo/index.ts:378,1216`; J: `createTimer` `jeopardy/engine.ts:60,251` | W, J | Pause/Resume Host-Recht, Frist selbst geschlossen | Zeitpunkte persistiert, Restore `restoreActiveTimers` | — | `g2Restart` (zwei echte Prozess­tode), `jeopardy/socket-flow` | R | ja (2) für Countdown/Pause. `extendTimer`/Count-up: **kein Runtime-Aufrufer → H** |
| Buzzer (erster Servereingang, Sperre, Override) | §5.6; G2/G3 | `claimBuzzer`/`openBuzzer`/`resolveBuzzer` J `engine.ts:253,346,423,490`; WID `weristdas/state.ts:74`, `engine.ts:197` | J, WID | `BUZZER_CONTROL`, Phase `BUZZ_OPEN`, Roster | im State + Event, Reihenfolge stabil beim Rejoin | Lösung bis Reveal geheim | `jeopardy/socket-flow`, `weristdas/socket-flow` („CAS buzzes“), `g3Submission`, `g4Protection` (Konkurrenz) | R | ja (2) |
| Antwortbesitzer/Turn (FIXED, ein Spieler) | §5.12; G3 | `createTurn` J `engine.ts:64`; WID `state.ts:76`; `requireWinningTurn` | J, WID | nur Gewinner darf antworten/bewertet werden | im State | — | `g3Submission.integration` | R | ja (2) — **nur Einzelbesitzer**, kein Mehrspieler-Zug (H/S) |
| Submission (einmal, Dedup) | §5.14; G3 | `submitOnce` W `geo/index.ts:577`, J `engine.ts:62`; `lockSubmission` nur W `geo/index.ts:495` | W, J | Phase/Frist; fremde Frage/Partie abgewiesen (run+question) | im State | private Antwort bis Reveal | `g3Submission`, `g3Restart` | R | ja (2) für `submitOnce`; Lock-Variante nur W (1) |
| Antwort-Matching | §5.13; G3 | **W: `matchAnswer(…,'EXACT')` `geo/index.ts:1000`; J: `matchAnswer(…,'MANUAL_ONLY')` `jeopardy/engine.ts:63`; WID: kein Matching-Aufruf** (manuelle Bewertung ohne Modus) | W, J | — | im Submission-Eintrag | Lösung nicht in Antwort | `g3Submission` | R (EXACT: W; MANUAL_ONLY: J). NORMALIZED/SYNONYM/FUZZY: **H** | EXACT 1 Engine, MANUAL_ONLY 1 Engine → **nein** |
| Judge + Punktelogik | §5.7; G3 | `judgeSubmission` W `geo:1003`, J `engine:70`; `scoreJudgement` W `geo:1014,1023`, J `engine:410,564`. WID: eigene Wertung `weristdas/state.ts:94` (+3/+1/−1, ohne Core-Judge) | W, J (Core); WID eigen | `JUDGE_ANSWER`/Phase; falscher Kontext abgewiesen | Ledger | — | `g3Submission`, `g4Protection` | R (W, J). WID **nicht** auf `scoreJudgement` | ja (2: W, J); PARTIAL/CANCELLED nicht in zwei Engines bedient (H) |
| Rundenübergang | §5.33; G2 | `transitionRoundState` W `geo:1140`, J `engine:658,705,747`, WID `engine:199` | W, J, WID | atomar mit Resets | Event + State | — | `roundTransition.test`, `g2Runtime` | R | ja (3) |
| Score-Ledger | §5.8; G4 | `recordScoreMutation` W `geo:1034`, J `engine:427,578`, WID `engine:162` | W, J, WID | Ledger = Score = Cache | `ScoreEvent` | — | `g4Protection` („one evidence“ ×3) | R | ja (3) |
| Ergebnis/Rang/Gleichstand | §5.9/§5.35; G4 | `rankScores`, `buildEngineGameResult` (`core/resultBuilders.ts`) | W, J, WID | Lese-Recht, Revision | `GameResultRecord/Version` | keine Lösungen im Ergebnis | `g4Protection`, `results.integration` | R | ja (3). Tie: `resolveTie` nur W/J, **nur ALLOW_TIE**, andere Strategien S |
| Korrektur/Amendment/Rollback | §5.30/§5.31; G4 | `resultCommands.ts` | W, J, WID | `SCORE_ADJUST`, Referenz, Partiebindung | Version mit Historie | — | `g4Protection` (C), `g4Restart` | R | ja (3) |
| Recovery-Evidenz | §5.21; G2/G4 | `ensureGameStateSafe`, `recoveryCommands.ts` | W, J, WID | nur Host mit `GAME_PAUSE` | Replay bis exakte Vorversion, Ledger-Abgleich | keine Secret-Neuausgabe | `results.integration` (stale tail, fehlende Evidenz, spätere Spieler, **G5: Ledger-Abweichung, fremder Run**), `weristdas/recovery.integration` | R | ja (3) |
| Invarianten | §5.29 | `checkGameInvariants` | W, J, WID | Verletzung → ERROR_RECOVERY | — | — | `invariants.test` | R | ja (3) |
| Aktionslimits + Intentclient | §5.26; G4 | `actionLimits`, `requestAdmission`, `createCommandIntentClient` | W, J, WID | früh vor DB/Receipt | Budget nicht persistiert (bewusst) | Logs bereinigt | `g4Protection` (**G5: Limiter-Uhr in `exhaust()`**), `commandIntentClient.test` | R | ja (3) |
| Verfügbare Aktionen (Server) + Core-Read | §5.32 | `projectCoreRuntime`, `game:core:read` | W, J, WID | je Rolle/Phase | — | rollenabhängig | **G5: `g4Protection` „exhausted core read“ ×3** | R | ja (3) |

## 2. Raum-, Medien- und Bedienungsbausteine (engineübergreifend, kein Engine-Verbraucher im DoD-Sinn)

| Baustein | Quelle | Aufrufer / Pfad | Nachweis | Stufe | Grenze |
| --- | --- | --- | --- | --- | --- |
| Admission-Isolation PENDING_JOIN/WAITLIST | §4.12/4.13; PR15–19 | `roomChannel`-Mitgliedschaft (`access.ts`), Medien `admission: ACTIVE` | **G5** `g4Protection` „PENDING_JOIN and a WAITLIST…“ ×3; `team-room.integration` | R | HTTP-Ergebnislesen für Wartende: im Probe-Set enthalten (`game:result:read`), HTTP-Route selbst durch `results.integration` (Zugriffspolitik) |
| Gemeinsame Viewer-Kapazität | PR15–19 | `activeViewerCount` unter Raumsperre | `team-room.integration` (Token-Rejoin, letzter Slot, Übernahme) | R | anonyme Viewer ohne Wiederaufnahme |
| DISPLAY | §2.1/§7 | `DisplaySession` | `media/live.integration` „true DISPLAY sessions…“, E2E M5 | R | — |
| Medien: Routen, Rechte, Neustart beidseitig | §7; PR15–19 | `media/live.ts` `media:restart` | E2E M4 (Empfänger), **G5 M4b (Sender, inbound-rtp)**, `media/live.integration` | R | lokal; keine externen NATs, kein STUN/TURN |
| 0 Punkte | PR15–19 | Ranking/UI | `g4Protection` „nobody scored“ (W, WID), TEAM_SCORE (J: 0 als Rang-3-Wert), **G5 `ResultScreen.test`** | R | J 0:0 regulär nicht erreichbar (Feld endet nur per Buzz+Urteil); Legacy-`ResultPage.tsx` unverändert (`p.score \|\| 0`) |
| Gemeinsame Core-Read-Bedienung | Auftrag §9 | `useGameCore` → ModeratorGame, Player, JeopardyModerator, JeopardyPlayer, WerIstDas; RoomPanel | **G5:** `useGameCore.test` (6), `GeoRecovery.test` (Host-Seite), `RoomPanel.test` | R | Spieler-/Jeopardy-/WID-Seite nutzen dieselbe Komponente, jeweils nur über den Hook-Test belegt |
| Kleiner Bildschirm, Namen, Read-Last | Auftrag §9/§10 | Browser 360 px | **G5 E2E G5-B1** | R (Wissensduell) | Jeopardy/WID nicht auf 360 px im Browser geprüft |

## 3. Pflichtfälle Master §5.28 je Engine (Zuordnung)

| Fall | W | J | WID |
| --- | --- | --- | --- |
| Start | Contract, `g2Runtime` | Contract, `jeopardy/socket-flow` | Contract (G5), `weristdas/socket-flow` |
| komplette Runde | `g2Runtime`, E2E geo | `socket-flow`, E2E J1–J10 | `socket-flow` („plays both rounds“), E2E weristdas |
| GAME_END | `g4Protection` | `g4Protection`, `socket-flow` | `g4Protection`, `socket-flow` |
| Rejoin / Resync | `g2Runtime`, `geo/resync` | `socket-flow` | `weristdas/resync`, `socket-flow` („reload“) |
| Pause/Resume | `g2Runtime`, `g2Restart` | `g2Runtime` | `g2Runtime` (Pausenadapter) |
| ungültige Commands | `commandBoundary.integration` | dito | dito |
| Duplicate Commands | Contract 2, `g4Restart` | Contract 2 | Contract 2 (G5) |
| Recovery | `g2Restart`, `results.integration` | `results.integration` | `weristdas/recovery.integration` |
| Secrets/Visibility | `g3Submission`, `g4Protection` | `g4Protection` | `g4Protection`, `socket-flow` |

## 4. Abschlussliste (pro Teilumfang, keine pauschale Aussage)

- **Zwei-Engines-Kriterium erfüllt (bei weiteren DoD-Punkten nach Master §13.2 bleibt das Urteil beim Nutzer):** Command-Hülle, Event/State-Version, Config/Version, Countdown/Pause-Timer (W, J), Buzzer (J, WID), Einzel-Antwortbesitzer (J, WID), `submitOnce` (W, J), Rundenübergang (3), Score-Ledger (3), Ergebnis/Korrektur (3), Recovery (3), Invarianten (3), Judge/Punktelogik (W, J).
- **Nur eine Engine / nur H:** EXACT (W), MANUAL_ONLY (J), `lockSubmission` (W), Auswahlabgabe als Eingabeformat (W), NORMALIZED/SYNONYM/FUZZY (H), `extendTimer`/Count-up (H), PARTIAL/CANCELLED (H), weitere Tie-Strategien (H/S), Mehrspieler-Turnzyklus (S).
- **O/S:** Rollen-/Voting-/Leben-Core, Song-Clip-Zeitplan, Event/Olympia, Würfel-/Brett-/Bietmechaniken, numerische/Mehrfeld-/Sortierabgaben.
- **Offene DEC-Punkte:** Tie-Strategien außer ALLOW_TIE (unverändert); keine neuen.
- **Keine Aussage** „alle Mechaniken fertig“ und keine Prozentwerte.
