# PR14 — Korrekturen nach dem vollständigen Review vom 19.10.2026

Stand: 20.10.2026. Review-Basis: `55f01a0eb653771bde1fbbecfea7492540e572b0`.
Der Nutzer hat die Behebung aller acht reproduzierten Befunde und die erforderliche
Nacharbeit beauftragt. Die frühere Merge-Freigabe ist durch das Review widerlegt;
für die neue Freigabe zählen die Prüfungen des aktuellen PR-Heads.

## Befunde und Nachweise

| ID | Reproduzierter Fehler | Korrektur | Regression |
|---|---|---|---|
| R1 / P1 | Lebender WID-Judge wird nach 3 s übernommen; alter Handler bewertet anschließend den nächsten Spieler | Persistenter executionToken; Engine-Schreibtransaktion und Receipt-Abschluss prüfen denselben Besitzer; mutationStartedAt verhindert Übernahme nach erstem Commit | pr14-review-regression: expired lease, delayed result, closed execution, takeover revisions |
| R2 / P1 | Antwort für Room-Revision 2 wird nach Wechsel auf Revision 4 der nächsten Frage zugeordnet | Versionsprüfung im Engine-CAS, einschließlich bedingtem Room-Write ohne Revisionserhöhung; schneller Vorabcheck allein ist kein Nachweis | delayed receipt claim und delayed engine entry, jeweils keine Antwort in Frage 2 |
| R3 / P1 | Config-Update bei defektem Snapshot beendet den Server ohne ACK | Vollständige Fehlergrenze im Config-Core und abgefangene Promise am Socket; CONFIG_SNAPSHOT_INVALID / RECOVERY_REQUIRED mit traceId | migration.deploy: echter separater Serverprozess liefert Fehler-ACK und bleibt gesund |
| R4 / P2 | WID open/hint, Geo-Joker oder Jeopardy judge/stealJudge können fremde Aktionsantwort replayen | Eindeutige Receipt-Aktionen; kein pauschales ROUND_ADVANCE für unbekannte Aktionen | Reale WID-, Geo- und Jeopardy-Sockets liefern COMMAND_CONFLICT |
| R5 / P2 | commandId:123 / stateVersion:"bad" beendet das Spiel ohne Receipt | Vorhandene Envelope-Felder werden vor Auswahl des Legacy-Pfads strikt validiert; keine still gestrichenen Typfehler | Lifecycle-Test und sieben weitere malformed-field-Gegenproben |
| R6 / P2 | Erfolgreicher Start replayt nach Spieler-Disconnect nicht mehr | Aktuelle Spieler-/Ready-/Status-Prüfungen nur in neuer Ausführung; abgeschlossene Antwort zuerst auflösen | Start → Disconnect → gleicher Command bleibt success + replayed |
| R7 / P2 | Timer 0 wird gespeichert und führt anschließend zu ERROR_RECOVERY | Aktuell ausführbarer Bereich 1..2147483647 ms am Writer; Resolver bewahrt weiterhin echte 0/false, er erklärt sie nicht automatisch zu gültigen Engine-Werten | Update 0 abgelehnt, anschließender normaler Start bleibt INPUT_OPEN |
| R8 / P2 | questionCount:1 im Snapshot, aber zwei tatsächliche Fragen | Initializer aller drei Spiele verwenden effektive Counts; Snapshot übernimmt den initialisierten Umfang; nicht vorhandene WID-Runden/Boards werden abgelehnt | Geo-Fragenzahl, WID-Ende nach einer Runde, Jeopardy-Registrierung/Resync/Ende mit einem Board |

## Transaktions- und Recovery-Grenze

Receipt und Engine werden weiterhin nicht nachträglich als eine einzige große
Transaktion bezeichnet. Jeder geroutete Engine-Write nutzt jedoch jetzt dieselbe
persistente Schreibsperre innerhalb seiner eigenen Transaktion:

1. Claim oder exklusiver Takeover erhält einen neuen zufälligen executionToken.
2. Shared-State-CAS, Initialisierung und Start-Übergang prüfen den Besitzer vor
   dem Schreiben. Die erwartete Room-Revision wird per bedingtem Write bis zum
   Transaktionsende gesperrt; ihre Nummer bleibt dabei unverändert.
