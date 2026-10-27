# Content / Editor — Abnahme und Grenzen

Master-Regelwerk 28.09.2026, §6. Dieses Dokument ist eine aktuelle
Implementierungsabgrenzung, keine pauschale Erfüllungserklärung für §6.
Die konkret benannten offenen Vorlagen-, BLIND_HOST- und Schnellstart-Wege
sind implementiert. Nachfolgende Cores bleiben separat abgegrenzt.

| Bereich | Reales Verhalten | Nachweis / Grenze |
|---|---|---|
| Pools / Ownership | PRIVATE, ausdrücklich ausgewählte SHARED-Editoren, PUBLIC nach ADMIN-Freigabe; SYSTEM nur Admin-editierbar; Fork nach PRIVATE | content.integration.test.ts: fremde Ressourcen/Revisionen verborgen, deaktivierte Accounts, Access-Revoke, private DRAFT-Kopie |
| Gemeinsamer Editor | Wissensduell + Jeopardy, Quick/Advanced, explizites READY, Autosave, Quellen/Lizenz/Sprache/Difficulty/Tags | ContentEditor.test.tsx: Autosave, Save-in-flight, kein Auto-READY, Read-only, Spiel-spezifische Felder |
| Revision / Konflikt | CAS, immutable Revisionen, Vergleich; fremde Fassung übernehmen oder eigenen Entwurf ausdrücklich auf geprüfter aktueller Revision speichern | echte HTTP/DB-Tests für Stale/Restore/DB-Trigger; UI prüft neue Basisrevision |
| Snapshots / Consumer | serverseitige berechtigte Auswahl und ContentUse in derselben Raum-Transaktion; konkrete Payloads + Item-/Poolrevision; Änderungen beeinflussen Partie nicht | echte game:start-, Buzz-/Judge-/Reveal-Commands beider Engines; unveränderliche Uses |
| Auswahl / Repeat | Multi-Pool, feste Counts je Pool, Sprache, Difficulty, Tags, Kategorie; NO_REPEAT_IN_ROOM, PREFER_UNSEEN, ALLOW_REPEATS | HTTP/DB-Fälle für Count/Filter/Version; echter Rematch mit Erschöpfung/Rollback; Event-Regel erst mit Event-Core |
| Import / Export | JSON1, CSV, XLSX; persistierte Preview; New/Exact/Similar/Conflict/Invalid; Entscheidungen pro Zeile/Tag; DRAFT-only, Stale-Fence, Receipts | Roundtrip in beiden Schemas; Formel-/Format-Ablehnung; keine Writes vor Commit; keine stillen Updates |
| Public Review | Quellen-/Lizenz-/READY-Gate, Pool-Sperre, nur ADMIN final; Gameplay-Vorschlag lässt publiziertes Original bis Entscheidung unverändert | echte HTTP-/DB-Reapproval-Fälle, C2-Browser von Dateiimport bis ADMIN-Freigabe |
| Spieler-Korrekturen | stabile Teilnehmer-ID + Rejoin-Token; nur gespeicherte Auflösungs-Evidenz; Vorschlag/Inbox, Owner-/Admin-Entscheid | zwei echte Engine-Consumer; vor Reveal leer, künftige Fragen verborgen, falsche Tokens/Expired verweigert; alte Snapshots bleiben erhalten |
| Qualität / Kommentare / Locks | konkrete Status-Counts/Gründe, Inbox, interne Kommentar-Endpunkte, manuelle und Review-Sperren | HTTP/DB-Nachweis; Kommentar-/Lock-/Usage-UI ist angebunden; empirische Statistik folgt separat |
| Browser / Regression | 29 Browserfälle aktiv; C6 Difficulty, C7 vollständige Vorlagen, C8 BLIND_HOST, C9 Schnellstart | Aktueller CI/E2E-Head ist verbindlich; Ergebnisse älterer Heads gelten nicht automatisch für neue Commits |

## Nachfolgende Cores und optionale Erweiterungen

- Eigene nachfolgende Cores: vollständige Übersetzungsentitäten/zentraler UI-
  Sprachwechsel, empirische Content-Statistiken sowie Betriebs-Retention/Quotas.
- Vollständige Audio-Decodierung/Normalisierung und erweiterte Medienfelder
  gehören zum Medien-/Voice-Paket. Optionale Custom-Felder, Feldsets, AI und
  geplantes Publishing werden nicht als bereits implementiert behauptet.

Die früher hier offenen Zusammenarbeit-, Bulk-, Medien-, Vorlagen-, Review-,
Playtest-, Difficulty- und BLIND_HOST-Wege sind in den Ergänzungen unten mit
ihren konkreten Nachweisen und Grenzen beschrieben.

## Wiederaufnahme

Siehe handoff.md und ../roadmap-execution/handoff.md. Alle Arbeit liegt auf
feature/pr18-content-editor, gestapelt auf PR17. Push autorisiert; kein Merge.

