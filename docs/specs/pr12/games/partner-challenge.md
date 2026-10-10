# Wie weit gehst du? (`partner-challenge`) — Spezifikation

**Status main:** PLANNED, keine Engine. **Ziel-PR:** PR31 (nach PR14–20).
**Slug FEST** (§14/§15.9). **Am detaillierteste festgelegte Spiel im
Master** — §15.9 enthält nahezu alle Mechanik-Details.

## 1. Kurzbeschreibung & Regelquellen

Kooperations-/Wettbewerbs-Hybride mit 2er-Teams: **Innerhalb jedes Teams**
gibt es je einen **Bidder** und einen **Performer** (Master §15.9: „pro
Team Bidder + Performer"). Pro Teamzug verhandelt der Bidder **für seinen
eigenen Partner** (Performer) ein Ziel; der Performer sieht beim Bidding
**weder Kategorie noch Gebote/Ziel** — nur „Dein Partner verhandelt
gerade". Erfolg → +2 (Team des Performers), Misserfolg → +1 **nur** für
das Team, das **zuletzt gegen den Gewinner-Bidder ausgestiegen/passiert**
ist, frühere Teams 0 (keine Minuspunkte).

> **Korrektur 12-02:** Die Rollen sind **keine Teamaufteilung**
> („Bidder-Team vs. Performer-Team"), sondern Rollen **innerhalb** jedes
> Teams. Der Gewinner-Bidder setzt das Ziel für **seinen Partner**, nicht
> für ein anderes Team.

- FEST §15.9 (vollständig in requirements-matrix MR-15-09-01):
  Bidder/Performer **je Team**, Rollen- und Startteam/-bidder-Rotation,
  freie Gebote, Pass-Regeln, verdeckte Kategorie/Gebote, Challenge-Ablauf,
  Zielzähler, Validierung, Scoring +2/+1, Task-DB-Pflichtfelder.

## 2. Feste Regeln (Master §15.9)

- **Teams:** gerade Spielerzahl, typisch 2er-Teams (Bidder + Performer
  je Team); Host mitspielen oder nur hosten.
- **Rotation:** Rollen rotieren; Startteam/-bidder rotiert.
- **Bidding (frei):** Startgebot, Erhöhungen, Sprünge erlaubt;
  Pass: bei 2 Teams → Bidding-Ende; bei >2 Teams → bis nur ein Team
  übrig ist. Gebote sind Ziele (z. B. „5 Mal", „30 Sekunden").
- **Geheimhaltung:** Der **Performer eines Teams** sieht während des
  Biddings nur „Dein Partner verhandelt gerade" (keine Kategorie,
  kein Bid, kein Target). **Viewer darf Category/Bids sehen** (sofern
  Projection es erlaubt).
- **Host-Performer ohne Wissensvorteil (FEST, 12-02):** Administrative
  Rechte sind **kein Gameplay-Informationsrecht**. Ein mitspielender
  Host, der in der Rolle des **Performers** steckt, sieht bei dem
  Bidding, an dem er nicht selbst Bidder ist, genau das wie jeder andere
  Performer (nur „Partner verhandelt"). „Host sieht alles" gilt nur für
  **andere** Teams, nicht für den eigenen Team-Geheimhaltungsrahmen.
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
- **Scoring (FEST §15.9):** Success → **+2** an das Team des
  Performers; Failure → **+1 an genau das Team, das zuletzt gegen den
  Gewinner-Bidder ausgestiegen/passiert** ist; alle früher
  ausgestiegenen Teams: **0**; **keine Minuspunkte**. Die Regel gilt
  für zwei **und** mehr Teams (Master-Formel, keine separate
  Zwei-Teams-Variante).
- **Task-DB (Pflicht):** prompt, category, **difficulty REQUIRED**,
  **tags REQUIRED**; optional: valid answers/synonyms, timer,
  suggested bid, moderator notes, beta config.
- **Room Overrides:** nur als Snapshot (nicht live).

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 4 / 12 (2er-Teams) | F (gerade Zahl) |
| Teams | **Pflicht**, 2er; **je Team 1 Bidder + 1 Performer** | F §15.9 |
| Rollen pro Team | Bidder + Performer (rotierend); Startteam/-bidder rotiert | F §15.9 |
| Host-Mitspiel | erlaubt; Host-Performer ohne Wissensvorteil (siehe §2) | F |
| Secrets | **pro Spielerrolle**: Kategorie + Gebote + Ziel sind dem **Performer** verborgen (Bidder seines Teams weiß um seine eigene Bietaktion; Viewer/Host-Sicht für **andere** Teams erlaubt); Performer sieht erst nach Bidding Task + Ziel | F §15.9 |

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

- **Ablaufbeispiel (2 Teams):** Team 1 = Bidder A + Performer B;
  Team 2 = Bidder C + Performer D. Startteam 1: **A bietet 3** (für
  seinen Partner B). Team 2: **C erhöht auf 5** (für seinen Partner D).
  Team 1: **A passt** (ausgestiegen). Bidding endet → **C ist
  Gewinner-Bidder**, Ziel 5 für **seinen Partner D**. D bekommt
  Task + Ziel 5. Host: „Los". D zählt (progress 1…5). Team 1 validiert.
  - **Erfolg:** Team 2 +2.
  - **Misserfolg:** +1 an **Team 1** — es ist das Team, das zuletzt
    (und als einziges) gegen den Gewinner C ausgestiegen ist.

- **Ablaufbeispiel (3 Teams):** Team 1 (A1/B1), Team 2 (A2/B2),
  Team 3 (A3/B3). A1 bietet 3 → A2 erhöht 5 → **A1 passt**
  (Ausstieg 1, gegen A2) → A3 erhöht 8 → **A2 passt** (Ausstieg 2,
  gegen A3). Bidding endet → A3 gewinnt mit Ziel 8 für Partner B3.
  B3 **fehlschlägt**:
  - +1 an **Team 2** (A2 ist das zuletzt **gegen den Gewinner A3**
    ausgestiegene Team).
  - **Team 1 = 0** (früher ausgestiegen, und gegen A2, nicht gegen
    den Gewinner).

## 7. Wertung & Endgründe (FEST + Vorschläge, DEC-PCH-01)

- **FEST §15.9:** Success +2 (Team des Performers), Failure +1
  (**genau** das Team, das zuletzt gegen den Gewinner-Bidder
  ausgestiegen/passiert ist), alle anderen Teams 0, keine Minus.
- **Zwei Teams (FEST-Anwendung, keine Sonderregel):** Bei 2 Teams ist
  das gegnerische Team per Definition das Team, das zuletzt gegen den
  Gewinner ausgestiegen ist → +1 an dieses Team. (Die Master-Formel
  deckt beide Fälle; 12-02: keine separate „Zwei-Teams-Freigabe".)
- Endgründe: `COMPLETED`, `HOST_ABORTED`, `TECHNICAL_ABORT`,
  `INSUFFICIENT_PLAYERS` (unter 4 → Pause).
- Ties: Team-Platzierungen (integer).

## 8. Projektionen & Secrets

- **Bidder (eigens):** eigenes Gebot, Gebote der anderen Bidder,
  Fortschritt der Challenge (seine eigene Aktion zählt mit).
- **Performer (während Bidding):** nur „Dein Partner verhandelt
  gerade" + Timer; **keine** Kategorie, **keine** Gebote, **kein** Ziel.
- **Performer (nach Bidding):** Task + Ziel + eigene
  Fortschritte (n/target).
- **Host:** Bids + Task + Fortschritt **für andere Teams** (Override-,
  Go-, Validierungs-Tools); für den **eigenen Team-Geheimhaltungsrahmen**
  gilt als mitspielender Host die Performer-/Bidder-Sicht (kein
  Wissensvorteil über das eigene Bidding/Task).
- **Viewer:** Kategorie + Bids + Fortschritt (sofern Projection erlaubt
  — Vorschlag: Viewer sieht Bids + Ziel, **nicht** den Task-Prompt
  (sonst könnte man per Zuschauer tippen) → DEC-PCH-01).
- **DISPLAY:** Bidding-Übersicht + Challenge-Status (ohne Task-Text,
  wenn Viewer-Regel greift).

## 9. Rejoin/Pause/Host-Ausfall/Recovery

- Rejoin: eigene Rolle im Team (Bidder/Performer), Phase, eigene Gebote,
  Punkte; Geheimhaltung bleibt (Performer sieht bei Rejoin während
  Bidding wieder nur „verhandelt").
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

> **12-02 bereinigt:** Die 2-Teams-Failure-Regel ist **FEST** (§15.9:
> +1 an das zuletzt gegen den Gewinner ausgestiegene Team — bei 2 Teams
> das gegnerische Team). Sie wird **nicht** erneut freigegeben. Die
> Pass-Regeln für >2 Teams sind ebenfalls FEST (§15.9: weiter bis ein
> Team übrig).

| ID | Frage | Vorschlag (default) |
|---|---|---|
| DEC-PCH-01 | Viewer-Task-Sichtbarkeit (einziger verbleibender offen Punkt) | Viewer sieht Bids + Ziel, **nicht** den Task-Text (Anti-Tippen-via-Zuschauer) |

---

## 13. Engine-Vertrag, Late Join & Rollen-Policy (12-08)

- **Gemeinsamer Vertrag:** `partner-challenge` referenziert `../technical-mapping.md §3.4`
  (Zustandsmaschine, Command-Guards 1–4, Projektionen/`availableActions`,
  Persistenz/Version/Recovery, Medien-/Voice-/Camera-/Mic-/Display-Defaults)
  und weicht **nur** in den folgenden Punkten ab. `INSUFFICIENT_PLAYERS`
  gilt nur an Start-/Transition-Gates, nie gegen das absichtlich sinkende
  aktive Teilnehmerfeld im Spielverlauf (§12-10).
- **Late-Join-Policy (engine-spezifisch):** Nein während `BIDDING_*`/`CHALLENGE_ACTIVE` → `PENDING_JOIN`, ab der **nächsten** Runde; Teams werden dann neu geformt (gerade Spielerzahl; Neu-Teamung mit Rollen-Zuweisung, kein Nachteil für Bestandsspieler).
- **Ausscheidende Teilnehmer:** keine (Teams bleiben; Bidder/Performer rotieren pro Runde).
- **Teamrollen/Rotation:** **Pflicht:** je Team 1 Bidder + 1 Performer, Rotation pro Runde (§2); 2er-Teams.
- **Voice/Camera/Mic (Abweichung von den Defaults):** Mikrofon MUTED während Bidding (Geheimhaltung) und Challenge (Validierung erst danach) — keine Abweichung vom Default, aber explizit. ·
- **Viewer (FEST, Master §7.23 — kein Spiel darf abweichen):** kein Mic/Send (Viewer senden nie Audio); Viewer hört `MAIN`; nie `TEAM`; Host kann Viewer-Audio deaktivieren. ·
  Camera: OFF (Default).
- **Medien in Phasen:** Task-Details nie in Viewer-/Display-Projektion (DEC-PCH-01).
- **RESULT_REVIEW:** geerbt (§3.4).
