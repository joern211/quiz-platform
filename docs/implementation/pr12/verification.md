# PR12 — Verifikation dieser Nacharbeit (10.10.2026)

## Ausgeführt

- `python3 docs/implementation/pr12/check-docs.py`: 1292 eindeutige Einzelanforderungen, 291 fachliche Herkunftsgruppen und ein Split-Index; alle 20 Masterabschnitte. Jede Einzelanforderung hat elf Attribute und eine geplante AT-Abnahme. Alle Eltern-/Kindzuordnungen erhalten.
- 19/19 Spielespezifikationen mit gemeinsamem Engine-Vertrag und verbindlicher Viewer-Policy; relative Dateilinks geprüft.
- Manuell: Master §2/§10 (Host-Fairness), §7.18/§7.21/§7.23 (Voice/Defaults/Viewer), §15.3/§15.9/§16 (Spiele) gegen relevante Spezifikationen und Entscheidungsregister gelesen. Widersprüche und unzulässige Alternativen korrigiert.
- Beispiele und Target-Guards der geänderten Spiele geprüft; keine Nutzerfreigabe für Vorschläge behauptet.
- PR12-Diff bleibt in den beiden Dokumentationsverzeichnissen. `check-docs.py` ist ein Dokumentationsprüfer, kein Anwendungscode.

## Getrennte Runtime-Nachweise

PR12 implementiert keine neue Engine. Die parallel ausgeführten PR11-Checks gehören zu PR11: Server-Suite, Web-Tests, Typecheck, Lint und Build. Eine grüne Doku-PR-CI ersetzt keinen fachlichen Regelabgleich. Aktuelle GitHub-Läufe sind im PR unter Checks verlinkt; hier werden keine historischen Zahlen als neue Ergebnisse ausgegeben.

## Geplant, nicht ausgeführt

Die AT-MR-IDs der Matrix und §11-Tests der Spiele sind Abnahmepläne für die jeweiligen Implementierungs-PRs. Ihre Existenz bedeutet nicht, dass diese Funktionen umgesetzt oder ihre Tests ausgeführt wurden. Die Strukturprüfung garantiert keine vollständige semantische Fehlerfreiheit.

Nach PR11-Merge: main-Istbasis, PR11-Spalte und Implementierungshinweise erneut abgleichen. Unbestätigte Detailvorschläge werden vor ihrer jeweiligen Umsetzung entschieden; feste Master-Regeln bleiben geschlossen. PR12 bleibt Draft, kein Merge.
