# Paket 5 — Media / Voice / Camera / Display

Basis: PR18 / 2319154. Vollständige GitHub-CI und29 Browserfälle grün
(Run40253379733). Paket4: die benannten Vorlagen-, Blindmoderations- und
Schnellstart-Lücken sind geschlossen. Detaillierte Grenzen bleiben in
../pr18/acceptance.md. Kein Merge. Folgebranch feature/pr19-media-voice.

## Erster implementierter Teil: echte Audioverarbeitung

Der Upload prüft MP3, WAV, M4A/AAC und bestehendes OGG durch ffprobe und
vollständiges Decodieren. Nur ein Audiostream; Video außer eingebettetem
Coverbild wird abgewiesen. Fest gewählte Demuxer und file-only-Protokoll für
Uploads erlauben keine Playlists/Netzwerkquellen. Das PCM-Zwischenergebnis
enthält keine Quellmetadaten oder Bilder. Loudness-Normalisierung auf -16 LUFS,
True-Peak-Ziel -1.5dBTP, danach stereo48kHz/128kbit MP3 ohne übernommene ID3-/
Container-Metadaten. Dateiendung und MIME stammen vom Ergebnis, nicht vom Namen.

Konfigurierbar:20MB Audio,300s,30s Gesamtverarbeitung und zwei gleichzeitige
Jobs pro Serverprozess. PCM-/Ausgabepuffer sind begrenzt; Threads ebenfalls.
Zu lange Audios werden abgewiesen statt abgeschnitten. Fehlender Prozessor,
Timeout und Auslastung ergeben retryfähige503; ungültige Dateien415. Multipart-
Größenlimit liefert413. Fehler erzeugen keine READY-Zeile oder Upload-Orphans;
Slots werden auch nach Abbruch freigegeben. Dauer wird aus decodierten Samples
ermittelt und mit dem fertigen Asset gespeichert. Dedupe, Owner-/Visibility-
Grenzen, Reparatur und aktuelle Content-/Raum-/Frage-Signaturen bleiben gültig.

FFmpeg/ffprobe sind Systemvoraussetzung, in CI und Docker-Runner eingetragen.
Bildverarbeitung bleibt WebP. Historische Assets werden nicht still neu codiert.
Die synchrone Uploadverarbeitung ist noch kein persistenter Background-Job-
Scheduler und speichert noch keine zusätzliche Original-/Variantenhierarchie.

## Nachweise

- 14 echte Audio-HTTP-/DB-/Prozessfälle: fünf Formate, tatsächliche Lautstärke,
  Metadata-Strip, gefälschte Header, Truncation, Dauer/Größe, Video, fehlender
  Prozessor, Timeout/Parallelität und anschließender Retry, Dedupe/Ownership.
- Bestehender Runtime-Medientest zusätzlich mit wirklich hochgeladenem Audio:
  Wissensduell + Jeopardy, Host-/Player-/Viewer-Projektionen, aktives/future
  Medium, Startgate, Itemaustausch, Resync und Run-/Room-Sperren.
- M1-Browserfall: Upload über beide Editor-UIs, private Vorschau, tatsächliche
  Wiedergabe auf einem Gastgerät, Reload, keine Lösung vor Reveal und Entzug
  der Medien-URL nach Playtest-Close. Insgesamt30 Browserfälle aktiv.
- Lokal505/505 Servertests (59 Dateien),132/132 Webtests (25 Dateien),
  beide Builds und Typecheck grün; Lint0 Fehler/113 bestehende Warnungen.
  Genaue GitHub-Abnahmen werden im PR aktualisiert.

## Fortsetzung innerhalb von Paket 5

Persistente Verarbeitung/Varianten und Originalableitung bleiben von diesem
Uploadpfad getrennt. Live-Voice mit MAIN/TEAM-Fences, Host-Mute/PTT, Prejoin/
Gerätewechsel, unabhängige Kamera-Freigabe, Viewer-Audio und echter DISPLAY-
Sessionpfad sind noch nicht implementiert. Recording, Screen Sharing und
weitere Engines werden nicht durch das Vorhandensein eines Audio-Uploads als
fertig behauptet. Das Master-Regelwerk bleibt verbindlich; Paket5 ist in Arbeit.

