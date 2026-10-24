# Punkt 2 — GAME-CORE Runtime-Abnahme

Stand: 24.10.2026. PR16 bleibt gestapelt auf PR15 und wird nicht durch den
Agenten gemergt. Abschluss erst nach grüner CI und E2E am letzten Commit.

## Vereinbarter Umfang

Gemeinsamer GameEngineContract, Lifecycle und Spielaktionen für die realen
Engines Wissensduell und Jeopardy; Wer ist das? nutzt dieselben Ports ebenfalls.
Ergebnisprüfung, Ergebnis-Persistenz/FINALIZED und nachträgliche Punkte-
Korrekturen sind ausdrücklich Punkt 3. Content-Editor/Review ist Punkt 4.

| Baustein | Reale Verwendung / Nachweis |
|---|---|
| Engine-Vertrag | Registry, Initialisierung/Preflight, Befehlsprüfung und Ausführung, Rollenprojektion/Resync in drei Engines. Setup-/Content-Schemas und versionierte Replay-/Result-Builder vorhanden. |
| Gemeinsamer Lifecycle | `getLifecyclePhase` im SDK-Vertrag und `corePhase` in der Runtime-Projektion. Engine-Unterphasen bleiben erhalten; PAUSED/ERROR_RECOVERY werden sicher abgebildet. WID-Reopen ist weiterhin ROUND_ACTIVE. |
| Timer | Wissensduell: persistierter Countdown, Pause/Resume/Expiry und Neustart. Jeopardy: persistierte unbegrenzte Antwortzeit. Count-up und positive/negative Zeitänderungen als geprüfte Core-Primitiven; keine zusätzlichen, nicht implementierten Engine-Controls beworben. |
| Buzzer / Teams | Jeopardy und WID: Servereingang, CAS, ausgewählter Roster, Teamkarte pro Runde, Team-Sperre, Reopen, Reset und stabiles Rejoin. Neue Teamkarte erst zur Folgerunde. Legacy-Ausschlüsse bleiben erhalten. |
| Host-Korrektur | Reale UI und Commands für beide Buzzer-Engines, wirksame Verwaltungsrechte, commandId/Run/Engine-Version, gemeinsame Transaktion für Zustand/Event/Audit/Feed. Kein Score durch Gewinnerwechsel. |
| Submission / Judge / Matching | Wissensduell und Jeopardy speichern/prüfen Submissions und Bewertungen; WID verwendet gemeinsame Score-Judgements. Unsicheres Fuzzy-Matching bleibt NEEDS_JUDGE. Verbaltext wird nicht erfunden. |
| Turn / Tie / Zufall | Persistierter Antwortzug in Jeopardy/WID und kontrollierte Korrektur. ALLOW_TIE wird vor Start festgeschrieben und von Wissensduell/Jeopardy beim Ende genutzt. Andere Tie-Strategien bleiben bei fehlenden Entscheidungen PENDING und sind dort nicht auswählbar. Serverzufall wird gespeichert und beim Rejoin nicht wiederholt. |
| Rundenübergang | Alle drei Engines verwenden denselben Übergangsguard. Er fordert ROUND_END, erlaubt nur ROUND_PREPARE oder GAME_END und verbietet Punkteänderungen. Reset für Buzzer/Turn/Submission/Timer, Abschluss-ID und Übergangsfolge werden mit dem Zustand/Event gespeichert. Content/Teams der nächsten Runde kommen aus der bestehenden Vorbereitung. |
| Guards / Projektionen | Dieselben serverseitigen Aktionsbedingungen bestimmen reale Mutationen und UI-Controls. Viewer bekommen keine Befugnisse; Verwaltung gibt keine privaten Antworten frei. Projektionen enthalten explizite Feldlisten. |
| Persistenz / Recovery | State-CAS, unveränderliche Domain-Events und deterministischer Replay in drei Engines. Legacy-Checkpoints, bekannte Versionen, echte Migration/Prozess-Neustarts. Unsichere States werden angehalten; keine neuen Punkte/Zufallsentscheidungen. Weitergehende Reparatur-/Finalisierungs-Workflows folgen in Punkt 3. |

## Lokale Prüfung

- 423/423 Servertests in 50 Dateien, vollständiger Lauf.
- 85/85 Webtests; Typecheck und beide Builds erfolgreich.
- Lint: 0 Fehler, 115 bestehende Warnungen. Dokuchecker und `git diff --check` erfolgreich.
- 48 gezielte State-/Contract-/Runtime-/Transition-Fälle zusätzlich geprüft.
- Browserabnahme auf GitHub erforderlich; lokale Chromium-Installation fehlt.
- Team-Vorgänger b53c972: vollständige CI/E2E grün, Run 40121033591.

Die bestehenden Browsertests spielen weiterhin alle drei Engines. Jeopardy J4
und WID prüfen zusätzlich den sichtbaren Host-Wechsel des Buzzer-Gewinners.
Die Runtime-Sockettests prüfen Vier-Spieler-/Teamabläufe, Replay, Rollen,
Rechteentzug, stale Commands, Migration/Neustart und Gleichheit zum Event-Replay.
