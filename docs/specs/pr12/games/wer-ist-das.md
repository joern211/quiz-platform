# Wer ist das? (`wer-ist-das`) — Spezifikation

**Status main:** BETA (MVP `games/weristdas/`, 2184 Zeilen, E2E W-Tests).
**PR11 (offener Draft, Head 1470894):** Composite-Fusion, Setup v2,
Medien-Geheimhaltung, Originals/Names als Secrets, Host-Mitspiel-Gate,
`gameImageUrl`-Resync, `/api/v1/media/composite`, sichere Uploads.
**Ziel-PR:** PR11 (Abschluss) + PR37 (V1-Verträge).

## 1. Kurzbeschreibung & Regelquellen

Rätselspiel mit zwei gesuchten Personen: Die Plattform erzeugt ein
**Fusionsbild** (Composite) aus zwei Originalbildern; Spieler buzzen und
benennen verbal. Vor dem Reveal sehen Player/Viewer nur das Fusionsbild;
Originals und Namen bleiben geheim.

- FEST: Master §15.3 (vollständiger Wortlaut in requirements-matrix
  MR-15-03-01).
- FEST: zwei Originale + Website-simple Fusion; später serverseitiger
  Morph **austauschbar** (echter Bild-Morph = ausdrücklich später).
- BESTEHEND (MVP): Buzzer, Hint „Eine Person reicht", +3/+1/−1,
  falscher Buzzer für Runde gesperrt, Rejoin/Resync, Secret-Tests.
- PR11 (offen): Setup v2 (A/B-Optionen + Spielbild), `gameImageUrl`,
  `setupVersion/engineVersion=2`, Medien-Geheimhaltung, Upload-Sicherheit.

## 2. Feste Regeln (Master §15.3)

- Zwei Originalbilder `personA`/`personB` + Namen; `gameImage` = Fusion.
- Gameplay: erster gültiger Buzz → verbale Antwort → Host-Judge.
- Scoring (pro Runde): **+3** beide korrekt; **+1** eine Person (nach Hint);
  **−1** falsch; falscher Buzzer → für diese Runde ausgeschlossen.
- Hint: „Eine Person reicht" (bestehend).
- Shared Buzzer-Core (kein eigener).
- Reveal: darf Originals/Namen zeigen; danach PUBLIC.
- Datenmodell Ziel: `personA`, `personB` (jeweils name + originalAssetId),
  `gameImageAssetId` (Composite, `derivedFromAssetIds=[A,B]`).

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 2 / 10 | FEST (Manifest) |
| Teams | optional (Team-Buzzer via Core) | O |
| Host-Mitspiel | **nur wenn Setup vollständig** (personA+B + Spielbild hochgeladen) — PR11-Gate; Host sieht als Player vor Reveal nichts Mehr als andere (Originals/Names sind `HOST_PRIVATE`, aber das Gameplay-Geheimnis gilt für alle bis Reveal; der Informationsvorteil durch Upload-Rechte wird durch die feste Reveal-Regel neutralisiert) | FEST (PR11) |
| Secrets | Originals + Namen: `HOST_PRIVATE` vor Reveal (Player/Viewer/Display nie); eigene Buzz-Antwort `PLAYER_PRIVATE` | FEST §5.15, PR11 |

## 4. Setup (Ziel = PR11 Setup v2)

```
WerIstDasSetup v2 {
  personA: { name: string (min 2), originalAssetId: string }
  personB: { name: string, originalAssetId: string }
  gameImageAssetId: string     // Composite aus /api/v1/media/composite
  gameImageUrl?: string         // Signed-URL, Resync-feld (PR11)
  perRound: {timerMs (default 30000), hintEnabled: true, points: {both:3, oneAfterHint:1, wrong:-1}}
  rounds: number (default = 10, max)
  hostCanPlay: boolean (default: auto — nur wenn Setup vollständig)
  repeatRule / hostContentVisibility: BLIND_HOST-irrelevant (Host ist Erzeuger)
}
setupVersion = 2 (v1-MVP bleibt lauffähig — PR11)
```

- **Preflight:** beide Personen vollständig (Name + Bild), Spielbild
  vorhanden (sonst `MISSING_GAME_IMAGE`), Spieler ≥2.
- **Medien-Pipeline (PR11, offen):** Uploads (JPG/PNG/WebP, ≤5MB, 512×512
  Min, EXIF-Strip, Dedupe, ROOM_TEMP), Composite-Endpoint (idempotent,
  1024×1024, crossfade-v1), Signed URLs (shortlived, no-store),
  `visibility=SHARED` für gameImage, Originals `HOST_PRIVATE`.
- **Recovery:** `gameImageUrl` wird im Resync neu ausgeteilt (PR11),
  Originals nie.

## 5. Content-/Editor-Schema

- Keine Content-Pool-Items — Setup-basiert (Prozedural-Pool-Modell,
  wie heute; Personen bleiben Session-Daten, nicht ContentLibrary).
