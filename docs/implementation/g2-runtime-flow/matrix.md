# G2 — Zeit, Antwortzug, Buzzer und Rundenübergang

Basis: main `407117e6` mit G1/PR22. Quellen: bestehende Registry und Engines,
[G1-Matrix](../g1-command-contract/matrix.md),
[technisches Mapping](../../specs/pr12/technical-mapping.md) und vorhandene
Spielespezifikationen. Historische PR12-Istspalten sind kein aktueller Nachweis;
dies ist kein neuer vollständiger Master-Audit.

**R** = real integrierter, geprüfter Teilumfang; **H** = vorhandener Hilfsbaustein
mit fehlendem vollständigem Laufzeitanschluss; **S** = späterer passender Bedarf.
Die Abnahme erfindet weder neue Engines noch neue Spielregeln.

## Mechaniken und echte Verbraucher

| Mechanik | Echter Verbraucher / Abnahme | Grenze und Verhalten |
| --- | --- | --- |
| Countdown | Wissensduell, R | Gespeicherter CoreTimer; die Deadline selbst nimmt keinen Input mehr an. Verzögerte native Callbacks verlängern die Frist nicht |
| Unbegrenzte Antwortzeit | Jeopardy, R | UNLIMITED mit persistiertem Status/Elapsed; Pause schließt Input, Resume bewahrt das verbrauchte Budget; keine erfundene Deadline |
| Gemeinsamer Timer-/Pause-Vertrag | Wissensduell und Jeopardy, R für diese Modi | create/pause/resume/end + Legacy-Reader werden von zwei echten Engines verwendet; jeweilige Engine-Regeln bleiben maßgeblich |
| Untimed Pause | WID sowie Jeopardy, R | Vollständiger `_roomPause`-Zustand für exakte Fortsetzung; Gewinner, Antwortzug, Roster und Ausschlüsse bleiben erhalten |
| Gewinner / verbaler Antwortzug | Jeopardy und WID, R | Erste angenommene Serverankunft gewinnt; genau ein gespeicherter Gewinner und zugehöriger Ein-Personen-Antwortzug; Bewertung prüft diesen Zug |
| Team-/Teilnehmer-Buzzer | Jeopardy und WID, R | Roster und Teamzuordnung werden beim ersten Öffnen gespeichert. Falsche Antwort schließt die passende Person/Teamgruppe aus; Wiederöffnung/Rejoin zieht keinen neuen Roster |
| Rundenwechsel | alle drei Engines, R | Abschlussphase, einmalige Absicht, Runtime für nächste Runde zurücksetzen, Punkte bewahren; State-CAS und DomainEvent in derselben Transaktion |
| Count-up | H/S | Primitive ist vorhanden, aber kein vollständiger realer Engine-/UI-Verbraucher; nicht als fertiger Modus ausgegeben |
| Allgemeine FIXED/RANDOM/ROTATING/CUSTOM-Zugzyklen | H/S | Ein gespeicherter verbaler Antwortzug ist kein integrierter Mehrspieler-Zugzyklus; kein fachfremder Verbraucher eingebaut |
| Zusätzliche Timeraktionen (Extend/End als Spielersteuerung) | H/S | Primitive abgesichert; keine neuen Wire-Events oder Controls erfunden. TIMER_CONTROL allein macht keinen Anschluss fertig |

## Tatsächlich erreichbare Aktionen

Für Socket-Mutationen gelten die G1-Nachweise: aktuelle Sitzung, Zulassung,
Gerätezuordnung, Raumscope und Rechte; Receipt-Replay vor fachlicher Phasenprüfung,
State-/Room-CAS und Command-Fence. Allgemeines Envelope-stateVersion meint
Room.revision; gameStateVersion beim Override meint RoomGameState.revision.

