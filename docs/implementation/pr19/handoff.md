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
