# Millionenfrage (`millionenfrage`) — Spezifikation

**Status main:** PLANNED, keine Engine. **Ziel-PR:** PR27 (nach PR15–18).
**Slug FEST** (§14/§15.13).

## 1. Kurzbeschreibung & Regelquellen

Millionär-Prinzip: Fragenleiter mit steigender Schwierigkeit,
Sicherheitsstufen (Gewinnbank), Joker, Ausstieg möglich. Der Name
„Millionenfrage" ist der kanonische Plattform-Name für das
Millionär-Prinzip — keine Marken-Referenzen.

- FEST §15.13: eigener Name, kanonischer Slug, Content-Pools,
  progressive Fragen/Difficulty, Joker über game-spezifische capabilities,
  zentrale Result/Timer/Submission/Visibility Cores.
- OFFEN: Fragenleiter (Stufenzahl/Beträge), Sicherheitsstufen,
  Joker-Satz, Ausstiegs-Regel → DEC-MIL-01.

## 2. Feste Regeln (Prinzip)

- Linearer Fragenleiter: Frage 1 → n (steigende Schwierigkeit).
- Sicherheitsstufen (Bank-Level): ab bestimmten Stufen wird der
  bisherige Gewinn „gesichert" (Verlust geht nur bis letzte Stufe).
- 3 Antworten (MC) oder verbal (Vorschlag: **MC mit 4 Optionen** als
  Default, da Content-Pools — DEC-MIL-01).
- Joker: game-spezifische capabilities (z. B. 50:50, Publikum? —
  Vorschlag: 50:50 + „Experten-Hint" + „Zeitverdopplung" — DEC-MIL-01).
- Ausstieg: Spieler kann nach jeder Sicherheitsstufe aufhören und
  gesicherten Gewinn behalten (Vorschlag: jederzeit, Gewinn = letzte
  erreichte Sicherheitsstufe; nach Nicht-Sicherheitsstufe = vorherige).
- Serverautoritativ: Antwort-Geheimhaltung, Timer, Reveal.

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 1 / 8 (Solo-spielbar! — Vorschlag) | V |
| Teams | nein (individuell) | V |
| Host-Mitspiel | nur ohne Lösungsvorsprung (§3.4-C); mitspielend Lösung erst nach Reveal. Verbal-Judge mit bekannter Lösung darf in derselben Frage nicht antworten; MC mit automatischer Wertung kann blind mitspielen | V |
| Secrets | korrekte Option + Erklärung: `HOST_PRIVATE` bis REVEAL | F (Prinzip) |

**Solo-Modus:** 1 Spieler + Host — das Spiel läuft „im Solo" (kein
Multiplayer-Wettbewerb); Host kann pausieren/steuern. Solo-Unterstützung ist hier ein Vorschlag mit `minPlayers=1`; Yacht
unterstützt Solo bereits verbindlich (Master §16.3).

## 4. Setup (Ziel)

```
MillionenfrageSetup {
  pools: ContentPoolRef[]           // Fragenleiter-Items (mit Stufe 1..n)
  ladderSize: number (default 10)   // Stufen, DEC-MIL-01
  perQuestion: {timerMs (default 60000)}
  bankLevels: number[] (default [3, 6, 9, 10] — Stufen 3/6/9/10 sichern Gewinn)
  jokers: {fiftyFifty: true, expertHint: true, timeDouble: true} (je 1× pro Spiel)
  points: {perStage: [10,20,30,50,75,100,150,200,300,400] — VORSCHLAG}
  autoReveal: true (MC-Modus)
  hostCanPlay: boolean (default true)
  language: de-DE
}
```

- Quick: SYSTEM-Leiter „Millionenfrage 10" (Fragen mit Stufe 1–10
  vorbefüllt), 60s, alle Joker.
- Preflight: ≥1 Spieler, Leiter vollständig (Stufe 1–n, READY).

## 5. Content-/Editor-Schema

- Item = `MillionenfrageQuestion`: stage (1–10), prompt, 4 Optionen,
  correctOptionId, explanation?, difficulty (automatisch: Stufe),
  tags, language.
- Leiter = `MillionenfrageLadder` (10 Items, Stufen 1–10, je Pool).
- READY: 4 Optionen, correctOptionId, Stufe gesetzt, Sprache.
- Editor: Leiter-Template (10 Fragen in einem Set-Editor).

## 6. Phasen/Commands

```
INTRO → (je Stufe) QUESTION_REVEAL → INPUT_OPEN → INPUT_LOCKED → REVEAL (richtige Option + Bank-Stand) → (AUSSTIEG?) → NEXT_STAGE|GAME_END (GEWONNEN|GEKNACKT) → FINALIZED
```

| Command | Rolle | Phase |
|---|---|---|
| `answer.submit` (optionId) | PLAYER | INPUT_OPEN |
| `joker.fifty / joker.expert / joker.time` | PLAYER | INPUT_OPEN |
| `player.bailout` (Ausstieg) | PLAYER | REVEAL (nach korrekter Antwort) |
| `stage.next` / `game.start` / `pause`/`resume` | HOST | — |
| `emergency.*` | HOST | — |

