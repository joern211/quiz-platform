# Imposter (`imposter`) — Spezifikation

**Status main:** PLANNED, keine Engine. **Ziel-PR:** PR22 (nach PR15–18).
**Slug FEST** (§14/§15.4). **Getrennt von Undercover** (FEST).

## 1. Kurzbeschreibung & Regelquellen

Rundenspiel mit einer geheimen echten Antwort: pro Runde gibt es eine
**geheime korrekte Antwort** auf eine Frage; jeder Spieler schreibt eine
plausible Antwort (die echte oder eine Lüge). Alle Antworten werden
gezeigt, dann wird abgestimmt. Die gewählte echte Antwort bringt +1 ihrem
Autor; der Autor einer Lüge bekommt +1 pro Spieler, der darauf (gefehlt)
gestimmt hat.

- FEST §15.4: Scoring +1 echte Antwort, +1 pro getäuschtem Vote für
  Lügenautor; getrennt von Undercover.
- OFFEN (Decision): exakte Teilwertung, Duplikate, Nichtabgabe,
  Gleichstand-Regel → DEC-SPI-01.

## 2. Feste Regeln

- Eine echte Antwort pro Runde (geheim, `HOST_PRIVATE` bis Reveal).
- Spieler reichen verbale Antworten ein (plausible Lügen erlaubt/erwartet).
- Reveal: alle Antworten + welche die echte war.
- Voting: jeder (außer Autor? — siehe Vorschlag) stimmt auf eine Antwort.
- Scoring: +1 Autor der gewählten echten Antwort; +1 Lügenautor pro
  getäuschtem Vote (FEST).
- Getrennt von Undercover (keine Rollen, kein Eliminations-Charakter).

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 3 / 12 (Vorschlag DEC-SPI-01) | V |
| Teams | nein (individuell) | V |
| Host-Mitspiel | erlaubt; Host sieht die echte Antwort als Content-Ersteller **erst im Reveal** — VORSCHLAG: Host-Content-Visibility `HOST_PREVIEW` (Host erkennt eigene Lüge nicht, wenn er nicht Autor ist) | V |
| Secrets | echte Antwort: `HOST_PRIVATE` (nur Host + Autor nach Reveal); eigene Antwort: `PLAYER_PRIVATE` bis Reveal; **keine Autoreninfo im Voting** (Vorschlag: Antworten ohne Namenszuordnung bis Reveal — siehe DEC-SPI-01) | V/F (Secret-Prinzip) |

## 4. Setup (Ziel)

```
ImposterSetup {
  pools: ContentPoolRef[]          // Fragen (mit einer festen echten Antwort je Item)
  questionCount: number (default 6)
  repeatRule / poolSelection: Standard (PR17)
  perQuestion: {inputTimerMs (default 30000), voteTimerMs (default 20000)}
  revealAnswersAnonymized: boolean (default true — VORSCHLAG)
  playersCanVoteOwnAnswer: boolean (default false — VORSCHLAG)
  hostCanPlay: boolean (default true)
}
```

- Quick: Pool „Imposter-Fragen" (SYSTEM-Preset), 6 Runden, 30s/20s.
- Preflight: ≥3 Spieler, Pool READY.

## 5. Content-/Editor-Schema

- Item = `ImposterQuestion`: prompt (Frage), correctAnswer (die EINE echte
  Antwort, kurz, 2–6 Wörter), context? (Hintergrund für den Host),
  difficulty, tags.
- READY: prompt + correctAnswer gesetzt, Sprache.
- **Wichtig:** die echte Antwort ist Teil des Items (serverseitig);
  Spielerantworten sind Submission (nicht Content).
- Editor Quick: Frage, Antwort, Tag, Difficulty.

## 6. Phasen/Commands

```
INTRO → (je Runde) QUESTION_REVEAL → ANSWER_OPEN → ANSWER_LOCKED → VOTE_OPEN → VOTE_LOCKED → REVEAL (echte Antwort + Zuordnung) → ROUND_END → … → GAME_END → FINALIZED
```

| Command | Rolle | Phase |
|---|---|---|
| `answer.submit` (text) | PLAYER | ANSWER_OPEN |
| `vote.cast` (answerId) | PLAYER | VOTE_OPEN |
| `reveal` | HOST (REVEAL_CONTENT) | VOTE_LOCKED |
| `round.next` / `timer.*` / `pause`/`resume` | HOST | — |

