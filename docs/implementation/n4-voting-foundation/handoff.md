# N4 — Übergabe

Stand: 01.11.2026 (nach Nachbesserung R1).

- **main** beim Start und bei der Übergabe geprüft: `7ce1a785206af69d72c7ff02d14ca188fc68a5f2` (N3 gemergt, N1-Anzeigefix `b72ac34` in der Basis nachgewiesen; N3-main-CI vorher grün). Einziger andere offene PR beim Start: #21 (historischer Plan-Draft, keine Basis).
- **Branch:** `claude/new-session-t4thly` (von der Sitzung vorgegeben, direkt von `main`). **PR:** [#33](https://github.com/joern211/quiz-platform/pull/33), Draft, gegen `main`.
- **Commits:** `c229094` (Audio-Test-Flake, eigener Commit) · `04f53b2` (Vertrag + Domain) · `7cb4569` (VoteForm + Harness) · `576b8a8` (Doku) · `292e003` (Eigenprüfung E3 + Test E2) · `458916d`/`a712bbe` (Doku) · **`fa19b89` (R1: erfolgreicher ACK ohne Ballotdaten bleibt nach dem Schluss bestätigt)** · `c48cc86` und danach nur Doku. **Code-Head: `fa19b89`.**
- **CI:** Lauf [41336455289](https://github.com/joern211/quiz-platform/actions/runs/41336455289) am Head `c48cc86` (Code `fa19b89`) — `CI` und `E2E` grün, erster Anlauf. Lokal am Code-Head: Server 958, Web 386, Browser 45, Typecheck/Lint/Build ok, Harness Exit 0 (`acceptance.md`). Der Lauf am allerletzten Doku-Head steht im PR.
- **Offene Jobs/Dateien:** keine. Keine temporären Prozesse (Harness-Server beendet), Arbeitsbaum sauber.

## Offene Beobachtung (vorbestehend, nicht N4)
`apps/server/src/media/live.integration.test.ts:217` ist ein vorbestehender Race-Flake (Details und Reproduktion in `review.md`, letzter Abschnitt); er hat einen CI-Lauf am Doku-Head rot gefärbt. Nicht in PR #33 behoben. Empfehlung: separater kleiner Testfix (`vi.waitFor` auf die neue Route-ID in der Sicht des Spielers).

## Nächste konkrete Aktion
1. PR #33 reviewen und selbst mergen (Claude merged nicht). Merge-Urteil für das **begrenzte Paket**: reviewbereit — alle Mindesttests, getrennte Eigenprüfung und CI/E2E grün; unvollständig bleibt bewusst die Runtime-Integration.
2. Danach — nur nach Freigabe der jeweiligen Spielregel (DEC-SPI-01 / DEC-UND-01 / DEC-AGT-01) — der erste echte Verbraucher nach der Reihenfolge in `design.md` §6, inklusive Socket-/DB-/Neustart-/Rejoin-/Recovery-/Secret-/Browsernachweis und `createStateEvent`/CAS/Receipt-Verdrahtung. Erst mit zwei echten Engines ist Master §13.2 für dieses Core-Modul erfüllbar.

## Ehrliche Grenze
0 echte neue Engine-Verbraucher; keine Katalogfreischaltung, keine Route, kein `vote.cast`/`vote:submit`, keine Rollen-/Eliminierungs-/Spielpunktefunktion, keine still bestätigten DEC-Regeln. Vollständige Core-DoD (Permissions, Persistenz, Rejoin/Resync/Recovery, Monitoring, zwei Engines) offen.
