# Wahr oder Fake? (`wahr-oder-fake`) — Spezifikation

**Status main:** PLANNED, keine Engine. **Ziel-PR:** PR28 (nach PR15–18).
**Slug FEST** (§14/§15.14).

## 1. Kurzbeschreibung & Regelquellen

Fakten-/Fake-Prinzip: pro Runde wird eine Aussage (faktisch wahr oder
fiktiv) gezeigt; jeder Spieler tippt WAHR oder FAKE. Reveal zeigt die
Korrektur (bei Fake: die wahre Tatsache), Punkte für Richtigkeit.
Serienwertung möglich (Vorschlag).

- FEST §15.14: Anzeigename/Slug fest, Fakten-/Fake-Prinzip, zentrale
  Submission/Result/Content-Pools.
- OFFEN: Quellen-/Rechte-Handling, Serienwertung, Ties, Nichtabgabe
  → DEC-WOF-01.

## 2. Feste Regeln

- Aussage + 2 Antworten: WAHR / FAKE.
- Bei FAKE: Reveal zeigt die **wahre Tatsache** (Korrektur-Text).
- Bei WAHR: Reveal zeigt Bestätigung + optional Kontext.
- Punkte: korrekt/fehlerhaft (integer, z. B. +100); Serienbonus
  optional (Vorschlag).
- Content-Rechte: Aussagen mit Quellenangabe (Pflicht bei PUBLIC-Pools,
  §6.42/§7.12).

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 2 / 12 | V |
| Teams | optional (Team-Tipp = 1 Stimme, Vorschlag: Mehrheit im Team) | V |
| Host-Mitspiel | erlaubt; Korrektur-Text `HOST_PRIVATE` bis Reveal | V |
| Secrets | Wahrheit (WAHR/FAKE-Flag) + Korrektur: `HOST_PRIVATE` bis REVEAL | F (Prinzip) |

## 4. Setup (Ziel)

```
WahrOderFakeSetup {
  pools: ContentPoolRef[]           // Aussage-Items
  roundCount: number (default 10)
  perRound: {inputTimerMs (default 15000), revealDelayMs (default 1500)}
  ratio: {truesPerRound: 'RANDOM' (50/50) | 'BALANCED' (abwechselnd)}
  scoring: {correct: 100, wrong: 0, streakBonus: 50 (je 3) — VORSCHLAG}
  showSource: boolean (default true, bei Reveal)
  hostCanPlay: boolean (default true)
  language: de-DE
}
```

- Quick: SYSTEM-Pool „Alltag & Geschichte — Wahr oder Fake?", 10 Runden.
- Preflight: ≥2 Spieler, Pool READY.

## 5. Content-/Editor-Schema

- Item = `WofItem`: statement (Aussage), isTrue (boolean), correction?
  (wahrheitsgemäße Korrektur bei Fake, Pflicht wenn isTrue=false),
  source? (Quellenangabe, Pflicht PUBLIC), difficulty, tags, language.
- READY: statement + isTrue; bei Fake: correction nicht leer; PUBLIC:
  source.
- **Review:** PUBLIC-Uploads mit isTrue=false müssen eine prüfbare
  Korrektur haben (PR18 Review-Workflow).

## 6. Phasen/Commands

```
INTRO → (je Runde) STATEMENT_REVEAL → INPUT_OPEN (WAHR/FAKE) → INPUT_LOCKED → REVEAL (wahrheitsgemäße Antwort + Korrektur/Bestätigung + Quelle) → ROUND_END → … → GAME_END → FINALIZED
```

| Command | Rolle | Phase |
|---|---|---|
| `answer.submit` (TRUE\|FALSE) | PLAYER | INPUT_OPEN |
| `round.reveal` | HOST / auto | INPUT_LOCKED |
| `round.next` / `pause`/`resume` | HOST | — |

- **Ablaufbeispiel:** „In Deutschland gibt es mehr Kanalschiffe als
  Autofahrer." → A: WAHR, B: FAKE → Reveal: FAKE (Korrektur: …,
  Quelle: Statistisches Bundesamt) → B: +100.