- **Ablaufbeispiel:** 4 Spieler, Frage „Welches Tier kann fliegen?".
  Echte Antwort (geheim): „Pinguin" (absichtlich absurd? — nein: die echte
  Antwort ist faktisch korrekt, z. B. „Adler"; Lügen: „Giraffe", „Kaulquappe").
  Alle Antworten werden anonymisiert gezeigt; Abstimmung; „Adler" wird
  gewählt → +1 an Adler-Autor; „Kaulquappe" erhält 2 Stimmen → +2 an
  Kaulquappe-Autor (wenn der eine Lüge war und gewählt wurde).

## 7. Wertung & Endgründe (Vorschläge, DEC-SPI-01)

- **FEST:** +1 für die gewählte echte Antwort (Autor); +1 pro getäuschtem
  Vote für den Lügenautor.
- **VORSCHLAG:** Nichtabgabe (Antwort) = automatisch 0, Voting mit Platzhalter
  „(keine Antwort)" erlaubt, aber nicht wählbar; Nichtabgabe (Vote) =
  kein Punkt, aber andere zählen; Duplikat-Antworten: werden zusammengeführt,
  Stimmen addiert, Autor des zuerst Abgebenden behält die Zuschreibung;
  Tie bei Voting: keine zweite Runde — Punkt geht an beide Autoren
  (geteilt), alternativ: keine Punkte (empfohlen: **keine Punkte** bei
  vollständigem 2-Wege-Tie, da kein „Gewinner").
- Ledger-Events: `ROUND_BONUS (+1/…)` pro Spieler, `ANSWER_REVEALED`.
- Endgründe: `COMPLETED`, `HOST_ABORTED`, `TECHNICAL_ABORT`,
  `INSUFFICIENT_PLAYERS`.

## 8. Projektionen & Secrets

- PLAYER: Frage, eigene Antwort (private), anonymisierte Antwortliste
  (ohne Autorenschlüssel), eigene Punkte; Voting-Ziel = anonymisierte IDs.
- HOST: + echte Antwort ab REVEAL (davor nur, wenn Host-Content-Preview
  an — Standard: **aus**, `HOST_PREVIEW=false` default für Imposter).
- VIEWER: Frage, „Antwort offen", Punkte; keine Antworten vor Reveal.
- DISPLAY: Frage, anonymisierte Antworten nach Reveal.
- **Secret-Grenze:** Autoren-Vote-Mapping erst im REVEAL (serverseitig
  berechnet), nie davor an Player (sonst „Wer hat was geschrieben?").

## 9. Rejoin/Pause/Host-Ausfall/Recovery

- Rejoin: eigene Antwort (wenn schon abgegeben), Punkte, Phase;
  anonymisierte Liste ohne eigene Identität.
- Pause: Submission/Voting gesperrt (Game-Core).
- Host-Ausfall: Voting kann automatisch nach Timer in REVEAL münden
  (VORSCHLAG `autoRevealOnExpire=true`, wie Wissensduell DEC-KAT-02).
- Recovery: Submissions/Votes persistiert (Submission-Core, PR15);
  keine Doppel-Votes (commandId).

## 10. Results/Stats/Events/Versionierung

- RoundResult: Antworten (anonymisiert), Votes, echte Antwort, Punkt-
  Verteilung, Dauer.
- GameResult: Platzierungen, Endpunkte.
- Stats: games, wins, answers_chosen, lies_tricks (§9.12).
- Engine-Version: `1` (neu).

## 11. Tests & DoD

- 10 Pflichttests + spezifisch: Autor-Info-Leak (Voting-Payload enthält
  keine Autor-IDs vor Reveal), Duplicate-Merge-Test, Tie-Test,
  Nichtabgabe-Test, Auto-Reveal-Test.
- Cores: Submission, Timer, Reveal/Visibility, Vote/Reveal (Tie), Score,
  Round-Transition, Leaderboard, Result-Screen, Notification, Recovery.

## 12. Offene Punkte

| ID | Frage | Vorschlag (default) |
|---|---|---|
| DEC-SPI-01 | Anonymisierung, Selbst-Vote, Tie, Duplikate, Nichtabgabe, min/max Players | anonymisiert ON, Selbst-Vote OFF, 2-Wege-Tie = keine Punkte, Duplikat → erster Autor, 3–12 Spieler |
