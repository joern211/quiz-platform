# Schätz mal (`schaetz-mal`) — Spezifikation

**Status main:** PLANNED, keine Engine. **Ziel-PR:** PR26 (nach PR15–18).
**Slug FEST** (§14/§15.12).

## 1. Kurzbeschreibung & Regelquellen

Schätzspiel: pro Runde wird eine Größe/Frage gezeigt („Wie viele
Einwohner hat Hamburg?"); jeder Spieler gibt eine **numerische Schätzung**
ein; am Reveal zeigt der Server den echten Wert, Punkte nach
Distanz/Toleranz.

- FEST §15.12: eigene Engine, numeric submissions, nearest-value rules,
  zentrale Score/Result/Stats; Detailregeln game-spezifisch.
- OFFEN: Einheiten, zulässige Bereiche, Toleranz-Kurve, Gleichstände,
  Fristen → DEC-SCH-01.

## 2. Feste Regeln

- Numerische Eingabe (Integer oder 1 Dezimalstelle, je Einheit).
- Zulässiger Bereich pro Item (`minValue`, `maxValue`) — serverseitig
  validiert, Werte außerhalb = ungültig (0 Punkte).
- Distanz-/Toleranzwertung: serverautoritativ, nicht vom Client berechnet.
- Gleichstand: bei gleicher (abgerundeter) Distanz → beide korrekteste
  (geteilt) oder Tie-Breaker „schnellster" (Vorschlag: **gleicher Punkt**,
  kein Zeit-Breaker — DEC-SCH-01).

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 2 / 12 | V |
| Teams | optional (Team-Schätzung = Durchschnitt der Team-Mitglieder — Vorschlag) | V |
| Host-Mitspiel | erlaubt; echter Wert `HOST_PRIVATE` bis Reveal | V |
| Secrets | echter Wert + Toleranz: `HOST_PRIVATE` bis REVEAL; eigene Schätzung `PLAYER_PRIVATE` | F (Prinzip) |

## 4. Setup (Ziel)

```
SchaetzMalSetup {
  pools: ContentPoolRef[]           // Schätz-Items
  roundCount: number (default 8)
  perRound: {inputTimerMs (default 20000)}
  scoring: {
    mode: TIERED|LOGARITHMIC|LINEAR (default TIERED — VORSCHLAG)
    tiers: {exact: 100, within5pct: 80, within10pct: 60, within25pct: 40,
            within50pct: 20, outside: 0}   // TIERED-Default, DEC-SCH-01
    relativeTo: TRUE_VALUE           // Distanz relativ zum echten Wert
  }
  allowDecimal: boolean (default true, 1 Dezimalstelle)
  showUnitHint: boolean (default true)   // „in Tausend" / „in Millionen"
  hostCanPlay: boolean (default true)
  language: de-DE
}
```

- Quick: SYSTEM-Pool „Alltag & Wissen schätzen", 8 Runden, 20s, TIERED.
- Preflight: ≥2 Spieler, Pool READY (trueValue + min/max).

## 5. Content-/Editor-Schema

- Item = `SchaetzItem`: prompt, trueValue (number), unit? („Mio. Euro",
  „km", „Jahre"…), minValue, maxValue, decimalPlaces (0–1),
  explanation? (Kontext), difficulty, tags.
- READY: prompt + trueValue + min/max (trueValue innerhalb min/max),
  Sprache.
- **Einhinweis:** `showUnitHint` verhindert Größenordnungs-Fehlgriffe
  (fairness); ohne Hint = `HARD`-Varianten (Vorschlag: Preset).

## 6. Phasen/Commands

```
INTRO → (je Runde) PROMPT_REVEAL (Frage + Einheit) → INPUT_OPEN → INPUT_LOCKED → REVEAL (echter Wert + Distanz + Punkte) → ROUND_END → … → GAME_END → FINALIZED
```

| Command | Rolle | Phase |
|---|---|---|
| `answer.submit` (number) | PLAYER | INPUT_OPEN |
| `round.reveal` | HOST / auto | INPUT_LOCKED |
| `round.next` / `pause`/`resume` | HOST | — |

- **Ablaufbeispiel:** „Wie hoch ist der höchste Punkt Deutschlands?"
  (Einheit: m) → A: 2.970, B: 2.500, C: 3.500 → Reveal: 2.962 m
  (Zugspitze) → A: within1pct → +100, B: within18pct → +40, C: +0.

## 7. Wertung & Endgründe (Vorschläge, DEC-SCH-01)

- **TIERED-Default** (siehe Setup): relative Distanz zum trueValue.
  Alternative **LOGARITHMIC** (Punkte = max(0, 100 − 20·log10(1+relDistanz)))
  — für sehr große Wertebereiche (Vorschlag als Preset).
- Ungültig (außerhalb min/max, NaN): 0 Punkte, `INVALID_SUBMISSION`
  (kein Minus).
- Nichtabgabe: 0.
- **Gleichstand:** gleiche Tier-Einordnung = gleiche Punkte (kein
  Time-Breaker — Vorschlag; Alternative: „schnellere" Abgabe bei
  exakt gleicher Schätzung → kein Vorteil, da gleich = gleich).
- Endgründe: `COMPLETED`, `HOST_ABORTED`, `TECHNICAL_ABORT`,
  `INSUFFICIENT_PLAYERS`.

## 8. Projektionen & Secrets

- PLAYER: Frage + Einheit, Timer, eigene Schätzung (private),
  Punkte; **kein** trueValue vor Reveal.
- HOST: + trueValue/Toleranz ab REVEAL.
- VIEWER: Frage, Timer, Punkte; trueValue nach Reveal.
- DISPLAY: große Schätz-Ansicht + Reveal.
- Preloading: Frage-Text (PUBLIC), trueValue nie.

## 9. Rejoin/Pause/Host-Ausfall/Recovery

- Rejoin: Phase, eigene Schätzung (wenn abgegeben), Punkte.
- Pause: Input gesperrt, Timer stoppt.
- Host-Ausfall: Auto-Reveal; Host-Transfer.
- Recovery: Submissions persistiert; keine Doppel (commandId);
  Punkte serverseitig neu berechnet aus trueValue + Schätzungen
  (deterministisch, keine „verlorene" Wertung).

## 10. Results/Stats/Events/Versionierung

- RoundResult: Item-Ref, Schätzungen (anonymisiert bis Reveal? — nein,
  nach Reveal sichtbar), trueValue, Punkte, Dauer.
- GameResult: Platzierungen, Endpunkte.
- Stats: games, wins, avg relative distance, exact hits, best guess
  (§9.12).
- Engine-Version: `1` (neu).

## 11. Tests & DoD

- 10 Pflichttests + spezifisch: trueValue-Leak, Toleranz-Test
  (Randwerte an Tier-Grenzen), Ungültig-Test (NaN, außerhalb),
  Gleichstands-Test, Recovery nach Reveal (Punkte konsistent),
  Einheit-Darstellung (keine Locale-Verschmutzung).
- Cores: Submission (numerisch), Timer, Reveal/Visibility, Score
  (Toleranz-Kurve), Round-Transition, Leaderboard, Result-Screen,
  Notification, Recovery.

## 12. Offene Punkte

| ID | Frage | Vorschlag (default) |
|---|---|---|
| DEC-SCH-01 | Toleranz-Modus (TIERED/LOGARITHMIC/LINEAR), Einheiten-Hinweis, Gleichstand, Dezimalstellen | TIERED, showUnitHint=true, gleiche Tier = gleiche Punkte, 0–1 Dezimalstellen |
