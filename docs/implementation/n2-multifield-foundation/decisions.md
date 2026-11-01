# N2 — Offene Spielregeln

Nur Punkte, die für eine spätere Stadt-Land-Fluss-/Gleicher-Gedanke-Engine noch fehlen. **Master** = verbindlich festgelegt, **PR12** = unbestätigter Vorschlag (`docs/specs/pr12/…`). Keine erneute Frage zu Rollenmodell, Serverautorität oder Katalog: Master §15.10 legt Stadt, Land, Fluss als eigenes Spiel mit Kategorien, Submission, Timer, Answer Matching, Duplicate Detection, Synonym/Fuzzy, Auto/Manual Judge und Individualwertung fest; Details sind game-spezifisch. N2 liefert den Abgabevertrag, nicht diese Mechaniken.

| # | Thema | Stand | Empfehlung | Auswirkung auf die Engine (N2 liefert) |
|---|---|---|---|---|
| 1 | Kategoriensatz und -anzahl (PR12: S/L/F, ≤ 6) | PR12 (DEC-SLF-01) | als Engine-/Content-Konfiguration; nicht in N2-Defaults | N2: 1–12 Felder als Schutzgrenze, `fieldId` stabil |
| 2 | Punkte je gültiger Kategorie (PR12: +100) | PR12 | erst bestätigen, dann als Konfiguration | N2 schreibt nie Punkte |
| 3 | Duplikatregel (PR12: beide ungültig; Alternative: spätere/frühere verliert) | PR12 | Spielentscheidung vor der Engine | `findSharedAnswers` gruppiert nur (gleiche Runde + fieldId), kein Sieger |
| 4 | Serienbonus, Teamwertung (PR12: Summe bester Einträge) | PR12 | zunächst aus, Team später | keine Teamlogik in N2; Partner sieht fremde Karten nie |
| 5 | Pflicht eines Wortpools (PR12: Pool optional, sonst Manual-Judge) | PR12 | Manual-Fallback ohne Pool | Adapter: `NOT_CHECKED` ohne Referenz, `MANUAL_ONLY` → `NEEDS_JUDGE` |
| 6 | Match-Modus je Kategorie (PR12 für SAM: `EXACT_SYNONYM`) | PR12 (DEC-SAM-01) | EXACT/NORMALIZED/SYNONYM je Kategorie konfigurieren; FUZZY nur als Vorschlag | N2 pinnt Modus + Revision neben dem Ergebnis (Aufrufer) |
| 7 | Gültigkeit eines Wortes (Anfangsbuchstabe, Kategoriezugehörigkeit, Wörterbuch) | PR12 / offen | getrennte Prüfungen der Engine | N2: formal gültige Karte ≠ richtige Antwort; keine Buchstabenprüfung |
| 8 | Nichtabgabe/Leerfeld (PR12: „—“ erlaubt, 0 Punkte) | PR12 | `required` je Feld konfigurieren; Bewertung der Engine | N2: `null` ist die einzige Leerdarstellung |
| 9 | Fristen, Rundenzahl, Buchstabenquelle (PR12: 45 s, 5 Runden, Server-RNG) | PR12 | Konfiguration der Engine | Timer-Core vorhanden; Buchstabe nicht in N2 |
| 10 | Rundenende (STOP-Ruf o. Ä.) | offen | Engine-Phase; ruft `closeTextCardRound` | N2: `closeTextCardRound` ist der Lock |
| 11 | Reveal-Phase und Judge-Einsicht | offen | ausdrückliche Engine-Phase und Informationsregel | `projectTextCardRound(…, {revealed})`; Judge braucht `cardRef` |
| 12 | Mitspielender Host: Sichtbarkeit eigener Karte | Master §2.2 (Admin ≠ Information) | als PLAYER projizieren | Domain: Rolle `HOST` sieht nie PLAYER_PRIVATE |
| 13 | Nachträgliche Antwortänderung / Reopen | offen (nicht beschlossen) | nein | N2: Karte unveränderlich; Urteil nur idempotent, Korrektur über den zentralen Pfad |
| 14 | Unsichtbare Zeichen (ZWSP/ZWJ) und Lookalikes in Antworten | offen | bei Duplikat-/Matchregel mitentscheiden | N2 erlaubt sie (Emoji brauchen ZWJ); Modi entfernen sie nicht |
| 15 | Gleicher Gedanke: Teamgröße, Paarwechsel, Punkte, Nichtabgabe | PR12 (DEC-SAM-01) | gesondertes Paket | N2: private Partnerantworten bleiben getrennt; keine Paarlogik |
