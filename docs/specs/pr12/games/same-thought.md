# Gleicher Gedanke (`same-thought`) — Spezifikation

**Status main:** PLANNED, keine Engine. **Ziel-PR:** PR30 (nach PR14–18).
**Slug FEST** (§14/§15.11).

## 1. Kurzbeschreibung & Regelquellen

Assoziationsspiel: Partner/Teams geben zu einer Kategorie/Begriff
**unabhängig** einen Begriff ein; gleiche (oder synonyme/fuzzy-gleiche)
Assoziationen werden gematcht und bringen Team-Punkte. Antworten bleiben
bis Reveal getrennt.

- FEST §15.11: Teams/Partner, gemeinsame Kategorie, Partner unabhängig,
  Matching auf gleiche Assoziation, Fuzzy/Synonym über Answer Matching;
  Detailwertung später.
- OFFEN: Paarwechsel, Teamscoring-Details, Nichtabgabe → DEC-SAM-01.

## 2. Feste Regeln

- **Teams zu 2** (Partner-Paare) — Vorschlag: 2er-Teams, min 2 Teams
  (4 Spieler), max 6 Teams (12 Spieler).
- Pro Runde: Kategorie/Begriff (z. B. „Sommer") → beide Partner geben
  unabhängig je einen Begriff ein (`PLAYER_PRIVATE`).
- Matching (serverseitig, §5.12): EXACT (normalisiert) → MATCH;
  SYNONYM/FUZZY → `NEEDS_JUDGE` (Host entscheidet); sonst NO_MATCH.
- Match → +Punkte **beiden** Team-Mitgliedern (oder Team-Score —
  Vorschlag: Team-Score +100, zusätzlich je +100 an beide — DEC-SAM-01).
- Nicht-Match: 0 (kein Minus — Vorschlag).
- Paarwechsel: optional (Vorschlag: `swapPartnersEveryRounds: number|null`,
  default null = keine Wechsel; bei Wechsel: Host-geführte oder
  rotierende Neupaarung, §3-Rotation-Analogie).

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 4 / 12 (Teams zu 2) | V |
| Teams | **Pflicht** (2er-Partner) | V (DEC-SAM-01) |
| Host-Mitspiel | erlaubt (als Partner in Team, wenn gerade Spielerzahl — sonst Host-only) | V |
| Secrets | Partner-Antwort: `PLAYER_PRIVATE` (Partner sieht erst im Reveal!) | F (Prinzip) |

## 4. Setup (Ziel)

```
SameThoughtSetup {
  pools: ContentPoolRef[]           // Kategorien/Begriffe
  roundCount: number (default 6)
  perRound: {inputTimerMs (default 30000)}
  teamSize: 2 (fest)
  swapPartnersEveryRounds: number|null (default null)
  matchMode: EXACT|EXACT_SYNONYM (default EXACT_SYNONYM)
  scoring: {teamMatch: 100, perPlayerBonus: 50 — VORSCHLAG}
  hostCanPlay: boolean (default true, wenn Team-Vollzähligkeit)
  language: de-DE
}
```

- Quick: SYSTEM-Pool „Assoziationen", 6 Runden, 30s, EXACT_SYNONYM.
- Preflight: gerade Spielerzahl, ≥4, ≥2 Teams.

## 5. Content-/Editor-Schema

- Item = `SameThoughtPrompt`: prompt (Begriff/Kategorie), examples?
  (Beispiel-Assoziationen, nur `HOST_PRIVATE` — nicht Teil des
  Matchings), synonyms[] (für Fuzzy-Matching-Unterstützung),
  difficulty, tags.
- READY: prompt + Sprache.
- **Wichtig:** Assoziationen der Spieler sind Submissions, nie Content.

## 6. Phasen/Commands

```
INTRO → (je Runde) PROMPT_REVEAL → INPUT_OPEN (alle parallel, privat) → INPUT_LOCKED → REVEAL (alle Assoziationen + Matches) → ROUND_END → (PAARWECHSEL?) → … → GAME_END → FINALIZED
```

| Command | Rolle | Phase |
|---|---|---|
| `answer.submit` (text) | PLAYER | INPUT_OPEN |
| `judge.decide` (MATCH\|NO_MATCH bei NEEDS_JUDGE) | HOST | REVEAL |
| `team.swap` (neue Paareung) | HOST (TEAM_CONTROL) | zwischen Runden |
| `round.next` / `pause`/`resume` | HOST | — |

- **Ablaufbeispiel:** Prompt „Sommer". Team A: Partner1 „Baden",
  Partner2 „Strand" → NO_MATCH (0). Team B: „Sonnenbrille" /
  „Sonnenbrille" → MATCH → Team +100, je +50.

## 7. Wertung & Endgründe (Vorschläge, DEC-SAM-01)

- **12-10: eine konsistente Formel.** Bei Match (beide Assoziationen
  gleich/EXACT_SYNONYM): **Team-Gesamt +100** und **je +50 zu den
  individuellen Punkten der 2 Partner** (50+50 = 100 = Team-Inkrement;
  keine zusätzliche +100 pro Mitglied). Nicht-Match: 0 (Team UND
  individuell).
- Nichtabgabe (1 Partner): Team-Resultat für die Runde = 0 (der
  andere kann trotzdem matchen, wenn 2. Team auch 1 fehlt? — nein:
  **Match nur bei 2 Abgaben je Team**, sonst 0 — Vorschlag).
- Endgründe: `COMPLETED`, `HOST_ABORTED`, `TECHNICAL_ABORT`,
  `INSUFFICIENT_PLAYERS` (unter 4 → Pause).
- Ties: geteilte Team-Platzierungen.

## 8. Projektionen & Secrets

- PLAYER: Prompt, Timer, eigene Antwort (private); **keine**
  Partner-Antwort, keine fremden vor Reveal.
- HOST: + Judge-Tools (NEEDS_JUDGE-Paare), Beispiel-Assoziationen
  (`HOST_PRIVATE`).
- VIEWER: Prompt, Timer; Assoziationen nach Reveal.
- DISPLAY: große Prompt-Anzeige.
- Preloading: Prompt (PUBLIC), Beispiele nie an Player.

## 9. Rejoin/Pause/Host-Ausfall/Recovery

- Rejoin: Phase, Prompt, eigene Antwort (wenn abgegeben), Team-Resultate.
- Pause: Input gesperrt.
- Host-Ausfall: Auto-Reveal + Auto-Match (EXACT nur; NEEDS_JUDGE →
  Pause bis Host zurück/Transfer).
- Recovery: Submissions persistiert; Matching deterministisch
  (Seed/Sortierung); keine Doppel-Submissions.

## 10. Results/Stats/Events/Versionierung

- RoundResult: Prompt, Assoziationen (alle, nach Reveal), Matches,
  Team-Punkte, Dauer.
- GameResult: Team-Platzierungen.
- Stats: games, wins, match rate, partner-sync rate (§9.12).
- Engine-Version: `1` (neu).

## 11. Tests & DoD

- 10 Pflichttests + spezifisch: Partner-Antwort-Leak (kein
  Partner-Zugang vor Reveal), Fuzzy-Match-Test (Synonyme →
  NEEDS_JUDGE), Paarwechsel-Test (Rechte/Historie), Team-Scoring-
  Konsistenz, Recovery (Assoziationen erhalten).
- Cores: Submission, Timer, Answer-Matching, Judge, Team-Score,
  Reveal/Visibility, Round-Transition, Result-Screen, Notification,
  Recovery, Team-Core (PR14).

## 12. Offene Punkte

| ID | Frage | Vorschlag (default) |
|---|---|---|
| DEC-SAM-01 | Teamgröße, Paarwechsel, Scoring (Team+Bonus), Nichtabgabe-Regel, Match-Modus | 2er, optional rotierend, 100+50, Match nur bei 2 Abgaben, EXACT_SYNONYM |

---

## 13. Engine-Vertrag, Late Join & Rollen-Policy (12-08)

- **Gemeinsamer Vertrag:** `same-thought` referenziert `../technical-mapping.md §3.4`
  (Zustandsmaschine, Command-Guards 1–4, Projektionen/`availableActions`,
  Persistenz/Version/Recovery, Medien-/Voice-/Camera-/Mic-/Display-Defaults)
  und weicht **nur** in den folgenden Punkten ab. `INSUFFICIENT_PLAYERS`
  gilt nur an Start-/Transition-Gates, nie gegen das absichtlich sinkende
  aktive Teilnehmerfeld im Spielverlauf (§12-10).
- **Late-Join-Policy (engine-spezifisch):** Nein während `INPUT_*`/`REVEAL` der laufenden Runde → `PENDING_JOIN`, ab der **nächsten** Runde aktiv; Paarwechsel berücksichtigt neue Teilnehmer.
- **Ausscheidende Teilnehmer:** keine (alle bleiben aktiv).
- **Teamrollen/Rotation:** **Pflicht:** 2er-Paare (Vorschlag DEC-SAM-01), optional rotierend.
- **Voice/Camera/Mic (Abweichung von den Defaults):** Mikrofon MUTED (Default). ·
- **Viewer (FEST, Master §7.23 — kein Spiel darf abweichen):** kein Mic/Send (Viewer senden nie Audio); Viewer hört `MAIN`; nie `TEAM`; Host kann Viewer-Audio deaktivieren. ·
  Camera: OFF (Default).
- **Medien in Phasen:** keine.
- **RESULT_REVIEW:** geerbt (§3.4).
