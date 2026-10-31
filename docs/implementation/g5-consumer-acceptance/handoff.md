# G5 — Handoff

Base: main `bafbc61`. Branch `claude/new-session-7pw835` (von der Umgebung vorgegeben statt `feature/g5-consumer-acceptance`). PR [joern211/quiz-platform#28](https://github.com/joern211/quiz-platform/pull/28).
Produktstand und Prüfbezug: [acceptance.md](acceptance.md) (maßgeblich). Spätere Commits sind Doku-only und dort als solche gekennzeichnet.

## Abgeschlossen
Basis-/Zugriffsprüfung; Baseline; zwei Testfehler repariert; Gegenfälle Admission, Recovery, 0 Punkte, sendeseitiger Medien-Neustart; **Nachbesserung nach Prüfbericht:** R1 (Core-Read-Vertrag und UI), R2 (Lobby-Warnung, Browser 360 px, Read-Last gemessen, WID in Contract-Suite), R3 (Matrix neu), PR-Beschreibung. Details: [review.md](review.md), [matrix.md](matrix.md).

## Offen / Grenzen
Siehe Abschnitt „Nicht geprüft / verbleibend“ in [review.md](review.md) und Abschlussliste in [matrix.md](matrix.md). Kein Merge durch Claude; Entscheidung zur Freigabe beim Nutzer.

## Risikoliste
ACK-Timeout `commandBoundary … wer-ist-das applies current abort authority…` (einmalig bei PR26-CI): in keinem G5-Lauf aufgetreten, Ursache unbelegt; bei Wiederauftreten als Befund untersuchen (Log/Receipt/Handler), nicht Timeout erhöhen.

## Fortsetzung in einem neuen Chat
Git/Remote und diese Dateien abgleichen; CI am PR-Head lesen; nur bei Befunden weiterarbeiten.