Technische Referenz: https://ffmpeg.org/ffmpeg-protocols.html,
https://ffmpeg.org/ffmpeg-filters.html#loudnorm und
https://ffmpeg.org/ffmpeg.html (-xerror).

## Gegenprobe aus der vollständigen Browserregression

376bc88: GitHub-CI mit505 Server-/132 Webtests grün; M1-Audiowiedergabe und
weitere28 Browserfälle bestanden. C3 (zwei Editoren) zeigte eine echte
Anwesenheits-Race: StrictMode kann active/cleanup/active mit demselben editorKey
parallel senden. Ein verspätetes inactive löscht dann die neue Registrierung.
Die Komponente serialisiert diese Requests jetzt über Effect-Lebenszyklen;
eine verzögerte erste Antwort wird im StrictMode-UI-Test reproduziert. Keine
Verlängerung des Browsertimeouts und kein Entfernen des C3-Nachweises.

Lokale Gegenprobe nach der Korrektur:133/133 Webtests (26 Dateien), beide
Builds und Typecheck grün. Der bisherige Unmount-Test wartet auf die jetzt
geordnet asynchrone Abmeldung; seine inhaltliche Assertion bleibt erhalten.

180080a: komplette CI mit505 Server-/133 Webtests grün. Browserjob blieb
unverhältnismäßig lange in der FFmpeg-Paketinstallation; die Installation
erhält deshalb begrenzte Netzwerk-Timeouts/Retry, fünf Minuten Step-Limit,
noninteractive und keine empfohlenen Zusatzpakete. Produktcode unverändert.
Finale genaue Browserabnahme wird im PR festgehalten.

## Wiederaufnahme 26.10.2026 — Audio abgenommen / lokaler Gerätecheck

0934183: komplette GitHub-CI und30/30 Browserfälle im Wiederholungslauf grün
(Run40292697356). Erster E2E-Versuch endete vor den Tests an einem langsamen
FFmpeg-Paketdownload; derselbe Head bestand anschließend ohne Produktänderung.

Neuer Teil: optionaler lokaler Gerätecheck vor Player-/Viewer-Beitritt und
in der Host-Lobby. Mic und Kamera werden nur durch eigenen Klick und getrennt
angefragt. Viewer erhalten keinen Mic-Test. Kamera-Preview bleibt lokal und
stumm; der Mikrofonpegel hat keine Verbindung zum Lautsprecher. Testton am
System-Standardausgang; separate Output-Auswahl wird noch nicht behauptet.
Input-Geräte und Filterpräferenzen bleiben lokal gespeichert. Fehlende frühere
Geräte fallen beim Test ausdrücklich auf das Standardgerät zurück; Permission-
Denial und fehlende APIs blockieren keinen Beitritt. Kamera/Mic stoppen bei
Collapse, Abbruch, Gerätewechsel und Unmount. Späte Freigaben werden anhand
einer Requestgeneration gestoppt, ohne eine neuere Vorschau zu überschreiben.

Sechs neue UI-Gegenproben, insgesamt139/139 Webtests grün. Beide Builds und
Typecheck grün. M2/M3 ergänzen echte Chromium-Fake-Device-Aufnahme, getrennte
Tracks, Pegel, Testton, Collapse-Cleanup und echten Beitritt trotz verweigerter
Permission; insgesamt32 Browserfälle. Deren GitHub-Abnahme folgt am neuen Head.

Das ist ausdrücklich lokale Vorbereitung, kein Live-Transport und keine
serverseitige Voice-/Kamerafreigabe. MAIN/TEAM, Host-Mute/PTT, Gerätemanagement
während eines Live-Spiels, DISPLAY und persistente Assetjobs bleiben offen.
Kein Merge; Folgeänderungen weiterhin auf feature/pr19-media-voice sichern.

## Lokaler Sicherungspunkt / blockierte Übertragung

