# Merge-Review PR15–19 — Korrekturauftrag 27.10.2026

Auftrag: fünf bestätigte Befunde einzeln beheben, regelmäßig committen und
pushen, die Korrekturen durch alle abhängigen PRs übernehmen und deren finale
Heads abnehmen. Kein Merge. Pushes sind im Auftrag autorisiert.

| Befund | Ziel | Stand |
| --- | --- | --- |
| 1 | PR15: wartende Zuschauer von Spielkanal und Resync trennen | behoben; 28 Raum-/Sockettests und neuer UI-Fall grün; finale CI nach Befund 2 |
| 2 | PR15: Zuschauerlimit auch bei Zulassung über beide Modelle zählen | behoben; 31 Raum-/Sockettests grün; finale CI am neuen PR15-Head |
| 3 | PR16/17: Raumänderungen atomar protokollieren, Recovery ohne Verlust | behoben; PR16-Events und PR17-Recovery-Regressionsfälle grün |
| 4 | PR18: ausdrücklich 0 Punkte in der Runtime erhalten | behoben; vier neue Content-bis-Ergebnis-Fälle grün |
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

Befund 2: gemeinsame aktive Zuschauerzählung für JOIN, ADMIT und Token-Rejoin,
jeweils unter dem DB-Schreiblock. Pending belegt keinen aktiven Slot; ein
Gerätewechsel zählt die eigene Teilnahme nicht doppelt. Eine volle Zulassung
rollt vollständig zurück und öffnet keinen Spielkanal.

Kombinierter PR15-Stand lokal: 31/31 Raum-/Sockettests, neuer Viewer-UI-Fall,
vollständiger Typecheck sowie Server- und Web-Build grün, Lint ohne Fehler.
Befund 1 auf GitHub als 94e43ba gesichert. Nach dem zweiten Push CI am neuen
Head prüfen; PR16–19 erhalten diese Änderungen über ihre Vorgänger.

CI-Nachlauf PR15: native Socket.IO-Raumunion als Array hält auch die vorhandenen
Transport-Doubles kompatibel; die drei betroffenen Identitäts-/Reconnectfälle
sind gezielt grün. Finaler vollständiger CI-Lauf folgt auf diesem Head.

Befund 3 / PR16: ADMIT und Runtime-Namensänderungen nutzen den gemeinsamen
State-CAS mit Domain-Event in derselben Transaktion. Umbenennen während Pause
aktualisiert auch den persistierten Resume-Zustand. Neue reale Jeopardy-/WID-
Fälle prüfen lückenlosen Replay, Receipt-Replay, unveränderte Punkte und den
vollständigen Rollback bei einem fehlgeschlagenen Eventwrite.

Befund 3 / PR17: Freeze speichert die exakte Vorversion. Recovery lehnt auch
einen formal gültigen, aber älteren Event-Tail ab. Zehn Result-/Recoveryfälle
grün, darunter Late-Admission/Umbenennung mit erfolgreicher Wertung nach Repair,
Legacy-Lücke ohne Änderungen und wiederholte Recovery. PR16 ist als 99900ce gepusht.

Befund 4: Nullish-Default erhält ausdrücklich 0 Punkte auch mit Risiko-Joker.
Neue reale Content-/HTTP-/Socket-/DB-Fälle sichern 0, 0 mit Risiko, 100 sowie
den fehlenden Wert mit Default 100 bis Score-Ledger und persistiertem Ergebnis.
PR15/16: vollständige CI einschließlich E2E am finalen Head erfolgreich.
