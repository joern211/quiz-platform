# Last Man Standing (`last-man-standing`) — Spezifikation

**Status main:** PLANNED, keine Engine. **Ziel-PR:** PR23 (nach PR14–18).
**Slug FEST** (§14/§15.6).

## 1. Kurzbeschreibung & Regelquellen

Kategoriespiel mit fester Turn Order: in jeder Runde wird ein Kategorie/
Begriff angezeigt; Spieler antworten **im Zug** mit einzigartigen, gültigen
Antworten; wer keine gültige/nicht-doppelte Antwort findet, verliert ein
Leben; das letzte „stehende" Team/der letzte Spieler gewinnt.

- FEST §15.6: Kategorie/Begriff, feste Turn Order, einzigartige gültige
  Antworten, konfigurierbare Leben, Ausscheidung, zentraler
  Turn-/Submission-/Judge-Core.
- OFFEN: Timeout-Verhalten, Wiederholungen, Disconnect im Zug,
  Endbedingungen → DEC-LMS-01.

## 2. Feste Regeln

- Feste Turn Order (Turn-Core, §5.6) — Start zufällig oder Host-Wahl,
  dann reihum.
- Antwort muss (a) zur Kategorie passen und (b) in der Runde noch nicht
  verwendet sein (Answer-Matching + Duplicate Detection, §5.12).
- Lebens-System: konfigurierbar (`lives`, default 3), verliert 1 bei
  ungültiger Antwort, Duplikat, Timeout oder Pass.
- Ausscheidung: Leben = 0 → aus (KO); letzte Person/das letzte Team
  ohne Leben-Verlust in der Runde gewinnt bzw. letzter Überlebender.
- Submission-/Matching-/Judge: Server prüft (normalisiert), Host kann
  override (Auto-Judge mit Synonymen als Default).

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 3 / 12 (Vorschlag) | V |
| Teams | optional (Team-Antworten = gemeinsame Dosis; Team-Buzzer nicht nötig, da Turn-based) | V |
| Host-Mitspiel | erlaubt; Host-Judge bleibt getrennt (Info-Vorteil nur durch Synonym-Wissen — akzeptabel) | V |
| Secrets | eigene Antwort `PLAYER_PRIVATE` bis zum Zug-Ende/Reveal; verwendete Antworten für Alle sichtbar (das ist der Spielinhalt) | F (Prinzip) |

## 4. Setup (Ziel)

```
LastManStandingSetup {
  pools: ContentPoolRef[]           // Kategorien (mit Synonymlisten je Item)
  categoryCount: number (default 8)
  perCategory: {turnTimerMs (default 15000)}
  lives: number (default 3)
  turnOrder: {mode: RANDOM|HOST_ORDER, seedRef?}
  autoJudge: boolean (default true)  // Synonym-Match, sonst NEEDS_JUDGE
  passAllowed: boolean (default true, kostet 1 Leben)
  hostCanPlay: boolean (default true)
}
```

- Quick: SYSTEM-Pool „Klassiker-Kategorien", 8 Runden, 3 Leben, 15s.
- Preflight: ≥3 Spieler, Kategorie-Pool READY.

## 5. Content-/Editor-Schema

