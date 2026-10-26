# Paket 5 — Implementierung und Abnahme

Stand 26.10.2026. Lokal implementiert; finale GitHub-/Browserabnahme der neuen
Live-/DISPLAY-/Jobfunktionen bleibt Voraussetzung für den Paketabschluss.
PR19 bleibt Draft, gestapelt auf PR18; kein Merge durch den Agenten.

| Bereich | Implementierung | Nachweis / Grenze |
|---|---|---|
| Upload / Decoder | MP3/WAV/M4A/AAC/OGG vollständig decodieren, Lautstärke normalisieren, Metadaten entfernen, Grenzen für Größe/Dauer/Prozesse | 14 echte Audiofälle, bestehende Runtime-Consumer beider Quizspiele |
| Persistente Jobs | QUEUED/PROCESSING/READY/FAILED/REJECTED, DB-Lease mit Token-Fence, Wiederaufnahme nach Ablauf, Eigentums-/Intentprüfung, bewusster Retry | 6 echte HTTP-/DB-/Prozessfälle inklusive separatem Prisma-Client als Worker-Neustart und konkurrierender Übernahme |
| Original / Varianten | unveränderte Originalbytes, separates WEB/THUMBNAIL/NORMALIZED_AUDIO, geschützte Provenienz; Original nur als autorisierter Download | FK-Schutz, atomarer Variantensatz, keine Originale als Content-/Spielmedium; alte Assets unverändert |
| Editoranbindung | beide Frageneditoren nutzen Jobs, Polling, Status/Retry, Wiederaufnahme je gespeicherter Frage, Abbruch beim Wechsel | Multipart-/Abort-/Intent-Tests; C1/M1 prüfen neue echte Jobkette im Browser |
| Live-Transport | echte WebRTC-Tracks über getrennte unidirektionale Audio-/Videorouten, aktuelle serverseitige Signalisierungsrechte | 10 Live-Integrationstests, Transporttests; M4 muss tatsächlichen Browserempfang bestätigen |
| MAIN / TEAM | Teamzugehörigkeit aus DB, Viewer nie TEAM; nichtspielender Host hört einen gewählten Teamkanal | echte Routen-, Teamwechsel- und veraltete Signalisierungsproben |
| Phasenregeln | explizite Raumoptionen für TEAM/PTT während aktiver Runde; Pause behält Einschränkungen | echte gestartete Wissensduell-/Jeopardy-Partien einschließlich Pause, Resume und Ende |
| Host-Mute | persistente Sperre, Mute-All, kein Self-Unmute, Freigabe aktiviert keine Hardware | echte Rejoin-/DB-Gegenprobe und UI-Test für verspätete Gerätefreigabe |
| Kamera | Nutzerfreigabe getrennt von Mic, Host kann Sichtbarkeit entziehen, keine fremde Hardwareaktivierung | separate Videorouten, Snapshot-/Permission-Gates, neutrale Initialen bei Kamera aus |
| PTT / Sprecher | Desktop-Leertaste, Touch-Halten, Release bei Blur/Visibility/Pointerverlust; parallele Sprecher mit Pegelanzeige | Servergate, Capture-/Transporttests; Browsernachweis am neuen Head offen |
| Geräte / Filter | gespeicherte Inputgeräte, fehlendes Gerät fällt zurück, Live-Switch per replaceTrack, Filter je Mikrofon | Prejoin-/Preference-Tests; Lautsprecherauswahl nur bei Browserunterstützung von setSinkId |
| Rejoin | neue Socketidentität, neue autorisierte Routen, erneute Mitgliedschafts-/Session-/Teamprüfung; keine automatische Hardwarefreigabe durch Host | echte Replacement-/Mute-/Session-Revoke-Tests |
| Viewer | receive-only, MAIN abschaltbar, freigegebene Kamera unabhängig von Voice | echte DB-/Socket-Proben; M4 |
| DISPLAY | eigene persistente Sitzung, 12h-Raumlink im URL-Fragment, keine Player-/Viewer-Belegung; read-only auch mit Hostcookie | echte gestartete Quizprojektion ohne Lösung/Stats; M5 mit zwei Displays/Reload |
| Großbild | eigene Route für öffentliche Projektionen von Wissensduell/Jeopardy/WID, Scores/Timer und Live-Medien | Typecheck und öffentliche Consumer; vollständige Browserabnahme offen |
| Bandbreite | WebRTC-Kongestionsregelung, AUTO/DATA_SAVER/HIGH_QUALITY, reduzierte/pausierte Videocodierung bei verborgenem Tab | Senderparameter; kein SFU-/Simulcast-System behauptet |

## Betrieb und Grenzen

- HTTPS beziehungsweise localhost ist Voraussetzung für Browser-Capture.
- `RTC_ICE_SERVERS` konfiguriert eigene STUN/TURN-Server. Für Verbindungen über
  unterschiedliche NAT-/Firewall-Netze wird ein erreichbarer Relaydienst
  benötigt. Es wurde kein fremder Dienstkonto- oder Infrastrukturvertrag erstellt.
- P2P-Mesh ist für kleine Räume; kein SFU und kein Nachweis für Großveranstaltungen.
- Keine Aufzeichnung oder Bildschirmfreigabe: im Master separate spätere/optionale
  Features, nicht Voraussetzung dieses Paketabschlusses.
- Allgemeine Storage-Quotas, langfristige Retention und Malware-Scanner gehören
  zu späteren Betriebserweiterungen. Die neue Bereinigung betrifft nur eigene,
  alte, nachweislich unreferenzierte Job-Stagingdateien.

## Stand der finalen Abnahme

Pushfreigabe für die neuen Commits und nötige Abnahmekorrekturen ist erteilt.
Die lokalen Commits b9ec43d/51ba101 sind mit identischen Bäumen als24d3cf7/
17f0a2e auf feature/pr19-media-voice gesichert. Run40341975302 bestätigte
521 Server-/147 Webtests, Migrationen/Builds/Typecheck/Lint. Im Browser bestanden
32 Fälle; T1 war Retry-grün, M4 scheiterte an der exakten Kanalbeschriftung,
nach bereits erfolgreichem echten Audio-/Video-/Mute-Weg. M5 DISPLAY und die
beiden Editor-/Medienjobwege bestanden.

Die Folgekorektur ergänzt explizite Select-Beschriftungen. T1 wartet auf die
bestätigte Teamzuordnung, bevor Ready gesendet wird. Raumaufnahmen lesen nach
Admission den aktuellen committed Roster und verwenden keine erfundene Revision
für eine veraltete zweite Broadcastaufnahme. Neue Server-/UI-Gegenproben sind
aktiv; alle34 Browserfälle bleiben unverändert verpflichtend. Der aktuelle
Abnahmestand am tatsächlichen Folge-Head wird verbindlich im PR19-Body mit
Run-Link festgehalten. Kein früheres Ergebnis gilt automatisch für neueren Code.