| Aktion / UI | Recht und Phase | Persistenz / Pause / Expiry |
| --- | --- | --- |
| `game:start` → Geo-Intro; ModeratorLobby/RoomPanel | GAME_START, LOBBY + Preflight | Initialisiert INTRO mit gepinntem Inhalt/Config. Registry plant genau dessen Intro; alter Callback prüft Handle, Partie, State-Version und Phase |
| `game:pause` / `game:resume`; Spielseiten/RoomPanel | GAME_PAUSE, G1-Core-Prädikat; Geo INPUT_OPEN bzw. PAUSED | Geo speichert exakte Restzeit; Jeopardy/WID speichern vollen Pause-State. Während Pause weder Antworten noch Buzz/Judge. Rechte werden vor Ausführung/Replays aktuell geprüft |
| `geo:answer`, `geo:joker:5050`, `geo:joker:risk`; PlayerGamePage | PLAYER + BUZZER_CONTROL, offener Timer/Phase | Deadline nochmals an eigener Persistenzgrenze; kein verbrauchter Joker nach abgelaufener Frist. Antwort wirkt einmal; 5050-Zufall wird gespeichert |
| `geo:joker:spy`; PlayerGamePage | PLAYER + BUZZER_CONTROL; bestehende Input-/Alle-geantwortet-Regel | Eigene gespeicherte Verteilung; kein neuer Zufall bei Rejoin. INPUT_LOCKED bleibt gemäß bestehender Regel zulässig |
| Geo-Deadline (Serveraktion) | laufende passende Partie/Runde/Deadline; keine neue Benutzerpermission | Eingabe schließen mit State-CAS/Event, dann scopegebundenes Auto-Reveal; bei Fristablauf genau einmal werten. Kein alter Callback schließt eine neue Runde |
| `geo:reveal` / `geo:next`; ModeratorGamePage | REVEAL_CONTENT / ROUND_ADVANCE, bestehende Abschlussphasen | Next öffnet mit einem State-CAS/Event direkt INPUT_OPEN. Ein Eventfehler rollt Runde, Room und Score zurück; Replay öffnet sie nicht erneut |
| `jeopardy:field:open` und Legacy `field:lock`; Moderatorseite | BUZZER_CONTROL + REVEAL_CONTENT, SELECTING | Öffnet UNLIMITED und pinnt Buzzer-Roster. Legacy-Alias und Receipt-Fingerprint bleiben erhalten |
| `jeopardy:buzz` / `jeopardy:steal:buzz`; Spielerseite | PLAYER + BUZZER_CONTROL, BUZZ_OPEN / STEAL_OPEN + gespeicherte Auswahl/Ausschlüsse | Gewinner, Team und Antwortzug als CAS/Event. Rejoin/Pause/Restart verändert sie nicht |
| `jeopardy:judge` / `jeopardy:steal:judge`; Moderatorseite | JUDGE_ANSWER, passende gelockte Antwortphase | Bewertet gespeicherten Antwortzug. Wrong öffnet Steal mit gespeichertem Roster/Ausschlüssen; Punkte und Event atomar |
| `jeopardy:next` / `jeopardy:board:switch`; Moderatorseite | ROUND_ADVANCE; FIELD_DONE / BOARD_COMPLETE; Boardwechsel HOST | Ein CAS/Event mit bereinigtem Runtime-State; Scores erhalten. Kein Wiedereinfügen bereits gespielter Felder |
| `weristdas:buzzer:open` / `weristdas:buzz`; WID-Seite | Buzzer-Controller bzw. PLAYER + BUZZER_CONTROL, ROUND_READY / BUZZ_OPEN | Erstes Öffnen pinnt den Roster, falsche Antwort und Wiederöffnung erhalten ihn |
| `weristdas:judge` / `hint` / `reveal`; WID-Seite | JUDGE_ANSWER / ROUND_ADVANCE + REVEAL_CONTENT / REVEAL_CONTENT, jeweilige G1-Phase | Antwortzug prüfen; falsche Antwort schließt Person/Team aus, ohne gespeicherten Roster neu zu ziehen. Hint/Reveal behalten ihre bestehenden Regeln |
| `weristdas:next`; WID-Seite | ROUND_ADVANCE, REVEAL | Bereinigt Buzzer, Antwortzug, Hinweis-/Lösungsflags in einem CAS/Event und bewahrt Scores |
| `game:buzzer:override`; Jeopardy-/WID-Controls | BUZZER_CONTROL + Controller, gelockte noch nicht bewertete Antwort; runIndex + gameStateVersion | Setzt Gewinner/Antwortzug mit Audit um. Bewertete Punkte werden nicht verdeckt zurückgesetzt; G1-Receipt-/Membership-Grenzen bleiben aktiv |