Produktcommit c17ea05 ist lokal vollständig gesichert, Working Tree danach
sauber.139 Webtests grün; gezielte sechs Capture-Gegenproben nach letzter
Cleanup-Korrektur erneut grün. Beide Builds und vollständiger Typecheck grün;
Lint0 Fehler/113 bestehende Warnungen.32 E2E-Fälle erfolgreich enumeriert,
M2/M3 noch NICHT ausgeführt.505 Server-/133 Webtests und30 E2E am unveränderten
Remote0934183 sind bestätigt; diese E2E-Abnahme gilt NICHT für c17ea05.

create_tree für Upload auf joern211/quiz-platform wurde durch die automatische
Freigabeprüfung zurückgewiesen: keine anerkannte ausdrückliche Autorisierung
für dieses neue Payload/Ziel im sichtbaren Transcript. Kein anderer Uploadweg
versucht. Vor Wiederholung Nutzerfreigabe für alle neuen lokalen Commits auf
feature/pr19-media-voice → https://github.com/joern211/quiz-platform.git einholen.
Nach Freigabe Remote-Head0934183 erneut abgleichen, lokalen Baum hochladen,
Commitobjekt mit Remote-Elterncommit erzeugen, Tree-SHA vergleichen und Ref
nur Fast-Forward mit expected_sha aktualisieren. Danach PR19 aktualisieren und
vollständige GitHub-CI/E2E am neuen Head abnehmen. Kein Merge.

## Paket5 — Live-WebRTC-Zwischenstand

Die frühere Pushsperre ist aufgehoben. Nutzerfreigabe26.10.; Remote d60f078
entspricht lokal5135371 exakt (Tree b12f7e2). Run40295048052 vollständig grün:
505 Server-/139 Webtests,32 Browserfälle; M2/M3 ohne Retry. Git-Note am lokalen
Head hält die API-Commitabbildung fest. Nächster Remote-Elterncommit d60f078.

Neu implementiert: serverseitig ausgegebene, widerrufbare unidirektionale
Audio-/Videorouten und echte WebRTC-Verbindungen. Consent gilt nur für den
aktuellen Raum/Socket. Aktuelle DB-Mitgliedschaft, Session, Admission, Team,
Host-Mute und Kamerafreigabe werden bei jeder Signalisierung erneut geprüft.
Viewer sind receive-only und erhalten nie TEAM-Audio. Nichtspielende Hosts
können einen Teamkanal moderieren; Spieler können keine fremden Teams wählen.
SDP darf exakt den erlaubten Medientyp in der erlaubten Richtung enthalten,
keinen zusätzlichen Video-/Datenkanal. Raumänderungen und periodische Prüfung
widerrufen Routen. Peerzustand/Consent sind flüchtig; Moderationssperren und
Raumpolicy sind additiv migriert und persistent/CAS-geschützt.

Persistentes Panel über Spielrouten: ausdrückliche separate Mic-/Camera-
Freigabe, Empfang nach Klick, Live-Gerätewechsel mit replaceTrack, PTT per
Touch/Leertaste mit Blur-/Visibility-Release, Sprecheranzeige, Viewer-MAIN-
Schalter, Host-Mute/Mute-All, Kameraverbergen und Bandbreitenwahl. Keine
Aufzeichnung/Screen-Sharing. Wiederverbinden verleiht keine neuen Kanalrechte.
RTC_ICE_SERVERS konfiguriert eigene STUN/TURN-Server; ohne Relay ist keine
universelle NAT-Erreichbarkeit versprochen. Kein neuer Drittanbieterdefault.

Sechs neue echte DB-/Socket-Fälle und drei Transport-Gegenproben;142 Webtests
grün. M4 ist als33. Browserfall vorbereitet und muss tatsächliche Audio-/Video-
Übertragung sowie Mute-/Team-/Kamerawiderruf beweisen. Vollständige CI/E2E am
Folge-Head noch ausstehend. DISPLAY und persistente Assetjobs/Varianten bleiben
als nächste Teile offen; Paket5 keinesfalls abgeschlossen melden.

## DISPLAY-Zugang ergänzt

