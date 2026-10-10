# PR12 — Entscheidungsregister

Zwei Klassen, klar getrennt:

1. **FACHLICHE NUTZERENTSCHEIDUNGEN** — brauchen eine explizite
   Nutzerfreigabe, bevor die betroffene Engine implementiert wird.
   (Keine erfundenen Freigaben: alle Vorschläge hier sind PR12-Entwürfe.)
2. **ROUTINE-ENTSCHEIDUNGEN** — aus bestehenden Regeln abgeleitet,
   vom PR12-Chat eigenständig zu treffen; Nutzer nur zur Kenntnis.

Jeder Eintrag: ID, Quelle, betroffen (Spiel/Core), Entscheidung,
empfohlener Vorschlag (Default), Alternativen, Folgen, Status.

**Klassen-Legende (12-06):**
- **FEST** — im Master/Bestand bereits entschieden; hier nur zur
  Kenntnis, **keine** Nutzerfreigabe erforderlich.
- **NUTZERERGÄNZUNG** — vom Nutzer bereits festgelegt (z. B. V1-Scope
  Master + DDF als 19. Spiel); keine erneute Frage.
- **VORSCHLAG** — PR12-Entwurf mit Default; erst nach widerspruchsfreier
  Ausarbeitung entscheidungsfähig.
- **OFFEN** — wirklich offenes Detail (keine Grundsatzfrage zu FESTen).

> **12-06 Regel:** Nur **wirklich offene Details** werden zur
> Entscheidung vorgelegt — keine pauschale Freigabe eines
> widersprüchlichen Default-Pakets. FESTe und NUTZERERGÄNZUNGEN stehen
> hier nur als Verweis, nicht als Frage.

---

## A. Fachliche Nutzerentscheidungen

### A1. Der Dümmste Fliegt (blockiert PR36)

| ID | Entscheidung | Empfohlener Vorschlag | Alternative | Folge bei Nichtbestätigung |
|---|---|---|---|---|
| DEC-DDF-01 | Slug | `der-duemmste-fliegt` | z. B. `der-duemmste-fliegt` (kann nur anders heißen, wenn Nutzer es möchte) | Kein Manifest-Eintrag, PR36 blockiert |
| DEC-DDF-02 | Grundmechanik + Spieleranzahl | Host-Judge-Runden, 4–10 Spieler, bis 2 übrig, dann Finale | Player-Voting statt Host-Judge; 3–12 | PR36 nicht startbar |
| DEC-DDF-03 | Fragenmodell + AUTO-Judge | HOST/POOL/BOTH; AUTO = falsch + längste Antwortzeit | nur Host-Fragen; AUTO nur Falschheit | PR36 nicht startbar |
| DEC-DDF-04 | Ties + Nichtabgabe | Voting-/AUTO-Tie = keine Elimination, nächste Runde; einzelne Nichtabgabe = ausgeschieden; mehrere Nichtabgaben = Tie | Stichentscheid; Nichtabgabe = nur 0 Punkte | PR36 nicht startbar |
| DEC-DDF-05 | Punkte | keine Punkte, nur Platzierung | +10 pro überlebter Runde | PR36 nicht startbar |
| DEC-DDF-06 | Ausgeschiedene + Host-Blind + Rejoin | Ausgeschiedene → Viewer-Modus; Rejoin übernimmt aktiv/ausgeschieden; mitspielender Host lockt eigene Antwort vor anonymem Judge, bekannte/eigene Fragen schließen Mitspiel aus | Ausgeschiedene → Raum verlassen; Namen im Judge nur bei nicht mitspielendem Host | PR36 nicht startbar |

> **Bündelungsempfehlung:** DEC-DDF-01…06 in **einer** Nutzerfrage
> klären (ein Vorschlagspaket mit Default-Werten, siehe
> `games/der-duemmste-fliegt-vorschlag.md`). Blockiert **nur** PR36 —
> alle übrigen PRs laufen unabhängig weiter.