3. Der erste erfolgreiche Engine-Commit setzt mutationStartedAt in derselben
   Transaktion. Ab dann darf Recovery diesen Command nicht erneut ausführen.
4. Ein übernommener Besitzer scheitert auch beim nachgelagerten Receipt-Write.
   Er überschreibt weder COMPLETED noch FAILED/REJECTED des neuen Besitzers.
5. Bei Recovery werden Room- und GameState-Beobachtungen auch im Mutations-CAS
   erneut geprüft. Ein anderer, inzwischen ausgeführter Command wird dadurch
   nicht irrtümlich als ursprünglicher Zustand verwendet.
6. Nach Ergebnis-Timeout ist die alte Ausführung geschlossen. Späte Engine-Writes
   sind gesperrt. Intro- und Runden-Timer laufen ausdrücklich außerhalb dieses
   Client-Command-Kontexts und behalten ihre eigenen Status-/CAS-Prüfungen.

Die additive Migration `20261020110000_command_execution_fence` ergänzt zwei
nullable Spalten. Bestehende IDs, Punkte, Sessions, Engine-Versionen und bereits
abgeschlossene Receipts werden nicht umgeschrieben. Unabgeschlossene Alteinträge
können nur bei unveränderten Revisionsbeobachtungen übernommen werden. Die früher
mehrdeutigen Aktionsklassen werden nicht geraten: Passt ein altes Receipt nicht
zur jetzt eindeutigen Aktion, wird es kontrolliert als Konflikt abgewiesen.

## Unklarer Receipt-Abschluss im Client

Ein fehlgeschlagener Receipt-Abschluss nach einem bereits committeten Effekt
ist keine definitive fachliche Ablehnung. Receipted Engine-/Lifecycle-Fehler
tragen deshalb outcomeUnknown:true. Der gemeinsame Client behält die ID bis zu
einem Replay oder einer definitiven Recovery-Antwort. Eine echte Socket-Gegenprobe
verbindet den Frontend-Controller mit einem verlorenen WID-COMPLETED-Write und
einem nachfolgenden zweiten Spieler: beide Versuche senden dieselbe ID, der
zweite Spieler behält seine Punkte. Eine Web-Regression prüft den ID-Lebenszyklus.

## Verifikation und Testkorrekturen

- 358/358 Servertests, 39/39 Dateien; 77/77 Webtests, 9/9 Dateien; keine skipped.
- 23 neue Socket-/DB-Regressionen plus ein neuer Test im separaten Serverprozess.
- Typecheck aller Pakete; Lint 0 Fehler / 117 bestehende Warnungen; beide Builds.
- Neun Migrationen frisch und erneut deploybar; alle vier PR14-Migrationen auf
  Bestandsdaten, echte alte WID-v1/v2-Sessions, Rejoin und Receipt-Replay.
- Der alte Test für zwei Fragen benutzte zweimal dieselbe ID. Er verwendet nun
  zwei echte Fragen und prüft auch den initialisierten State.
- Composite-Tests prüfen weiterhin das Fehlen eigener temporärer Dateien. Ihre
  Prüfung ist auf den zugehörigen Dateinamen begrenzt, damit parallele Tests
  anderer Assets keinen falschen Fehler auslösen. Keine Cleanup-Assertion wurde
  entfernt, kein Test deaktiviert und kein Testtimeout verlängert.
- PR12-Dokumentationschecker und git diff --check.

Lokale Umgebung: Node 24.19.0 / pnpm 9.12.0. Die verbindlichen CI- und vollständigen
Playwright-E2E-Prüfungen laufen mit Projekt-Node 22 am veröffentlichten PR-Head:
https://github.com/joern211/quiz-platform/pull/14/checks
Ready-/Merge-Empfehlung erst nach beiden grünen Jobs. Der Nutzer merged selbst.
Die lokale Chromium-Beschränkung aus verification.md ist unverändert.

BASIS-STANDARDS bleibt Roadmap-Planplatz PR13 / GitHub-PR14. TEAM-ROOM,
Co-Host-Oberfläche, Display/Voice und vollständige V1-Abnahme bleiben Folgepakete.
