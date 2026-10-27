# GAME-CORE — aktueller Handoff, 24.10.2026

## Auftrag / Arbeitsweise

Die fünf Nutzerpunkte nacheinander umsetzen und regelmäßig auf GitHub sichern.
Punkt 1 ist abgeschlossen; Punkt 2 bleibt in Arbeit. Punkte 3–5 sind noch offen.
Keine PR selbst mergen. Nutzer hat den Push ausdrücklich bestätigt und die
Fortsetzung autorisiert; frühere Freigabe-Blocker sind historisch und erfordern
keine erneute Rückfrage.

Der lokale Git-Client hat keine Anmeldung. Änderungen über den verbundenen
GitHub-Zugang übertragen: Git-Baum exakt gegen lokalen Commit prüfen und
Branch nur per Fast-Forward mit erwartetem Remote-Head aktualisieren. Lokale
Originalcommits auf Checkpoint-Branches erhalten. Nach API-Übertragung
anonym fetchen und die Arbeitsbranch auf dem neuen Remote-Commit fortsetzen.
Commit-IDs unterscheiden sich dabei, Dateibäume sind identisch.

## Letzte gesicherte Stände

| Remote | Identischer lokaler Commit | Nachweis |
|---|---|---|
| f26e8fb, PR15 | f26e8fb | Punkt 1: 386 Server-/83 Web-/20 Browsertests, CI/E2E grün, Run 40104459714 |
| 4d637b7, PR16 | 4d637b7 | erste gemeinsame Runtime-/Aktionsregeln, CI/E2E grün, Run 40106514606 |
| 3b0f302 | d98e2bc | Runden-/Turn-/Matching-/Zufallsregeln |
| 298e97f | 710697e | Visibility/Invariants, 405 Server-/85 Webtests; CI/E2E grün, Run 40115586491 |
| cc66952 | 4535d2c | Event-Persistenz und Buzzer-Zustände, 408 Server-/85 Webtests; CI/E2E grün, Run 40117073536 |
| a7e4c41 | b59365f | realer Engine-Vertrag, lokal 411 Server-/85 Webtests; CI Run 40118255452 an SQLite-Sperren gescheitert |
| 53896ad | d5364d8 | Tie-/Scheduler-/Sitzungs-Fix, 416 Server-/85 Webtests, CI und E2E grün, Run 40119533680 |
| b052a44 | f5c3636 | echte Host-Buzzer-Korrektur und UI, 419 Server-/85 Webtests, CI/E2E grün, Run 40120123179 |
| b53c972 | c7c2e57 | echte Team-Buzzer, 421 Server-/85 Webtests, CI/E2E grün, Run 40121033591 |

Gestapelte Merge-Reihenfolge: #15 vor #16. Nach #15-Merge Base auf main
umstellen und erneut prüfen. PR16 bleibt Draft, bis der gesamte Umfang
nachgewiesen ist. Kein Merge ist erfolgt.

## Tatsächlich angebunden

- Gemeinsame Timer (Countdown/Count-up/unbegrenzt), Submission, Judge,
  Matching, Turn-/Rundengrenzen, Serverzufall und Competition-Ränge.
  Wissensduell/Jeopardy nutzen die Primitiven tatsächlich. Alte persistierte
  Timer/Submissions werden explizit kompatibel gelesen, nicht erfunden.
- Serverseitig erlaubte Aktionen prüfen dieselben Bedingungen wie echte
  Mutationen; Receipts replayen vor späteren Phasengates. Der Engine-Slug
  wird serverseitig gebunden. Fremde Spielaktionen bleiben WRONG_GAME.
- Gemeinsamer Visibility-Core (HOST_PRIVATE/PLAYER_PRIVATE/TEAM_PRIVATE/
  PUBLIC) und explizite Projektionen. Administration gibt keinen Zugriff
  auf persönliche Antworten. Jeopardy und Wissensduell benutzen Feldlisten;
  WID signiert verweigerte Originalbilder nicht. Viewer erhalten nur Public.
- Die drei realen State-Writer, Untimed-Pause und Recovery prüfen Invariants.
  Beschädigte bekannte States werden per CAS in ERROR_RECOVERY angehalten;
  Originalzustand bleibt serverseitig. Es werden weder neue Punkte noch
  neue Zufallsentscheidungen erzeugt. Unbekannte Engine-Versionen werden
  nicht umgedeutet. Die Runtime-Projektion zeigt sichere Recovery-Metadaten.
- Additive Migration 20261024180000_game_domain_events. Event und daraus
  materialisierter Zustand teilen eine Transaktion mit CAS/Score-Writes.
  DB-Trigger verbietet Event-Updates. SDK-Replay hat keine Uhr/Random-/DB-/
  Socket-/Score-Effekte; fremde Runs und Versionssprünge werden abgelehnt.
  Legacy-Spiele bekommen explizite Checkpoints statt fiktiver Vergangenheit.
  Fehlgeschlagene, noch nicht akzeptierte Starts rollen eigene Initial-
  Events zurück. migrate-deploy plus spielbare v1/v2-Bestandsräume geprüft.
