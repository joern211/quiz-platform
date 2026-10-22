# BASIS-STANDARDS — Abnahme im PR14-Scope

Maßgeblicher Abschlussumfang: [Review-Korrekturen vom 20.10.2026](review-fixes-2026-10-20.md).
Die acht Befunde am alten Head widerlegten dessen frühere Merge-Freigabe.
Die neue Freigabe verlangt CI und E2E am aktuellen Head.

Stand 20.10.2026. Grundlage: Master §1/§2/§5/§12/§13, ursprünglicher
Planplatz PR13. Dies ist keine pauschale Abnahme des gesamten V1-Regelwerks.
Aktueller Umfang: [Korrekturen vom 20.10.2026](review-fixes-2026-10-20.md); maßgeblich ist der veröffentlichte PR-Head.

| Bereich | Implementierter Umfang und Gegenprobe | Nachweis |
|---|---|---|
| A Rollen/Migration | ADMIN/HOST/PLAYER/VIEWER/DISPLAY zentral; MODERATOR nur Compatibility; unbekannte und Prototype-Rollen abgelehnt, Bestandsidentitäten bleiben | shared normalizeRole; permissions.ts; migration.roles.test.ts; migration.deploy.test.ts; audit14 14-10 |
| B Permissions | zentrale Defaultpakete ± persistierte Grants/Revoke; kritische Engine-/Lifecycle-/Kick-Aktionen autorisiert; Revoke wirkt bei verbundenem Socket; Grants geben keine zusätzlichen Secrets | permissions.integration.test.ts; audit14 14-06; Geo-/Jeopardy-Contracts; bestehende WID-Secret-Tests |
| C Commands/Receipts | strikt validierte IDs/Version/Feldkonflikte; persistenter Besitzer und Versions-CAS in Engine-Transaktionen; keine Übernahme nach committiertem Effekt; abgeschlossene Absicht replayt trotz eigener alter Revision; neue Absicht nach bestätigter Ablehnung | pr14-review-regression; commandContract.integration.test.ts; audit14; reviewer14; intentLifecycle.test.ts |
| D Fehler | AppError mit code/messageKey/traceId an umgestellten Grenzen, Legacy-Wire-Codes bleiben; keine SQL-/Pfad-/Stackdetails im neuen Clientfehler | appError.ts; compatibility.md; negative Socket-/Config-/Recovery-Gegenproben |
| E Konfiguration | sieben Ebenen als Resolververtrag, echte False/Zero-Werte, Start-Snapshots/Engineversion, Revision/CAS, kein Partial-Commit oder Default-Ersatz bei kaputtem Snapshot | config.integration.test.ts; audit14 14-04/05; GeoRecovery.test.tsx |
| F Manifest/Contract | gemeinsame Katalognormalisierung, Capabilities/Engineversion/Setup-Metadaten; generische Guards/Replay/Config-Contracts mit Geo und Jeopardy; WID-Regression | catalog-consistency.test.ts; games/contract; WID-Integration/Migration/E2E |
| Nacharbeit | fehlerhaftes game:end-ACK korrigiert; Ready wartet auf Membership; Server-Build ohne Frontend-Import; alle 5 PR14-Migrationen geprüft | audit14; migration.deploy; reviewer14; PlayerLobbyReady; Build/Typecheck |

Lokale Abnahme: **359 Servertests und 77 Webtests, 0 skipped**, Typecheck,
Lint ohne Fehler, beide Builds, frische/wiederholte und Bestandsmigration,
PR12-Dokumentationschecker. Details: [verification.md](verification.md).

GitHub-Abschlussgate: CI und vollständige E2E am exakten aktuellen PR-Head.
Die Live-Checks sind maßgeblich: https://github.com/joern211/quiz-platform/pull/14/checks
Lokal blockiert die Laufzeit Chromium vor der ersten Seite; kein lokaler
E2E-Erfolg wird behauptet. Ready erfolgt erst nach dem GitHub-Nachweis.

## Abgrenzung zu Folgepaketen

DISPLAY ist hier Rollen-/Permission-Vertrag, noch keine Broadcast-Oberfläche.
Co-Host-Bedienung und vollständiges Team-/Room-Lifecycle bleiben TEAM-ROOM.
HOST_DEFAULT/ROOM_TEMPLATE/GAME_PRESET sind Auflösungsverträge, ihre vollständigen
Editor-/Persistenzoberflächen folgen später. Die bestehenden Spiele werden
nicht allein durch diese Typen auf vollständigen V1-Status angehoben.

Die 1.292 historischen PR12-Matrixzeilen werden nicht ohne Einzelbeleg als
IMPLEMENTED umgebucht. Der datierte Main-Abgleich und diese konkrete
Paketabnahme dokumentieren die Änderung; keine V1-Prozentzahl wird daraus
abgeleitet. Ein full V1-/Team-/Voice-/Display-/Result-Core-DONE wird hier nicht
behauptet.


## Historischer GitHub-Nachweis vom 19.10. (kein Nachweis für die neue Nacharbeit)

Am Code-/Test-Head `c4bcc00b79de3e5a72368e9a23707010fb2ebdcb` sind CI und
vollständige E2E erfolgreich: [Run 39249235352](https://github.com/joern211/quiz-platform/actions/runs/39249235352).
**18/18 Browserfälle im ersten Versuch bestanden**, keine Retries/Flakes,
keine übersprungenen Tests; WID W1–W10 in 9,7 s, Gesamtlauf 55,1 s.
Nachfolgende Dokumentationsänderungen erhalten vor der Freigabe ebenfalls
CI/E2E am exakten aktuellen PR-Head; deren Live-Nachweis steht in den PR-Checks.
