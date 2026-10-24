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

## Aktuelle lokale Folgeänderung

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

## Exakte Fortsetzung

1. Tie-/CI-/Sitzungs-Fix per geprüftem Fast-Forward sichern. Keine zweiten
   Serversuiten gleichzeitig auf /tmp/quiz-server-test.db starten.
2. Aktuelle GitHub-CI und vollständige E2E am neuen Head prüfen. Lokaler
   Chromium fehlt; bisher war GitHub die verbindliche Browserabnahme.
3. Punkt 2 vervollständigen: Host-Overrides als echte autorisierte Commands
   mit Receipt, persistiertem Audit/Event und UI; Team-Buzzer-Snapshot/
   Teamsperren in echten Engines; restliche Turn-/Submission-/Timer-Controls
   und gemeinsame Rundenübergaben nach Master §5.33. Keine bloßen Typen/
   Helfer als vollständigen Core-Abschluss ausgeben.
4. Erst nach Punkt-2-Abnahme Punkt 3 (Results/Review/FINALIZED, Ledger-
   Korrekturen/Amendments und Recovery) auf eigener Folgebranch beginnen.
   Frühe echte Consumer: Jeopardy + Wer ist das?. Danach Content/Editor
   (Punkt 4), Audio/Voice/Kamera/Display und weitere Engines (Punkt 5).
