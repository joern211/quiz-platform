# PR12 — Aktueller Handoff (10.10.2026)

PR12 ist eine Vorbereitung mit 19 Spielespezifikationen, keine Umsetzung neuer Engines.
[PR #12](https://github.com/joern211/quiz-platform/pull/12) bleibt auf Nutzerwunsch Draft; kein Merge.
Die frühere Aussage, die Matrix sei bereits vollständig atomar und alle übrigen Specs widerspruchsfrei, war zu weitgehend.

## Quellen und Vergleichsstände

- Verbindlich: Master Regelwerk, Stand 28.09.2026, vollständig gelesen (§1–20), und Nutzerergänzung Der Dümmste Fliegt.
- main-Istbasis: `411a5b783e5857bca5b208598fade43affc108b5`.
- Historischer, ausdrücklich separater PR11-Vergleich: `14708940246de105b83fdf69501ce373e2c48d21`.
- Ausgangsstand dieser Nacharbeit: PR12 `90ec1e1f5278cd0dcb3b82e29a3e5064270699e4`; gleichzeitig wurde PR11 ausgehend von `0a3a24e` separat korrigiert.
- Aktueller veröffentlichter Commit und CI-Lauf: GitHub-PR und dessen Checks. Dieses Dokument pinnt keinen erfundenen eigenen Commit.

## Korrekturen dieser Nacharbeit

- Alle 291 fachlichen Herkunftsgruppen auf 1292 Einzelanforderungen aufgeteilt; zusätzlich bleibt der Yacht-Split-Index erhalten. Das Herkunftsregister bewahrt die historischen 292 MR-IDs und ursprünglichen Befunde. Beide Tabellen sind gegenseitig zugeordnet.
- Elf Attribute je Einzelanforderung; Erfüllung nicht von einer gebündelten Gruppe übernommen. `M` bezeichnet historisch fehlende Umsetzung, `NV` eine nicht einzeln ausgeführte Runtime-Abnahme. AT-IDs sind geplante Tests.
- Viewer hört MAIN, niemals TEAM; kein Mic/Send, Host-Deaktivierung in allen 19 Specs und gemeinsamem Vertrag. Der alte pauschale Ausschluss aus Voice wurde präzisiert.
- Mikrofon: Master §7.21 empfiehlt ON, Kamera OFF; Host konfigurierbar, Prejoin-Bestätigung. Phasenbezogenes Mute bei Partner-Challenge ist ein expliziter Override.
- Gemeinsamer verbindlicher Fairness-Guard für alle 19 Engines; Vorschau niemals bei aktivem Host-Mitspiel, bekannte eigene Lösungen schließen Mitspiel aus. Wissensduell-Istbericht korrigiert: MODERATOR sieht Lösungen beim Resync, ist jedoch durch den Server vom Antworten ausgeschlossen; fairer Host-as-Player-Flow ist ein Ziel von PR37. Auch Millionenfrage/Wahr-oder-Fake/Schätz-mal auf diesen Vertrag präzisiert.
- Mitspielende Hosts erhalten bei Undercover und Geheim Agent keine fremden Rollen/Begriffe. Ansicht aller Secrets nur für nicht mitspielenden Host; unfaire Host-Alternative entfernt.
- Wer-ist-das: vollständiges Setup hebt das Ersteller-Gate nicht auf; falsches automatisches Host-Mitspiel entfernt. Anonyme Zweitidentitäten werden durch die Kontosperre nicht erkannt.
- Geheim Agent: optionale Voice konsistent mit Setup und Entscheidungsregister; erfundene Voice-Pflicht entfernt.
- Yacht: Solo ist FEST, Maximum 8 ist Vorschlag; keine erfundene Master-Begründung für dieses Maximum. Alle 17 Unterabschnitte erhalten korrekte Quellenverweise; Zusatzbonus/Joker-Prinzip bleibt FEST, nur konkrete zusätzliche Werte bleiben Vorschlag.
- DDF: Host bei eigenen/bekannten Fragen ausgeschlossen; bei unbekannten Poolfragen eigene Abgabe vor fremden Antworten locken. Judge arbeitet mit anonymen Antwort-IDs vor öffentlichem Reveal. Gleichzeitige Antworten können AUTO-Judge-Ties erzeugen; Tie-Vorschlag dokumentiert. Kein allgemeines Minusverbot behauptet. Ablaufbeispiel verwendet feste geometrische Fragen.
- Unbestätigte Detailvorschläge blockieren nur ihre spätere Implementierung. FEST-Fairness ist keine erneut offene Grundsatzfrage.
- DDF-AUTO benötigt gültige Matchingdaten; Zeitrangfolge und kumulative Survival-Punkte konsistent. Prozentdarstellung als Routineentscheidung mit zulässigen Nachkommastellen präzisiert.
- Stale Zahlen, Abschluss- und CI-Behauptungen in README, Handoff, Verifikation und PR-Beschreibung korrigiert.

## Nachweise und Grenzen

`python3 docs/implementation/pr12/check-docs.py` prüft ID-Eindeutigkeit, Herkunfts-/Kindabdeckung, elf Attribute, Statuswerte, alle 20 Masterabschnitte, 19 Engine-Verträge/Viewer-Policies und relative Dateilinks.
Strukturprüfungen beweisen weder vollständige semantische Fehlerfreiheit noch implementierte V1-Funktionen. Die Regeländerungen wurden manuell gegen die betreffenden Masterstellen geprüft; Beispiele gegen ihre eigenen Regeln.

Nach dem PR11-Merge folgt der in `dependencies-and-parallel-work.md` beschriebene neue main-Abgleich. Das ist ein späterer Integrationsschritt, keine vorweg behauptete Erledigung. Detailvorschläge bleiben ausdrücklich unbestätigt; ihre Umsetzung gehört in PR13+.
