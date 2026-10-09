# Jeopardy (`jeopardy`) — Spezifikation

**Status main:** AVAILABLE (MVP, `games/jeopardy/`). **Ziel-PR:** PR37
(Vollständige V1-Verträge). **Keine neue Engine.**

## 1. Kurzbeschreibung & Regelquellen

Klassisches Jeopardy-Board: 2 Boards à 6 Kategorien, verbale Antworten,
Host-Judge, Steals, Buzzer, Punkte über ScoreEvents, Rejoin/Resync,
Secret/Projection-Regeln.

- FEST: Master §15.2 (Spielcharakter + zentrale Cores).
- FEST: §5 (Game Core), §6 (Content), §13 (DoD).
- BESTEHEND: Board-Struktur, Phasen `SELECTING → BUZZ_OPEN → BUZZ_LOCKED →
  FIELD_DONE / STEAL_OPEN → STEAL_LOCKED → … → BOARD_COMPLETE`,
  atomarer Buzzer (CAS), Steal-Ausschluss, ScoreEvents.

## 2. Feste Regeln (Master + bestehender MVP)

- Verbale Antworten, Host bewertet (JUDGE_ANSWER).
- Steals: nach falscher Antwort dürfen andere antworten; Steal-Winner
  scheidet für Folge-Steals aus (`excludedPlayerId`, bestehend).
- Buzzer: erster gültiger Servereingang (SERVER_ARRIVAL), falsche Antwort
  → optional Runden-Ausschluss (Buzzer-Core `excludedPlayerIds`, bestehend).
- Punkte über ScoreEvent-Ledger (`recordScoreMutation`, bestehend).
- **Geheimhaltung (BESTEHEND, Ist — Engine `handleFieldOpen`, E2E J9
  grün):** Beim **Feldöffnen** geht die **Frage an ALLE**
  (`jeopardy:field:open` → Raum-Kanal); die **Lösung geht NUR an den
  Host** (`jeopardy:answer:secret` → Moderator-Socket). **Nicht**
  „Frage + Lösung an Winner + Host" — der Buzzer-Winner sieht die
  Frage bereits im öffentlichen Feld-Event; die Lösung bleibt
  Judge-only. (12-05: Projektion korrekt übernommen.)

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 2 / 10 (Manifest) | FEST |
| Teams | heute false; Team-Buzzer über Buzzer-Core (PR15) möglich | O |
| Host-Mitspiel | erlaubt; **administrierende Rolle ≠ Informationsrecht** (FEST, Master §2/§10): Die Trennung von Verwaltung (Judge) und Gameplay-Information ist **keine freigabefähige Alternative** — ein „akzeptabler Wissensvorteil" ist keine zulässige Option. Ist: Host sieht die Lösung als Judge bei jedem Feld (Judge-only-Kanal, §2). Konkrete faire Rollenlösung für den mitspielenden Host → **VORSCHLAG DEC-JEO-01** (Host wird in eigenen Runden aus dem Buzzer-Pool ausgeschlossen — kein Rollenmodell-Bruch) | IST + Vorschlag |
| Secrets | **Frage: PUBLIC** ab Feldöffnen (alle, E2E J9); **Lösung: Judge-only** (`HOST_PRIVATE`-Kanal, nur Host) bis Feld abgeschlossen | FEST §5.15, IST |

## 4. Setup (Ziel)

```
JeopardySetup {
  pools: ContentPoolRef[]            // Kategorien als Pools/Tags
  boards: 1|2 (default 2, bestehend)
  categoriesPerBoard: 6 (bestehend)
  questionCount: boards * 6
  perField: {timerMs (default 20000 — bestehend), pointValues: [200,400,600,800,1000,2000] (bestehend)}
  stealAllowed: true (bestehend)
  falseBuzzPenalty: none (bestehend: Steal-Ausschluss)
  buzzerLockoutMs: 1000 (bestehend, config)
  repeatRule / difficultyProgression: wie Wissensduell (PR17)
  hostContentVisibility: HOST_PREVIEW|BLIND_HOST
}
```

