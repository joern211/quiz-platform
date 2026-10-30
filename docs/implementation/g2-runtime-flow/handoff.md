# G2 — Arbeitsstand

Basis: main `407117e6` mit gemergtem G1/PR22. Branch direkt darauf:
`feature/g2-runtime-flow`. Kein Merge durch Codex.

## Umfang

Countdown/Pause/Resume/Expiry/Restart in Wissensduell sowie unbegrenzte
Antwortzeit, Buzzer-/Teamroster und Antwortzüge in Jeopardy/WID absichern.
Gemeinsame Primitive und bestehende Engine-/CAS-/Receipt-/Eventpfade bleiben
maßgeblich. Keine neuen Spiele oder erfundenen Detailregeln.

## Zwischenstand 1

- Neue Regressionen belegen: vorzeitiger/veralteter Geo-Callback, Wiederaufnahme
  von INTRO/PROMPT, mehrfaches Öffnen derselben Runde, zweistufiger Next-Write,
  Joker nach Deadline und Wiederbelebung eines abgelaufenen Countdown per Extend.
- Fix: Callbacks an Handle, Partie, Runde und Deadline gebunden; Deadlineprüfung
  und Close in der Engine-TX; Auto-Reveal an dieselbe abgelaufene Runde gebunden.
- Geo-Rundenwechsel öffnet mit einem State-CAS/Event. Alte PROMPT-Checkpoints und
  unterbrochene Intros werden beim Wiederherstellen berücksichtigt.
- Geo verwendet die bestehende reentrante Raumwarteschlange auch für Installation/
  Abbruch nativer Timer und zugehörige Zustandswechsel. Die DB-Fences bleiben
  maßgeblich über mehrere Prozesse hinweg. Joker prüfen die Frist vor Persistenz.
- Lokal: 10 neue Socket-/DB-Regressionen + Timer-Regression grün; bestehende vier
  Primitive-Tests ebenfalls grün. Typecheck und beide Builds erfolgreich.

## Noch zu erledigen

- Rejoin/Pause/Resume, konkurrierendes Buzzern, Ausschlüsse/Roster und atomaren
  Rundenwechsel mit Jeopardy und WID als zwei echten Verbrauchern abnehmen.
- Echte Prozessneustarts einschließlich aktiver, pausierter und offline abgelaufener
  Geo-Deadline belegen; aktuelle Projektionen und einmalige Punktewirkung prüfen.
- Finale Mechanik-/Aktionsmatrix, gezielte betroffene Regressionen sowie vollständige
  CI/E2E-Abnahme am letzten Head. Erst dann Ready-for-review.
- Count-up, allgemeine Mehrspieler-Zugzyklen und zusätzliche Timeraktionen bleiben
  Hilfs-/spätere Bausteine, solange passende reale Verbraucher fehlen.