### A2. Neun neue Engines mit Detailregeln (blockieren je PR21–34)

Für jedes Spiel ist **ein** Entscheidungs-Bündel offen (je eine ID):

| ID | Spiel (PR) | Kern der offenen Entscheidung | Empfohlener Default | Alternative |
|---|---|---|---|---|
| DEC-SNG-01 | Erkenne den Song (21) | Punktwerte, Reopen-Count, Ladefehler-Fallback, min/max | 3/1/0, 1 Reopen, FALLBACK nach 2 Retries, 2–12 | −1 bei falsch; 2 Reopens; SKIP_ROUND sofort |
| DEC-SPI-01 | Imposter (22) | Anonymisierung, Selbst-Vote, Tie, Duplikate, Nichtabgabe, min/max | anonymisiert ON, Selbst-Vote OFF, **Tie betrifft nur die Rundengewinnerfrage — die feste je-Stimme-Wertung (+1 korrekt / +1 pro getäuschtem Vote) gilt auch bei Gleichstand (FEST, Master §15.4; 12-03/E)**, Duplikat → erster Autor, Nichtabgabe = 0, 3–12 | Namenszuordnung ab Vote; Self-Vote ON |
| DEC-LMS-01 | Last Man Standing (23) | Timeout, Disconnect-Frist, Wiederholungen, gleichzeitiges Ausscheiden, min/max | Timeout=Pass, 30s Gnadenfrist, Wiederholung OK (nur Kategorie-Duplizität), letzter valider Zug, 3–12 | Timeout = sofort KO; 60s Gnadenfrist |
| DEC-HOL-01 | Higher or Lower (24) | Datenmodell (NUMERIC/RANKING), Tie-Content, Streak-Bonus, Reveal-Delay | NUMERIC+RANKING, Tie-Content = beide korrekt, +50 je 3, 1.5s | Tie-Content = kein Punkt; LOGARITHMIC-Scoring |
| DEC-TIM-01 | Timeline (25) | Teilwertungs-Formel, Ties, Speed-Bonus, Items/Runde | 20/Position + 50 full-correct, Tolerated Ties, Speed-Bonus optional, 5 Items | nur Vollwert (0/100); 4–7 Items |
| DEC-SCH-01 | Schätz mal (26) | Toleranz-Modus, Einheit-Hinweis, Gleichstand, Dezimalstellen | TIERED, showUnitHint=true, gleiche Tier = gleiche Punkte, 0–1 St | LOGARITHMIC; kein Hinweis (HARD) |
| DEC-MIL-01 | Millionenfrage (27) | Leiter-Größe, MC/verbal, Joker-Satz, Bank-Level, Punkte, Solo | 10 Stufen, MC 4-Option, 50:50+Expert+Zeit, Bank [3,6,9,10], [10..400], Solo ja (minPlayers=1) | 15 Stufen; verbal; Solo nein |
| DEC-WOF-01 | Wahr oder Fake? (28) | Punkte/Streak, WAHR/FAKE-Verhältnis, Quellen-Pflicht, Team-Mehrheit | 100/0/+50, 50/50, Quellen Pflicht (PUBLIC), Team = Mehrheit | −10 bei falsch; 40/60 |
| DEC-SLF-01 | Stadt, Land, Fluss (29) | Kategorien, Wertung, Duplikat, Serien-Bonus, Pool-Pflicht, Team | S/L/F + erweiterbar, 100, beide ungültig, Bonus OFF, Pool optional (Manual), Team = Summe | 4er-Kategorien; früherer Spieler verliert bei Duplikat |
| DEC-SAM-01 | Gleicher Gedanke (30) | Teamgröße, Paarwechsel, Scoring, Nichtabgabe, Match-Modus | 2er, optional rotierend, 100+50, Match nur bei 2 Abgaben, EXACT_SYNONYM | 3er-Teams; Partial-Credit |
| DEC-UND-01 | Undercover (32) | Undercover-Anzahl, Tie, Win nach max Runden, technische Blind-Host-Umsetzung (Fairness FEST), Hinweis-Regeln | 1 Undercover, Tie = keine Elimination, 3 Runden → Agenten, Host blind, 20 Zeichen | 2 Undercovers; Stichentscheid; Ansicht aller Rollen ausschließlich für nicht mitspielenden Host |
| DEC-AGT-01 | **Geheim Agent (33)** — am offensten | **Rollen-Satz, Win Conditions, Runden-Count, optionale Voice, technische Blind-Host-Umsetzung (Fairness FEST)** | V1: Agent+Undercover+Voice; Saboteur als Preset; 4 Runden; Voice optional; Host blind | Voll-Sat (Agent/Undercover/Saboteur) ab V1 |
| DEC-BRD-01 | Raus damit! (34) | Brettgröße, Figuren, Hit-Regel, Heimfeld-Regel, Teammodus, Sonderfelder | 24 Felder, 1 Figur, EXACT_HIT, EXACT_REMAIN, individuell, keine Sonderfelder | 40 Felder; 2 Figuren; ANY_OVERRUN |
| DEC-YAC-01 | Yacht (35) | Maximal 8 Spieler als V1-Vorschlag, Mehrfach-Yacht-Bonus, QUICK-Kategorien, Timer-Timeout bei Host-Ausfall (AVERAGE: **FEST später**, keine V1-Option — Master §16.4) | 2nd=25/3rd=50; QUICK=8 Kategorien; Auto-Skip 2×30s | QUICK=10; Sudden-Death-Default |
| DEC-PCH-01 | Wie weit gehst du? (31) | **Nur** Viewer-Task-Sichtbarkeit (2-Teams-Failure-Regel und >2-Teams-Bidding-Ende sind **FEST** per Master §15.9 — keine erneute Frage) | Viewer: Bids+Ziel ohne Task-Text | Viewer sieht Task-Text |