- Buzzer-Zustände CLOSED/OPEN/LOCKED/RESOLVED, SERVER_ARRIVAL, Teilnehmer-
  Auswahl und Zeitstempel werden in Jeopardy/WID gespeichert. Das reine
  Core-API kann TEAM, Teamsperre, Reopen/Reset und protokollierte Gewinner-
  Korrektur. Die vollständige Team-/Host-Command-Anbindung ist noch offen.
- Der SDK-GameEngineContract wird von Start/Preflight/Befehlen/Resync aller
  drei Engines benutzt; Setup-/Content-Schemas, validateCommand,
  handleCommand, applyEvent und rollenabhängige createProjection sind real
  implementiert. Result-Builder sind funktional, aber noch nicht historisch
  persistiert/finalisiert (das ist Punkt 3). Legacy-WID behält engineVersion=1.
- WID verwendet gemeinsame availableActions/Progress/Controls. Ein normaler
  PLAYER darf buzzern, aber mit dem Basisrecht BUZZER_CONTROL nicht den
  Buzzer öffnen. Host und ausdrücklich delegierte Co-Hosts behalten Controls.
  Bestehende Wire-Codes, besonders WID PLAYER_EXCLUDED, sind erhalten.

## Tie-Regel und CI-Fix (gesichert mit 53896ad)

Tie-Core mit ALLOW_TIE, SUDDEN_DEATH, TIEBREAKER_QUESTION, SECONDARY_METRIC
und HOST_DECIDES. Nicht aufgelöste Varianten bleiben PENDING ohne zufälligen
Gewinner. Bestehende Engines unterstützen bewusst nur ihr bisheriges
ALLOW_TIE: vor Start im Config-/State-Snapshot festgeschrieben, danach
LOCKED_AFTER_START. Wissensduell und Jeopardy benutzen den Core tatsächlich
beim Spielende. Fehlende Legacy-Felder bewahren die historische ALLOW_TIE-
Semantik; ungültige/null-Werte werden nicht als Default umgedeutet.
Reale Socketfälle prüfen gemeinsame Gewinner, unveränderten Start-Snapshot
und die Ablehnung nicht unterstützter bzw. nachträglich geänderter Regeln.

GitHub-CI für a7e4c41: Typecheck/Lint/Build erfolgreich, Serversuite durch
konkurrierende Testsuiten auf derselben SQLite-Testdatei in P1008/Socket-
Timeouts gelaufen (39 Tests wegen fehlgeschlagenem Setup nicht ausgeführt).
Nicht als grün melden oder Pflichtfälle überspringen. vitest.config.ts
setzt nun fileParallelism=false. Alle Tests bleiben aktiv; die echten
Parallelaktionen innerhalb der Multiplayer-Tests bleiben unverändert.
Die serielle Ausführung deckte zusätzlich abgelaufene, zufällig ausgewählte
Test-Sitzungen auf: fünf betroffene Suiten benutzen nun ihre jeweils selbst
angelegte Host-Sitzung, statt irgendeine Sitzung von mod-1 auszuwählen.

Lokal nach Scheduler-/Sitzungs-Korrektur: 416/416 Server-Tests (49 Dateien),
111,79 Sekunden, 85/85 Webtests, Typecheck/Build/Lint ohne Fehler grün.
Lint hat weiterhin 115 Warnungen. Dokuchecker und diff --check grün.

## Host-Buzzer-Korrektur (gesichert mit b052a44)

`game:buzzer:override` für Jeopardy (Haupt-/Steal-Buzzer) und Wer ist das?.
Nur Host bzw. ausdrücklich delegierte BUZZER_CONTROL-Verwaltung; normale
Spieler besitzen diese Verwaltungsbefugnis nicht. Neue Commands benötigen
commandId sowie gameStateVersion und runIndex. gameStateVersion ist die
Engine-CAS-Version; das alte Envelope-stateVersion bezeichnet weiterhin die
Room-Revision und wird nicht still umgedeutet. Alte Runs/Versionen werden
abgelehnt, ein Receipt-Replay derselben Absicht erzeugt keine zweite Wirkung.

Nur der noch nicht bewertete Gewinner ist korrigierbar. Buzzer, Antwortzug,
Jeopardy-Submission (alte CANCELLED, neue SUBMITTED), unveränderlicher
State-Event, AuditLog und RoomFeed teilen dieselbe Transaktion. Keine
Punktänderung durch die Korrektur. Eine anschließende Bewertung punktet
exakt einmal für den korrigierten Gewinner. Beim Steal bleibt der erste
Responder ausgeschlossen; mehrfache Korrektur zurück zu einer zuvor
abgebrochenen Antwort ist möglich, ohne alte Score-Events zu verändern.

Beide Moderationsansichten haben dieselbe Auswahl mit optionalem Grund.
Clients laden ihre eigene Rollenprojektion nach; Grund/Audit/Secrets werden
nicht in einen allgemeinen Spiel-Snapshot übernommen. Die neuen UI-Flows
sind den bestehenden Jeopardy-J4- und WID-Browsertests hinzugefügt.

