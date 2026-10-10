# Imposter (`imposter`) — Spezifikation

**Status main:** PLANNED, keine Engine. **Ziel-PR:** PR22 (nach PR15–18).
**Slug FEST** (§14/§15.4). **Getrennt von Undercover** (FEST).

## 1. Kurzbeschreibung & Regelquellen

Rundenspiel mit einer geheimen echten Antwort: pro Runde gibt es eine
**geheime korrekte Antwort** auf eine Frage; jeder Spieler schreibt eine
plausible Antwort (die echte oder eine Lüge). Alle Antworten werden
gezeigt, dann wird abgestimmt.

- **Scoring (FEST §15.4):**
  - **+1 an jeden Spieler, der die echte Antwort korrekt wählt** (der
    Punkt geht an den *richtig votierenden Spieler*, nicht an einen
    „Autor der echten Antwort" — die echte Antwort stammt aus dem
    Content, sie hat **keinen Spieler-Autor**).
  - **+1 an den Autor einer Lüge pro getäuschtem Vote** (jede Stimme,
    die auf seine Lüge fällt).

> **Korrektur 12-03:** Der Entwurf gab +1 einem „Autor der echten
> Antwort". Das ist falsch: die echte Antwort ist Content, nicht eine
> Spieler-Submission. Empfänger ist der Spieler, der **korrekt auf die
> echte Antwort votiert**.

- FEST §15.4: Scoring +1 echte Antwort (an den Wählenden), +1 pro
  getäuschtem Vote für Lügenautor; getrennt von Undercover.
- OFFEN (Decision): exakte Teilwertung, Duplikate, Nichtabgabe,
  Gleichstand-Regel → DEC-SPI-01.

## 2. Feste Regeln

- Eine echte Antwort pro Runde (geheim, **auch vom mitspielenden Host
  verborgen bis Reveal** — 12-03).
- Spieler reichen verbale Antworten ein (plausible Lügen erlaubt/erwartet).
- Reveal: alle Antworten + welche die echte war.
- Voting: jeder (außer Autor? — siehe Vorschlag) stimmt auf eine Antwort.
- Scoring: +1 an jeden Spieler, der die echte Antwort korrekt wählt;
  +1 an den Autor einer Lüge pro getäuschtem Vote (FEST §15.4).
- Getrennt von Undercover (keine Rollen, kein Eliminations-Charakter).

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 3 / 12 (Vorschlag DEC-SPI-01) | V |
| Teams | nein (individuell) | V |
| Host-Mitspiel | erlaubt; **blind mitspielend (FEST, 12-03/E):** Host sieht die echte Antwort wie jeder andere **erst im Reveal**. `HOST_PREVIEW=false` ist die **verbindliche V1-Konfiguration** für mitspielende Hosts — es gibt KEINE Option/Voreinstellung, die dem mitspielenden Host die echte Antwort vor dem Reveal zeigt (geheimen Antworten für einen mitspielenden Host sind untersagt; 12-03). | F |
| Secrets | echte Antwort: `PLAYER_PRIVATE`/Content (bis Reveal — **auch für den Host blind mitspielend**; 12-03); eigene Antwort: `PLAYER_PRIVATE` bis Reveal; **keine Autoreninfo im Voting** (Vorschlag: Antworten ohne Namenszuordnung bis Reveal — siehe DEC-SPI-01) | F/V (Secret-Prinzip) |

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

- **Ablaufbeispiel (FEST-Wertung):** 4 Spieler (P1–P4), Frage
  „Welches Tier kann fliegen?". Echte Antwort (Content, geheim):
  „Adler". P1 schreibt „Adler" (= die echte Antwort), P2 „Giraffe",
  P3 „Kaulquappe", P4 „Eichelhäher" (Lügen, alle eindeutig).
  Abstimmung:
  P1 → „Giraffe", P2 → „Adler" (**korrekt**), P3 → „Giraffe",
  P4 → „Eichelhäher" (eigene Antwort = **Selbst-Vote**, nicht getäuscht).
  - **Korrekt votierend:** P2 (wählte „Adler") → **P2 +1**.
  - **Getäuschte Votes:** P1 und P3 votierten auf „Giraffe" (Lüge von
    P2) → **P2 (Giraffen-Autor) +2** (je 1 pro getäuschtem Vote).
  - „Eichelhäher": nur P4 selbst votiert darauf (Selbst-Vote) →
    **0** getäuschte Votes → kein Bonus.
  - Ergebnis: P2 = 1 + 2 = **3 Punkte**.
  - Keiner der Punkte geht an einen „Autor der echten Antwort" —
    „Adler" hat keinen Spieler-Autor.
  - **Tie-Grenze (12-03):** selbst wenn z. B. „Adler" und „Giraffe"
    exakt gleich viele Stimmen bekämen (2:2), bliebe die je-Stimme-
    Wertung bestehen: P2 erhielte weiterhin +1 (korrekt) und
    +2 (getäuscht).