## Ergänzung: Zusammenarbeit und Sammelaktionen

- Multi-Select/Impact/Bestätigung, Tags/Difficulty/Status/Move/Copy:
  echte HTTP-/DB-Gegenproben für Revisionskonflikte, Locks, fremde IDs,
  entzogene Grants, Receipt-Replay, neue Copy-IDs und erhaltene Snapshots.
- Concurrent-Editor-Anzeige: echte Sessions,45s Ablauf, deaktivierte und
  widerrufene Zugriffe. Zwei gleichzeitig schreibende Editoren ergeben
  einen409-Konflikt ohne stilles Overwrite. Keine pessimistische Sperre.
- UI für interne Kommentare, manuelle Sperren und historische Verwendung.
  Öffentliche Leserechte liefern keine internen Editorial-/Raumdaten.
- C3 ergänzt die Browserabnahme um echte zwei Tabs und Sammelarchivierung.
  Diese neuen Funktionen ersetzen keine weiterhin offenen §6-Bereiche oben.

## Ergänzung: Medienreferenzen und tatsächliche Delivery

Bild-/Audiorefs und strukturierte Rechte sind im Schema, Editor,
JSON/CSV/XLSX und bei READY/Selection/Preflight verbunden. DB-Referenzen
sind historisch geschützt. Echte HTTP-/Socket-Gegenproben für beide Engines
prüfen aktive/future Medien, Asset-/Run-/Room-Signaturfences, Zugriffsentzug,
ungeprüfte alte Drafts und identische gepinnte Medien nach Editoränderung.
Eine echte Altbestandsmigration erhält Medien in neuer DRAFT-Revision;
Originalrevision, Optionsdaten, Benutzeränderungen und private Eigentums-
grenzen bleiben erhalten. C1 deckt echten Upload/Vorschau in beiden Editoren ab.

Die oben genannte offene Medienintegration ist damit für diesen beschriebenen
Pfad implementiert. Vollständige Audio-Decodierung/Normalisierung und weitere
Legacy-Optionsfelder/erweiterte Medienmodelle werden damit nicht als DONE
behauptet. Laufzeitdaten/History bekommen keine rückwirkende Secretfreigabe.

## Ergänzung: Fragenvorlagen und Review-Arbeitsschritte

SYSTEM-Quickvorlagen und eigene Fragevorlagen erzeugen neue DRAFTs mit
Revision-/Receipt-/Ownership-Grenzen für beide unterstützten Spiele.
Vollständige Spiel-Presets und Room-Templates sind separat unten ergänzt.
Prüfaufgaben sind versionsgebunden und geben beim Abschluss nichts frei.
Die Einzelprüfung besitzt Original/Vorschlag, Skip/Next, Begründung,
Tastaturbefehle und kontogebundenen Cursor. C4 ergänzt den realen Browserweg.

Öffentliche Leser erhalten keine internen Pending-Proposals, alten privaten
Draftversionen oder nach Scopewechsel unzulässigen Receipt-Antworten. Diese
Gegenproben sind echte HTTP-/DB-Fälle. Globale Publikationsrechte bleiben
unverändert: Public-Finalentscheidung ausschließlich ADMIN.

## Ergänzung: temporärer Fragen-Playtest

PLAYTEST startet aus dem Editor mit gespeicherter Revision, auch DRAFT.
Temporärer Gerätecode, vier Perspektiven, explizite Auflösung, Testantworten,
Zeitgrenze und private Fehler-/Warnmeldung sind verbunden. Originalfragen
bleiben unverändert. Echte HTTP-/DB-Gegenproben belegen keine normalen
Räume/Teilnahmen/ScoreEvents/Ergebnisse/ContentUses sowie Revisions-, Rollen-,
Ablauf-, Zugriffs- und Mediengrenzen. Invalide Optionsmetadaten werden auch
im alten Vorschauendpunkt nicht mehr ungefiltert an Leser weitergegeben.

Der Fragenplaytest ist keine vollständige Multiplayer-Engine-Simulation;
Jeopardy-Buzzer/Steal/Judge sind hier nicht nachgebaut. C5 hat am gesicherten Head5ac3566 mit allen25 Browserfällen bestanden;
CI476 Server-/120 Webtests ebenfalls grün (Run40226692379).

## Ergänzung: Difficulty-Verläufe (§6.13)

Prozentverteilungen werden über größte Reste exakt auf ganze Fragen verteilt;
Rundenbereiche decken die gesamte gewählte Fragenzahl lückenlos ab. Steigend
passt EASY/MEDIUM/HARD-Bereiche an die Fragenzahl an. SYSTEM- und private
Host-Schwierigkeitsvorlagen sind auswählbar, privat speicherbar und per CAS
archivierbar. Die gewählte Konfiguration wird als Wert in der Raumkonfiguration
und die konkrete Reihenfolge in ContentUse gespeichert; spätere Vorlagen-/
Fragenänderungen verändern sie nicht. Keine automatische Difficulty-Zuweisung.

