# Raus damit! (`board-race`) — Spezifikation

**Status main:** PLANNED, keine Engine. **Ziel-PR:** PR34 (nach PR14–18).
**Slug FEST** (§14/§15.16).

## 1. Kurzbeschreibung & Regelquellen

Digitale Figuren-Rennspiel-Variante: Spieler würfeln (serverseitig),
bewegen Figuren, können gegnerische Figuren „schlagen" (ins Startfeld
zurück), und rennen ins eigene Heimfeld. Eigener Name statt externer
Marken — kanonischer Slug `board-race`.

- FEST §15.16: eigene digitale Figuren-Rennspiel-Variante; Würfeln,
  Figuren bewegen, schlagen, Heimfeld, eigener Name statt externer
  Marken.
- OFFEN: Brettlayout (Feldanzahl, Heimfeld-Große), exakte
  Schlag-/Heimfeld-Regeln, Teamoptionen, Animationstiefe → DEC-BRD-01.
- **Ziel:** dieselben Turn-/Random-/Result-Verträge wie alle anderen
  Spiele (keine Sonderlösung für Würfel/Brett).

## 2. Feste Regeln (Prinzip)

- Brett: Startfeld → Felder 1…n → Heimfeld (eigenes, farbig).
- Würfeln: serverseitig (Random-Core, seedRef), Ergebnis PUBLIC,
  Client nur Animation; Rejoin/Reload würfelt **nie** neu.
