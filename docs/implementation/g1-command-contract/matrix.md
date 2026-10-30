# G1 — Aktions- und Zustandsvertrag

Basis: main `75013448` (PR15–19 über PR20 integriert). Eigenständige Umsetzung
zu [Planungs-PR21](https://github.com/joern211/quiz-platform/pull/21), ohne dessen
Branch vorauszusetzen. Nur die drei registrierten Engines sind Verbraucher:
Wissensduell (`geo` ist Legacy-Slug), Jeopardy und Wer ist das? (WID).

## Gemeinsame Eingangsgrenzen

- `currentSocketMembership` prüft aktive Raumkanäle, übereinstimmende serverseitige
  Identitäten, aktuelle Sitzung, Teilnahmerolle, Zulassung, Sperren und die aktuelle
  `connectionId`. Gast-Viewer benötigen ihre verbundene ViewerSession; DISPLAY
  benötigt seine gültige DisplaySession und erhält keine Mutationsrechte.
- `requireGamePermission` lädt aktuelle Grants/Revocations und Eigentümerschaft.
  Ein Verwaltungsrecht ändert nicht die Informationsrolle. `socketRoomActor`
  benutzt denselben Membership-Nachweis; nur die bereinigte Raumverwaltung darf
  wartenden Teilnehmern mit `allowPending` eine Ansicht geben.
- `runGuardedCriticalAction` erhält optionale Raumcodes statt sie wegzuparsen.
  Explizit falscher Raum wird vor Receipt und Engine abgelehnt. Fehlt ein bei der
  jeweiligen Aktion optionaler Raumcode, bleibt die Socket-Zuordnung maßgeblich.
- `resolveCommandContextForSocket` validiert Protokoll, IDs und Revisionsaliase.
  Widersprüche sind auch ohne bereits aufgelöste Membership ungültige Nutzdaten.
  Nicht unterstützte explizite Protokollversionen werden abgewiesen.
- Neue Engine-Mutationen laufen durch `assertCoreActionAllowed` und den konkreten
  Engine-Guard. Pause/Resume benutzen nun ebenfalls den gemeinsamen Prädikatpfad.
  Start prüft Preflight; End behält den bestehenden enginespezifischen Abschluss.

## Receipt- und Versionssemantik

**R** in der Tabelle: `commandId` oder Legacy-Alias `requestId` aktiviert
`runReceipted`; ohne beide gilt der ausdrücklich erhaltene Legacy-Pfad ohne
Receipt-Schutz. `stateVersion`/`expectedRevision` im allgemeinen Envelope meinen
**Room.revision**, nicht die GameState-Revision. Mitgesendete Version ohne ID,
negative Werte und widersprüchliche Aliase werden abgelehnt.

Gleiche ID + gleicher Akteur + gleiche Absicht liefert die gespeicherte Antwort.
Gleiche ID mit anderer Aktion/Payload/Akteur ergibt `COMMAND_CONFLICT`.
Aktuelle Membership/Rechte werden **vor Replay** geprüft; fachliche Phasen erst
bei neuer Ausführung, damit eine erfolgreiche Absicht nach dem Phasenwechsel
weiter replaybar bleibt. Bei Geo-Antworten, Jeopardy und WID bleibt der früher
weggeparste Raumcode nach der Scope-Prüfung aus dem Receipt-Fingerprint ausgenommen.
Dadurch bleiben vor G1 gespeicherte Absichten replaybar; ein fremder Raum wird
auch bei vorhandenem Erfolg vor dem Replay abgewiesen. Die Engine schreibt mit eigener Transaktion/CAS und
Command-Fence. Receipt und Engine sind nicht pauschal eine einzige Transaktion:
bei verlorener Quittung nach bereits beobachteter Zustandsänderung folgt
`COMMAND_STATE_ADVANCED`/Resync statt erneuter Ausführung.

**S**: `saveGameStateIfRevision` prüft Invarianten und erwartete
`RoomGameState.revision`, materialisiert das DomainEvent und schreibt den State
in derselben Engine-Transaktion. Punkteänderungen verwenden dort zusätzlich das
Score-Ledger; Rundenergebnisse und Endergebnisse entstehen am jeweiligen Übergang.

**E**: Envelope wie oben. **C**: gültiger Raumcode `NNN-NNN`.
**P**: aktive aktuelle PLAYER-Teilnahme im gespeicherten Roster, kein Viewer/Display.
Alle Phasenangaben sind Engine-Phasen; zusätzliche Payload-/Roster-/Zeitprüfungen
bleiben verbindlich. Exakte Prädikate: `games/core/actionRules.ts` und Engine.

## Registrierte Spielmutationen (27 Events)

| Wire-Event | Payload zusätzlich zu E | Aktuelles Recht / Zusatzgrenze | Erlaubte neue Ausführung | Receipt | Persistierte Wirkung / UI-Verbraucher |
| --- | --- | --- | --- | --- | --- |
| `game:start` | C; boolesche `overrideReady?`, `acknowledgeWarnings?` | GAME_START; aktuelle Membership, nach Receipt-Claim nochmals prüfen | LOBBY + Engine-Preflight, Mindestspieler, Ready-/Team-/Contentregeln | R / GAME_START | Room-CAS → Engine-Init mit Event → gepinnter Config-Snapshot; Start-Rollback bei Init-/Snapshotfehler. ModeratorLobbyPage und RoomPanel aus Raum-Preflight/Rechten |
| `game:pause` | C | GAME_PAUSE + Core-Prädikat | RUNNING; nicht PAUSED/GAME_END/ERROR_RECOVERY; Geo nur INPUT_OPEN | R / GAME_PAUSE | S + Room-Phase/Revision, Timer einfrieren. Game-Seiten + RoomPanel aus Core-Aktionen |
| `game:resume` | C | GAME_PAUSE + Core-Prädikat | RUNNING/PAUSED mit gültiger gespeicherter Vorgängerphase | R / GAME_RESUME | S + Room-Phase/Revision, gespeicherten Timer fortsetzen. Gleiche UI |
| `game:end` | C | GAME_ABORT; vor neuer Ausführung nochmals aktuelle Rechte | Bestehender enginespezifischer Abschluss; Legacy-End bleibt idempotent | R / GAME_ABORT | Engine-Ende, Endergebnis, Room ENDED. Geo-/WID-Hostseite; kein universeller Reparaturbefehl für beliebig korrupten State |
| `geo:answer` | `optionId`, `questionIndex?`, C optional | BUZZER_CONTROL + P | INPUT_OPEN, offener Timer, noch nicht beantwortet/gesperrt, gültige Option; ein mitgesendetes `questionIndex` muss die aktuelle Runde sein (`STALE_ROUND`, seit G3 geprüft) | R / ANSWER_SUBMIT | S: eigene Antwort/Lock; Punkte erst beim Reveal. PlayerGamePage / Core `answer` |
| `geo:joker:5050` | C | BUZZER_CONTROL + P | INPUT_OPEN, Timer offen, unbeantwortet, Joker unbenutzt | R / JOKER_5050 | S: Verbrauch und gespeicherte Ausschlüsse. PlayerGamePage / `joker5050` |
| `geo:joker:spy` | C | BUZZER_CONTROL + P | INPUT_LOCKED oder INPUT_OPEN wenn alle anderen geantwortet haben; unbenutzt | R / JOKER_SPY | S: Verbrauch/Verteilung; nur eigene Projektion. PlayerGamePage / `jokerSpy` |
| `geo:joker:risk` | C | BUZZER_CONTROL + P | INPUT_OPEN, Timer offen, unbeantwortet, unbenutzt | R / JOKER_RISK | S: Verbrauch/Risikoflag. PlayerGamePage / `jokerRisk` |
| `geo:reveal` | C | REVEAL_CONTENT | INPUT_OPEN oder INPUT_LOCKED, noch nicht aufgelöst | R / REVEAL | S + Punkte/Ledger + RoundResult. ModeratorGamePage / `reveal` |
| `geo:next` | C | ROUND_ADVANCE | REVEAL | R / ROUND_ADVANCE | S: nächste Runde oder Endergebnis. ModeratorGamePage / `next` |
| `jeopardy:field:open` | `boardIndex:1\|2`, `categoryIndex:0..5`, positive `value`; C optional | BUZZER_CONTROL + REVEAL_CONTENT | SELECTING, vorhandenes noch offenes Feld | R / FIELD_OPEN | S: Feld, Auswahl, Buzzer/Timer. JeopardyModeratorPage / `fieldOpen` |
| `jeopardy:field:lock` | wie field:open | identisch; Legacy-Wire-Alias | identisch | R / FIELD_OPEN | identischer Handler; kein eigener zweiter UI-Befehl |
| `jeopardy:buzz` | C optional | BUZZER_CONTROL + P | BUZZ_OPEN, offener Buzzer, noch kein Gewinner, nicht ausgeschlossen | R / BUZZ | S: gespeicherter Gewinner/Antwortzug. JeopardyPlayerPage / `buzz` |
| `jeopardy:judge` | boolesches `correct`; C optional | JUDGE_ANSWER | BUZZ_LOCKED mit Feld/Gewinner | R / JUDGE | S + Punkte/Ledger; ggf. Steal oder FIELD_DONE. JeopardyModeratorPage / `judge` |
| `jeopardy:steal:buzz` | C optional | BUZZER_CONTROL + P | STEAL_OPEN; nicht Erstantwortender/ausgeschlossen | R / STEAL_BUZZ | S: Steal-Gewinner/Antwortzug. JeopardyPlayerPage / `stealBuzz` |
| `jeopardy:steal:judge` | boolesches `correct`; C optional | JUDGE_ANSWER | STEAL_LOCKED mit Feld/Gewinner | R / STEAL_JUDGE | S + Punkte/Ledger, FIELD_DONE. JeopardyModeratorPage / `stealJudge` |
| `jeopardy:next` | C optional | ROUND_ADVANCE | FIELD_DONE | R / ROUND_ADVANCE | S: SELECTING oder BOARD_COMPLETE, RoundResult. JeopardyModeratorPage / `next` |
| `jeopardy:board:switch` | `toBoard:1\|2`; C optional | ROUND_ADVANCE + Informationsrolle HOST | BOARD_COMPLETE, anderes gültiges Board | R / BOARD_SWITCH | S: Boardwechsel oder Spielabschluss. JeopardyModeratorPage / `boardSwitch` |
| `weristdas:buzzer:open` | C optional | BUZZER_CONTROL + Buzzer-Controller (Owner oder explizit delegiert) | ROUND_READY, mindestens ein berechtigter Spieler | R / BUZZER_OPEN | S: BUZZ_OPEN. WerIstDasGamePage / `open` |
| `weristdas:buzz` | C optional | BUZZER_CONTROL + P | BUZZ_OPEN; berechtigter, nicht ausgeschlossener Spieler | R / BUZZ | S: Gewinner/Antwortzug. WerIstDasGamePage / `buzz` |
| `weristdas:hint` | C optional | ROUND_ADVANCE + REVEAL_CONTENT | ROUND_READY/BUZZ_OPEN/ANSWERING; Hinweis noch nicht aktiv | R / HINT | S: Hinweisflag, Projektion bleibt rollenabhängig. WerIstDasGamePage / `hint` |
| `weristdas:judge` | `result:BOTH_CORRECT\|ONE_CORRECT\|WRONG`; C optional | JUDGE_ANSWER | ANSWERING mit Gewinner; ONE_CORRECT benötigt Hinweis | R / JUDGE | S + Score-Ledger, Wiederöffnung oder Reveal. WerIstDasGamePage / `judge` |
| `weristdas:reveal` | C optional | REVEAL_CONTENT | ROUND_READY oder BUZZ_OPEN | R / REVEAL | S + RoundResult, öffentliche Auflösung. WerIstDasGamePage / `reveal` |
| `weristdas:next` | C optional | ROUND_ADVANCE | REVEAL | R / ROUND_ADVANCE | S: nächste Runde oder Endergebnis. WerIstDasGamePage / `next` |
| `game:buzzer:override` | `participantId`, positive `gameStateVersion`, `runIndex`, `reason?`; commandId Pflicht | BUZZER_CONTROL + Controller, aktuelles berechtigtes Ziel | Jeopardy BUZZ_LOCKED/STEAL_LOCKED; WID ANSWERING | Pflicht / BUZZER_OVERRIDE | S + Audit/Feed; Antwortzug umhängen, keine bereits bewerteten Punkte umschreiben. BuzzerOverride in beiden echten Engines |
| `game:result:command` | C, `runIndex`, `resultRevision`, `operation`; commandId Pflicht, Protokoll 1 | SCORE_ADJUST; aktuelle Sitzung/Teilnahme/Rechte auch in TX | REVIEW/FINALIZE/ADJUST/ROLLBACK/AMEND nach Result-Lifecycle und Referenznachweis | Pflicht / RESULT_COMMAND | Versioniertes Result + Korrektur-Ledger/State/Event/Audit/Feed. ResultScreen für alle drei Engines |
| `game:recovery:command` | C, `runIndex`, `gameStateVersion`, `operation:RESTORE_REPLAY`; commandId Pflicht, Protokoll 1 | authentifizierter aktueller Owner + GAME_PAUSE; erneut in TX | ERROR_RECOVERY, bekannte Engine-Version, vollständige Ereigniskette bis Vorversion | Pflicht / RECOVERY_COMMAND | S + Audit/Feed; gespeicherte Punkte/Zufallsentscheidungen erhalten. RecoveryControl; kein stiller Neu-Start |

## Lesewege und Konfigurationsanschluss

| Event | Scope / Validierung / Membership | Projektion / Wirkung / UI |
| --- | --- | --- |
| `room:resync` | C muss zum aktuellen Socket-Raum passen; aktuelle Membership | öffentliche Raum-/Spielerliste, keine Engine-Lösungen; Snapshot, keine fachliche Mutation |
| `room:core:read` | Socket-Raum; `socketRoomActor(..., true)` | RoomPanel / ModeratorLobbyPage; wartend nur bereinigte Ansicht ohne Roster/Verwaltungsrechte |
| `game:core:read` | Socket-Raum; optionaler expliziter C muss übereinstimmen; aktuelle Membership | `CoreRuntimeProjection`: Phase, Timer, Fortschritt, erlaubte Aktionen; keine Lösungen. `useGameCore` in echten Spielseiten und RoomPanel |
| `geo:resync` | `authorizeGameContext`, aktuelle Membership/Sitzung, richtige Engine; optionaler C muss passen | Vertragprojektion: HOST (sofern nicht blind), eigene Spielerantwort/Joker oder öffentlich; nie kompletter Fragen-/Antwortspeicher |
| `jeopardy:resync` | wie Geo, einschließlich Versions-/Invariantengate | Vertragprojektion: Lösungen nur Host bzw. nach Reveal, Spieler/Viewer/Display öffentlich |
| `weristdas:resync` | gleicher Kontextguard, optionaler C; unterstützte gepinnte Version | Bilder/Namen entsprechend Informationsrolle, Blindmoderation und Reveal; eigenes Teilnehmerkontext |
| `game:result:read` | striktes Schema: C, optionale Partie/Result-Revision; aktuelle Membership | öffentliches versioniertes Result, keine privaten Lösungen; ResultScreen |
| `room:config:update` | C, erwartete Room-Revision, nichtleere Changes; aktueller authentifizierter Owner und Membership | `updateRoomConfig`: gültige Feldwerte, Änderungsklasse, Room-CAS; Start-Snapshot bleibt unverändert. Kein Command-Receipt, ausdrücklich revisionsbasierte API |

Resync/Core-Reads können einen erkannten unsicheren State **einfrieren** und
ERROR_RECOVERY persistieren; sie führen dabei keine Spielaktion/Neuwertung aus.
Unbekannte gepinnte Engine-Versionen werden nicht umgeschrieben. Normale
Projektionen veröffentlichen weder Recovery-Snapshot noch interne Fehlerevidenz.

## Anschlüsse über `room:command`

Diese registrierte API benötigt C, commandId und Protokoll 1; optionales
stateVersion meint Room.revision. Receipt-Aktion ist ROOM_COMMAND, Payload ist
die diskriminierte `RoomOperationSchema`-Operation. Aktuelle Membership gilt auch
vor Replay; `mutateRoom` prüft Rechte/Sitzung/Gerät erneut in seiner Transaktion.

| Operation | Guard und Phase | Persistierte Wirkung / Verbraucher |
| --- | --- | --- |
| EMERGENCY / ABORT_GAME / KEEP_POINTS | GAME_ABORT vor Replay und vor neuer Ausführung, RUNNING, realer Engine-Handler | Engine-Ende + Audit/Feed; RoomPanel nutzt Core `end` und GAME_ABORT, kein zusätzliches PLAYER_MANAGE erforderlich. Andere Emergency-/Punktevarianten bleiben ENGINE_ACTION_UNSUPPORTED |
| LOBBY / REMATCH / SWITCH_GAME | aktueller Owner; ENDED; ggf. erwartete Partie; nur startbare Engine mit gültigem Setup | Archiviert Partie, erhöht runIndex, entfernt aktuellen State, setzt Punkte/Ready/Config zurück; RoomPanel |
| CLOSE | Owner; laufendes Spiel zuerst beenden | Archiviert, beendet alle Teilnahme-/Viewer-/Display-Sitzungen; RoomPanel |
| ADMIT | PLAYER_MANAGE; Kapazität, Zulassung/Team-/Rundengrenze | Teilnahme und bei spätem Einstieg S / ROOM_PLAYER_ADMITTED; RoomPanel |
| RENAME | PLAYER_MANAGE oder eigene Teilnahme in der Lobby; eindeutiger Name | Name + ggf. S / ROOM_PLAYER_RENAMED, einschließlich gespeichertem Pause-State; RoomPanel |
| TEAM_SELECT / TEAM_EDIT / TEAMS_ASSIGN | eigenes zulässiges Team oder TEAM_MANAGE; Policy/Roster/Rundengrenzen | Teamzuordnung/-daten, Room-Revision und spätere Engine-Rosterübernahme; RoomPanel |
| TOKEN_ROTATE / INVITE | PLAYER_MANAGE bzw. aktueller Owner **vor Replay**; Mutationsguard erneut in TX | Geräte-/Einladungscredential nur an aktuell Berechtigten; gespeicherte private Receipt-Antwort wird nach Entzug nicht herausgegeben |

Übrige Raumoperationen (Policy, Planung, Sperren, Nachrichten, Moderation,
Co-Host/Transfer und Verlassen) behalten den geschlossenen Raumvertrag in
`rooms/core.ts`. Sie erzeugen keine zusätzliche Spiel-Engine.

## UI-Abgleich und belegte Korrekturen

`availableCoreActions` und `assertCoreActionAllowed` verwenden dasselbe
`coreActionDenial`. `useGameCore.can` wird jetzt auch für Geo-Spieleraktionen
und die Pause/Resume-Steuerung im Raumpanel verwendet. Insbesondere ist Spy nach
INPUT_LOCKED tatsächlich bedienbar; ein INPUT_OPEN allein gibt noch kein Recht.
Der persistente Hook folgt dem mit `observeSocket` ersetzten Client und verwirft
alte/überholte Antworten. Start verwendet die aktuellen Raumrechte und den
serverseitigen Preflight, einschließlich deaktiviertem Ready-Check und echten
Blockern. Die bestehende explizite Geo-Abbruchmöglichkeit bei Config-Recovery
bleibt erhalten; sie behauptet keine Reparatur beliebiger beschädigter Zustände.

Neue Regressionen: `commandBoundary.integration.test.ts` prüft alle 20
Engine-Wiremutationen mit fremdem Raumcode jeweils mit/ohne Receipt (40
Ablehnungen mit unverändertem Room/State/Event/Score/Receipt), aktuelle Geräte,
Pending, Sitzungsentzug, ViewerSession, private Reads, zwei echte Verbraucher
für Replay und Rechteentzug, Pause/Resume und ERROR_RECOVERY. Hinzu kommen
Abbruch über die Raumsteuerung sowie Schutz gespeicherter privater Credentials. Eine künstlich
verzögerte reale Receipt-Übernahme belegt den erneuten Start-Guard nach Entzug.
`lifecycleBoundary.test.ts` prüft fehlerhafte Nutzdaten und Fehlerprioritäten.
UI-Nachweise liegen in RoomPanel-, useGameCore-, GeoRecovery- und
ModeratorStartContract-Tests. Bestehende Tests für Events/Results/Recovery und
Prozess-Restart bleiben die Verbraucherabnahme für diese unveränderten Mechaniken.

## Limits und bewusst nachfolgende Arbeit

HTTP-Login und Raum-Erstellen/Join besitzen Produktions-Rate-Limiter;
`app.ts` begrenzt JSON-Bodies, Medien-Uploads begrenzen Größe/Teile und
Audiodecoder Laufzeit/Parallelität. Live-Medien haben pro Socket/Event ein
10-Sekunden-Fenster (Join/Restart 20, Self 60, Control 30).

Die obigen Spielbefehle besitzen Payload-, Phasen-, Receipt- und CAS-Grenzen,
aber **keinen dedizierten aktionsbezogenen Socket-Rate-Limiter**. Ein neues
Absichtstoken ist kein Drosselmechanismus. Begründete Limits pro Aktion,
insbesondere Reads/Spam/Receipt-Wachstum, gehören in G4; es wird kein gemeinsames
NAT-IP-Limit als vermeintliche Lösung eingeführt.

Weitere Raumverwaltung (Kick, Ready, Profil, Lobbychat), HTTP-Editoren
und Medienaktionen behalten ihre eigenen Verträge; sie sind keine zusätzlichen
Spiel-Engine-Befehle. G1 ersetzt diese nicht durch einen Universaldispatcher.
G2–G5 und die späteren Mechanikcluster bleiben separat offen. Nicht registrierte
Spiele bleiben PLANNED und zählen weder als Engine noch als zweiter Verbraucher.
