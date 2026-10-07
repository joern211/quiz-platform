# Wissensduell (`wissensduell`) — Spezifikation

**Status main:** AVAILABLE (MVP als „Geo" gebaut, PR10 auf kanonischen Slug
migriert). **Ziel-PR:** PR37 (auf vollständige V1-Verträge), Content-Regeln
mit PR17. **Keine neue Engine** — die bestehende `games/geo/`-Engine wird
ergänzt/integriert.

## 1. Kurzbeschreibung & Regelquellen

Generisches Wissens-/Multiple-Choice-Duell. Das frühere Geo-Spiel wird zu
einem spielübergreifenden Wissensspiel; Geo und Allgemeinwissen sind
**Content-Kategorien/Pools**, keine eigenen Spiele.

- FEST: Master §15.1 (Spielcharakter, Kategorien, Slug-Migration), §14.
- FEST: zentrale Regeln §5 (Game Core), §6 (Content), §13 (DoD).

## 2. Feste Regeln

- 4-Antworten-Multiple-Choice (bestehend, wird behalten als Content-Default).
- Kategorien/Pools: Geo, Geschichte, Naturwissenschaften, Technik,
  Allgemeinwissen, weitere Tags (§15.1 FEST).
- `geo`-Slug-Referenzen migriert (PR10, umgesetzt).
- Zentrale Content-/Pool-/Difficulty-/Repeat-/Stats-Regeln gelten (§15.1 FEST,
  Umsetzung in PR17 — heute MISSING).
- Punkte über ScoreEvent-Ledger, Rejoin/Resync, Buzzer optional (heute:
  Timer-Antwortmodus ohne Buzzer).

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| minPlayers / maxPlayers | 2 / 10 (bestehend) | FEST (Manifest) |
| Teams | optional (hasTeams heute false; Team-Modus über PR14 möglich) | O |
| Host-Mitspiel | erlaubt; Host ist als Player normal — keine Secrets im MC-Modus, da Lösungen erst im Reveal an alle gehen | FEST §2.1/16.16-Analogie |
| Secrets | korrekte Option + Erklärung bis REVEAL `PLAYER_PRIVATE` (eigene Auswahl) / `HOST_PRIVATE` (Lösung+Erklärung vor Reveal) | FEST §5.15 |

## 4. Setup (Ziel)

```
WissensduellSetup {
  pools: ContentPoolRef[]          // Multi-Pool §6.8 (heute: 1 Pool)
  poolSelection: {mode: RANDOM|MANUAL|MIXED, perPoolCount?, filters:{tags?,difficulty?,category?,seen?}}
  repeatRule: NO_REPEAT_IN_ROOM|ALLOW_REPEATS|PREFER_UNSEEN   // §6.9
  difficultyProgression: {mode: FIXED|RANGE|PERCENT, preset?} // §6.13
  questionCount / roundCount: number|null
  perQuestion: {timerMs (default 20000, min 5000 — bestehend), points (100), wrongPoints (0)}
  jokers: {j5050, spy, risk} — bestehend, behalten (VORSCHLAG: als Standard-Preset)
  buzzerMode: OFF|PER_QUESTION     // VORSCHLAG DEC-KAT-01: MC-Duell bleibt ohne Buzzer, Buzzer-Option offen
  lateJoin: allowLateJoin (Room-Core)
  hostContentVisibility: HOST_PREVIEW|BLIND_HOST   // §6.10
}
```

- **Quick Defaults:** 1 Pool (erster PRIVATE/SYSTEM-READY-Pool des Hosts),
  10 Fragen, 20s, 100 Punkte, alle Joker an.
- **Advanced:** Multi-Pool, Filter, Difficulty-Progression, Repeat, BLIND_HOST.
- **Preflight:** ≥2 Spieler, Pool READY mit genügend Items (min = questionCount,
  sonst `WARNINGS` bei randomFill), Timer-Limits.

## 5. Content-/Editor-Schema

- Item = `WissensduellQuestion` (bestehendes GeoQuestion-Modell, migriert):
  prompt, category (Tag), 4 Optionen, correctOptionId, explanation?,
  mediaAssetId? (Bild/Audio), durationMs?, points?, difficulty, tags.
- **READY-Kriterien** (§6.43): prompt nicht leer, 4 unterschiedliche Optionen,
  correctOptionId gültig, Ready-Sprache, Media READY (falls vorhanden),
  Difficulty gesetzt wenn Pool es verlangt.
- Editor: Quick (prompt, 4 Optionen, korrekte Option, Category, Difficulty) +
  Advanced (Erklärung, Media, Punkte-Override, Timer-Override, Tags).
- Presets: SYSTEM-Quick-Template „Allgemeinwissen 10" (VORSCHLAG).
- Sprache: Content-Language de-DE (später en-US/tr-TR, §6.36).

## 6. Phasen/Commands (Ziel)

```
INTRO → (je Frage) PROMPT → INPUT_OPEN → INPUT_LOCKED → REVEAL → ROUND_END → … → GAME_END → RESULT_REVIEW → FINALIZED
```

