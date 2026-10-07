# Wie weit gehst du? (`partner-challenge`) — Spezifikation

**Status main:** PLANNED, keine Engine. **Ziel-PR:** PR31 (nach PR14–20).
**Slug FEST** (§14/§15.9). **Am detaillierteste festgelegte Spiel im
Master** — §15.9 enthält nahezu alle Mechanik-Details.

## 1. Kurzbeschreibung & Regelquellen

Kooperations-/Wettbewerbs-Hybride mit 2er-Teams: pro Runde ist ein Team
„Bidder" (verhandelt ein Gebot), das andere „Performer" (versucht die
Aufgabe mit dem Ziel). **Wichtig:** Der Performer sieht beim Bidding
**weder Kategorie noch Gebote/Ziel** — nur „Dein Partner verhandelt
gerade". Erfolg → +2 (Performer-Team), Misserfolg → +1 nur für das
Team, das **zuletzt ausgestiegen** ist (keine Minuspunkte).

- FEST §15.9 (vollständig in requirements-matrix MR-15-09-01):
  Bidder/Performer-Rotation, freie Gebote, Pass-Regeln, verdeckte
  Kategorie/Gebote, Challenge-Ablauf, Zielzähler, Validierung,
  Scoring +2/+1, Task-DB-Pflichtfelder.

## 2. Feste Regeln (Master §15.9)

- **Teams:** gerade Spielerzahl, typisch 2er-Teams (Bidder + Performer
  je Team); Host mitspielen oder nur hosten.
- **Rotation:** Rollen rotieren; Startteam/-bidder rotiert.
- **Bidding (frei):** Startgebot, Erhöhungen, Sprünge erlaubt;
  Pass: bei 2 Teams → Bidding-Ende; bei >2 Teams → bis nur ein Team
  übrig ist. Gebote sind Ziele (z. B. „5 Mal", „30 Sekunden").
- **Geheimhaltung:** Performer-Team sieht während Bidding nur
  „Dein Partner verhandelt gerade" (keine Kategorie, kein Bid,
  kein Target). **Viewer darf Category/Bids sehen** (sofern Projection
  es erlaubt). Host sieht alles (Judge-Notwendigkeit).
- **Challenge:** nach Bidding bekommt Performer Task + Ziel; Host
  startet („Los"); Timer unlimited oder Presets (während/nach Bidding
  setzbar, vor Challenge).
- **Validierung:** mindestens ein gegnerisches Team validiert
  (success/failure); wenn Host performt → Gegner validieren;
  Host hat finalen Override.
