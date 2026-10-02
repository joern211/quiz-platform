# Wer ist das? (MVP)

## Einrichtung

Der Moderator wählt das Spiel im Katalog (Slug `wer-ist-das`, Anzeigename „Wer ist das?") und erstellt eine oder mehrere Runden. Jede Runde benötigt ein vorbereitetes Bild sowie zwei Personennamen. Der bestehende Medienendpunkt speichert die hochgeladenen Bilder. Der Raum speichert die Reihenfolge und Lösungen als `setupSnapshotJson`; bei Spielstart prüft die Engine Runden, eindeutige IDs und vorhandene Bilder des Raumhosts. Ein fehlerhaftes Setup setzt den Raum in die Lobby zurück.

> Hinweis: Der interne Modul- und Socket-Eventname bleibt `weristdas`
> (Modulpfad `games/weristdas/`, Events `weristdas:*`). Das ist bewusst
> getrennt vom **Spiel-Slug** `wer-ist-das` (sichtbare Identität in DB/API/URL).

Das MVP erzeugt keine Fusionsbilder und erkennt gesprochene Namen nicht automatisch. Der Moderator bewertet mündliche Antworten. Öffentliche Bildantworten geben den ursprünglichen Upload-Dateinamen nicht im HTTP-Header preis, da er die Lösung enthalten kann.

## Phasen und Regeln

`ROUND_READY` → Moderator öffnet den Buzzer → `BUZZ_OPEN` → erster gültiger Spieler buzzert → `ANSWERING`. Der Moderator bewertet:

| Bewertung | Punkte | Folge |
| --- | ---: | --- |
| Beide richtig | +3 | `REVEAL` |
| Eine richtig, Hinweis aktiv | +1 | `REVEAL` |
| Falsch | −1 | `ROUND_READY`; Spieler für diese Runde ausgeschlossen |

Eine richtige Person ohne Hinweis kann nicht als solche gewertet werden. Auch nach aktiviertem Hinweis bleiben beide richtigen Personen +3 Punkte wert. Der Moderator kann den Hinweis während `ROUND_READY`, `BUZZ_OPEN` oder `ANSWERING` aktivieren; er verrät noch keinen Namen. Bei falscher Antwort öffnet er den Buzzer erneut. Sind alle Spieler ausgeschlossen, kann er die Runde ohne Gewinner auflösen.

`REVEAL` veröffentlicht beide Namen und die Punkte. Nur der Moderator startet die nächste Runde. Die neue Runde setzt Hinweis, Buzzer, Gewinner und Ausschlüsse zurück. Nach der letzten Auflösung führt „Ergebnis anzeigen“ zum gemeinsamen Spielabschluss: Raum `ENDED`, `runPhase` `RESULTS`, Spielphase `GAME_END`. `game:end` bietet auch den manuellen Abschluss; dieser gibt eine noch verborgene Lösung nicht frei.

## Architektur und Sicherheit

Die Registry ruft die Engine über den generischen `game:start`- und `game:end`-Lifecycle auf. Socket-Aktionen werden anhand der serverseitigen Socket-Identität und Raumzugehörigkeit autorisiert. Der gemeinsame Buzzer entscheidet den ersten gültigen Buzz; Revision/CAS verhindert einen zweiten Sieger. Der gemeinsame Score-Core schreibt `Participation.score`, `ScoreEvent` und `RoomGameState` transaktional. Spieler und Zuschauer erhalten ausschließlich explizit projizierte Rundendaten. Vor Reveal fehlen beide Namen und Aliase in Socket-Events, Resync und Raumsnapshot. Ein Rejoin stellt Phase, Punktestand, Ausschluss und Antwortrecht aus dem gespeicherten State wieder her.

Socket-Aktionen: `weristdas:buzzer:open`, `weristdas:buzz`, `weristdas:judge`, `weristdas:hint`, `weristdas:reveal`, `weristdas:next`, `weristdas:resync`. Der Server sendet `weristdas:update` mit einer Projektion für die jeweilige Rolle.

## Prüfung

`state.test.ts` prüft Phasen, Punkte, Hinweis, Ausschluss und Reset. `socket-flow.integration.test.ts` prüft einen realen Zwei-Runden-Ablauf, parallele Buzzes, Rollenrechte, Geheimhaltung, Score-Transaktionen, Rejoin, zwei Räume, Initialisierungs-Rollback und manuellen Abschluss. `apps/web/e2e/weristdas-e2e.spec.ts` beschreibt den Browserablauf samt Bild-Upload, Buzzer, Reload und Ergebnis. CI führt diesen zusammen mit Geo und Jeopardy aus.