| Command | Rolle | Phase | Wirkung |
|---|---|---|---|
| `answer.submit` (optionId) | PLAYER | INPUT_OPEN | Antwort (DRAFT→SUBMITTED), Timer-Lock möglich |
| `joker.5050 / joker.spy / joker.risk` | PLAYER | INPUT_OPEN | bestehende Joker (serverseitig, 1× pro Spieler) |
| `timer.extend / timer.end / timer.pause` | HOST (TIMER_CONTROL) | INPUT_OPEN/… | §5.5 |
| `round.reveal` | HOST (REVEAL_CONTENT) | INPUT_LOCKED/after Timer | REVEAL |
| `game.start / game.pause / game.resume` | HOST (GAME_*) | — | Lifecycle |
| `emergency.*` | HOST | — | §4.16 |

- `availableActions` je Phase/Rolle (Next-Action-Core).
- **Ablaufbeispiel:** 4 Spieler, Frage „Hauptstadt von Australien?" —
  Input 20s, zwei antworten, REVEAL zeigt korrekte Option (Canberra) +
  Erklärung, +100 für Korrekte, Speed-Bonus optional (bestehend).

## 7. Wertung & Endgründe

- +`points` korrekt, +`wrongPoints` (default 0) falsch, Speed-Bonus optional
  (bestehend, VORSCHLAG als Preset-Option).
- Ledger-Events: `ANSWER_CORRECT`, `ANSWER_WRONG`, `ROUND_BONUS` (Speed).
- Keine Ties-Problematik (Punkte integer); Endstand = Leaderboard.
- Endgründe: `COMPLETED` (alle Fragen), `HOST_ABORTED`, `TECHNICAL_ABORT`,
  `INSUFFICIENT_PLAYERS` (unter Min während Pause — VORSCHLAG),
  `TIME_LIMIT_REACHED` (Room-Spielzeitlimit optional).
- Timeout: nicht beantwortet = falsch (0 bzw. wrongPoints).

## 8. Projektionen & Secrets

- PLAYER: eigene Auswahl (private), Frage, Timer, (Joker-Zustand eigen).
- HOST: + Lösung/Erklärung ab REVEAL, Spy-Joker-Daten (bestehend: Spy zeigt
  Verteilung — bleibt `HOST_PRIVATE`), Status-Übersicht.
- VIEWER/DISPLAY: Frage, Timer, Optionen; **keine** Lösung vor REVEAL.
- Preloading: nächste Frage nur wenn leak-safe (BLIND_HOST: nie Inhalte).

## 9. Rejoin/Pause/Late Join/Host-Ausfall/Recovery

- Rejoin: Name/Team/Punkte/Rundenzustand/eigene Auswahl (wenn vor Reveal) —
  bestehend, ausbauen auf §4.10-Vollstand.
- Pause: Timer stoppt, Input gesperrt (bestehend), exakte Fortsetzung.
- Late Join: erlaubbar (MC-Spiel ist spät-join-freundlich), Score 0, keine
  Secrets vergangener Fragen.
- Host-Ausfall: Spiel läuft weiter (keine zwingende Hostaktion bis Reveal;
  Reveal kann automatisiert nach Timer sein — VORSCHLAG DEC-KAT-02:
  Auto-Reveal-Option), Host-Transfer nach Frist.
- Recovery: State + Timer aus echten Zeitpunkten; keine Doppel-Punkte
  (Ledger-Idempotenz über commandId).

## 10. Results/Stats/Events/Versionierung

- RoundResult: Frage-Ref, Antwortverteilung, Punkte, Dauer.
- GameResult: Platzierungen, Gesamtpunkte, Endgrund.
- Stats: games, wins, hit rate, avg answer time, best streak (zentrales
  Schema §9.12), Content-Usage (Empirical Difficulty).
- Engine-Version: best. `engineVersion=1` → `2` bei V1-Vertrags-Anpassung
  (PR37); Recovery nutzt gepinnte Version.

## 11. Tests & DoD

- Bestehend: E2E G4-1…G4-6, Integrationstests, Rejoin-Test.
- **Neu (PR37):** alle 10 Pflichttests des DoD-Blocks, Secret-Leak-Test
  (Lösung/Erklärung nicht vor REVEAL in Player/Viewer/Display-Snapshot),
  Duplicate-Command-Test, BLIND_HOST-Test, Multi-Pool-Snapshot-Test,
  Auto-Reveal-Test (falls DEC-KAT-02 bestätigt).
- Verwendete Cores: Timer, Submission, Reveal/Visibility, Score,
  Round-Transition, Leaderboard, Result-Screen, Notification, Recovery,
  Next-Action (mit jeopardy/wer-ist-das = 2-Engine-Nachweis je Core).

## 12. Offene Punkte

| ID | Frage | Vorschlag |
|---|---|---|
| DEC-KAT-01 | Buzzer-Option im Wissensduell? | OFF (MC-Duell ohne Buzzer), als Preset-Option offen |
| DEC-KAT-02 | Auto-Reveal nach Timer-Ende (Host-Ausfall)? | ja, Option `autoRevealOnExpire` default ON |
