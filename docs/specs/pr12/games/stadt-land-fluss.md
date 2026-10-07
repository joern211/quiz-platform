# Stadt, Land, Fluss (`stadt-land-fluss`) — Spezifikation

**Status main:** PLANNED, keine Engine. **Ziel-PR:** PR29 (nach PR15–18).
**Slug FEST** (§14/§15.10).

## 1. Kurzbeschreibung & Regelquellen

Klassisches Wortspiel: ein Buchstabe wird gezogen, alle Spieler schreiben
**gleichzeitig und privat** je Kategorie (Stadt, Land, Fluss, …) ein
passendes Wort beginnend mit diesem Buchstaben. Gültigkeit wird über
Answer Matching + Synonyme geprüft; Duplikate in derselben Runde zählen
nicht (bzw. werden bestraft — Vorschlag).

- FEST §15.10: eigene Game-Idee; zentrale Systeme: Kategorien,
  Submission, Timer, Answer Matching, Duplicate Detection,
  Synonyms/Fuzzy, Auto/Manual Judge, individual scoring; Detailregeln
  später innerhalb der Cores.
- OFFEN: Buchstabenauswahl (zufällig/gezogen?), Timer-Länge,
  Einzelwertungs-Details, Serienwertung → DEC-SLF-01.

## 2. Feste Regeln

- Kategorien pro Runde: Standard „Stadt, Land, Fluss" (+ erweiterbar:
  „Tier", „Vorname", „Gegner-Kategorien" — Vorschlag: bis 6 Kategorien).
- Buchstabe: pro Runde serverseitig gezogen (Random-Core, seedRef),
  alle sehen denselben Buchstaben (PUBLIC — das ist Spielinhalt).
- Gleichzeitige private Texteingabe (Submission-Core, `DRAFT→SUBMITTED`).
- Validierung: Wort beginnt mit Buchstabe + passt zur Kategorie
  (Answer-Matching gegen Pool/Synonyme; sonst `NEEDS_JUDGE` → Host).
- Duplikat: zwei Spieler liefern in derselben Kategorie dasselbe Wort →
  beides ungültig (Vorschlag; Alternative: nur der spätere).
- Punkte je gültiger Kategorie-Erfüllung; „—" (kein Wort) erlaubt
  (0 Punkte, kein Minus).

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 2 / 10 | V |
| Teams | optional (Team = gemeinsame Karte? — Vorschlag: Team-Wert = Summe der gültigsten Einträge — DEC-SLF-01) | V |
| Host-Mitspiel | erlaubt; Host-Judge bei NEEDS_JUDGE (Info-Vorteil durch Sprachwissen — akzeptabel) | V |
| Secrets | eigene Worte: `PLAYER_PRIVATE` bis REVEAL (erst dann sichtbar) | F (Prinzip) |

## 4. Setup (Ziel)

```
StadtLandFlussSetup {
  pools: ContentPoolRef[]           // Wort-Pools je Kategorie (optional; ohne Pool = Host-Judge)
  categories: string[] (default ['Stadt','Land','Fluss'], max 6, frei definierbar)
  roundCount: number (default 5)
  perRound: {inputTimerMs (default 45000), revealDelayMs (2000)}
  letterSource: RANDOM_PER_ROUND (A–Z, serverseitig)
  scoring: {perValidCategory: 100, duplicate: 0 (beide ungültig) — VORSCHLAG}
  autoJudge: boolean (default true, wenn Pool vorhanden)
  hostCanPlay: boolean (default true)
  language: de-DE
}
```

- Quick: Kategorien S/L/F, 5 Runden, 45s, AUTO-JUDGE mit SYSTEM-Wortpool.
- Preflight: ≥2 Spieler; ohne Wort-Pool → `WARNINGS` (Manual-Judge nötig).

## 5. Content-/Editor-Schema

- Item = `SlfEntry`: category, word, synonyms[] (optional),
  language, tags.