> **Bündelungsempfehlung:** je Spiel **eine** kompakte Frage mit dem
> Default-Paket (Vorschlag + Alternativen, 1–2 Zeilen je Punkt). Die
> Default-Werte sind so gewählt, dass sie aus dem Master-Prinzip und
> den bestehenden Engines abgeleitet sind — sie sind **brauchbar**,
> aber **nicht bestätigt**.

### A3. Bestands-Spiele (kleine Restentscheidungen)

| ID | Spiel (PR) | Entscheidung | Empfohlener Vorschlag | Alternative |
|---|---|---|---|---|
| DEC-JEO-01 | Jeopardy (37) | Host-Mitspiel bei Judge (Info-Vorteil durch sofortige Lösungsansicht) | **VORSCHLAG (12-05/F):** Host wird in eigenen Runden aus Buzzer-Pool ausgeschlossen (faire Rollenlösung ohne Rollenmodell-Bruch) | — **keine Alternative „Host darf mitbuzzen (Vorteil akzeptiert)"**: der Wissensvorteil ist keine freigabefähige Option; Verwaltung ≠ Gameplay-Information (FEST, Master §2/§10; 12-05/F) |
| DEC-JEO-02 | Jeopardy (37) | End-Tie | geteilte Plätze (ALLOW_TIE) | Tie-Breaker-Feld |
| DEC-JEO-03 | Jeopardy (37) | Auto-Judge bei Host-Ausfall | nein — Pause + Transfer | Auto-Judge nach 60s (CORRECT-Default) |
| DEC-KAT-01 | Wissensduell (37) | Buzzer-Option | OFF (MC-Duell), als Preset offen | Buzzer-Modus ab V1 |
| DEC-KAT-02 | Wissensduell (37) | Auto-Reveal nach Timer (Host-Ausfall) | ON (Option) | OFF (Pause) |
| DEC-WID-01 | Wer ist das? (11/37) | SYSTEM-Beispielpersonen | nein (Rechte) | ja, nur Demo |
| DEC-WID-02 | Wer ist das? | Echter Bild-Morph | **ausdrücklich später** (Master) | — |
| DEC-WID-03 | Wer ist das? | Originals nach Reveal | alle (PUBLIC), Master: „Reveal darf es zeigen" | nur Host |

