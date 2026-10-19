# Audit PR14 — aktueller Abschlussnachweis

Stand 19.10.2026; Code/Teststand `c4bcc00b79de3e5a72368e9a23707010fb2ebdcb`.
Die beiden letzten Hermes-Commits `8a4398f` und `4a0e3ae` sind im PR enthalten.
Alte Aussagen zum Head `2e1055a` und zu ausschließlich lokaler Arbeit sind
historisch. Aktuelle lokale Prüfung: 334 Server-/76 Webtests, keine skipped.

| Auditpunkt | Fix und gezielte Gegenprobe |
|---|---|
| 14-01 | shared createCommandIntentClient, vom Frontend verwendet: endgültige ACKs verbrauchen Absicht; fehlende/ungültige/in-progress ACKs erhalten sie; verspätete ACKs löschen keine neue ID. Echte WID-Sockets öffnen → falsch bewerten → wieder öffnen; Frontend intentLifecycle; Reviewer prüft denselben shared Controller gegen reale Sockets. |
| 14-02 | runReceipted speichert Raum- und GameState-Revisionsbeobachtung. Nach verlorenem COMPLETED-Write verhindert ein fortgeschrittener Zustand erneute Mutation; Antwort verlangt Resync. Exklusives Takeover per Status/Lease-CAS. reviewer14 injiziert den Fehler nach echter WID-WRONG-Bewertung; der nächste Spieler verliert beim Retry keinen Punkt. |
| 14-03 | widersprüchliche IDs/Revisionen und ungültige Felder werden an Resolver und Socket-Adaptern abgelehnt. Replay abgeschlossener Commands wird vor der inzwischen veralteten Versionserwartung aufgelöst. Geo-/Jeopardy-/WID-Gegenproben. |
| 14-04 | kanonische Slugs/echte Engineversion und Setupwerte in Snapshots. Defekter Snapshot erzeugt persistente ERROR_RECOVERY statt Default-Timer. Host/Player/Viewer sehen Fehler auch nach Reload; Host kann ohne erste Frage beenden. audit14 + GeoRecovery. |
| 14-05 | Config-CAS und Write in einer Transaktion; Injektion nach CAS rollt Revision/Werte zurück. Kein erfolgreicher Start ohne Snapshot. config.integration + audit14. |
| 14-06 | Kick läuft durch PLAYER_MANAGE-Guard; Revoke wirkt bei bereits verbundenem Host. audit14 + permissions.integration. |
| 14-07 | aktueller datierter Main-/Paketabgleich, Planplatz PR13 = GitHub #14; TEAM-ROOM bleibt offen. Historische Matrixbasis ausdrücklich kein Live-Iststand; keine unbelegte Umbuchung von 1.292 Einzelanforderungen. |
| 14-08 | echte migrate-deploy-Tests: fünf Basismigrationen + alle drei PR14-Migrationen, erneuter Deploy, unveränderte Referenzen/IDs/Scores/Versionen; WID v1/v2 mit realem Rejoin; danach receipted game:end mit beforeStateRevision und Replay. |
| 14-09 | Handoff, Verification, Acceptance, Compatibility und PR-Text am aktuellen Scope ausgerichtet. Frühere Behauptung einer gemeinsamen Receipt-/Engine-Transaktion korrigiert: aktueller Socket-Wrapper nutzt eigene Engine-CAS-Transaktionen und konservative Revisions-/Lease-Recovery. |
| 14-10 | gemeinsame normalizeRole auch im Permission-Guard, keine zweite Prototype-anfällige Map. Unknown/constructor/__proto__/toString/hasOwnProperty werden an beiden Grenzen verworfen. |

Zusätzlicher Abnahmebefund: game:end mutierte erfolgreich, lieferte aber im
Receipt-Pfad eine Ablehnung (fehlendes success im toResponse). Korrigiert und
im Recovery- sowie Bestandsmigrationsflow mit gespeichertem COMPLETED-Receipt
und erfolgreichem Replay belegt. Ready wird erst nach Raum-Subscribe-ACK
freigeschaltet; zwei gezielte UI-Tests prüfen Ablehnung und erneuten Versuch.

## Grenzen der Nachweise

Lokale Browserausführung ist durch verbotene Unix-Sockets dieser Laufzeit
blockiert, bevor Anwendungscode geladen wird. Vollständiger Browsernachweis
ist die E2E-Suite in GitHub Actions. Maßgeblich sind CI und E2E am **aktuellen**
PR-Head: https://github.com/joern211/quiz-platform/pull/14/checks

Keine übersprungenen Pflicht-Tests und kein Übertragen eines grünen alten
Heads auf einen neueren. V1-Folgepakete bleiben wie in acceptance.md getrennt.


## GitHub-Nachweis des Produktcode-Heads

Am Code-/Test-Head `c4bcc00b79de3e5a72368e9a23707010fb2ebdcb` sind CI und
vollständige E2E erfolgreich: [Run 39249235352](https://github.com/joern211/quiz-platform/actions/runs/39249235352).
**18/18 Browserfälle im ersten Versuch bestanden**, keine Retries/Flakes,
keine übersprungenen Tests; WID W1–W10 in 9,7 s, Gesamtlauf 55,1 s.
Nachfolgende Dokumentationsänderungen erhalten vor der Freigabe ebenfalls
CI/E2E am exakten aktuellen PR-Head; deren Live-Nachweis steht in den PR-Checks.
