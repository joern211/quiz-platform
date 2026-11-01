# N1 — Offene Schätz-mal-Entscheidungen

Nur Punkte, die für eine spätere Engine noch fehlen. **Master** = verbindlich festgelegt, **PR12** = unbestätigter Vorschlag (`docs/specs/pr12/…`). Keine erneute Frage zu Rollenmodell, Serverautorität oder Katalog (Master §14/§15.12 stehen fest: eigenständiges Spiel, numeric submissions, nearest-value rules, zentrale Score-/Result-Pfade).

| # | Thema | Stand | Empfehlung | Auswirkung auf die Engine (N1 liefert) |
|---|---|---|---|---|
| 1 | Wertungsmodus und Punktekurve (TIERED/LOGARITHMIC/LINEAR, 100/80/60/40/20/0) | PR12 (DEC-SCH-01), nicht freigegeben | erst Modus festlegen; Kurve als Engine-Konfiguration | N1 liefert nur Metriken und explizite Toleranzprüfung; Punkte nur über Score-Pfad |
| 2 | Relative Basis und Zielwert 0 | PR12 schlägt `absTiers`-Override vor | bei Ziel 0 ausdrücklich konfigurierte absolute Stufen verlangen | N1: relativ `UNDEFINED`, absolut immer berechenbar |
| 3 | Dezimalstellen je Item | PR12: 0–1 | 0–1 je Item im Content-Schema, pro Runde in Config pinnen | N1 unterstützt scale 0/1 |
| 4 | Einheiten-Hinweis (`showUnitHint`), Faktor („Mio.“) | PR12: true | Hinweis an, Faktor explizit je Item | N1: `unit.{label,factor}` als Metadaten, keine Konvertierung |
| 5 | Gleichstand bei gleicher Distanz/gleicher Stufe | PR12: gleiche Stufe = gleiche Punkte, kein Zeit-Breaker | so übernehmen, wenn bestätigt | N1: `groupByDistance` ohne Gewinner; Tie-Core kennt nur `ALLOW_TIE` im Einsatz |
| 6 | Ungültige Eingabe | PR12: „0 Punkte, `INVALID_SUBMISSION`“ — widerspricht Auftrag/Master-Prinzip technischer Ablehnung | technische Ablehnung mit erneuter Eingabe, solange Frist läuft | N1 lehnt ab, schreibt nie 0 Punkte |
| 7 | Nichtabgabe/Timeout | PR12: 0 | bestätigen | Engine entscheidet; N1 kennt keine Nichtabgabe-Wertung |
| 8 | Überpräzise Eingabe (Rundung) | offen | weiter ablehnen | N1 lehnt ab |
| 9 | Teamwertung (Durchschnitt) | PR12 | erst bei Teamunterstützung entscheiden | N1: keine Teamlogik |
| 10 | Fristen, Rundenzahl, Spielerlimits | PR12: 20 s, 8 Runden, 2–12 | als Konfiguration, nicht als N1-Default | Timer-Core vorhanden |
| 11 | Mitspielender Host und Sichtbarkeit des Zielwerts | PR12: erst nach Reveal | Master §2.2 (Admin ≠ Information) → Zielwert/Fremdabgaben erst nach Reveal | `projectNumericRound` kennt Host nur über Rolle `HOST`; Projektion des spielenden Hosts am echten Verbraucher festlegen |
| 12 | Reveal-Zeitpunkt der Fremdabgaben | offen | nach `INPUT_LOCKED` zusammen mit Zielwert | `revealed` ist Parameter der Projektion |
