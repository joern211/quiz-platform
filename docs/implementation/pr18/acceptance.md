# Content / Editor — Abnahme und Grenzen

Master-Regelwerk 28.09.2026, §6. Dieses Dokument ist eine aktuelle
Implementierungsabgrenzung, keine pauschale Erfüllungserklärung für §6.
Punkt4 des autorisierten Fünf-Schritte-Plans bleibt in Arbeit.

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
| Qualität / Kommentare / Locks | konkrete Status-Counts/Gründe, Inbox, interne Kommentar-Endpunkte, manuelle und Review-Sperren | HTTP/DB-Nachweis; weitere UI für Kommentar-/Lock-/Usage-Arbeit offen |
| Browser / Regression | Alle bestehenden 20 Browserfälle bleiben aktiv; C1 ergänzt beide Editoren/Setups; C2 ergänzt Import/Public Review | Aktueller CI/E2E-Head ist verbindlich; Ergebnisse älterer Heads gelten nicht automatisch für neue Commits |

## Noch nicht DONE

- BLIND_HOST: bisher ausdrücklich nicht auswählbar. Erfordert vollständige
  Informationsgrenzen über Pool-Lesewege, Start, Projektion, Host-Mitspiel,
  Judge/Co-Host und Recovery; keine Freigabe nur wegen UI-Schalter.
- Vollständige Difficulty-Progression, Host-Templates/Presets, Room-Templates,
  definierter Quick-Setup-Ablauf und optionale erweiterte Feldmodelle.
- Concurrent-Editor-Anzeige, Bulk-Workflows, Playtest, Review-Assignments,
  Keyboard-/Batch-Review und alle übrigen verbindlichen §6-Abnahmen.
- Vollständige Übersetzungsentitäten und Content-Statistik-Regeln mit ihren
  späteren Cores; die jetzige Sprachwahl ist kein vollständiges i18n-System.
- Medienreferenzen im neuen Modell/Editor/Import und Delivery/READY-Prüfung
  vervollständigen. Legacy-Daten sind unverändert vorhanden; neue Kopien
  werden hier noch nicht als verlustfrei/fertig erklärt.
- Retention/Quotas/Cleanup mit dem Betriebs-Paket; keine automatische Löschung
  historischer Daten oder unfreigegebener Drafts eingeführt.

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
Spiel-Presets und Room-Templates sind dadurch noch nicht implementiert.
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
Jeopardy-Buzzer/Steal/Judge sind hier nicht nachgebaut. C5 für den realen
Browserweg ist erstellt und gelistet, am neuen Head noch nicht ausgeführt.
Push aktuell durch automatische Freigabeprüfung blockiert, lokal gesichert.
