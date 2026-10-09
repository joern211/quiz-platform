# Yacht (`yacht`) — Spezifikation

**Status main:** PLANNED (Manifest vorhanden), keine Engine. **Ziel-PR:**
PR35 (nach PR14–18). **Slug FEST** (§14). **Regeln vollständig fest**
(Master §16, MR-16-00-01) — am vollständigsten festgelegte neue Engine.

## 1. Kurzbeschreibung & Regelquellen

Würfel-Scorespiel: 5 Würfel, bis zu 3 Würfe pro Zug, Würfel halten
(Hold/Unhold), eine freie Wertungskategorie pro Zug, Scorecard mit
Upper/Lower Block, Solo/1v1/FFA/Team.

- **FEST: Master §16 vollständig** (17 Unterpunkte, MR-16-00-01 in
  requirements-matrix). Kein offenes Grundprinzip — nur Detailwerte
  (Mehrfach-Yacht-Bonus, Quick-Modus-Kategorien, AVERAGE-Zeitpunkt)
  als DEC-YAC-01.

## 2. Feste Regeln (§16)

- **Würfel:** immer **serverseitig** (Random-Core, seedRef); Client nur
  Animation; Rejoin/Reload **nie neu**; Würfe persistiert; keine
  Browser-Manipulation.
- **Zug:** max 3 Würfe, beliebig Hold/Unhold zwischen Würfen
  (serverseitig validiert), frühe Wertung erlaubt (nach 1./2. Wurf).
- **Scorecard CLASSIC (§16.6):** Upper Block (Einer 1–6, Bonus ab 63) +
  Lower Block (Dreierpasch = **Würfelsumme**, Viererpasch = **Würfelsumme**,
  Full House 25, Kleine Straße 30, Große Straße 40, Yacht 50, Chance =
  Würfelsumme).
- **Eine freie Kategorie pro Zug** (beliebige offene, auch 0 streichen);
  Game bei kompletter Scorecard.
- **Mehrfach-Yacht:** Zusatzbonus, klassische Joker-Regeln; eigene Presets
  dürfen verändern/deaktivieren (konkrete Werte → DEC-YAC-01).
- **Modi:** Solo, 1v1, FFA, Team.
- **Team-Scorecard (§16.4):** `SHARED_SCORECARD` (Default: **ein aktiver
  Player pro Teamzug** würfelt und trägt final ein, Team darf beraten,
  aktiver Player **rotiert** innerhalb des Teams, gemeinsame Scorecard) +
  `INDIVIDUAL_SCORECARDS` (je Spieler eigene komplette Partie,
  Teamendwert = Summe). `AVERAGE_SCORE` bei ungleichen Teamgrößen ist
  **ausdrücklich später** — keine V1-Option.
- **Turn Order:** random Start, dann reihum; Host editierbar
  (CUSTOM_HOST_ORDER), Override, Rotation zwischen Runden.
- **Presets:** CLASSIC (komplett), QUICK (reduzierte Scorecard —
  welche Kategorien → DEC-YAC-01), eigene Presets (Host darf
  Kategorien deaktivieren / Sonderkategorien ergänzen).
- **Quick Mode:** reduzierte Scorecard, weniger Würfe? (Vorschlag:
  gleiche Regeln, weniger Kategorien — DEC-YAC-01).
- **Turn Timer:** optional, **Default OFF**; Presets 30/45/60s;
  Timeout → **kein** Auto-Wurf, kontrollierte Beendigung
  (Spieler wird übersprungen nach Host-Entscheidung — Vorschlag).
