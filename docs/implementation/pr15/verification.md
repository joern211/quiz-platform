# PR15 — Verifikation

## Nachprüfung öffentliche Raumliste — 24.10.2026

API und UI verwenden einen gemeinsamen PublicRoomSummary-Vertrag. Belegung
zählt aktive Player (auch bei vorübergehendem Disconnect), keine Wartenden,
abgelehnten oder entfernten Identitäten. Aktive Zuschauer werden über beide
Bestandsmodelle gezählt. Entwürfe/abgelaufene/geschlossene Räume sind verborgen;
geplante/gesperrte Räume und Pause werden korrekt angezeigt. Eintrittsaktionen
berücksichtigen Zugang, Kapazität, Warteliste und Late Join. PINs/Setup/Tokens
verlassen diese Projektion nicht.

Lokal: **386/386 Servertests**, **83/83 Webtests**, Typecheck und beide Builds
grün; Lint 0 Fehler / 115 Warnungen. Neue HTTP-Abnahme deckt echten DB-Zustand,
Lifecycle, beide Viewer-Modelle, Belegung und Secrets ab; drei UI-Tests prüfen
Arrayvertrag, Navigation, Zugangsstatus und Fehler/Retry. Neuer Browserfall R1
prüft echte öffentliche Liste → Beitritt → Warteliste → Kick/Belegung.

Der lokale Chromium-Download liefert ein unvollständiges ZIP und ist
fehlgeschlagen. Kein lokaler E2E-Pass. Finale Freigabe erst nach CI/E2E am neuen
GitHub-Head. Historische Nachweise unten gelten für den früheren Umfang.

Erster Nacharbeitslauf am Head 15941e9: CI grün, 19 bestehende E2E grün;
neuer R1 zunächst rot, weil der HTTP-Read direkt nach dem UI-Klick mit dem
noch laufenden Kick-Command konkurrierte. R1 wartet nun ohne feste Schlafzeit
auf dessen echten DB-Effekt. Die Erwartung 1/2 und alle Prüfungen bleiben
unverändert. Aktueller vollständiger Lauf bleibt vor Freigabe verbindlich.

Freigabebedingung: erfolgreiche CI und vollständige E2E am aktuellen PR-Head.
Maßgeblich ist der aktuelle [GitHub-Check](https://github.com/joern211/quiz-platform/pull/15/checks);
die PR-Beschreibung hält den zuletzt vollständig verifizierten Head und Run fest.

Bisherige lokale vollständige Regression: 385 Servertests / 40 Dateien,
80 Webtests / 10 Dateien; keine Skips. Build/Typecheck erfolgreich. Lint:
0 Fehler, 116 Warnungen. Neue Änderungen erhalten passende Wiederholung.

26 neue echte Room-/Team-Integrationstests und 3 UI-Tests prüfen u. a.:
parallelen letzten Slot, eindeutige Namen, Warte-/Freigabestatus, PIN-Trennung,
einmalige Einladungen, Teams/Rotation, Ready/Blocker, Geräteübernahme,
Tokenrotation, Kick/Ban/Unban, Co-Host-Entzug, Host-Transfer/Failover,
Late Join, Teamwertung und Rematch in zwei Engines, exakte Pause/Resume,
Viewer-Freigabe, Gast-Ban, Spielwechsel und endgültigen Close.

Frische DB: elf additive Migrationen. Bestandsmigration mit echten alten
WID-v1/v2-Rejoins bleibt in der vollständigen Suite enthalten. PR12-Checker:
1292 atomare IDs, 291 Quellgruppen, 20 Masterabschnitte, 19 Spielverträge.

Lokaler Chromium-Start ist derzeit nicht möglich: passende Browserdatei
fehlt, Browserdownload scheitert an den Netzbeschränkungen. Der lokale
Browserversuch ist fehlgeschlagen und zählt nicht als E2E-Nachweis.
GitHub führt die 18 bestehenden Fälle plus den neuen TEAM-ROOM-Browserfall
(T1: Freigabe, Teamwahl, Start, Pause, Reconnect, Rematch, Close) aus.

Die Browserinstallation hat eine explizite Zehn-Minuten-Grenze. Infrastrukturfehler
werden als Fehler gewertet; ein älterer grüner Run ersetzt keine aktuelle Abnahme.

GitHub-Abnahme fand unter Last konkurrierender Joins SQLite-Transaktions-Timeouts.
Gleiche Räume werden nun bereits vor dem Öffnen der Transaktion sequenziert;
DB-Unique/Revision/Receipt-Fences bleiben bestehen. Der Produktions-Rate-Limiter
und echte parallele Joins werden unverändert nachgewiesen.

Der alte Medien-Audit zählte Dateien im gemeinsam genutzten Upload-Verzeichnis.
Ein paralleles Cleanup einer anderen Suite änderte die Anzahl trotz korrektem
Composite. Die Suite verwendet jetzt ihren eigenen temporären Upload-Ordner;
alle ursprünglichen Orphan-/Datei-/Byte-Prüfungen bleiben vollständig erhalten.

Informationshistorie ist von Verwaltungsrechten getrennt: Wer bereits die
HOST-Informationsrolle innehatte, erhält nach Transfer keine neue PLAYER-
Identität im selben Raum. Eine vorherige PLAYER-/VIEWER-Rolle wird bei der
Übernahme nicht zur geheimnisberechtigten HOST-Rolle. Beide Richtungen sind
über echte Sockets geprüft.

Auch die ursprüngliche Raumerstellungsabsicht bleibt nach Host-Transfer stabil:
createdByUserId ist unveränderlich; Replay liefert denselben Raum und niemals
ein Verwaltungs-Token des neuen Hosts oder eine neue HOST-Informationsrolle.