Eigene persistente DISPLAY-Sitzungen, befristete raumgebundene HMAC-Links
(12 Stunden, Token im Fragment), mehrere Displays ohne Player-/Viewer-Slot.
Nur berechtigte Raumverwaltung erzeugt Links. Read-only gilt selbst mit
Hostcookie: Permission-Core und Raum-/Configbefehle bleiben gesperrt; keine
Umwandlung eines Display-Sockets durch room:subscribe. Ablauf/Disconnect/Close
entziehen die Sitzung. Eigene Großbildroute /raum/:code/broadcast verwendet
bestehende öffentliche Projektionen für Quiz/Jeopardy/WID, Scores/Timer und
die freigegebenen Kameras über den Live-Transport. Kein lokaler SessionStore-
Rollenwechsel zu HOST oder PLAYER. Großbildansicht besitzt keinen RoomPanel.

Zwei zusätzliche echte DB-/Socket-Fälle belegen Kapazitätsfreiheit, fremde/
manipulierte Links, Ownercookie ohne Rechte und echte laufende Quizfrage ohne
Lösung/Statistiken. M5 ergänzt Broadcast auf zwei Geräten und Reload. Insgesamt
34 Browserfälle aktiv. Vollständige Abnahme am neuen GitHub-Head steht aus.

Audio-Testisolation: die14 HTTP-/Decoder-Fälle erhalten einen eigenen temporären
Uploadordner. Der bisherige gemeinsame Ordner konnte noch Uploads anderer
Suiten enthalten; alle Orphan-/Timeout-Assertions bleiben unverändert. Danach
vollständige511 Server-/142 Webtests grün (vor DISPLAY-Ergänzung). Der folgende
vollständige Lauf umfasst513 Serverfälle. Persistente Assetjobs/Varianten sind
weiterhin offen; Paket5 noch nicht abgeschlossen.

Lokale Abnahme des kombinierten Live-/DISPLAY-Stands:513/513 Serverfälle
(60 Dateien),142/142 Webtests (28 Dateien), beide Builds und vollständiger
Typecheck grün; Lint0 Fehler/113 bestehende Warnungen.34 Browserfälle aktiv;
GitHub-Abnahme am neuen Remote-Head folgt. Keine offene lokale Produktarbeit
wird durch eine frühere CI-Prüfung als bereits browsergeprüft bezeichnet.

## Persistente Jobs, Varianten und restliche Gerätefunktionen lokal ergänzt

Live-/DISPLAY-Zwischenstand lokal b9ec43d (Tree ad483a9). create_tree wurde
von Auto-Review zurückgewiesen: frühere Freigabe gelte nur für die beiden alten
Commits, nicht für die neue Implementierung. Kein zweiter Uploadversuch oder
Ausweichweg. Die autorisierte lokale Arbeit wurde weitergeführt.

Neue additive Job-/Variantentabellen und ORIGINAL-Markierung. Beide Content-
Editoren nutzen /media/jobs, Polling, fragegebundene Wiederaufnahme/Retry und
Abort bei Wechsel. Multipart-Intent bleibt bei einem ungewissen Netzwerk-Retry
identisch. Worker startet im Produktionsserver, übernimmt abgelaufene Leases
per CAS, persistiert unveränderte Originale plus atomare geschützte Varianten,
trennt retryfähige Decoderfehler von REJECTED, und bereinigt alte unreferenzierte
Stagingbytes. Originale dürfen nie als Spielmedium ausgeliefert werden. Der
bestehende synchrone Legacy-/WID-Uploadpfad behält seine Decoder-/Dedupe-Semantik.

Live-Gerätewechsel, gerätebezogene Filter, unterstützte Lautsprecherauswahl mit
Standardfallback, Quality-Persistenz über neue Routen, Host-Mute-Capture-Abbruch
und PTT-Release weiter abgesichert. Optionale automatische TEAM-/PTT-Regeln
werden von echten Wissensduell- und Jeopardy-Zuständen abgeleitet; Pause hält
Beschränkungen, Ende kehrt zu MAIN zurück. Neue Frage-/Feldereignisse warten
auf die aktualisierte Medienprojektion.

