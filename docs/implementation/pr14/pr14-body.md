Die bestehenden Spiele verwendeten unterschiedliche Rollen-, Command- und Konfigurationsverträge. PR14 führt die gemeinsame BASIS-STANDARDS-Grundlage ein und nutzt sie in den vorhandenen Socket-Flows: HOST-Rollen mit Bestandsmigration, Permission-Grants/Revoke, validierte Commands/Protokollversion, sichere Wiederholungen, Start-Snapshots, Fehler- und Manifestverträge.

Die Abschlussnacharbeit übernimmt beide letzten Hermes-Fixes und schließt die nachgewiesenen Lücken: Build ohne Frontend-Import im Server, Intent-Verbrauch bei endgültiger Ablehnung, Schutz vor verlorenen Receipt-Abschlüssen, persistenter Geo-Config-Fehler mit Rückmeldung für alle Rollen, korrekt bestätigtes Spielende/Replay sowie Ready erst nach bestätigtem Raumbeitritt. Alle drei PR14-Migrationen sind im echten Bestandsmigrations-/Rejoin-Test enthalten. WID verwendet den tatsächlich wirksamen dokumentierten 90-s-Testtimeout.

Prüfung:
- Lokal: Typecheck, Lint ohne Fehler, Server-/Web-Build erfolgreich.
- 334/334 Servertests und 76/76 Webtests, keine übersprungenen Tests.
- Frische DB, erneuter Deploy und Bestandsmigration mit WID-v1/v2-Rejoin und Receipt-Replay geprüft; PR12-Dokumentationschecker grün.
- GitHub am Produktcode-Head `c4bcc00`: CI erfolgreich, 18/18 E2E im ersten Versuch (keine Retries/Flakes/Skipped), [Nachweis](https://github.com/joern211/quiz-platform/actions/runs/39249235352). Auch der abschließende Dokumentations-Head wird vor Ready vollständig geprüft. Lokal verhindert die Ausführungsumgebung den Chromium-Start durch gesperrte Unix-Sockets; kein lokaler E2E-Pass wird behauptet.

Nachweise: docs/implementation/pr14/{acceptance,verification,compatibility,handoff}.md und evidence/audit-14-results.md.

Arbeitspaket: ursprünglicher Roadmap-Planplatz PR13. Vollständiges Team-/Room-Lifecycle, Co-Host-UI, Content-Editor, Voice/Display und neue Spiele bleiben Folgepakete; TEAM-ROOM ist weiterhin offen. Die vorhandenen AVAILABLE-Labels sind keine vollständige V1-Abnahme. Der Nutzer merged selbst.
