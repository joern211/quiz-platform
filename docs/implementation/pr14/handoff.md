# BASIS-STANDARDS — Handoff, 20.10.2026

Maßgeblicher Abschlussumfang: [Review-Korrekturen vom 20.10.2026](review-fixes-2026-10-20.md).
Die acht Befunde am alten Head widerlegten dessen frühere Merge-Freigabe.
Die neue Freigabe verlangt CI und E2E am aktuellen Head.

Arbeitspaket: ursprünglicher Roadmap-Planplatz PR13. GitHub: **PR #14**,
`feature/pr14-foundation-standards`. main-Basis: `3dba9ff`.
Nächstes fachliches Paket: **TEAM-ROOM (Planplatz PR14)**, weiterhin offen.

## Maßgeblicher Stand

- Review-Basis `55f01a0`; aktuelle Nacharbeit: [acht Korrekturen und Nachweise](review-fixes-2026-10-20.md).
- Beide zuvor nur auf dem Audit-Branch gesicherten Commits `8a4398f` und
  `4a0e3ae` sind Vorfahren des PR-Heads; keine Arbeit wurde verworfen.
- Die Nacharbeit vom 20.10. ändert Laufzeitregeln und ergänzt die vierte und fünfte PR14-Migration.
- Nutzerauftrag vom 19.10.: PR fertigstellen, testen und mergebereit machen.
  Das ersetzt die alte Vorgabe, ihn auch nach erfolgreicher Abnahme dauerhaft
  Draft zu lassen. **Kein Merge durch den Agenten.**

## Abgeschlossene lokale Abnahme

Typecheck, Lint (0 Fehler / 117 bestehende Warnungen), Server- und Web-Build
sind erfolgreich. **359/359 Server-Tests (39 Dateien)** und **77/77 Web-Tests
(9 Dateien)** sind ausgeführt und grün, keine übersprungenen Tests.
Der PR12-Dokumentationschecker ist grün (1.292 IDs / 19 Spielverträge).
Frische DB: alle zehn Migrationen; erneuter Deploy: keine offenen Migrationen.
Bestandsmigration und echter WID-v1/v2-Rejoin sind in der Server-Suite enthalten.

Die vollständige Browserabnahme erfolgt in GitHub Actions. Lokal startet
Chromium wegen verbotener Unix-Sockets dieser Laufzeit nicht; das ist **kein
lokaler E2E-Pass**. Es wurden keine Pflicht-Tests deaktiviert. Maßgeblich sind
**CI und E2E am aktuellen PR-Head**, nicht grüne ältere Commits:
https://github.com/joern211/quiz-platform/pull/14/checks

## Inhalt der Abschlussnacharbeit

- Tatsächlich gemeinsame Intent-Verwaltung in shared, vom Frontend genutzt
  und über echte Sockets geprüft; kein Cross-App-Import im Server-Build.
- Definitives ACK verbraucht die Benutzerabsicht; verlorenes, ungültiges, noch
  laufendes oder explizit outcomeUnknown-ACK erhält sie. Verspätete ACKs verwerfen keine neue Absicht.
- Receipt-Recovery berücksichtigt Raum- **und** Spielzustandsrevision;
  abgeschlossene Wiederholung kommt vor Prüfung ihrer alten Versionserwartung.
- Ungültiger Geo-Snapshot führt ohne Default-Runde/Timer zu persistenter
  ERROR_RECOVERY-Anzeige für Host/Player/Viewer; Wiederanmeldung erhält sie.
- Game-Ende mit commandId speichert eine Erfolgsquittung; Retry bleibt ein
  erfolgreicher Replay statt einer Ablehnung nach bereits beendetem Spiel.
- Ready erst nach bestätigtem Raumbeitritt, keine parallelen Toggle-Requests.
- Alle fünf PR14-Migrationen in echter Bestandsmigration getestet;
  gemeinsame Rollen-Normalisierung auch im Permission-Guard.
- WID-Browsertest verwendet das tatsächlich wirksame test.setTimeout(90_000).

## Wiederaufnahme / Freigabe

`git fetch origin`, aktuellen PR-Head und seine Checks lesen. Bei einem roten
Check dessen Ursache beheben, passende Regression ausführen und denselben PR
aktualisieren. Erst bei erfolgreicher finaler CI/E2E Ready markieren. Kein
Force-Push, kein selbstständiger Merge und keine neuen Engines in diesem Paket.

Vollständiges Team-/Room-Lifecycle, Co-Host-UI, Content-Editor, Voice/Display,
allgemeine Retention/Jobs sowie vollständige V1-Results bleiben Folgepakete.
Die historischen PR12-Matrixzeilen sind keine aktuelle V1-Prozentanzeige.


## Historischer GitHub-Nachweis vom 19.10. (kein Nachweis für die neue Nacharbeit)

Am Code-/Test-Head `c4bcc00b79de3e5a72368e9a23707010fb2ebdcb` sind CI und
vollständige E2E erfolgreich: [Run 39249235352](https://github.com/joern211/quiz-platform/actions/runs/39249235352).
**18/18 Browserfälle im ersten Versuch bestanden**, keine Retries/Flakes,
keine übersprungenen Tests; WID W1–W10 in 9,7 s, Gesamtlauf 55,1 s.
Nachfolgende Dokumentationsänderungen erhalten vor der Freigabe ebenfalls
CI/E2E am exakten aktuellen PR-Head; deren Live-Nachweis steht in den PR-Checks.
