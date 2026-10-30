# G2 — Mechanikabgleich (in Arbeit)

Grundlagen: bestehende Registry, G1-Matrix, `docs/specs/pr12/technical-mapping.md`
und die drei vorhandenen Spielespezifikationen. Die historischen PR12-Istspalten
sind kein aktueller Runtime-Nachweis. Dies ist kein neuer vollständiger Master-Audit.

| Mechanik | Echter Verbraucher | Eingangs-/Persistenzgrenze | Prüfstand |
| --- | --- | --- | --- |
| Countdown, exakte Deadline | Wissensduell | CoreTimer / submitOnce, Engine-TX / State-CAS, gespeicherter Endzeitpunkt | neue Grenzprüfungen grün |
| Pause/Resume | Wissensduell; Jeopardy/WID | GAME_PAUSE, aktuelle Phase/Rechte, persistierter Timer bzw. vollständiger Pause-State | Geo grün; zwei untimed Verbraucher noch in Abnahme |
| Intro/Deadline nach Restart | Wissensduell | laufende Partie/Engine-Version/Phase; gespeicherte Frist, keine neue Dauer | In-process Restore grün; Prozessnachweis folgt |
| Buzzer, Gewinner, Antwortzug | Jeopardy und WID | BUZZER_CONTROL, aktiver Roster, erste angenommene Serverankunft, CAS/Event | neue Verbraucherabnahme folgt |
| Team-Roster, Ausschlüsse, Wiederöffnung | Jeopardy und WID | gespeicherte Auswahl/Teamzuordnung; Rejoin lost nicht neu aus | neue Verbraucherabnahme folgt |
| Atomarer Rundenwechsel | alle drei Engines | ROUND_ADVANCE, Abschlussphase, Runtime resetten / Scores erhalten, CAS/Event | Geo jetzt ein Write; Jeopardy/WID folgen |
| Count-up, allgemeine Zugzyklen | noch kein vollständiger realer Verbraucher | vorhandene Primitive sind kein vollständiger Laufzeitanschluss | H/S, kein künstlicher Verbraucher |