- Pool je Kategorie (z. B. „Stadt-DE": 500 Einträge + Synonyme).
- READY: word + category + Sprache.
- **Fallback:** ohne Pool → Manual-Judge (Host entscheidet je Antwort);
  VORSCHLAG DEC-SLF-01: V1 ohne Pool nutzbar (Manual), SYSTEM-Pool
  „Deutschland-Basics" als Preset.

## 6. Phasen/Commands

```
INTRO → (je Runde) LETTER_REVEAL (Buchstabe + Kategorien) → INPUT_OPEN → INPUT_LOCKED → REVEAL (alle Karten + gültig/ungültig je Kategorie) → ROUND_END → … → GAME_END → FINALIZED
```

| Command | Rolle | Phase |
|---|---|---|
| `answer.submit` (category → word \| null) | PLAYER | INPUT_OPEN |
| `judge.decide` (je Antwort: VALID\|INVALID) | HOST | REVEAL (bei NEEDS_JUDGE) |
| `round.next` / `timer.*` / `pause`/`resume` | HOST | — |

- **Ablaufbeispiel:** Buchstabe „B". A: Stadt=Berlin, Land=Bayern,
  Fluss=…(—). B: Stadt=Baden-Baden, Land=Birken? (Land: falsch →
  Host-Judge: ungültig), Fluss=Braunschweig? (kein Fluss → ungültig).
  Reveal: A: 2×100, B: 1×100.

## 7. Wertung & Endgründe (Vorschläge, DEC-SLF-01)

- +100 je gültige Kategorie; Duplikat → beide 0 in dieser Kategorie;
  kein Wort (—) → 0; ungültig → 0 (kein Minus).
- **Serienwertung:** optional Streak-Bonus (Vorschlag: Preset, default OFF).
- Endgründe: `COMPLETED`, `HOST_ABORTED`, `TECHNICAL_ABORT`,
  `INSUFFICIENT_PLAYERS`.
- Ties: geteilte Plätze (integer).

## 8. Projektionen & Secrets

- PLAYER: Buchstabe, Kategorien, Timer, eigene Karte (private);
  **keine** fremden Worte vor Reveal.
- HOST: + Judge-Tools (NEEDS_JUDGE-Liste), Synonym-Details `HOST_PRIVATE`.
- VIEWER: Buchstabe, Kategorien, Timer; Karten nach Reveal.
- DISPLAY: große Buchstaben-Karte.
- Preloading: Kategorien (PUBLIC), Wort-Pool-Inhalte nie an Player.

## 9. Rejoin/Pause/Host-Ausfall/Recovery

- Rejoin: Phase, Buchstabe, eigene eingereichte Karte (wenn SUBMITTED),
  Punkte.
- Pause: Input gesperrt.
- Host-Ausfall: Auto-Reveal + AUTO-JUDGE (wenn Pool); bei Manual-
  Notwendigkeit → Pause + Transfer.
- Recovery: Submissions persistiert (komplett je Spieler/Kategorie);
  Duplikat-Erkennung deterministisch; keine Doppel-Submissions.

## 10. Results/Stats/Events/Versionierung

- RoundResult: Buchstabe, Karten (alle, nach Reveal), Validierung je
  Kategorie, Punkte, Dauer, Judge-Interventionen.
- GameResult: Platzierungen, Endpunkte.
- Stats: games, wins, valid per category, duplicate rate (§9.12).
- Engine-Version: `1` (neu).

## 11. Tests & DoD

- 10 Pflichttests + spezifisch: Karten-Leak (fremde Worte nicht vor
  Reveal), Duplikat-Test, Buchstaben-Fairness (serverseitig gezogen,
  kein Client-Buchstabe), Auto-vs-Manual-Judge-Test, Recovery (Karten
  erhalten), Sprache (Umlaute, Groß-/Kleinschreibung).
- Cores: Submission (Multi-Feld), Timer, Answer-Matching, Judge,
  Duplicate Detection, Reveal/Visibility, Score, Round-Transition,
  Leaderboard, Result-Screen, Notification, Recovery.

## 12. Offene Punkte

| ID | Frage | Vorschlag (default) |
|---|---|---|
| DEC-SLF-01 | Kategorien-Satz, Wertung (100), Duplikat-Regel, Serien-Bonus, Pool-Pflicht, Team-Modus | S/L/F + erweiterbar, 100, beide ungültig, Bonus OFF default, Pool optional (Manual-Fallback), Team = Summe bester Einträge |