## 7. Wertung & Endgründe (FEST + Vorschläge, DEC-SPI-01)

- **FEST (pro Stimme):** +1 an jeden Spieler, der die echte Antwort
  korrekt wählt; +1 an den Autor einer Lüge je getäuschtem Vote.
  Die Wertung ist **je einzelner Stimme** definiert.
- **Tie-Grenze (12-03):** Eine vorgeschlagene **globale** Nullwertung
  bei Vote-Gleichstand (z. B. „bei vollständigem 2-Wege-Tie gibt es
  keine Punkte") gilt **nur** für die Frage „welche Antwort gewinnt
  die Runde" und **darf die feste je-Stimme-Wertung nicht aufheben**.
  Auch bei einem Gesamt-Tie erhalten die korrekt votierenden Spieler
  ihren +1 und die Lügenautoren +1 pro getäuschtem Vote.
- **VORSCHLAG (nur Details, DEC-SPI-01):** Nichtabgabe (Antwort) =
  automatisch 0, Voting mit Platzhalter „(keine Antwort)" erlaubt, aber
  nicht wählbar; Nichtabgabe (Vote) = kein Punkt, aber andere zählen;
  Duplikat-Antworten: werden zusammengeführt, Stimmen addiert, Autor des
  zuerst Abgebenden behält die Zuschreibung.
- **Ledger-Events (empfohlen, 12-03):** pro korrektem Voter
  `CORRECT_VOTE_BONUS` (+1 an den Wählenden); pro getäuschtem Vote
  `LIE_TRICK_BONUS` (+1 an den Lügenautor); `ANSWER_REVEALED`.
- Endgründe: `COMPLETED`, `HOST_ABORTED`, `TECHNICAL_ABORT`,
  `INSUFFICIENT_PLAYERS`.

## 8. Projektionen & Secrets

- PLAYER: Frage, eigene Antwort (private), anonymisierte Antwortliste
  (ohne Autorenschlüssel), eigene Punkte; Voting-Ziel = anonymisierte IDs.
- HOST: + echte Antwort **ab REVEAL**. Für den mitspielenden Host ist
  `HOST_PREVIEW=false` verbindlich (12-03/E): es existiert KEINE
  Vor-REVEAL-Preview-Option — ein mitspielender Host sieht die echte
  Antwort nicht vor dem Reveal, egal welche Host-/Admin-Funktion aktiv ist.
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
| DEC-SPI-01 | Anonymisierung, Selbst-Vote, Tie, Duplikate, Nichtabgabe, min/max Players | anonymisiert ON, Selbst-Vote OFF, Tie betrifft nur die Rundengewinnerfrage — die feste je-Stimme-Wertung gilt auch bei Gleichstand (FEST, Master §15.4), Duplikat → erster Autor, 3–12 Spieler |

---

## 13. Engine-Vertrag, Late Join & Rollen-Policy (12-08)

- **Gemeinsamer Vertrag:** `imposter` referenziert `../technical-mapping.md §3.4`
  (Zustandsmaschine, Command-Guards 1–4, Projektionen/`availableActions`,
  Persistenz/Version/Recovery, Medien-/Voice-/Camera-/Mic-/Display-Defaults)
  und weicht **nur** in den folgenden Punkten ab. `INSUFFICIENT_PLAYERS`
  gilt nur an Start-/Transition-Gates, nie gegen das absichtlich sinkende
  aktive Teilnehmerfeld im Spielverlauf (§12-10).
- **Late-Join-Policy (engine-spezifisch):** Nein während `ANSWER_OPEN`/`VOTE_OPEN` der laufenden Runde → `PENDING_JOIN`, ab der **nächsten** Runde aktiv (keine Antworten/Votes nachreichen).
- **Ausscheidende Teilnehmer:** keine (alle bleiben in jedem Votum).
- **Teamrollen/Rotation:** keine (individuell).
- **Voice/Camera/Mic (Abweichung von den Defaults):** Mikrofon: gemeinsamer, Host-konfigurierbarer Default (§3.4/Master §7.21), Bestätigung im Prejoin. ·
- **Viewer (FEST, Master §7.23 — kein Spiel darf abweichen):** kein Mic/Send (Viewer senden nie Audio); Viewer hört `MAIN`; nie `TEAM`; Host kann Viewer-Audio deaktivieren. ·
  Camera: OFF (Default).
- **Medien in Phasen:** keine (verbale Antworten).
- **RESULT_REVIEW:** geerbt (§3.4) — §6-Flow ergänzt `RESULT_REVIEW` vor FINALIZED.
