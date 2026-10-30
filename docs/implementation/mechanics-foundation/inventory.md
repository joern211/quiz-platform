# Mechanik-Bestand am Beginn des Grundlagenblocks

Basis: `75013448ebf7065daad4b64a90ce568c85d11d3b`, gelesen am 30.10.2026.
Statusdefinitionen und Abschlusskriterien: [Plan](plan.md).
Dies ist ein Code-/Dokumentationsabgleich; heute wurden dafür keine Laufzeit-Tests
wiederholt. Vorhandene Testdateien belegen den vorgesehenen Prüfumfang, nicht einen
neuen erfolgreichen Testlauf. Frühere Vollabnahme des Basis-Heads:
[main CI/E2E](https://github.com/joern211/quiz-platform/actions/runs/40602098082).

## 1. Gemeinsamer Kern: nachgewiesener Teilumfang und Grenze

Codepfade unter `apps/server/src/`, sofern nicht anders angegeben.

| Mechanik | Stand | Code / echte Verbraucher | Konkrete Restgrenze und Paket |
| --- | --- | --- | --- |
| Engine-/Command-Vertrag | R | `games/core/engineContract.ts`, `commandContext.ts`, `receiptedAction.ts`; alle drei Engines | Adapter und Aktionslisten sind ausdrücklich auf drei Slugs zugeschnitten; kein bereits universeller Engine-Dispatcher. G1. |
| Berechtigungen / verfügbare Aktionen | R | `games/core/access.ts`, `permissions.ts`, `actionRules.ts`, `actions.ts`; drei Engines | Jeden realen Einstieg mit UI/Mutation/Information abgleichen. Neue Aktionen erben nicht automatisch alle Guards. G1. |
| Receipt / CAS / Domain-Event | R | `games/core/commands.ts`, `commandExecution.ts`, `state.ts`, `events.ts`; drei Engines | Expliziter Legacy-Pfad ohne Absichtstoken bleibt dokumentiert. Ein GameEvent ist keine EventSeries/Turnierfunktion. G1/G4. |
| Lifecycle / Konfigurationssnapshot | R | `games/core/lifecycle.ts`, `config.ts`; drei Engines | Zulässige Werte sind enginespezifisch. Eine Typvariante ist noch keine auswählbare Option. G1/G2. |
| Countdown / Pause / Wiederaufnahme | R | `games/core/runtimePrimitives.ts`, `games/geo/index.ts`, `rooms/pause.ts` | Wissensduell hat Countdown, Jeopardy unbegrenzte Antwortzeit, WID einen untimed Pause-Snapshot. G2. |
| Count-up / Timer verlängern oder kürzen | H | `createTimer`, `extendTimer`, `runtimePrimitives.test.ts` | Keine entsprechende vollständige gemeinsame Host-Bedienung in zwei Engines nachgewiesen. Nur bei passendem Bedarf integrieren; sonst H/S. G2. |
| Einzel-/Team-Buzzer / Override | R | `games/core/buzzer.ts`, `buzzerRoster.ts`, `buzzerOverride.ts`; Jeopardy und WID | Roster, Team-Sperre und Gewinner werden persistiert; weitere Regeln nicht aus neuen Spielen vorwegnehmen. G2/G5. |
| Antwortzug / allgemeiner Turn-Zyklus | R/H | `roundFlow.ts`; Jeopardy und WID verwenden `createTurn([winner])` | Einzelner Antwortbesitzer ist kein vollständiger Mehrspieler-Umlauf. `advanceTurn`, RANDOM und ROTATING_START sind separat getestet. G2, spätere Turn-Spiele. |
| Serverzufall | R | `shuffleServer`, gespeicherte Engine-/Contentauswahl | Kein neuer Client-Zufall, kein Neu-Auslosen beim Rejoin. Würfeln und Behalten sind noch kein gemeinsamer Runtime-Vertrag. G2/S. |
| Abgabe / Lock / Judge | R/H | `runtimePrimitives.ts`; Auswahlantwort in Wissensduell, manuelle Submission in Jeopardy | `SubmissionRecord.value` ist String/null; Entwurf/Mehrfeld-/Zahlen-/Sortierablauf dadurch nicht vollständig vorhanden. G3. |
| EXACT / manuelle Prüfung | R | `matchAnswer`; Wissensduell EXACT, Jeopardy MANUAL_ONLY | Keine automatische verbale Antwort erfinden. G3. |
| Normalisierung / Synonyme / Fuzzy | H | `roundFlow.ts`, `roundFlow.test.ts` | Fuzzy gibt NEEDS_JUDGE; kein belegter durchgängiger Editor-/Command-/UI-Consumer für alle Modi. G3/S. |
| Bewertung / Teilpunkte | R | `scoreJudgement`; drei Engines, WID mit PARTIAL | Jeopardy-Judge-Payload bleibt boolesch; PARTIAL dort nicht allein wegen Core-Unterstützung anbieten. G3/G4. |
| Rollenprojektion / Reveal / Secrets | R | drei Projektionen, `core/visibility.ts`, `content/blindHost.ts` | BLIND_HOST ist vorhanden; geheime Social-Deduction-Rollen sind damit noch kein fertiges Spielsystem. G3/G5/S. |
| Gleichstand / Rang | R/H | `core/tie.ts`, `rankScores`; Wissensduell/Jeopardy mit ALLOW_TIE | Andere Strategien können PENDING liefern; `config.ts`/Invariants begrenzen aktuelle Spiele auf ALLOW_TIE. G4/S. |
| Rundenübergang | R | `roundTransition.ts`; alle drei Engines | Gemeinsamer Guard, Punkte unverändert, frische Laufzeitwerte. Verbraucherabhängige nächste Inhalte bleiben bei der Engine. G2/G5. |
| Persistenz / Version / Replay / Recovery | R | `core/state.ts`, `events.ts`, `recovery.ts`, `recoveryCommands.ts`; drei Engines | Neue States brauchen eigene Invariants/Projektionen. Unbekannte Slugs sind nicht automatisch vollständig abgesichert. G1/G4/G5. |
| Score-Ledger / Resultate / Finalisierung | R | `core/score.ts`, `resultBuilders.ts`, `results.ts`, `resultCommands.ts`; drei Engines | Keine parallele Punktepersistenz einführen. G4. |
| Korrektur / Rücknahme | R, begrenzt | `resultCommands.ts`, `buzzerOverride.ts` | Ergebnis-Gegenbuchung/Gewinnerkorrektur sind kein allgemeines Undo jeder Spielaktion oder eines Reveals. G4. |
| Progress / Leaderboard / Result-UI | R | `core/actions.ts`, `core/results.ts`, `apps/web/src/components/ResultScreen.tsx` | Laufzeitfortschritt wird pro Engine berechnet; gleiche UI nicht mit identischen Spielregeln verwechseln. G5. |
| Fehler / Fallback / Benachrichtigung | R, begrenzt | `core/appError.ts`, `core/errors.ts`, Raumfeed, `RecoveryControl.tsx` | Kein allgemeiner ausgeführter Fallback für alle zukünftigen Fehlerarten. Keine globale Notification-DoD aus einzelnen Toasts ableiten. G1/G4/G5. |
| Rate-Limits / Messwerte | R/O, je Pfad | HTTP-Limits und `media/live.ts` vorhanden; `observability/logger.ts` vorhanden | Kein durchgängiger gemeinsamer Spiel-Socket-Limiter/Metrics-Core im gelesenen Kern belegt. G4 prüft konkret; keine globale Überwachungsplattform. |
| Invariants / Test-Contract | R, drei Engines | `core/invariants.ts`, Contract-/Runtime-/Recoverytests | Zehn Pflichtfälle je neuer Engine und zwei Verbraucher je fertigem Core bleiben spätere Nachweise, wo Verbraucher fehlen. G1/G5. |
| Content / Review / feste Auswahl | R | `content/*`, `http/content.ts`; Wissensduell/Jeopardy | Bestehende Auswahl/Revision/Medienrechte wiederverwenden; neues Eingabeformat braucht passendes Content-Schema. G3/S. |
| Medienjobs / Voice / Kamera / Display | R | `media/jobs.ts`, `live.ts`, `display.ts`, `LiveMediaPanel.tsx` | Geräte-/Transportbasis vorhanden. Serverseitig terminierter Song-Clip mit Rejoin-Seek ist damit nicht belegt. S. |

## 2. Bedarfszuordnung aller 19 dokumentierten Spiele

Die folgenden Einträge sind Bedarfe aus den verlinkten Specs, keine neue
Implementierungs- oder Freigabezusage. Ein DEC-Eintrag blockiert die betreffende
fachliche Regel; er blockiert nicht alle unabhängigen Grundlagenarbeiten.

| Spiel / Quelle | Wiederverwendbarer Bedarf | Spielbezogen / spätere Entscheidung |
| --- | --- | --- |
| [Wissensduell](../../specs/pr12/games/wissensduell.md) | Countdown, Auswahlabgabe, Auto-Judge, Reveal, Score | Vorhandener Verbraucher; zusätzliche Buzzer-/Jokerregeln nicht still erweitern. |
| [Jeopardy](../../specs/pr12/games/jeopardy.md) | Buzzer, Antwortbesitzer, manuelle Bewertung, Steal, Resultate | Boards, Feldwerte und bestehende Bewertungsregeln bleiben Engine-Inhalt. |
| [Wer ist das?](../../specs/pr12/games/wer-ist-das.md) | Buzzer, Teilpunkte, Bild-/Reveal-Grenzen, Pause, Resultate | Personen-/Hinweisablauf bleibt Engine-Inhalt. |
| [Imposter](../../specs/pr12/games/imposter.md) | Private Abgabe, anonyme Optionen, Abstimmung | DEC-SPI-01; feste Punkte je Stimme werden durch Vote-Ties nicht aufgehoben. |
| [Erkenne den Song](../../specs/pr12/games/song-quiz.md) | Audio-Zeitplan, Buzzer, manuelle/teilweise Bewertung | DEC-SNG-01; Clip-Verfügbarkeit und Metadatenprojektion vor Implementierung präzisieren. |
| [Last Man Standing](../../specs/pr12/games/last-man-standing.md) | Mehrspieler-Turn, Matching, Leben, Ausscheiden | DEC-LMS-01; Timeout/Disconnect und Ende dürfen nicht aus einer allgemeinen Lebenszahl folgen. |
| [Higher or Lower](../../specs/pr12/games/higher-lower.md) | Binäre Abgabe, Zahlenvergleich, Serienwertung | DEC-HOL-01; Wertung, Gleichheit und Datenmodell bleiben explizit. |
| [Timeline](../../specs/pr12/games/timeline.md) | Reihenfolge-Abgabe, Teilbewertung, Reveal | DEC-TIM-01; konkrete Formel und Toleranz von gleichen Zeitpunkten. |
| [Wie weit gehst du?](../../specs/pr12/games/partner-challenge.md) | Teamrollen, Bieten, Aufgabenzeit und Bewertung | DEC-PCH-01 betrifft Viewer-Aufgabensicht; feste Biet-/Endregeln nicht neu erfinden. |
| [Stadt, Land, Fluss](../../specs/pr12/games/stadt-land-fluss.md) | Mehrfeldabgabe, Frist-Lock, Matching, Duplikate | DEC-SLF-01; Kategorien und Punkte je gültiger/gleicher Antwort. |
| [Gleicher Gedanke](../../specs/pr12/games/same-thought.md) | Private Partnerabgaben, Paarzuordnung, Matching | DEC-SAM-01; Paarwechsel, Nichtabgabe und Vergleichswertung. |
| [Schätz mal](../../specs/pr12/games/schaetz-mal.md) | Zahlenabgabe, Einheiten, Vergleich und Rang | DEC-SCH-01; Nähe-/Toleranzformel nicht aus einem String-Matcher ableiten. |
| [Millionenfrage](../../specs/pr12/games/millionenfrage.md) | Auswahlabgabe, Timer, Joker, sichere Zwischenwerte | DEC-MIL-01; Leiter, Banken und Punktetabelle bleiben bei der Engine. |
| [Wahr oder Fake?](../../specs/pr12/games/wahr-oder-fake.md) | Binäre Abgabe, Reveal, Serienwertung | DEC-WOF-01; Quellen, Teamaggregation und Bonuswerte. |
| [Undercover](../../specs/pr12/games/undercover.md) | Geheime Rollen, Hinweise, Turn, Vote, Ausscheiden | DEC-UND-01; Rollen-/Tie-/Siegregeln. |
| [Raus damit!](../../specs/pr12/games/board-race.md) | Persistierter Würfelwurf, Turn, öffentlicher Figurenstand | DEC-BRD-01; Brett, Figuren, Schlagen und Heimfeld bleiben Spielregeln. |
| [Geheim Agent](../../specs/pr12/games/secret-agent.md) | Geheime Rollen, Hinweise, Vote, optionale Voice | DEC-AGT-01; eigenes Spiel mit eigenen Siegbedingungen. |
| [Yacht](../../specs/pr12/games/yacht.md) | Persistierte Würfel, Behalten, Turn, Scorecard-Commit | DEC-YAC-01; Kombinationen/Bonus-/QUICK-Regeln spielbezogen, AVERAGE_SCORE ausdrücklich später. |
| [Der Dümmste Fliegt](../../specs/pr12/games/der-duemmste-fliegt-vorschlag.md) | Private Abgaben, Judge, ggf. Vote, Ausscheiden | DEC-DDF-01…06; Aufnahme gewünscht, konkrete Mechanik weiterhin Vorschlag. Kein Manifest-/Engine-Eintrag durch diesen Plan. |

## 3. Rückverfolgung bei Umsetzung

Jede geänderte Mechanik erhält im zugehörigen PR genau diese Nachweise:
Anforderungsstelle und freigegebene Regel; Codepfad; echte Verbraucher;
Rechte/Phase; persistierte Daten und Ereignis; Rejoin/Recovery; Fehlerfall;
gezielter Test und finaler CI-Head. Offene Verbraucher-/Entscheidungspunkte
bleiben mit G-/DEC-Verweis sichtbar. Diese Bestandsaufnahme wird bei Änderungen
fortgeschrieben; historische PR12-Zeilen werden nicht pauschal auf DONE gesetzt.