- Quick Defaults: 2 Boards, je 6 Kategorien aus erstem READY-Pool,
  Standard-Werte, Steals an.
- Preflight: genügend Fragen pro Kategorie/Wert (sonst WARNINGS).

## 5. Content-/Editor-Schema

- Item = `JeopardyQuestion`: prompt (Feldtext), answer (verbal, Lösung),
  category (Tag), pointValue, explanation?, mediaAssetId?.
- READY: prompt + answer nicht leer, Kategorie vorhanden, Wert im Raster.
- Editor Quick: Feld, Antwort, Kategorie, Wert. Advanced: Erklärung, Media,
  Synonyme für Judge-Hilfe (VORSCHLAG).
- SYSTEM-Quick-Template „Jeopardy 2×6".

## 6. Phasen/Commands (bestehend, vereinheitlicht)

```
SELECTING → BUZZ_OPEN → BUZZ_LOCKED → FIELD_DONE | (WRONG) STEAL_OPEN → STEAL_LOCKED → … → BOARD_COMPLETE → … → GAME_END → RESULT_REVIEW → FINALIZED
```

| Command | Rolle | Phase |
|---|---|---|
| `field.select` | PLAYER (im SELECTING) | SELECTING |
| `buzz` / `steal.buzz` | PLAYER | BUZZ_OPEN / STEAL_OPEN |
| `judge.decide` (CORRECT\|WRONG\|CANCELLED + reason?) | HOST (JUDGE_ANSWER) | BUZZ_LOCKED / STEAL_LOCKED |
| `timer.*` | HOST | während Feld |
| `board.next` / `game.start` / `pause`/`resume` / `emergency.*` | HOST | — |

- **Ablaufbeispiel (Ist-Wertung, gepinnter Stand):** Feld „Geografie
  400" → Frage an alle, Lösung nur Host → Player A buzzt → A falsch →
  **A −200** (`pointsForWrongFirst(400) = −Math.round(400/2)`) →
  STEAL_OPEN → Player B buzzt → korrekt → **B +200**
  (`pointsForCorrectSteal(400) = Math.round(400/2)`). (Steal-Ausschluss
  für Folge-Steals bleibt bestehen.)

## 7. Wertung & Endgründe (IST — aus `contracts.ts` abgeleitet, 12-05)

- **Korrekt zuerst:** **+Feldwert** (`pointsForCorrect` → `value`).
- **Falsch zuerst:** **−halber Feldwert**, gerundet
  (`pointsForWrongFirst` → `−Math.round(value/2)`).
- **Korrekter Steal:** **+halber Feldwert**, gerundet
  (`pointsForCorrectSteal` → `Math.round(value/2)`).
- **Falscher Steal:** **−halber Feldwert**, gerundet, kein weiterer
  Steal (`pointsForWrongSteal` → `−Math.round(value/2)`).
- (Ist-Befund 12-05: Der Entwurf behauptete „falsch (Steal verloren):
  −Feldwert" und „+400 für Steal auf ein 400er-Feld" — beides **falsch**;
  die bestehenden Funktionen geben jeweils ±halben Wert.)
- Ledger-Events: `ANSWER_CORRECT`, `ANSWER_WRONG` (Score-Mutation via
  `recordScoreMutation`).
- Ties: möglich → Leaderboard zeigt Gleichstand (Tie-Core `ALLOW_TIE` Default,
  Endplatzierung mit geteiltem Platz — VORSCHLAG DEC-JEO-02).
- Endgründe: `COMPLETED` (alle Felder), `HOST_ABORTED`, `TECHNICAL_ABORT`,
  `INSUFFICIENT_PLAYERS`, `RULE_TRIGGERED_END` (negativer Gesamtpunkt-
  Limit? — OFFEN, nicht im Master; **kein** Default).

## 8. Projektionen & Secrets

- PLAYER: Board, gewählte Felder, eigene Punkte, Timer; **Frage: alle**
  ab Feldöffnen; **Lösung: NUR Host** (Judge-only).
