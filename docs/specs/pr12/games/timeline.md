# Timeline (`timeline`) — Spezifikation

**Status main:** PLANNED, keine Engine. **Ziel-PR:** PR25 (nach PR15–18).
**Slug FEST** (§14/§15.8). **Eigenständig, nicht mit Higher or Lower**
(zusammenlegen) (FEST).

## 1. Kurzbeschreibung & Regelquellen

Sortierspiel: mehrere Items (z. B. 5–7 historische Ereignisse) müssen
**chronologisch oder numerisch** korrekt sortiert werden. Jeder Spieler
arbeitet an der eigenen Reihenfolge (Desktop: Drag & Drop, mobil:
Reihenfolge-Buttons); Reveal zeigt die korrekte Reihenfolge, Teilwertung
je Position.

- FEST §15.8: eigenständig, mehrere Items in Reihenfolge (chronologisch
  oder numerisch), zentrale Cores (Submission, Timer, Reveal, Score).
- OFFEN: Teilwertungs-Formel, gleiche Werte, Lock/Reveal-Timing,
  mobile-Eingabe-Details → DEC-TIM-01.

## 2. Feste Regeln

- Items werden **unsortiert** angezeigt (Random-Order, seedRef).
- Sortierregel: `CHRONOLOGICAL` (Datum/Jahr) oder `NUMERICAL`
  (Zahl, steigend/fallend konfigurierbar).
- Jeder Spieler gibt **eigene** Reihenfolge ein (privat bis Reveal).
- Reveal: korrekte Reihenfolge + eigene Positionen, Teilwertung.
- Gleiche Werte (z. B. zwei Ereignisse im selben Jahr): `TOLERATED_TIES`
  — beide Positionen gelten als korrekt (VORSCHLAG, DEC-TIM-01).

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 2 / 10 | V |
| Teams | optional (gemeinsame Reihenfolge — Team-Device? Nein: jeder gibt ein, Team-Resultat = beste? — Vorschlag: Team-Modus = 1 Device, gemeinsame Eingabe) | V |
| Host-Mitspiel | erlaubt; Host sieht korrekte Reihenfolge erst im Reveal (`HOST_PREVIEW=false`) | V |
| Secrets | korrekte Reihenfolge + Item-Werte (Jahre/Zahlen): `HOST_PRIVATE` bis REVEAL | F (Prinzip) |

## 4. Setup (Ziel)

```
TimelineSetup {
  pools: ContentPoolRef[]           // Timeline-Sets (je 4–7 Items)
  roundCount: number (default 5)
  perRound: {items: 4|5|6|7 (default 5), inputTimerMs (default 60000),
             revealDelayMs (default 2000)}
  sortMode: CHRONOLOGICAL|NUMERICAL (default CHRONOLOGICAL)
  direction: ASCENDING|DESCENDING (default ASCENDING)
  scoring: {fullCorrect: 100, perPosition: 20 (Teilwertung) — VORSCHLAG}
  tiesPolicy: TOLERATED (gleiche Werte zählen als korrekt)
  hostCanPlay: boolean (default true)
  language: de-DE
}
```

- Quick: SYSTEM-Pool „Geschichte & Alltagswissen", 5 Runden, 5 Items, 60s.
- Preflight: ≥2 Spieler, Pool READY (Items mit Sortierwert).

## 5. Content-/Editor-Schema

- Item = `TimelineEntry`: label (Anzeigetext), sortValue (zahl/datum),
  sortUnit (JAHRE|ZAHLEN|…), tieGroup? (für gleiche Werte),
  explanation?, difficulty, tags.
- Set = `TimelineSet` (mehrere TimelineEntry, 4–7, gleiche sortUnit).
- READY: ≥4 Einträge, alle sortValue gesetzt, keine Konflikte
  (sonst tieGroup gesetzt), Sprache.
- Editor Quick: Label + Wert je Eintrag, Einheit wählen.

## 6. Phasen/Commands

```
INTRO → (je Runde) SET_REVEAL (unsortierte Items) → SORTING_OPEN → SORTING_LOCKED → REVEAL (korrekte Reihenfolge + Teilwertung) → ROUND_END → … → GAME_END → FINALIZED
```

| Command | Rolle | Phase |
|---|---|---|
| `sort.update` (neue Reihenfolge, partial allowed) | PLAYER | SORTING_OPEN |
| `sort.lock` (optional, „fertig") | PLAYER | SORTING_OPEN |
| `round.reveal` | HOST / auto nach Timer | SORTING_LOCKED |
| `round.next` / `pause`/`resume` | HOST | — |

- **Eingabe:** `sort.update` sendet die komplette aktuelle Reihenfolge
  (einfach, idempotent); `sort.lock` = „fertig" (früher einreichen →
  optional Speed-Bonus, Vorschlag).
- **Mobile:** ↑/↓-Buttons je Item; Desktop: Drag & Drop.

## 7. Wertung & Endgründe (Vorschläge, DEC-TIM-01)

- **Teilwertungs-Vorschlag:** +`perPosition` (20) je korrekt platziertes
  Item; +50 Bonus wenn komplett korrekt (`fullCorrect` überschlägt
  die Summe); nicht eingeordnet (unvollständig) = 0 für die Position.
- **Ties:** Items mit gleichem sortValue (tieGroup): beide Positionen
  gelten als korrekt (Vorschlag `TOLERATED`).
- Endgründe: `COMPLETED`, `HOST_ABORTED`, `TECHNICAL_ABORT`,
  `INSUFFICIENT_PLAYERS`.

## 8. Projektionen & Secrets

- PLAYER: unsortierte Items (Labels), eigene aktuelle Reihenfolge,
  Timer; **keine** korrekte Reihenfolge/Werte vor Reveal.
- HOST: + korrekte Reihenfolge ab REVEAL.
- VIEWER: Items, Timer, „sortiert?"; korrekte Reihenfolge nach Reveal.
- DISPLAY: große Sortier-Ansicht.
- Preloading: Item-Labels (PUBLIC), sortValues nie.

## 9. Rejoin/Pause/Host-Ausfall/Recovery

- Rejoin: Phase, Items, eigene Reihenfolge (wenn schon eingegeben),
  Punkte.
- Pause: Input gesperrt, Timer stoppt.
- Host-Ausfall: Auto-Reveal nach Timer; Host-Transfer.
- Recovery: Sortier-Zustand persistiert (komplett, idempotent);
  keine Doppel-Reveal.

## 10. Results/Stats/Events/Versionierung

- RoundResult: Set-Ref, Reihenfolge je Spieler, Teilwertung, Dauer.
- GameResult: Platzierungen, Endpunkte.
- Stats: games, wins, avg positions correct, full-correct rate (§9.12).
- Engine-Version: `1` (neu).

## 11. Tests & DoD

- 10 Pflichttests + spezifisch: Sortierwert-Leak, Tolerated-Ties-Test,
  Partial-Update-Idempotenz (sort.update ×2 = letzter Zustand),
  Speed-Lock-Test, Recovery nach Disconnect (Reihenfolge erhalten).
- Cores: Submission (Sortierung), Timer, Reveal/Visibility, Score
  (Teilwertung), Round-Transition, Leaderboard, Result-Screen,
  Notification, Recovery.

## 12. Offene Punkte

| ID | Frage | Vorschlag (default) |
|---|---|---|
| DEC-TIM-01 | Teilwertungs-Formel, Ties, Speed-Bonus, Items/Runde, Richtung | 20/Position + 50 full-correct, Tolerated Ties, Speed-Bonus optional Preset, 5 Items, ASCENDING default |
