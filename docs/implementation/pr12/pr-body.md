# PR12: Regelwerk-Mapping und Vorbereitung von 19 V1-Spielen

Dieser PR ordnet das Master-Regelwerk vom 28.09.2026 und die Nutzerergänzung Der Dümmste Fliegt den Anforderungen, gemeinsamen Verträgen, Spielespezifikationen und Folge-PRs zu. Er implementiert keine neuen Engines. Draft bleibt bestehen; kein Merge.

## Ergebnis der Nacharbeit

- **1292 Einzelanforderungen aus 291 fachlichen Herkunftsgruppen** über alle 20 Masterabschnitte, elf Attribute und geplante AT-Abnahme je Zeile. Historische **292 MR-IDs** einschließlich Yacht-Split-Index bleiben im neuen Herkunftsregister erhalten. Vollständige Eltern-/Kindzuordnung statt bloßer ID-Zählung.
- Historische Gruppenbefunde werden nicht als atomar verifizierte Umsetzung übernommen: M/NV getrennt, geplante Tests ausdrücklich nicht ausgeführt. Main-Istbasis `411a5b7`, alter PR11-Vergleich `1470894` separat; neuer main-Abgleich erst nach PR11-Merge.
- Gemeinsamer Engine-Vertrag und §13 in allen **19 Specs** mit Late Join, Ausscheidung, Rollen/Rotation, Recovery und Viewer-Policy. Viewer hört MAIN, niemals TEAM, sendet kein Audio; Host kann Viewer-Audio deaktivieren.
- Mikrofon ON/Kamera OFF als Master-Empfehlung, Host konfigurierbar und Prejoin-Bestätigung. Partner-Challenge-Mute als Phasen-Override; falscher pauschaler MUTED-Default entfernt.
- Bestehende Audit-Korrekturen erhalten: Yacht-Würfelsumme/Teamzug, Partner-Challenge-Rollen und feste Punkte, Imposter-Wertung je Vote auch bei Tie, Wer-ist-das-Ersteller-Gate, Jeopardy ±halber Wert und getrennte Frage/Lösung, Core-DoD/PR36-Scope.
- Gemeinsamer verbindlicher Host-Fairnessguard für alle 19 Engines; Vorschau gibt keinem mitspielenden Host zusätzliche Secrets. Wissensduell-Ist korrigiert: MODERATOR-Resync zeigt Lösungen, aber Antwort-/Joker-Guards erlauben nur PLAYER; fairer Host-as-Player-Flow bleibt Ziel PR37. Millionenfrage/Wahr-oder-Fake/Schätz-mal entsprechend präzisiert.
- Weitere Widersprüche korrigiert: kein fremdes Rollenwissen für mitspielende Undercover-/Geheim-Agent-Hosts; keine erfundene Voice-Pflicht; Wer-ist-das-Setup kann Ersteller-Gate nicht aufheben; Yacht-Maximum 8 bleibt Vorschlag.
- DDF-Vorschlag: kein Host-Mitspiel bei eigenen/bekannten Fragen, eigene Abgabe vor fremden Antworten locken, anonyme Judge-ID vor öffentlichem Reveal; mögliche AUTO-Judge-Ties behandelt und falsches allgemeines Minusverbot entfernt. Konkrete Mechanik bleibt unbestätigter Vorschlag.
- README, Handoff, Verifikation und diese PR-Beschreibung auf den tatsächlichen Umfang gebracht. FEST-Regeln werden nicht wieder geöffnet; Detailentscheidungen blockieren nur ihre spätere abhängige Implementierung.

## Validierung

`python3 docs/implementation/pr12/check-docs.py`: eindeutige IDs, vollständige Herkunfts-/Kindzuordnung, elf Attribute, Statuswerte, 20 Masterabschnitte, 19 Engine-Verträge/Viewer-Policies, relative Dateilinks. Manueller Regelvergleich der geänderten Host-/Voice-/Spielregeln gegen Master §2/§10, §7.18/§7.21/§7.23, §15/§16; Beispiele gegen eigene Vorschlagsregeln.

Diese Strukturchecks beweisen keine vollständige semantische Fehlerfreiheit und keine Runtime-Implementierung. Grüne GitHub-CI wird separat am veröffentlichten Head belegt. V1-Abnahmen AT-MR und Spiel-§11-Tests gehören in die Folge-PRs; sie sind hier geplant, nicht ausgeführt.

Handoff: `docs/implementation/pr12/handoff.md`; Verifikation: `docs/implementation/pr12/verification.md`. Nach späterem PR11-Merge folgt der dokumentierte main-Abgleich. Keine automatische Nutzerfreigabe für offene Vorschläge.