Gezielte echte Socketfälle: 10/10 grün, inklusive Rechteentzug, Viewer/
Player-Denial, fremdem Teilnehmer, altem Run/State, fehlendem commandId,
Replay, keine vorzeitigen Lösungen, Steal-Sperre, doppelter Bewertung und
Event-Replay-Gleichheit. Vollständige Serversuite: 419/419 grün (49 Dateien,
89,65 Sekunden). Der Socket-Adapter führt auch die Korrektur über den realen
Engine-Vertrag aus.
85/85 Webtests, Typecheck/Build/Lint lokal grün (115 bestehende Warnungen).

## Team-Buzzer (gesichert mit b53c972)

Jeopardy und WID pinnen beim ersten Öffnen die aktuelle aktive Runde als
SELECTED- bzw. TEAM-Buzzer. Keine neue Zufallsauswahl. Team-Zuordnung und
zulässige Teilnehmer bleiben über Wrong/Reopen/Rejoin/Recovery gleich.
Falsche Antwort sperrt im Team-Modus das gesamte ursprüngliche Team;
Jeopardy-Steal übernimmt dieselbe Teamkarte und die Sperren. Beim nächsten
Feld bzw. der nächsten Runde werden sie zurückgesetzt und die dann gültigen
Teams geladen. Die echte room:command-Grenze erlaubt Team-Neuzuordnung
nach Abschluss, sperrt aber WID ROUND_READY nach falscher Antwort als noch
laufende Runde (auch anhand von Legacy-Ausschlüssen).

Jeopardy-Player verwenden jetzt ebenfalls availableActions; Projektion/
Resync übergeben die vollständige Steal-Sperrliste, damit Teammitglieder
keine scheinbar zulässigen Buzzer-Buttons bekommen. Host-Korrekturen
verwenden diese Liste ebenfalls. Optionaler Korrekturgrund ist in Wire/UI
auf dieselben 300 Zeichen wie das persistierte Schema begrenzt.

12/12 echte Runtime-Socketfälle lokal grün; neue Fälle spielen beide Engines
mit 4 Teilnehmern und 2 Teams, falscher Antwort, Rejoin, gesperrtem Team,
verbotener Neuzuordnung, erlaubter Neuzuordnung an der Grenze und neuem
Roster in der Folgerunde. Der volle 421er-Lauf fand noch einen Legacy-Fehler:
WID v1 ohne eligiblePlayerIds verlor beim ersten Öffnen alte Ausschlüsse.
Der Adapter übernimmt sie nun ausdrücklich; Migration/Neustart/Runtime
bestehen 18/18. Anschließend kompletter Serverlauf 421/421 grün (49 Dateien,
99,19 Sekunden), Web85, Typecheck/Build/Lint0 Fehler (115 bestehende Warnungen).

## Aktuelle lokale Folgeänderung: Lifecycle / Round-Transition

Gemeinsame CoreGamePhase und getLifecyclePhase im realen SDK-Vertrag aller
Engines; Runtime-Projektion enthält corePhase zusätzlich zur Unterphase.
Kein zweites konkurrierendes Phase-Feld in der Datenbank. WID ROUND_READY
nach falscher Antwort ist ROUND_ACTIVE, vor dem ersten Öffnen ROUND_PREPARE.
Pause/Recovery/Spielende bleiben explizit. Alte gespeicherte States brauchen
keine erfundenen Felder.

Alle drei Engines verwenden transitionRoundState bei normalen Runden-/
Boardwechseln und beim regulären Ende. Der Guard verlangt ROUND_END,
zulässige Folgephase und unveränderte Scores. Gemeinsame Runtime-Resets
löschen aktuelle Buzzer/Turn/Submission/Timer; historische Daten bleiben in
Events bzw. Geo-Rundenstates. lastRoundTransition speichert Abschluss-ID
und ROUND_END → ROUND_TRANSITION → ROUND_PREPARE/GAME_END atomar im
State-Event. Ein ACK-Verlust kann keinen zweiten Rundeneffekt erzeugen.

Lokale Abnahme: voller Serverlauf 423/423 (50 Dateien, 95,95 Sekunden),
Web85, Typecheck/Build/Lint0 Fehler (115 bestehende Warnungen), Dokuchecker
und diff --check grün. 48 gezielte Fälle grün. Terminal-Assertions für Geo wurden anschließend im vollständigen
Runtime-Test erneut geprüft: 12/12 grün.
Abnahmetabelle: docs/implementation/pr16/acceptance.md.

## Exakte Fortsetzung

1. Lifecycle-Folge baumidentisch pushen und vollständige GitHub-CI/E2E am
   neuen Head abnehmen. Bis dahin Punkt 2 nicht als abgeschlossen ausgeben.
   Nie zwei Serversuiten gleichzeitig auf /tmp/quiz-server-test.db starten.
2. Nach grüner Abnahme Punkt 2 in der Roadmap abschließen. Dann Punkt 3:
   Results/Review/FINALIZED, Ledger-Korrekturen/Amendments und Recovery auf
   einer isolierten Folgebranch. Kein Merge durch den Agenten.
3. Danach Punkt 4 Content/Editor und Punkt 5 Medien/Display/neue Spiele.