### A4. Global / Plattform

> **12-06 Bereinigung:** DEC-ACC-01 ist **FEST** (Master §9.1 +
> Nutzerergänzung) und steht hier nur zur Kenntnis — **keine** Frage.
> DEC-EVT-01 betrifft nur **Details** bereits FESTer V1-Funktionen.

| ID | Bereich | Entscheidung | Empfohlener Vorschlag | Alternative |
|---|---|---|---|---|
| DEC-EVT-01 | Event/Olympia (38) | **Details** der FESTEN Bonus-/Joker-Funktionen (Master §8.18/§8.19: beides **konfigurierbare V1-Funktionen**, nicht ersatzlos streichbar) | Bonus-Spiele optional, Joker nur bei festgelegtem Spiel | Bonus-Spiele nur im Preset; Joker-Set pro Spiel konfigurierbar |
| DEC-ACC-01 | Accounts (39) | **FEST (Master §9.1):** Player/Viewer **ohne** Account (Gast); **Host mit** Account (Festlegung, nicht offen) | — (keine Nutzerentscheidung) | — |

---

## B. Routine-Entscheidungen (aus Regeln abgeleitet, PR12-treu)

Diese Punkte braucht der Nutzer **nicht** zu entscheiden; sie folgen aus
dem Master oder dem bestehenden Code:

| ID | Punkt | Ableitung |
|---|---|---|
| RUT-01 | `MODERATOR` → `HOST`, `ROOM` → `ROOM_TEMP` (Begriffsmigration G1) | Master §1/§7/§12 (Begriffe); Migration im PR10-Muster (atomar, idempotent, Refs stabil) |
| RUT-02 | `commandId` in Command-Envelope | Master §5.17/§10.6 (Replay-Duplikate) |
| RUT-03 | Error-Codes `messageKey`/`retryable`/`traceId` | Master §12.2 (explizit genannt) |
| RUT-04 | `protocolVersion=1` | Master §12.4 |
| RUT-05 | `RoomConfigSnapshot` (GameConfigSnapshot) | Master §5.24 |
| RUT-06 | `RoundResult`/`GameResult`/`ResultAmendment` | Master §5.9/§5.31 |
| RUT-07 | Eventpunkte decimal (Tie-Durchschnitt 4 = (5+3)/2) | Master §8.3 (Tie-Durchschnitt explizit) |
| RUT-08 | P2P-Mesh für WebRTC in V1 (kein SFU) | Master §7 (SFU/simulcast ausdrücklich später) |
| RUT-09 | In-Prozess-Backplane (1 Instanz) in V1 | Master §11.19 (eine Instanz okay) |
| RUT-10 | `der-duemmste-fliegt` als **Vorschlags-Slug** (nicht final) | ADD-DDF-01: Aufnahme fest, Slug-Vorschlag — Bestätigung DEC-DDF-01 |
| RUT-11 | DDD-Scorecard: `SHARED_SCORECARD` Default | Master §16.4 (Default explizit) |
| RUT-12 | DDF: Geo/Allgemeinwissen = Kategorien, keine Spiele | Master §14 (explizit) |
| RUT-13 | Host-Blind-Judge bei Jeopardy/Untercover/GeheimAgent/DDF | Master §2.1 (keine Informationsvorteile) + §15.3 (Wer-ist-das-Host-Gate als Vorbild) |
| RUT-14 | Turn-Order: random Start, reihum, Host editierbar | Master §5.6 + §16.6 (Yacht explizit) |
| RUT-15 | Score-Ledger: **keine** pauschale Ableitung eines globalen Minusverbots — „keine Minuspunkte" gilt **nur** für Wie weit gehst du (§15.9); Wer ist das? hat **fest −1** (§15.3), Jeopardy ist Ist ±½-Feldwert (12-05) | Master §15.9 (lokal) + §15.3 (Wer ist das? −1) + Jeopardy `contracts.ts` |
| RUT-16 | DEC-002: Host-Mitspiel-Einschränkung je Engine/Phase dokumentieren, ohne Rollenmodell zu ändern | Master §2.1 (keine Informationsvorteile); Umsetzung in den jeweiligen Spieledokumenten (DEC-JEO-01, DEC-UND-01, DEC-AGT-01, DEC-DDF-06, DEC-PCH-01); keine pauschale Rollen-Änderung |
| RUT-17 | DEC-003: Rejoin nach Kick/Ban (**12-06 korrigiert**) | `KICK` = Entfernen aus dem Raum, **Rejoin prinzipiell möglich** (Master §4.9); `BAN`/`BAN_ROOM` = Blockade, Rejoin verweigert bis Unban. Kein `banState` beim Kick; Ban-Audit + Unban-FLOW bleiben; nach Unban: normaler Rejoin mit frischem Rejoin-Token; keine automatische Re-Einladung |
| RUT-18 | DEC-STD-01: `percentage`-Darstellung (0–1 vs. 0–100) | **0–100 numerisch, Nachkommastellen erlaubt** intern + UI, Einheit `percentage`; rationale: konsistente Darstellbarkeit ohne Locale-Drift; API bleibt numerisch, Units-Label im Schema (`shared`-Glossar) |