- **Live Scoring Preview:** serverberechnet, belegte Kategorien
  gesperrt, vor Value-Zuweisung sichtbar („Würfe = 25, in Full House").
- **Ties:** Default `TIE` (geteilt); optional Host: Higher-Upper-Block /
  More-Yachts / Sudden Death; **keine Zufallsentscheidung**.
- **Host-Verhalten:** mit normal mitspielen (keine Judge-Funktion! —
  Kombinationen/Score automatisch), Admin-Rechte getrennt,
  **kein Gameplay-Vorteil** (keine Info über offene Würfel anderer).
- **Host Disconnect:** Spiel läuft **serverseitig weiter** (Würfe,
  Turn, Scoring, Scorecard ohne anwesenden Host); erst bei
  Admin-Problem normale Regeln.

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 1 (Solo!) / 8 | F §16 |
| Teams | optional (SHARED/INDIVIDUAL Scorecard) | F |
| Host-Mitspiel | **erlaubt, normal, ohne Vorteil** (kein Judge, alles automatisch) | F §16 |
| Secrets | **keine** (Würfel PUBLIC, Scorecard PUBLIC); offene Kategorie-Wahl: `PLAYER_PRIVATE` bis Value-Zuweisung | F (Prinzip) |

## 4. Setup (Ziel)

```
YachtSetup {
  preset: 'CLASSIC'|'QUICK'|'CUSTOM'
  scorecard: {categories: string[] (CLASSIC: alle 13; QUICK: subset,
               DEC-YAC-01; CUSTOM: Host-Auswahl)}
  mode: SOLO|ONE_V_ONE|FFA|TEAM
  teamScoring: SHARED_SCORECARD|INDIVIDUAL_SCORECARDS (teamEndValue: SUM;
               AVERAGE_SCORE ausdrücklich später, nicht V1)
  turnsPerGame: 13 (CLASSIC) | reduced (QUICK)
  turnOrder: {mode: RANDOM_START|HOST_ORDER, rotation: true}
  turnTimer: {enabled: false, presets: [30000,45000,60000], onTimeout: 'SKIP_AFTER_HOST_CONFIRM'}
  multiYachtBonus: {second: 25, third: 50}   // DEC-YAC-01
  tiePolicy: TIE|HIGHER_UPPER|MORE_YACHTS|SUDDEN_DEATH (default TIE)
  hostCanPlay: boolean (default true)
  language: de-DE
}
```

- Quick: CLASSIC, 13 Züge, RANDOM_START, kein Timer.
- Preflight: Scorecard gültig (min 4 Kategorien), Spieler ≥1.

## 5. Content-/Editor-Schema

- **Kein Content-Pool** — prozedurales Spiel (Würfel + Scorecard =
  Setup). Keine ContentItems nötig.
- Presets (GAME_PRESET): SYSTEM „Yacht CLASSIC", SYSTEM „Yacht QUICK",
  eigene Host-Presets (Custom Metafields: Kategorien, Bonuswerte).

## 6. Phasen/Commands

```
INTRO → (je Zug) ROLLING (max 3 Würfe, Hold/Unhold) → SCORING (Kategorie wählen, Live-Preview) → VALUE_ASSIGNED → NEXT_TURN → … (Scorecard voll?) → GAME_END (TIE_CHECK?) → FINALIZED
```

| Command | Rolle | Phase |
|---|---|---|
| `dice.roll` (1–3×) | aktiver Spieler | ROLLING |
| `dice.hold/unhold` (indices[]) | aktiver Spieler | ROLLING |
| `score.assign` (categoryId, value?) | aktiver Spieler | SCORING |
| `score.strike` (categoryId, value 0) | aktiver Spieler | SCORING |
| `turn.next` (auto nach Value) | SYSTEM | — |
| `game.end` (auto bei Scorecard voll) | SYSTEM | — |
| `pause`/`resume` / `emergency.*` | HOST | — |

- **Ablaufbeispiel (§16.6):** Player A (aktiver Spieler des Teams bei
  SHARED_SCORECARD) würfelt 2× (3,3,4,5,6) → hält 3,3,4 → 3. Wurf
  (3,3,4,3,6) → Dreierpasch → **Würfelsumme 19** in „Dreierpasch" →
  Live-Preview zeigte u. a.: Dreierpasch=19, Chance=19, Yacht? nein.
  Nächster Zug B (nächster rotierender aktiver Spieler).

## 7. Wertung & Endgründe (FEST §16)

- Scorecard-Werte: Upper (Würfelsumme je Augenzahl, Bonus ab 63),
  Lower (Dreierpasch = **Würfelsumme**, Viererpasch = **Würfelsumme**,
  Full House 25, Kleine Straße 30, Große Straße 40, Yacht 50, Chance =
  Würfelsumme), Mehrfach-Yacht-Bonus (DEC-YAC-01).
- **Ledger-Events:** `TURN_COMPLETED` (Value je Kategorie),
  `SCORECARD_COMPLETE`, `GAME_WON`, `TIE_RESOLVED`.
- **Ties:** Default TIE (geteilt); Host-Optionen: Higher-Upper /
  More-Yachts / Sudden Death (keine Zufallsentscheidung).
- Endgründe: `COMPLETED` (Scorecard voll), `TIE` (geteilt),
  `HOST_ABORTED`, `TECHNICAL_ABORT`, `INSUFFICIENT_PLAYERS`
  (bei FFA: unter 2 während Pause).

## 8. Projektionen & Secrets

- PLAYER: eigene Würfe, Hold-Zustand, eigene Scorecard,
  Live-Preview, Turn-Anzeige, alle Scorecards (PUBLIC);
  **keine** Info über „noch offene" Würfe anderer (nur deren
  zugewiesene Values).
