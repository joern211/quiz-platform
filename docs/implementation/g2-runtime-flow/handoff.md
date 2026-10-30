# G2 — Handoff

Basis: main `407117e6` mit gemergtem G1/PR22. Branch direkt darauf:
`feature/g2-runtime-flow`. [PR23](https://github.com/joern211/quiz-platform/pull/23).
Kein Merge durch Codex. Voller Umfang und Grenzen: [Matrix](matrix.md).

## Umsetzung

- Countdown-Extend/Resume kann abgelaufene Fristen bzw. null Restzeit nicht
  wieder öffnen; Elapsed wird an der Deadline begrenzt.
- Geo-Callbacks sind an Handle, Partie, Runde und Deadline gebunden. Die Engine
  prüft Deadline/Phase in der TX, Auto-Reveal bleibt auf dieselbe Runde begrenzt.
- Geo-Next öffnet mit einem State-CAS/Event. Fehler im Eventpfad rollen die
  gesamte Öffnung zurück; eine neue Absicht kann danach normal fortsetzen.
- Intro, Countdown und Zustandswechsel verwenden die bestehende reentrante
  Raumwarteschlange bis einschließlich Timerinstallation/-abbruch. Wiederherstellen
  liest den aktuellen State innerhalb dieser Lease; DB-Fences bleiben maßgeblich.
- Wiederherstellung deckt INTRO, alte PROMPT-Checkpoints, laufende Deadlines und
  abgelaufene INPUT_LOCKED-Checkpoints ab. PAUSED bewahrt sein Budget.
- 5050/Risk prüfen ihre Deadline an der eigenen Persistenzgrenze.

## Verbraucher und Abnahme

- 20 neue Engine-/Socket-/DB-Fälle; 5 echte Prozessneustartfälle; 3 neue
  Primitive-Grenzfälle: 28 zusätzliche Tests. Zwei echte Buzzer-/Antwortzug-
  Verbraucher (Jeopardy/WID), Timerverbraucher Wissensduell/Jeopardy.
- Belegt: konkurrierende Buzzes, Rejoin, Pause/Resume, aktueller Rechteentzug,
  unveränderte Roster-/Team-Ausschlüsse, einzelne Next-Writes, Receipt-Replay,
  Eventfehler-Rollback und Neustart ohne neue Frist/doppelte Punkte.
- Lokaler gezielter Bestand: 106 Prüfungen aus Runtime, G1 sowie PR14-/Config-/
  Receipt-Nacharbeiten erfolgreich. Anschließend neue Wiederherstellungstests
  separat ausgeführt. Typecheck, Lint (0 Fehler) und beide Builds geprüft.
- Zwischenstand `550c2c8` früh gepusht; dessen CI meldete zwei ungenutzte Variablen,
  die im anschließenden Verbraucher-/Abnahmestand bereinigt sind.
- Verbindlich für die Freigabe ist die CI/E2E am letzten Head von PR23; ein
  früherer grüner Lauf ist keine Abnahme für einen späteren Code-Head.

## Danach

G3 erst auf dem gemergten G2-Stand beginnen. Count-up, allgemeine Mehrspieler-
Zugzyklen und zusätzliche Timersteuerungen sind in der Matrix ehrlich H/S;
keine künstlichen Verbraucher, neuen Engines oder ungeprüften Spielregeln.
G4-Limits und G5-Gesamtabnahme bleiben eigenständig. Kein UI-Neudesign.
