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
| Host-Mitspiel | blind erlaubt; echter Wert/Toleranz erst nach Reveal für mitspielenden Host (§3.4-C); HOST_PRIVATE-Vorschau nur nicht mitspielend | V |
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

- **Ablaufbeispiel (12-10: aus dem Setup-Tier-Modell abgeleitet):**
  „Wie hoch ist der höchste Punkt Deutschlands?" (Einheit: m,
  trueValue = 2.962 m, Zugspitze) → A: 2.970, B: 2.500, C: 3.500
  → Reveal:
  - A: |2970−2962|/2962 = 0,3 % → within5pct → **+80** (nicht „exact 100"
    — exact = 0,0 %; früher hieß es fälschlich 100).
  - B: |2500−2962|/2962 = 15,6 % → within25pct → **+40**.
  - C: |3500−2962|/2962 = 18,2 % → within25pct → **+40** (nicht 0;
    18,2 % < 25 %; früher hieß es fälschlich 0).
  **Ergebnis: 80 / 40 / 40** (statt des fehlerhaften 100/40/0).

## 7. Wertung & Endgründe (Vorschläge, DEC-SCH-01)

- **TIERED-Default** (siehe Setup): relative Distanz zum trueValue.
  Alternative **LOGARITHMIC** (Punkte = max(0, 100 − 20·log10(1+relDistanz)))
  — für sehr große Wertebereiche (Vorschlag als Preset).
- **12-10 trueValue = 0 / negativ:** relative Distanz ist bei trueValue=0
  nicht definiert (Division durch 0). Dann gilt **ABSOLUTE Distanz** in
  der Einheit des Items (Tier-Grenzen als absolute Werte, z. B.
  „exact = ±0", „within5pct" wird zu einem festen ±Δ); der Editor
  (Content-Schema §5) erfordert für trueValue=0 einen `absTiers`-Override.
  Negative trueValue: relative Distanz auf |trueValue| beziehen.
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

---

## 13. Engine-Vertrag, Late Join & Rollen-Policy (12-08)

- **Gemeinsamer Vertrag:** `schaetz-mal` referenziert `../technical-mapping.md §3.4`
  (Zustandsmaschine, Command-Guards 1–4, Projektionen/`availableActions`,
  Persistenz/Version/Recovery, Medien-/Voice-/Camera-/Mic-/Display-Defaults)
  und weicht **nur** in den folgenden Punkten ab. `INSUFFICIENT_PLAYERS`
  gilt nur an Start-/Transition-Gates, nie gegen das absichtlich sinkende
  aktive Teilnehmerfeld im Spielverlauf (§12-10).
- **Late-Join-Policy (engine-spezifisch):** Nein während `INPUT_*` der laufenden Runde → `PENDING_JOIN`, ab der **nächsten** Runde aktiv.
- **Ausscheidende Teilnehmer:** keine (alle bleiben aktiv).
- **Teamrollen/Rotation:** keine (individuell).
- **Voice/Camera/Mic (Abweichung von den Defaults):** Mikrofon: gemeinsamer, Host-konfigurierbarer Default (§3.4/Master §7.21), Bestätigung im Prejoin. ·
- **Viewer (FEST, Master §7.23 — kein Spiel darf abweichen):** kein Mic/Send (Viewer senden nie Audio); Viewer hört `MAIN`; nie `TEAM`; Host kann Viewer-Audio deaktivieren. ·
  Camera: OFF (Default).
- **Medien in Phasen:** keine (numerische Schätzungen).
- **RESULT_REVIEW:** geerbt (§3.4).