- **Ablaufbeispiel (12-10: Bank-Level [3,6,9,10], perStage
  [10,20,30,50,75,100,150,200,300,400]):**
  Stufen 1–8 korrekt → nach Stufe 8 hat der Spieler **200 P erreicht**,
  aber nur bis **Stufe 6 = 100 P gesichert** (Stufe 8 ist **keine**
  Bank-Stufe; früher hieß es „Bank 200" und „letzte Bank-Stufe 8").
  Stufe 9 falsch → **Gewinn = 100** (letzte abgeschlossene Bank =
  **Stufe 6**), Spielende „Geknackt".

## 7. Wertung & Endgründe

- Gewinn = Punkte der letzten erreichten **Bank-Stufe** (bei Ausstieg
  oder Fehler danach).
- Ledger-Events: `STAGE_CLEARED`, `BANK_UPDATED`, `JOKER_USED`,
  `GAME_WON`, `GAME_LOST`.
- Ties: keine (Solo/individuell).
- Endgründe: `COMPLETED` (alle Stufen → „Millionär"), `BAILOUT`
  (Ausstieg), `FAILED` (falsche Antwort), `HOST_ABORTED`,
  `TECHNICAL_ABORT`.

## 8. Projektionen & Secrets

- PLAYER: Frage, eigene Auswahl (private), Bank-Stand, Stufe,
  Joker-Status; **keine** Lösung vor Reveal.
- HOST: + Lösung/Erklärung ab REVEAL, Steuerung.
- VIEWER: Frage, Stufe, Bank; Lösung nach Reveal.
- DISPLAY: große Fragenleiter-Ansicht (Stufen + Bank).
- Preloading: nächste Frage **nie** (leak-safe) — nur aktuelle.

## 9. Rejoin/Pause/Host-Ausfall/Recovery

- Rejoin: Phase, Bank-Stand, Stufe, eigene Auswahl (wenn offen), Joker.
- Pause: Timer stoppt, Input gesperrt.
- Host-Ausfall: Auto-Reveal (MC); Host-Transfer; Spiel läuft fort.
- Recovery: Bank-Stand + Stufe persistiert; keine Doppel-Reveal;
  Joker-Zustand konsistent.

## 10. Results/Stats/Events/Versionierung

- RoundResult = pro Stufe (Frage-Ref, Antwort, korrekt?, Bank, Joker).
- GameResult: Endstufe, Gewinn, Endgrund.
- Stats: games, wins (Millionär), avg stage, bank-kept rate (§9.12).
- Engine-Version: `1` (neu).

## 11. Tests & DoD

- 10 Pflichttests + spezifisch: Lösung-Leak, Bank-Logik-Test
  (Sicherheitsstufen), Ausstiegs-Test (Gewinn = letzte Bank),
  Joker-Einmaligkeit, Solo-Modus-Test (1 Spieler), Recovery nach
  Reveal (Bank konsistent).
- Cores: Submission (MC), Timer, Reveal/Visibility, Score (Bank-Logik),
  Round-Transition, Result-Screen, Notification, Recovery.

## 12. Offene Punkte

| ID | Frage | Vorschlag (default) |
|---|---|---|
| DEC-MIL-01 | Leiter-Größe, MC vs. verbal, Joker-Satz, Bank-Level, Punktewerte, Solo-Support | 10 Stufen, MC 4-Option, 50:50+Expert+Zeit, Bank [3,6,9,10], [10..400], Solo ja (minPlayers=1) |

---

## 13. Engine-Vertrag, Late Join & Rollen-Policy (12-08)

- **Gemeinsamer Vertrag:** `millionenfrage` referenziert `../technical-mapping.md §3.4`
  (Zustandsmaschine, Command-Guards 1–4, Projektionen/`availableActions`,
  Persistenz/Version/Recovery, Medien-/Voice-/Camera-/Mic-/Display-Defaults)
  und weicht **nur** in den folgenden Punkten ab. `INSUFFICIENT_PLAYERS`
  gilt nur an Start-/Transition-Gates, nie gegen das absichtlich sinkende
  aktive Teilnehmerfeld im Spielverlauf (§12-10).
- **Late-Join-Policy (engine-spezifisch):** Nein in der laufenden Stufe → `PENDING_JOIN`, ab der **nächsten** Stufe aktiv; Bank-Stand via Resync (nur eigene Bank, `PLAYER_PRIVATE`).
- **Ausscheidende Teilnehmer:** Solo-Modus: kein Ausscheiden; MC-Runde endet mit GEWONNEN/GEKNACKT (Vorschlag DEC-MIL-01).
- **Teamrollen/Rotation:** keine (Solo oder FFA).
- **Voice/Camera/Mic (Abweichung von den Defaults):** Mikrofon: gemeinsamer, Host-konfigurierbarer Default (§3.4/Master §7.21), Bestätigung im Prejoin. ·
- **Viewer (FEST, Master §7.23 — kein Spiel darf abweichen):** kein Mic/Send (Viewer senden nie Audio); Viewer hört `MAIN`; nie `TEAM`; Host kann Viewer-Audio deaktivieren. ·
  Camera: OFF (Default).
- **Medien in Phasen:** keine.
- **RESULT_REVIEW:** geerbt (§3.4).
