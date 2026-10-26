# Merge-Review PR15–19 — Korrekturauftrag 27.10.2026

Auftrag: fünf bestätigte Befunde einzeln beheben, regelmäßig committen und
pushen, die Korrekturen durch alle abhängigen PRs übernehmen und deren finale
Heads abnehmen. Kein Merge. Pushes sind im Auftrag autorisiert.

| Befund | Ziel | Stand |
| --- | --- | --- |
| 1 | PR15: wartende Zuschauer von Spielkanal und Resync trennen | behoben; 28 Raum-/Sockettests und neuer UI-Fall grün; finale CI nach Befund 2 |
| 2 | PR15: Zuschauerlimit auch bei Zulassung über beide Modelle zählen | offen |
| 3 | PR16/17: Raumänderungen atomar protokollieren, Recovery ohne Verlust | offen |
| 4 | PR18: ausdrücklich 0 Punkte in der Runtime erhalten | offen |
| 5 | PR19: Empfangsverbindungen gemeinsam neu aushandeln | offen |

Wiederaufnahme: Branch/Working Tree und Remote-Heads abgleichen. Bestehende
Arbeit erhalten. Jeden Befund mit gezielten Regressionen sichern; abschließend
CI/E2E am jeweiligen finalen PR-Head prüfen und PR-Beschreibungen aktualisieren.

Befund 1: Pending-Identitäten erhalten einen reinen Wartekanal und eine
reduzierte Raumansicht. Direkte Spiel-/Resync-/Permission-Pfade bleiben gesperrt;
erst nach committed ADMIT wechselt die aktuelle Verbindung in den Spielkanal.
Ablehnung/Close entfernen auch den Wartezugang. Viewer-Lobby wartet auf die
tatsächliche Admission, auch wenn bereits eine Partie läuft.

Lokale Prüfungen zu Befund 1: vollständige betroffene Raum-Suite 28/28,
neuer Viewer-UI-Fall 1/1, Lint ohne Fehler. Typecheck und finale PR15-CI werden
am kombinierten Abschluss mit Befund 2 festgehalten.