- **VORSCHLAG DEC-WID-01:** optionale SYSTEM-„Beispielpersonen" als
  Quick-Setup-Vorlage (nur Demo, keine Rechte-Daten).
- Quick Setup: 2× (Name + Bild-Upload) → Spielbild-Generierung → Start.
- Advanced: Rundenanzahl, Timer, Hint-Option, Punkte-Preset.

## 6. Phasen/Commands

```
SETUP (Setup v2) → INTRO → (je Runde) BUZZ_OPEN → BUZZ_LOCKED → JUDGING → ROUND_END → … → GAME_END → RESULT_REVIEW → FINALIZED
```

| Command | Rolle | Phase |
|---|---|---|
| `buzz` | PLAYER/Host-as-Player | BUZZ_OPEN |
| `answer.submit` (verbale Antwort, optional) | Winner-Player | JUDGING |
| `judge.decide` (BEIDE\|EINE_NACH_HINT\|EINE_OHNE_HINT\|WRONG) | HOST (JUDGE_ANSWER) | JUDGING |
| `hint.grant` | HOST | JUDGING |
| `round.next` / `timer.*` / `pause`/`resume` / `emergency.*` | HOST | — |

- **Ablaufbeispiel:** Runde 3, Player B buzzt → „Da ist Angela Merkel
  drin!" → Host: nur eine korrekt → +1 B. Player C buzzt daneben
  („Das ist ein Roboter") → −1 C, für Runde 4 gesperrt.

## 7. Wertung & Endgründe

- Ledger-Events: `ROUND_BONUS (+3)`, `ROUND_BONUS (+1)`, `ANSWER_WRONG (−1)`.
- Ties: integer-Punkte, geteilte Plätze (ALLOW_TIE Default).
- Endgründe: `COMPLETED` (Runden), `HOST_ABORTED`, `TECHNICAL_ABORT`,
  `INSUFFICIENT_PLAYERS` (unter 2 → Pause).

## 8. Projektionen & Secrets

- PLAYER: `gameImage` (Fusion), eigene Buzz-Geschichte, Punkte; **nie**
  Originals/Namen vor Reveal.
- HOST: + Originals/Namen (ab Setup, `HOST_PRIVATE`), Judge-Tools.
- VIEWER: nur Fusion + Punkte („Wer ist das?"-Effekt bleibt).
- DISPLAY: große Fusion-Ansicht, Punkte, „wer ist es?"-Overlay nach Reveal.
- Preloading: `gameImageUrl` darf vorab geladen werden (PUBLIC ab INTRO —
  es ist das sichtbare Spielbild); Originals nie (PR11-Signed-URL-Scoping).

## 9. Rejoin/Pause/Host-Ausfall/Recovery

- Rejoin: Fusion (via `gameImageUrl`), Punkte, Rundenzustand, eigene
  Sperren (bestehend).
- Pause: Buzzer gesperrt (Game-Core).
- Host-Ausfall: Runde läuft nicht ohne Judge → Pause; Host-Transfer nach
  Frist (neuer Host sieht Originals — **Audit-Event**).
- Recovery: State-CAS (bestehend); Composite-Asset bleibt (ROOM_TEMP,
  7d); nach Asset-Verlust → `ERROR_RECOVERY` (VORSCHLAG: Spiel nicht
  fortsetzbar, da Bild essenziell).

## 10. Results/Stats/Events/Versionierung

- RoundResult: Winner, Judge-Entscheidung, Punkte, Dauer, Hinweis-Nutzung.
- GameResult: Platzierungen, Endpunkte.
- Stats: games, wins, first-buzz-rate, correct-after-hint (§9.12).
- Versionierung: `engineVersion=2`/`setupVersion=2` (PR11); Recovery
  pinnt Version; v1-Räume bleiben lauffähig (Katalog BETA→AVAILABLE
  nach PR11-Abschluss + PR37-Verträgen).

## 11. Tests & DoD

- Bestehend: E2E W1–W8 (Buzzer, Hint, Scoring, Rejoin, Resync, Secrets).
- PR11-Tests (im Draft): Composite-Endpoint, Signed-URL-Scoping,
  Upload-Validierung, Setup v2, Host-Gate.
- Neu (PR11-Abschluss/PR37): 10 Pflichttests, Secret-Leak-Suite
  (Originals/Namen in keinem Player/Viewer/Display-Payload, kein
  `storagePath`), Duplicate-Command, Rejoin-nach-Image-Refresh,
  Recovery bei Asset-Verlust.

## 12. Offene Punkte

| ID | Frage | Vorschlag |
|---|---|---|
| DEC-WID-01 | SYSTEM-Beispielpersonen für Quick Setup? | nein für V1 (Rechte-Risiko); nur eigene Uploads |
| DEC-WID-02 | Echter Bild-Morph (Interpolation)? | **ausdrücklich später** (Master) — Composite crossfade bleibt V1 |
| DEC-WID-03 | Wer sieht Originals nach Reveal? | alle (PUBLIC), Master: „Reveal darf es zeigen" |