Mehrere Pools, feste Pool-Counts, Sprach-/Tag-/Kategoriefilter und Repeat-Regeln
bleiben wirksam. Die gemeinsame Zuteilung erfüllt beide Quoten und bevorzugt
unter PREFER_UNSEEN global ungesehene Fragen. Nicht erfüllbare Anforderungen
brechen die gesamte Raumerstellung vor Writes ab, ohne stillen Fallback.
Jeopardy unterstützt Prozentverteilungen; lineare Rundenverläufe würden die
Boardreihenfolge falsch abbilden und werden dort ausdrücklich abgewiesen.

Schwierigkeitsvorlagen speichern keine vollständigen Spielkonfigurationen.
Spiel-Presets/Room-Templates sind separat unten implementiert. C6 ergänzt den
Browserweg vom Verlauf über eigene Vorlage zur echten Raumerstellung.

## Ergänzung: Spiel-Presets und Raumvorlagen

Für Wissensduell/Jeopardy sind komplette vorbereitete Konfigurationen privat
speicherbar, favoritisierbar, versioniert aktualisierbar und archivierbar.
SYSTEM/private Raumvorlagen ergänzen Raum-/Team-/Zugangs-/Sprachdefaults und
bevorzugte Presets. Explizite Übernahme mit lokalen Änderungen, kein Speichern
von PINs/Tokens. Serverseitige CAS/Grant-Prüfung vor atomarer Raumerstellung;
Quellen und wirksame Werte werden festgehalten. Neue Vorlagenfassungen ändern
keine laufende Partie. GAME_PRESET-Herkunft ist im echten Start nachgewiesen.

Die Aufnahme von weiteren Medien-/Voice-/Display-Feldern richtet sich nach deren
verfügbaren Cores. Eine Vorlage schaltet keine bisher nicht implementierte
Funktion frei. C7 ergänzt den realen Browserweg; BLIND_HOST folgt im
separaten Nachweis unten.

## Ergänzung: BLIND_HOST

BLIND_HOST ist für zufällige Poolauswahl von Wissensduell/Jeopardy nutzbar.
Persistierter Raummodus, aktuelle Rolle und serverseitige Projektionen gelten
auch nach Pause/Rejoin/Recovery. Keine Lösungen oder privaten Antwortstatistiken
vor tatsächlicher Auflösung; keine künftigen Items/Medien im Client. Manuelle
Auswahl bleibt unzulässig. Die Grenzen umfassen zusätzlich Editor, Exporte,
Draft-Setups, private Host-/Editor-URLs und ältere Playtest-Links. Andere eigene
aktive Räume sind ausgeschlossen, um keine parallele Vorschau als Oracle zu
öffnen. Bestehende Secret-Kenntnis wird nie durch einen Rollenwechsel gelöscht.

Sechs echte DB/HTTP/Socket-Fälle decken diese Grenzen und die Freigabe nach Close
ab. Normales HOST_PREVIEW bleibt verfügbar. Bereits gelerntes Vorwissen oder
Absprachen außerhalb der Anwendung sind kein durch Software löschbares Wissen.
Wer-ist-das wird nicht fälschlich als BLIND_HOST-fähiger Content-Editor beworben.
C8 ergänzt den UI-Weg. Head85f4ae4: GitHub-CI und alle28 Browserfälle grün
(Run40252335244). Der zusätzliche echte RESTORE_REPLAY-Fall prüft einen
absichtlich beschädigten Zustand, den wiederhergestellten Pausezustand und
die weiterhin gefilterte Hostprojektion vor regulärem Reveal.


## Ergänzung: geführter Schnellstart (§6.51)

Sieben Schritte für Wissensduell/Jeopardy: Spiel, Pools/Themen, Difficulty,
Fragen/Runden, zentrale Optionen, Teams/Spieler, Prüfung/Raumerstellung.
Bestehende Schemas, Poolfilter und Raumvorlagen werden gemeinsam verwendet.
Explizite Werte bleiben beim Zurückgehen und bei späteren Defaultänderungen
erhalten. Manuelle Board-Presets verweisen ausdrücklich zur erweiterten
Vorbereitung. Der normale serverseitige Snapshot-/Preflight-Pfad bleibt gültig.
Doppelklick ist gesperrt; ein unbestätigter Netzwerkfehler wird mit demselben
Idempotenzschlüssel wiederholt. Geänderte Vorbereitung erzeugt einen neuen.

132 Webtests inklusive vollständigem Ablauf und Netzwerk-Retry sind lokal
grün. C9 führt durch alle Schritte zu einer echten Lobby. Die abschließende
CI-/Browserprüfung am neuen Head wird im PR festgehalten.