---

## C. Konsolidierte Nutzer-Fragenliste (gebündelt, kurze Form)

**Frage 1 — Der Dümmste Fliegt (DDF-01…06):**
„Wir schlagen als Default vor: Slug `der-duemmste-fliegt`, 4–10
Spieler, Host-Judge-Runden (Host sieht anonymisierte Antworten),
Bis 2 übrig, dann Finale, keine Punkte (nur Platzierung),
ausgeschiedene Spieler werden Viewer, Nichtabgabe = ausgeschieden.
Bestätigen Sie dieses Paket oder möchten Sie einzelne Punkte ändern?"

**Frage 2 — Neue Engines (je 1 Satz, bei Bedarf einzeln):**
„Für jede der neuen Engines haben wir ein Default-Paket
(Details in den Spieledokumenten; Yacht und Partner-Challenge nur noch
in den in A2 verbleibenden Detailpunkten). Welche möchten Sie
übernehmen, welche möchten Sie anpassen?"

**Frage 3 — Bestands-Spiele (JEO/KAT/WID):**
„Jeopardy: Host wird in eigenen Runden aus Buzzer-Pool
ausgeschlossen; Wissensduell: Auto-Reveal ON; Wer-ist-das:
Originals nach Reveal = alle. OK?"

**Frage 4 — Event (Details) — Accounts KEINE Frage:**
„Event (Details der FESTen Funktionen): Bonus-Spiele optional, Joker
nur bei festgelegtem Spiel. Accounts: **FEST** — Player/Viewer ohne
Account, Host mit (Master §9.1), keine Entscheidung erforderlich."

> **Status-Regel:** Unbestätigte Detailvorschläge blockieren die jeweils
> abhängige Implementierung, nicht den Abschluss dieser Vorbereitung.
> PR12 dokumentiert Vorschläge und feste Regeln getrennt; es behauptet
> keine Nutzerfreigabe. Der Draft-Status bleibt auf Nutzerwunsch bestehen.
> FEST-Regeln wie die Fairness mitspielender Hosts werden nicht erneut zur
> Entscheidung gestellt. Der main-Abgleich folgt nach dem PR11-Merge.