- Item = `LmsCategory`: category (z. B. „Stadt"), minAnswerLength (2),
  validAnswers/synonyms (Liste, optional — sonst Judge/Manual),
  excludedAnswers (Liste, z. B. „Berlin" bei „Stadt"? — nein, Standard leer),
  difficulty, tags.
- READY: category gesetzt, Sprache; Synonyme optional.
- **Antwort-Validierung:** ohne Synonymliste → Manual-Judge (Host);
  mit Liste → Normalized Match (Groß-/Kleinschreibung, Umlaute,
  Mehrzahl-Option — Vorschlag: exakt + Umlaut-insensitiv).

## 6. Phasen/Commands

```
INTRO → (je Kategorie) CATEGORY_REVEAL → TURN_1 → TURN_2 → … → (LEBENSVERLUST?) → ROUND_END → (AUSGESCHIEDENE?) → … → LAST_MAN_REVEAL → GAME_END → FINALIZED
```

| Command | Rolle | Phase |
|---|---|---|
| `answer.submit` (text) | aktiver Spieler | TURN_i |
| `answer.pass` | aktiver Spieler | TURN_i |
| `judge.decide` (VALID\|INVALID + reason?) | HOST (JUDGE_ANSWER) | TURN_i (bei NEEDS_JUDGE) |
| `round.next` / `timer.*` / `pause`/`resume` | HOST | — |
| `emergency.*` | HOST | — |

- **Ablaufbeispiel:** Kategorie „Tier", Turn-Order A→B→C→D. A: „Hund"
  (valid) → B: „Katze" (valid) → C: „Hund" (Duplikat → −1 Leben C) →
  D: „Tiger" (valid) → nächste Kategorie. C hat nach 3 Duplikaten
  0 Leben → aus.

## 7. Wertung & Endgründe (Vorschläge, DEC-LMS-01)

- Keine Punkte im klassischen Sinn — **Platzierung durch Ausscheidungs-
  zeitpunkt** (1. = letzter Überlebender, 2. = vorletzter …).
- **VORSCHLAG Timeout:** Timeout = Pass (−1 Leben), Zug geht weiter.
- **VORSCHLAG Disconnect im Zug:** 30s Gnadenfrist, dann automatischer
  Pass (−1 Leben); Rejoin nimmt Zug wieder auf (wenn Frist nicht
  überschritten).
- **VORSCHLAG Wiederholungen:** gleiche Antwort in späterer Kategorie
  erlaubt (nur innerhalb einer Kategorie = Duplikat).
- Endgründe: `COMPLETED` (1 übrig), `HOST_ABORTED`, `TECHNICAL_ABORT`,
  `INSUFFICIENT_PLAYERS` (unter min → Pause/Ende).
- **Keine Ties** möglich (Ausscheidung ist linear) — 2 gleichzeitig
  „0 Leben" in derselben Kategorie: beide aus, Platzierung nach
  letztem validen Zug (Vorschlag).

## 8. Projektionen & Secrets

- PLAYER: eigene Antwort beim Zug, Liste bereits verwendeter Antworten,
  Leben aller, Turn-Anzeige („Nur X darf antworten").
- HOST: + Judge-Tools, Category-Details (Synonymliste `HOST_PRIVATE`).
- VIEWER: Kategorie, verwendete Antworten, Leben, Turn.
- DISPLAY: große Turn-Anzeige + Antworten.
- Preloading: Kategorie-Text (PUBLIC), Synonymliste nie.

## 9. Rejoin/Pause/Host-Ausfall/Recovery

- Rejoin: Phase, Turn, eigene Antwort (wenn offen), Leben;
  Turn-Order bleibt (Disconnect ändert nicht — §5.6).
- Pause: Timer stoppt, Input gesperrt.
- Host-Ausfall: autoJudge=true → Spiel läuft ohne Host weiter
  (nur NEEDS_JUDGE-Fälle blockieren → Pause bei Manual-Notwendigkeit);
  Host-Transfer nach Frist.
- Recovery: Turn-State persistiert; keine Doppel-Antworten (commandId);
  Leben-Zustand atomar.

## 10. Results/Stats/Events/Versionierung

- RoundResult: Kategorie, Antworten je Spieler, Leben-Änderungen,
  Ausscheidungen.
- GameResult: Platzierungen (1. bis n.), Endgrund.
- Stats: games, wins, avg position, valid answers, doppelte Antworten
  vermieden (§9.12).
- Engine-Version: `1` (neu).

## 11. Tests & DoD

- 10 Pflichttests + spezifisch: Duplicate-Erkennung (gleiche Antwort in
  Kategorie), Turn-Order-Integrität (Disconnect), Timeout→Pass,
  Auto-Judge-Test (Synonyme), Ausscheidungs-Reihenfolge, Recovery
  nach Disconnect im Zug.
- Cores: Turn, Submission, Answer-Matching, Judge, Timer, Score
  (Platzierung), Round-Transition, Result-Screen, Notification, Recovery.

## 12. Offene Punkte

| ID | Frage | Vorschlag (default) |
|---|---|---|
| DEC-LMS-01 | Timeout, Disconnect-Frist, Wiederholungs-Regel, gleichzeitiges Ausscheiden, min/max | Timeout=Pass, 30s Gnadenfrist, Wiederholung OK (nur Kategorie-Duplizität), letzter valider Zug, 3–12 |

---

## 13. Engine-Vertrag, Late Join & Rollen-Policy (12-08)

- **Gemeinsamer Vertrag:** `last-man-standing` referenziert `../technical-mapping.md §3.4`
  (Zustandsmaschine, Command-Guards 1–4, Projektionen/`availableActions`,
  Persistenz/Version/Recovery, Medien-/Voice-/Camera-/Mic-/Display-Defaults)
  und weicht **nur** in den folgenden Punkten ab. `INSUFFICIENT_PLAYERS`
  gilt nur an Start-/Transition-Gates, nie gegen das absichtlich sinkende
  aktive Teilnehmerfeld im Spielverlauf (§12-10).
- **Late-Join-Policy (engine-spezifisch):** Nein in der laufenden Kategorie → `PENDING_JOIN`, ab der **nächsten** Kategorie aktiv; verpasste Kategorien zählen nicht.
- **Ausscheidende Teilnehmer:** Ausgeschiedene → `LEFT`-Status (kein Rejoin in dieselbe Partie, Vorschlag DEC-LMS-01); Restlauf als Zuschauer.
- **Teamrollen/Rotation:** keine (individuell, feste Turn Order).
- **Voice/Camera/Mic (Abweichung von den Defaults):** Mikrofon MUTED (Default). ·
- **Viewer (FEST, Master §7.23 — kein Spiel darf abweichen):** kein Mic/Send (Viewer senden nie Audio); Viewer hört `MAIN`; nie `TEAM`; Host kann Viewer-Audio deaktivieren. ·
  Camera: OFF (Default).
- **Medien in Phasen:** keine.
- **RESULT_REVIEW:** geerbt (§3.4).