- Zugwechsel: reihum (Turn-Core), zufällige Startreihenfolge.
- Schlagen: auf ein Feld mit gegnerischer Figur → Gegner ins
  Startfeld zurück (Vorschlag: nur bei exaktem Treffer, nicht per
  „Überfahren" — DEC-BRD-01).
- Heimfeld: exakter Rest nötig, um einzuziehen (Vorschlag; Alternative:
  Überfahren erlaubt — DEC-BRD-01).
- Sieg: erste Figur im Heimfeld (oder: alle Figuren eingezogen bei
  Mehr-Figuren — Vorschlag: **1 Figur pro Spieler**, erst gewinnt).
- Board-/Figurenzustand: serverautoritativ, persistiert, Rejoin-safe.

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 2 / 6 (Vorschlag — Brett-Übersicht) | V |
| Figuren | 1 pro Spieler (Vorschlag; 2 optional — DEC-BRD-01) | V |
| Teams | optional (Team = geteilte Farbe? — Vorschlag: nein, individuell; Teammodus als Preset) | V |
| Host-Mitspiel | erlaubt; Host sieht nichts Extra (kein Secret — Würfel sind PUBLIC) | V |
| Secrets | keine (Brett ist PUBLIC); ggf. „Geheimnis-Felder" als Preset | V |

## 4. Setup (Ziel)

```
BoardRaceSetup {
  boardSize: number (default 24 Felder, DEC-BRD-01)
  homeSize: number (default 6 Felder Heimfeld)
  figuresPerPlayer: number (default 1, max 2)
  dice: {sides: 6, perTurn: 1}
  hitRule: EXACT_HIT (nur exakter Treffer schlägt) | ANY_OVERRUN
  homeEntryRule: EXACT_REMAIN | OVERFLOW_ALLOWED
  turnTimerMs: number (default 30000, UNLIMITED optional)
  animation: {enabled: true, speed: 'NORMAL'}   // Client-seitig
  hostCanPlay: boolean (default true)
  language: de-DE
}
```

- Quick: Standard-Brett 24, 1 Figur, 6-Seiter, EXACT_HIT, EXACT_REMAIN.
- Preflight: 2–6 Spieler, Brett-Konfiguration gültig.

## 5. Content-/Editor-Schema

- **Kein Content-Pool** — prozedurales Brett (wie Wer-ist-das-Setup).
  Brett-Layout + Regeln = Setup (Room Config), nicht Content.
- Optional: Feld-Icons/Effekte als Presets (Vorschlag: V1 ohne
  Sonderfelder, nur Start/Feld/Heim — DEC-BRD-01).
- Editor Quick: Brettgröße, Figuren, Würfel, Regeln (Hit/Home).

## 6. Phasen/Commands

```
INTRO (Startreihenfolge) → (je Zug) ROLL (serverseitig) → MOVE (Animation, serverseitig gültig) → (HIT? → Gegner zurück) → (HOME? → SIEG) → NEXT_TURN → … → GAME_END (WINNER) → FINALIZED
```

| Command | Rolle | Phase |
|---|---|---|
| `dice.roll` | aktiver Spieler | ROLL |
| `figure.move` (figureId, auto) | SYSTEM (serverseitig nach Roll) | MOVE |
| `turn.skip` (optional, wenn 0) | SYSTEM | — |
| `game.end` (auto bei Sieg) | SYSTEM | — |
| `pause`/`resume` / `emergency.*` | HOST | — |

- **Zufälligkeit:** Würfel serverseitig (Random-Core), Persistenz des
  Ergebnisses, Rejoin zeigt **gleichen** Würfelstand, keine Neuziehung.
- **Ablaufbeispiel:** Player A würfelt 4 → Figur von Feld 0→4. Player B
  würfelt 3 → Feld 5→8, Feld 8 hat Player C → C zurück auf 0. A würfelt
  …→ A erreicht Heimfeld → A gewinnt.

## 7. Wertung & Endgründe (Vorschläge, DEC-BRD-01)

- **Keine Punkte** — Platzierung durch Zug-Zählung / Sieg-Reihenfolge.
- 1 Figur: erster Sieg = 1. Platz; restliche Spieler nach
  „Abstand zum Heim" (Vorschlag: 2. = nächster am Heim).
- **Ties:** möglich bei gleichem Abstand → geteilt (oder: wer zuerst
  dran war — Vorschlag: geteilt).
- Endgründe: `COMPLETED` (Sieg), `HOST_ABORTED`, `TECHNICAL_ABORT`,
  `INSUFFICIENT_PLAYERS`.
- **Kein** Unentschieden-Ende (Brett-Spiel endet mit Siegern oder Abbruch).

## 8. Projektionen & Secrets

- PLAYER: eigenes Brett (alle Figuren PUBLIC), eigener Zug, Würfel-
  Ergebnis, Timer; keine Extra-Info.
- HOST: + Steuerung (Pause, Notfall), sonst identisch.
- VIEWER: komplettes Brett + Würfel (PUBLIC).
- DISPLAY: großes Brett-Layout (PR20).
- Preloading: Brett-Layout (PUBLIC), keine Secrets.

## 9. Rejoin/Pause/Host-Ausfall/Recovery

- Rejoin: kompletter Brettzustand (alle Figuren), aktuelle
  Startreihenfolge, letzter Würfel; **kein** Neuwürfel, keine
  Positions-Änderung durch Rejoin.
- Pause: Timer stoppt, Input gesperrt.
- Host-Ausfall: Spiel läuft serverseitig weiter (kein zwingendes
  Host-Interventions-Pflicht, außer Notfall); Transfer optional.
- Recovery: Brett-/Figuren-State atomar persistiert (CAS); Würfel-
  Resultat persistiert; keine Doppel-Rolls (commandId); Rejoin =
  Resync, keine „Neu-Würfel".

## 10. Results/Stats/Events/Versionierung

- RoundResult = pro Zug (Spieler, Würfel, Bewegung, Hit?, Home?, Dauer).
- GameResult: Sieger, Platzierungen, Zug-Zahl, Endgrund.
- Stats: games, wins, avg turns, hits made/against, longest streak
  (§9.12).
- Engine-Version: `1` (neu).

## 11. Tests & DoD

- 10 Pflichttests + spezifisch: **Würfel-Integrität** (serverseitig,
  Rejoin = gleicher Stand, keine Neu-Ziehung), Hit-Logik (EXACT_HIT),
  Heimfeld-Regel (EXACT_REMAIN), Turn-Order (Disconnect), Recovery
  nach Disconnect (Brett konsistent), Doppel-Roll-Schutz (commandId).
- Cores: Random/Seed (Würfel), Turn, State/CAS (Brett), Score
  (Platzierung), Round-Transition, Result-Screen, Notification,
  Recovery.

## 12. Offene Punkte

| ID | Frage | Vorschlag (default) |
|---|---|---|
| DEC-BRD-01 | Brettgröße, Figuren/Pro-Spieler, Hit-Regel, Heimfeld-Regel, Teammodus, Sonderfelder | 24 Felder, 1 Figur, EXACT_HIT, EXACT_REMAIN, individuell, keine Sonderfelder in V1 |

---

## 13. Engine-Vertrag, Late Join & Rollen-Policy (12-08)

- **Gemeinsamer Vertrag:** `board-race` referenziert `../technical-mapping.md §3.4`
  (Zustandsmaschine, Command-Guards 1–4, Projektionen/`availableActions`,
  Persistenz/Version/Recovery, Medien-/Voice-/Camera-/Mic-/Display-Defaults)
  und weicht **nur** in den folgenden Punkten ab. `INSUFFICIENT_PLAYERS`
  gilt nur an Start-/Transition-Gates, nie gegen das absichtlich sinkende
  aktive Teilnehmerfeld im Spielverlauf (§12-10).
- **Late-Join-Policy (engine-spezifisch):** Nein während der laufenden Zug-Sequenz → `PENDING_JOIN`, ab dem **nächsten Zug-BLOCK** (alle Figuren haben gewürfelt) aktiv, Startfeld-Zuweisung (Vorschlag DEC-BRD-01).
- **Ausscheidende Teilnehmer:** keine (Rennspiel, keine Ausscheidung).
- **Teamrollen/Rotation:** individuell (Teammodus Option, Vorschlag DEC-BRD-01).
- **Voice/Camera/Mic (Abweichung von den Defaults):** Mikrofon MUTED (Default). ·
  Camera: OFF (Default).
- **Medien in Phasen:** Brett-Render PUBLIC (Display-freundlich).
- **RESULT_REVIEW:** geerbt (§3.4).