Sechs Job-Integrationsfälle, zehn Live-/DISPLAY-Fälle, Transport-/Capture-/
Preference-/Intent-Tests. Vollständige Server-Suite521/521 (61 Dateien) grün;
Web147/147 (31 Dateien) grün. Nach letzten Audit-/UI-Nachträgen gezielte Jobsuite
6/6 erneut grün. Finalen Build/Typecheck/Lint nach Sicherung prüfen. C1/M1 sind
auf die echte Jobkette umgestellt; M4/M5 ergänzen die34 Browserfälle. Diese neuen
Browserwege wurden noch NICHT ausgeführt. Paket5-Abschluss bleibt ausdrücklich
bis zur CI-/Browserabnahme am gepushten Head offen. Matrix: acceptance.md.

Nächster Schritt: ausdrückliche Pushfreigabe für b9ec43d und den Folgecommit
nach https://github.com/joern211/quiz-platform.git, feature/pr19-media-voice,
einholen. Danach Remote d60f078 abgleichen, alle neuen Dateien gegenüber lokal
5135371 übertragen, Tree vergleichen, Remote-Commit mit Eltern d60f078 erzeugen
und Ref nur Fast-Forward mit expected_sha setzen. Vollständige CI/E2E abnehmen,
eventuelle Fehler beheben, PR19-Body um finalen Scope/Nachweise neu schreiben.
Keine eigenständigen Merges und keine früheren CI-Ergebnisse für neuen Code
als gültig darstellen.

## Freigabe umgesetzt / erste Browserabnahme und Korrektur

Nutzer erteilte ausdrücklich Pushfreigabe für b9ec43d/51ba101 sowie nötige
Paket5-Abnahmekorrekturen auf feature/pr19-media-voice → joern211/quiz-platform.
Der Blocker ist erledigt. Remote24d3cf7/17f0a2e entsprechen lokal b9ec43d/51ba101
exakt (finaler Baum4cadf25). Run40341975302: CI521 Server/147 Web/Build/Typecheck/
Lint grün. Browser32 bestanden, T1 Retry-grün, M4 nicht grün. DISPLAY M5 und
persistente Editor-Jobs C1/M1 sind bestanden. Keine Tests entfernt.

Logs und Traces tatsächlich gelesen: /tmp/quiz-pr19-e2e. M4 scheitert erst bei
getByLabel('Raumsprachkanal', exact:true), nachdem Audio, Kamera, Mute/Release
bereits bestanden. Selects bekommen explizite aria-labels, Browserfall bleibt
unverändert. T1 klickte Ready unmittelbar nach noch laufendem TEAM_SELECT;
eine Teamzuordnung setzt Ready zurück. Der Test wartet jetzt auf bestätigte
Mitgliedschaft im gewählten Team. Außerdem schließt ein echter Regressionstest
eine globale Snapshot-Lücke: während Subscription kann Ready geändert werden;
vorher wurde der alte Roster sogar nochmals mit einer erfundenen höheren
Revision verbreitet. Snapshot liest jetzt nach Admission frisch, gemeinsame
Raumprojektion übernimmt die anschließende Broadcastaktualisierung.

Gezielte Reconnect-Suite3/3 und Web148/148 grün, Typecheck grün. Vollständige
Serverregression und beide Builds/Lint vor Folgecommit prüfen. Remote-Eltern-
commit für die nächste API-Sicherung17f0a2ec20bccf7045e3a7a49fe6b279fb8f6b70.
Lokaler Elterncommit bleibt51ba101; Bäume gleich. Neue Dateien als Diff vom
lokalen Elterncommit übertragen, Tree vergleichen, nur FF mit expected_sha.
PR19 bleibt Draft, kein Merge. Finalen Status im PR-Body nach vollständiger
Abnahme des Folge-Heads festhalten; die ältere Pushblockade nicht erneut fragen.

Korrekturstand lokal vollständig geprüft:522/522 Server (61 Dateien),148/148
Webtests (31 Dateien), beide Builds und Typecheck grün, Lint0 Fehler/113
bestehende Warnungen. Nach Push folgt vollständige GitHub-Abnahme am neuen Head.