- HOST: Judge-Ansicht (Lösung bei jedem Feld), Scoreboard, Steuerung.
- VIEWER: Board, Werte, „Feld offen/besetzt", Scoreboard; keine Lösung.
- DISPLAY: große Board-Ansicht (PR20).
- Preloading: nächste Feldtexte nie (leak-safe).

## 9. Rejoin/Pause/Host-Ausfall/Recovery

- Rejoin/Resync: bestehend (E2E J7); Buzzer-Reihenfolge wird nicht
  verändert; offene Steals werden rekonstruiert.
- Pause: Buzzer gesperrt, Timer stoppt (Game-Core).
- Host-Ausfall: Spiel **pausiert** (Judge nötig) — nach Frist Host-Transfer;
  alternative Auto-Felder ohne Judge sind nicht vorgesehen (VORSCHLAG
  DEC-JEO-03: kein Auto-Judge).
- Recovery: State-CAS + Persistenz (bestehend); Buzzer/Score nie doppelt
  (commandId-Dedup, PR13/41).

## 10. Results/Stats/Events/Versionierung

- RoundResult = pro Feld (Frage-Ref, Winner, Punkte, Dauer, Steal-Flag).
- GameResult: Platzierungen, Endpunkte, Endgrund.
- Stats: games, wins, avg buzzer time, won buzzes, false buzzes (§9.12),
  Content-Usage.
- Engine-Version: `1` → `2` in PR37.

## 11. Tests & DoD

- Bestehend: E2E J1–J10 (inkl. J8 Judge-Rechte, J9 Geheimhaltung),
  State-/Contract-Tests (373/389 Zeilen), Socket-Flow-Integration (513 Zeilen).
- Neu (PR37): 10 Pflichttests vervollständigen, Duplicate-Command,
  Secret-Leak-Suite, Display-Projektion, FINALIZED-Integration.

## 12. Offene Punkte

| ID | Frage | Vorschlag |
|---|---|---|
| DEC-JEO-01 | Host-Mitspiel bei Judge-Rolle (Info-Vorteil durch sofortige Lösungsansicht)? | Host wird in eigenen Runden aus Buzzer-Pool ausgeschlossen (engine-/phasenbezogene Einschränkung, kein Rollenmodell-Bruch) |
| DEC-JEO-02 | End-Tie: geteilte Plätze oder Tie-Breaker-Feld? | `ALLOW_TIE` + geteilte Plätze (kein Zufalls-Tiebreaker) |
| DEC-JEO-03 | Auto-Judge bei Host-Ausfall? | nein — Pause + Transfer |

---

## 13. Engine-Vertrag, Late Join & Rollen-Policy (12-08)

- **Gemeinsamer Vertrag:** `jeopardy` referenziert `../technical-mapping.md §3.4`
  (Zustandsmaschine, Command-Guards 1–4, Projektionen/`availableActions`,
  Persistenz/Version/Recovery, Medien-/Voice-/Camera-/Mic-/Display-Defaults)
  und weicht **nur** in den folgenden Punkten ab. `INSUFFICIENT_PLAYERS`
  gilt nur an Start-/Transition-Gates, nie gegen das absichtlich sinkende
  aktive Teilnehmerfeld im Spielverlauf (§12-10).
- **Late-Join-Policy (engine-spezifisch):** Nein im laufenden Feld (`BUZZ_OPEN`/`STEAL_OPEN`/`BUZZ_LOCKED`) → `PENDING_JOIN`, ab dem **nächsten** Feld aktiv; Board-Fortschritt via Resync (Frage PUBLIC, Lösung Host-only).
- **Ausscheidende Teilnehmer:** keine Ausscheidung im Feldverlauf; Steal-Ausschluss ist field-begrenzt (§2).
- **Teamrollen/Rotation:** keine (Team-Buzzer ab PR15, Default individual).
- **Voice/Camera/Mic (Abweichung von den Defaults):** Mikrofon MUTED (Default). ·
  Camera: OFF (Default).
- **Medien in Phasen:** keine Standard; Media-Felder optional (leak-safe).
- **RESULT_REVIEW:** ausgewiesen (§6).