## 7. Wertung & Endgründe (Vorschläge, DEC-WOF-01)

- +100 korrekt, 0 falsch, +50 Streak (3 in Folge) — Vorschlag;
  kein Minus (Alternative −10).
- Nichtabgabe: 0.
- Ties: keine (Punkte integer, Streaks können Ties brechen — aber
  **kein** Tie-Breaker-Ende, geteilte Plätze).
- Endgründe: `COMPLETED`, `HOST_ABORTED`, `TECHNICAL_ABORT`,
  `INSUFFICIENT_PLAYERS`.

## 8. Projektionen & Secrets

- PLAYER: Aussage, Timer, eigene Tipp (private), Punkte/Streak;
  **kein** isTrue/correction vor Reveal.
- HOST: + isTrue/correction ab REVEAL.
- VIEWER: Aussage, Timer, Punkte; Wahrheit nach Reveal.
- DISPLAY: große Aussage + Reveal.
- Preloading: Aussage-Text (PUBLIC), isTrue/correction nie.

## 9. Rejoin/Pause/Host-Ausfall/Recovery

- Rejoin: Phase, eigene Tipp, Punkte, Streak.
- Pause: Input gesperrt.
- Host-Ausfall: Auto-Reveal; Host-Transfer.
- Recovery: Submissions persistiert; keine Doppel (commandId).

## 10. Results/Stats/Events/Versionierung

- RoundResult: Item-Ref, Tipp-Verteilung, Wahrheit, Korrektur-Ref,
  Punkte, Dauer, Streaks.
- GameResult: Platzierungen, Endpunkte.
- Stats: games, wins, correct rate, max streak, „Fake-erkennen"-Rate
  (§9.12).
- Engine-Version: `1` (neu).

## 11. Tests & DoD

- 10 Pflichttests + spezifisch: isTrue-Leak (kein Boolean in
  Player-Payload vor Reveal), Korrektur-Nachweis (Fake ohne Korrektur
  = Import-Validierung), Streak-Test, Auto-Reveal-Test.
- Cores: Submission (binär), Timer, Reveal/Visibility, Score (Streak),
  Round-Transition, Leaderboard, Result-Screen, Notification, Recovery.

## 12. Offene Punkte

| ID | Frage | Vorschlag (default) |
|---|---|---|
| DEC-WOF-01 | Punkte/Streak, Verhältnis WAHR/FAKE, Quellen-Pflicht, Team-Mehrheit | 100/0/+50, 50/50 balanced, Quellen Pflicht (PUBLIC), Team = Mehrheit |

---

## 13. Engine-Vertrag, Late Join & Rollen-Policy (12-08)

- **Gemeinsamer Vertrag:** `wahr-oder-fake` referenziert `../technical-mapping.md §3.4`
  (Zustandsmaschine, Command-Guards 1–4, Projektionen/`availableActions`,
  Persistenz/Version/Recovery, Medien-/Voice-/Camera-/Mic-/Display-Defaults)
  und weicht **nur** in den folgenden Punkten ab. `INSUFFICIENT_PLAYERS`
  gilt nur an Start-/Transition-Gates, nie gegen das absichtlich sinkende
  aktive Teilnehmerfeld im Spielverlauf (§12-10).
- **Late-Join-Policy (engine-spezifisch):** Nein während `INPUT_*` der laufenden Runde → `PENDING_JOIN`, ab der **nächsten** Runde aktiv.
- **Ausscheidende Teilnehmer:** keine (alle bleiben aktiv).
- **Teamrollen/Rotation:** Team = Mehrheit (Vorschlag DEC-WOF-01).
- **Voice/Camera/Mic (Abweichung von den Defaults):** Mikrofon MUTED (Default). ·
- **Viewer (FEST, Master §7.23 — kein Spiel darf abweichen):** kein Mic/Send (Viewer senden nie Audio); Viewer hört `MAIN`; nie `TEAM`; Host kann Viewer-Audio deaktivieren. ·
  Camera: OFF (Default).
- **Medien in Phasen:** keine (Fakten/Quellen als Text).
- **RESULT_REVIEW:** geerbt (§3.4).