- **Antworten/Aktionen:** wrong = immediate loss; duplicate zählt
  nicht (läuft weiter); correction erlaubt (z. B. „eigentlich 5");
  Performer sieht eigene Fortschritt (n) und Ziel (target);
  target erreicht = immediate success; Timer abgelaufen = loss;
  Give up erlaubt; Host kann manuell beenden.
- **Scoring (FEST):** Success → **+2** an Performer-Team; Failure →
  **+1 nur an das zuletzt ausgestiegene Gegnerteam**; früher
  Ausgestiegene: 0; **keine Minuspunkte**.
- **Task-DB (Pflicht):** prompt, category, **difficulty REQUIRED**,
  **tags REQUIRED**; optional: valid answers/synonyms, timer,
  suggested bid, moderator notes, beta config.
- **Room Overrides:** nur als Snapshot (nicht live).

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 4 / 12 (2er-Teams) | F (gerade Zahl) |
| Teams | **Pflicht**, 2er (Bidder/Performer) | F |
| Host-Mitspiel | erlaubt; dann validieren Gegner + Host-Override | F |
| Secrets | Kategorie + Gebote: **vom Performer-Team verborgen** (nur Bidder-Team + Host + Viewer); Performer sieht erst nach Bidding Task+Ziel | F §15.9 |

## 4. Setup (Ziel)

```
PartnerChallengeSetup {
  pools: ContentPoolRef[]           // Task-Items
  roundCount: number (default 5)
  perRound: {biddingTimerMs (default 60000, UNLIMITED optional),
             challengeTimerMs (default UNLIMITED, Presets 30/60/120s)}
  teamSize: 2 (fest)
  rotation: {startTeam: RANDOM|FIRST, swapRolesEveryRounds: 1}
  scoring: {success: 2, lastOutOnFailure: 1, othersOnFailure: 0, negatives: 0} // FEST
  validators: {minTeams: 1 (Gegner-Team), hostOverride: true}
  hostCanPlay: boolean (default true)
  language: de-DE
}
```

- Quick: SYSTEM-Pool „Partner-Challenges (leicht)", 5 Runden,
  Bidding 60s, Challenge UNLIMITED.
- Preflight: gerade Spielerzahl, ≥4, ≥2 Teams, Task-Pool READY
  (difficulty + tags Pflicht).

## 5. Content-/Editor-Schema

- Item = `ChallengeTask`: prompt (Aufgabe, z. B. „5 Mal mit dem
  schwachen Arm aufstehen und wieder hinsetzen"), category,
  **difficulty (Pflicht)**, **tags (Pflicht)**, targetSuggestion?
  (Vorschlag-Ziel, z. B. 5), validAnswers/synonyms? (für
  Validierungs-Hilfe), timerSuggestion?, moderatorNotes? (nur Host),
  betaConfig? (nur für Beta-Teste).
- READY: prompt + category + difficulty + tags (sonst **nicht READY**).
- **Keine** numerischen „richtigen Antworten" im Item (Ziel kommt vom
  Bidding) — außer optionalen validAnswers für zählbare Aufgaben.

## 6. Phasen/Commands

```
INTRO → (je Runde) BIDDING_OPEN (Bidder-Teams sichtbar, Performer-Teams: „Partner verhandelt") → BIDDING_CLOSED (höchstes Gebot fest) → CHALLENGE_BRIEF (Performer sieht Task+Ziel) → CHALLENGE_ACTIVE (Timer) → VALIDATION (Gegner validieren) → (HOST_OVERRIDE?) → ROUND_END (Punkte) → ROLESwap → … → GAME_END → FINALIZED
```

| Command | Rolle | Phase |
|---|---|---|
| `bid.place` (number) / `bid.raise` (number) | Bidder-Team | BIDDING_OPEN |
| `bid.pass` | Team | BIDDING_OPEN |
| `challenge.go` (Start) | HOST | CHALLENGE_BRIEF→ACTIVE |
| `challenge.progress` (n) | Performer | CHALLENGE_ACTIVE |
| `challenge.correct` (correction) | Performer | CHALLENGE_ACTIVE |
| `challenge.giveup` | Performer | CHALLENGE_ACTIVE |
| `validation.cast` (SUCCESS\|FAILURE) | Gegner-Teams | VALIDATION |
| `host.override` (SUCCESS\|FAILURE + reason) | HOST | VALIDATION |
| `round.next` / `pause`/`resume` / `emergency.*` | HOST | — |

- **Ablaufbeispiel:** Team A bidet 5, Team B (Performer) sieht nur
  „verhandeln". Bidding-Ende: Ziel 5. Team B bekommt Task + Ziel 5.
  Host: „Los". Team B zählt (progress 1…5). Team A validiert: SUCCESS
  → Team B +2. (Bei Failure: Team A — zuletzt ausgestiegen? — nein:
  Team A ist Bidder und blieb; das zuletzt ausgestiegene Team wäre
  ein drittes Team. Bei 2 Teams: Bidder-Team ist „zuletzt
  ausgestiegen" = +1 an Team A.)

## 7. Wertung & Endgründe (FEST + Vorschläge, DEC-PCH-01)

- **FEST:** Success +2 (Performer), Failure +1 (zuletzt ausgestiegen),
  0 sonst, keine Minus.
- **Zwei-Teams-Sonderfall (FEST-Analogie):** bei 2 Teams ist das
  Bidder-Team bei Failure „zuletzt ausgestiegen" (es ist das einzige
  Gegnerteam) → +1 an Bidder. (DEC-PCH-01: Bestätigung gewünscht.)
- Endgründe: `COMPLETED`, `HOST_ABORTED`, `TECHNICAL_ABORT`,
  `INSUFFICIENT_PLAYERS` (unter 4 → Pause).
- Ties: Team-Platzierungen (integer).

## 8. Projektionen & Secrets

- Bidder-Team: eigene Gebote, Gebote anderer Teams, Kategorie
  (nach Bidding: Task sichtbar), Timer.
- **Performer-Team (während Bidding):** nur „Dein Partner verhandelt
  gerade" + Timer; **keine** Kategorie, **keine** Gebote, **kein** Ziel.
- **Performer-Team (nach Bidding):** Task + Ziel + eigene
  Fortschritte (n/target).
- Host: alles (Bids, Task, Fortschritt), Override-Tools.
- **Viewer:** Kategorie + Bids + Fortschritt (sofern Projection erlaubt
  — Vorschlag: Viewer sieht Bids, aber nicht die Task-Prompt-Details?
  → VORSCHLAG: Viewer sieht Bids + Ziel, **nicht** den Task-Prompt
  (sonst könnte man per Zuschauer tippen — DEC-PCH-01).
- DISPLAY: Bidding-Übersicht + Challenge-Status (ohne Task-Text,
  wenn Viewer-Regel greift).

## 9. Rejoin/Pause/Host-Ausfall/Recovery

- Rejoin: Rolle (Bidder/Performer), Phase, eigene Gebote, Punkte;
  Geheimhaltung bleibt (Performer sieht bei Rejoin während Bidding
  wieder nur „verhandelt").
- Pause: Timer stoppt, Input gesperrt (Bidding wie Challenge).
- Host-Ausfall: Pause (Host braucht Override/Go); Transfer nach Frist.
- Recovery: Bids + Ziel + Fortschritt persistiert; Rotation-Zustand
  konsistent; keine Doppel-Bids (commandId); Timer aus echten
  Zeitpunkten.

## 10. Results/Stats/Events/Versionierung

- RoundResult: Bids (je Team), Ziel, Task-Ref, Ergebnis
  (SUCCESS/FAILURE), Validatoren, Punkte, Dauer (Bidding + Challenge).
- GameResult: Team-Platzierungen.
- Stats: games, wins, avg bid, success rate, „letzte Ausstieg"-Treffer
  (§9.12).
- Engine-Version: `1` (neu).

## 11. Tests & DoD

- 10 Pflichttests + spezifisch: **Secret-Leak** (Performer-Projektion
  enthält bei Bidding keine Kategorie/Bids/Task), Bid-Idempotenz,
  Pass-Logik (2 Teams vs. 3+), Ziel-Validierung (Gegner + Host-
  Override), Giveup/Timeout, Rejoin-Geheimhaltung, Rotation-Korrektheit,
  Recovery.
- Cores: Team-Core (PR14, 2er-Teams + Rotation), Turn/Role-Rotation,
  Timer (UNLIMITED + Presets), Submission (Bids), Reveal/Visibility
  (Rollen-abhängig), Score (+2/+1), Round-Transition, Leaderboard,
  Result-Screen, Notification, Recovery.

## 12. Offene Punkte

| ID | Frage | Vorschlag (default) |
|---|---|---|
| DEC-PCH-01 | 2-Teams-Failure-Regel (Bidder = zuletzt ausgestiegen?), Viewer-Task-Sichtbarkeit, >2 Teams Bidding-Ende | Bidder +1 bei 2 Teams, Viewer: Bids+Ziel ohne Task-Text, Bidding-Ende bei 1 Team übrig |
