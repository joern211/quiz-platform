# Higher or Lower (`higher-lower`) — Spezifikation

**Status main:** PLANNED, keine Engine. **Ziel-PR:** PR24 (nach PR15–18).
**Slug FEST** (§14/§15.7). **Eigenständiges Spiel, nicht mit Timeline
zusammenlegen** (FEST).

## 1. Kurzbeschreibung & Regelquellen

Binärer Vergleich: pro Runde werden zwei Werte/Objekte A und B gezeigt
(nur A zuerst, dann B); jeder Spieler tippt, ob B **höher oder niedriger**
als A ist.

- FEST §15.7: eigenständig, direkter binärer Vergleich (höher/niedriger),
  nicht mit Timeline zusammenlegen.
- OFFEN: Daten-Pools, Einheiten, Gleichstands-Regel, Reveal-Timing,
  Punkte → DEC-HOL-01.

## 2. Feste Regeln

- Binäre Antwort: HÖHER / NIEDRIGER (zwei Buttons).
- Zwei Werte/Objekte pro Runde (z. B. „Einwohner: Berlin vs. München",
  „Größe: Eiffelturm vs. Berliner Fernsehturm").
- Reveal: B-Wert wird angezeigt, richtige Richtung markiert.
- Daten: numerisch (mit Einheit) oder ordinal (Ranking) — serverseitig
  bekannt, nie im Payload vor Reveal.

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 2 / 12 | V |
| Teams | optional (Team-Button = 1 Stimme, alle müssen gleich tippen — Vorschlag) | V |
| Host-Mitspiel | erlaubt; Host sieht Werte erst im Reveal (Content-Item: A+B-Werte `HOST_PRIVATE`) | V |
| Secrets | B-Wert + Richtung: `HOST_PRIVATE` bis REVEAL; eigene Tipp `PLAYER_PRIVATE` | F (Prinzip) |

## 4. Setup (Ziel)

```
HigherLowerSetup {
  pools: ContentPoolRef[]           // Vergleichs-Paare (A, B, richtiger Wert)
  roundCount: number (default 10)
  perRound: {inputTimerMs (default 10000), revealDelayMs (default 1500)}
  showUnitA: boolean (default true)  // A-Wert + Einheit sichtbar
  showUnitB: boolean (default true)  // B-Wert + Einheit sichtbar (vor Reveal)
  tiePolicy: ALLOW_TIE (beide korrekt — VORSCHLAG)
  points: {correct: 100, streakBonus: 50 (je 3 in Folge) — VORSCHLAG}
  hostCanPlay: boolean (default true)
  shuffle: true (Random-Core)
}
```

- Quick: SYSTEM-Pool „Alltag & Wissen", 10 Runden, 10s.
- Preflight: ≥2 Spieler, Pools READY (A/B + Richtungs-Metadaten).

## 5. Content-/Editor-Schema

- Item = `HigherLowerPair`: label (z. B. „Einwohnerzahl"), aLabel, aValue,
  bLabel, bValue, unit (optional: „Mio.", „m", „km²"),
  explanation? (Kontext), difficulty, tags, language.
- READY: aLabel + bLabel + aValue + bValue gesetzt, aValue ≠ bValue
  (sonst `TIE_CONTENT` — Vorschlag: erlauben mit `tieContent`-Flag,
  beide „korrekt" = egal).
- **VORSCHLAG DEC-HOL-01 (Daten):** numerisch mit einheitlicher Einheit
  pro Item; ordinal-Paare (z. B. „Welche Stadt hat mehr Einwohner?")
  als `type: NUMERIC|RANKING`.
- Editor Quick: Label, A (Name+Wert), B (Name+Wert), Einheit, Tag.

## 6. Phasen/Commands

```
INTRO → (je Runde) A_REVEAL (nur A) → INPUT_OPEN (HÖHER/NIEDRIGER) → INPUT_LOCKED → B_REVEAL (B + Richtung) → ROUND_END → … → GAME_END → FINALIZED
```

| Command | Rolle | Phase |
|---|---|---|
| `answer.submit` (HIGHER\|LOWER) | PLAYER | INPUT_OPEN |
| `round.reveal` | HOST / auto nach Timer | INPUT_LOCKED |
| `round.next` / `pause`/`resume` | HOST | — |

- **Ablaufbeispiel:** „Wie hoch ist der Matterhorn-Gipfel?" → A:
  „4.478 m (Matterhorn)" → Spieler tippen HÖHER oder NIEDRIGER für
  B (Eiger) → B-Reveal: „Eiger: 3.967 m" → NIEDRIGER war richtig →
  +100.

## 7. Wertung & Endgründe

- **VORSCHLAG DEC-HOL-01:** +100 korrekt, +50 Streak-Bonus (3 in Folge),
  0 falsch (kein Minus); Tie-Content (aValue=bValue): beide Antworten
  korrekt (oder: Runde gilt als „kein Punkt" — Vorschlag: beide korrekt,
  da „gleich" als höhere/niedrigere erlaubt wurde — **Alternative:**
  Tie-Content beim Import verweigern).
- Endgründe: `COMPLETED`, `HOST_ABORTED`, `TECHNICAL_ABORT`,
  `INSUFFICIENT_PLAYERS`.

## 8. Projektionen & Secrets

- PLAYER: A-Label + A-Wert (+Einheit), Timer, eigene Punkte/Streak;
  **kein** B-Wert, **keine** Richtung vor REVEAL.
- HOST: + B-Wert/Richtung ab REVEAL (davor `HOST_PREVIEW=false` default).
- VIEWER: A + Timer; B erst nach Reveal.
- DISPLAY: großes A/B-Reveal.
- Preloading: A-Text (PUBLIC), B-Werte nie (Leak).

## 9. Rejoin/Pause/Host-Ausfall/Recovery

- Rejoin: Phase, A-Wert, Punkte, Streak; B nie vor Reveal.
- Pause: Input gesperrt, Timer stoppt.
- Host-Ausfall: Auto-Reveal nach Timer (default ON); Host-Transfer.
- Recovery: State-CAS; keine Doppel-Answers (commandId).

## 10. Results/Stats/Events/Versionierung

- RoundResult: Paar-Ref, Richtungs-Verteilung, Korrektheit, Punkte,
  Dauer, Streaks.
- GameResult: Platzierungen, Endpunkte.
- Stats: games, wins, correct rate, max streak (§9.12).
- Engine-Version: `1` (neu).

## 11. Tests & DoD

- 10 Pflichttests + spezifisch: B-Wert-Leak (kein B in Player-Payload
  vor Reveal), Streak-Bonus-Test, Tie-Content-Verhalten,
  Auto-Reveal-Test, Einheit-Darstellung (keine Locale-Verschmutzung).
- Cores: Submission (binär), Timer, Reveal/Visibility, Score (Streak),
  Round-Transition, Leaderboard, Result-Screen, Notification, Recovery.

## 12. Offene Punkte

| ID | Frage | Vorschlag (default) |
|---|---|---|
| DEC-HOL-01 | Datenmodell (NUMERIC/RANKING), Tie-Content, Streak-Bonus, Einheiten, Reveal-Delay | NUMERIC+RANKING, Tie-Content = beide korrekt, +50 je 3, einheitliche Einheit, 1.5s Delay |