- HOST: + Turn-Order-Edit, Timer, Notfall; **keine** Gameplay-Info
  (kein Judge, keine Extra-Würfel-Sicht).
- VIEWER: komplette Scorecards + Würfel (PUBLIC).
- DISPLAY: große Scorecard-Ansicht (PR20).
- Preloading: Scorecard-Layout (PUBLIC), keine Secrets.

## 9. Rejoin/Pause/Host-Ausfall/Recovery

- Rejoin: kompletter Scorecard-Zustand, aktuelle Würfe + Hold
  (wenn im eigenen Zug), Turn-Position; **kein** Neuwürfel.
- Pause: Timer stoppt, Input gesperrt; Würfe/Hold bleiben.
- **Host Disconnect (FEST §16):** Spiel läuft serverseitig weiter
  (kein zwingendes Host-Interventions-Pflicht — nur Timeout-Entscheidung
  bei Turn-Timer: `SKIP_AFTER_HOST_CONFIRM` → bei Host-Ausfall:
  Auto-Skip nach 2× 30s — Vorschlag DEC-YAC-01).
- Recovery: Würfel + Hold + Scorecard atomar persistiert (CAS);
  Random-State (seedRef) konsistent; keine Doppel-Rolls (commandId).

## 10. Results/Stats/Events/Versionierung

- RoundResult = pro Zug (Spieler, Würfe (alle 3), Hold-Punkte,
  Kategorie, Value, Dauer).
- GameResult: Scorecards (alle), Platzierungen, Ties, Endgrund.
- Stats: games, wins, avg final score, Yachts, Upper-Bonus-Success,
  most scratched, avg points/category, Team contribution (§16/§9.12).
- Engine-Version: `1` (neu).

## 11. Tests & DoD

- 10 Pflichttests + spezifisch: **Würfel-Integrität** (serverseitig,
  Rejoin = gleicher Stand), Hold-Validierung (keine >5 Würfel,
  keine 4. Wurf), Scorecard-Logik (Upper-Bonus, Mehrfach-Yacht,
  Strike), Live-Preview (korrekte Werte, gesperrte Kategorien),
  Team-Scorecard (SHARED/INDIVIDUAL), Tie-Regeln (keine Zufalls-
  entscheidung), **Host-Disconnect-Test** (Spiel läuft weiter),
  Turn-Timer-Timeout, Recovery.
- Cores: Random/Seed (Würfel), Turn, State/CAS (Scorecard), Score
  (Scorecard-Logik), Timer (optional), Round-Transition, Leaderboard,
  Result-Screen, Notification, Recovery.

## 12. Offene Punkte

| ID | Frage | Vorschlag (default) |
|---|---|---|
| DEC-YAC-01 | Mehrfach-Yacht-Bonuswerte, QUICK-Modus-Kategorien, Turn-Timer-Timeout-Verhalten bei Host-Ausfall | 2nd=25, 3rd=50; QUICK = 8 Kategorien (Einer 1–6 + Yacht + Chance); Auto-Skip nach 2×30s bei Host-Ausfall |

> **Nicht mehr offen (Master §16.4):** `AVERAGE_SCORE` ist ausdrücklich
> **später** — keine V1-Option und keine Nutzerentscheidung. `teamEndValue`
> ist in V1 ausschließlich `SUM`.