Die UI erhält weiterhin `availableCoreActions`/CoreRuntimeProjection. Kein
zusätzlicher Timerknopf oder neuer Spielmodus wurde nur aufgrund eines Typs
freigeschaltet. Timerduration-Config ändert die Konfiguration für folgende
Geo-Runden, nicht den bereits gespeicherten laufenden Countdown.

## Timer-Installation, Persistenz und Neustart

Geo benutzt für vollständige Operationen einschließlich Installation/Abbruch
nativer Timer die vorhandene **reentrante** `serializeRoom`-Warteschlange. Das
verhindert, dass die verspätete Nacharbeit eines Übergangs den Timer eines neueren
Übergangs entfernt. Sie ist kein prozessübergreifender Lock: DB-CAS, Transaktion
und Receipt-Fence bleiben dafür verbindlich.

- Ein Native-Handle ist nur ein Wecksignal. Persistierte Partie, Runde, Deadline
  und Phase entscheiden in der Engine-TX. Ein zu frühes Signal plant den Rest
  neu und verändert weder State noch Scores. Ein überholtes Signal wirkt nicht.
- Wiederherstellung liest den aktuellen Raum **innerhalb** derselben Raumlease.
  INPUT_OPEN erhält seine vorhandene Deadline, PAUSED bleibt unverändert.
- INTRO wird ohne erneute Initialisierung geöffnet; alte PROMPT-Checkpoints
  werden mit ihren vorhandenen Fragen/Scores fortgeführt. Neue Next-Operationen
  hinterlassen keinen solchen zweistufigen Checkpoint mehr.
- INPUT_LOCKED nach einer abgelaufenen gespeicherten Deadline beendet das
  unterbrochene Auto-Reveal. REVEAL wird nicht erneut gewertet. Unbekannte
  Engine-Versionen und ungültige Zustände bleiben am bestehenden Recovery-Gate.
- Countdown-Extend/Resume kann keine abgelaufene Deadline oder null Restzeit
  wieder öffnen. Elapsed endet an der Countdown-Deadline und zählt Pause nicht mit.

## Nachweise und Grenzen

Neue Regressionen: `g2Runtime.integration.test.ts` (20 echte Engine-/Socket-/DB-
Fälle), `g2Restart.integration.test.ts` (5 Fälle mit wirklich beendeten und frisch
neu gestarteten Serverprozessen) und 3 zusätzliche Primitive-Grenzfälle.
Zusammen **28 neue Tests**. Vier bestehende Primitive-Tests bleiben unverändert.

Die fünf Neustartfälle prüfen aktive und pausierte Geo-Budgets samt eigener
Abgabe/öffentlicher Geheimhaltung, offline abgelaufene Frist ohne doppelte Punkte,
Jeopardy-/WID-Gewinner und Antwortzug sowie einen bereits gespeicherten Input-Lock-
Checkpoint. Der letzte Fall setzt den zulässigen Zwischenzustand auf DB-Ebene auf;
er erfindet keine Recovery-Ereigniskette und gilt nicht als Replay-Evidenztest.
Der ergänzende Engine-Test erzeugt den Lock über den realen Expiry-Handler und
unterbricht gezielt nur dessen folgende Auto-Reveal-Ausführung.

Gezielte Bestandsprüfung: G1-Command-Grenzen, Runtime-Verbraucher sowie PR14-
Konfigurations-/Receipt-Regressionen. Verbindliche volle CI-/E2E-Abnahme und Head-SHA
stehen an [PR23](https://github.com/joern211/quiz-platform/pull/23).

G3 (Abgaben/Matching/Bewertung/Sichtbarkeit), G4 (Ergebnisse/Korrekturen/Limits)
und G5 (abschließende Verbraucherabnahme) bleiben eigene Pakete. Vorhandene
Hilfsmodi ersetzen keine spätere Integration mit den passenden neuen Spielen.
