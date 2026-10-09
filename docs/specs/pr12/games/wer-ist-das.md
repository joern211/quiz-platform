# Wer ist das? (`wer-ist-das`) — Spezifikation

**Status main:** BETA (MVP `games/weristdas/`, 2184 Zeilen, E2E W-Tests).
**PR11 (offener Draft):** Composite-Fusion, Setup v2, Medien-Geheimhaltung,
Originals/Names als Secrets, `HOST_CANNOT_PLAY_OWN_ROUND`-Gate,
`gameImageUrl`-Resync, `/api/v1/media/composite`, sichere Uploads.
**Ziel-PR:** PR11 (Abschluss) + PR37 (V1-Verträge).

> **12-04 Abgleichsnachweis:** Die Ist-Aussagen (BESTEHEND/FEST) wurden
> gegen den gepinnten PR11-Stand (Snapshot `1470894` als PR11-Vergleich,
> **getrennt von main**) abgeglichen. Nach dem PR11-Merge ist ein erneuter
> main-Abgleich erforderlich (12-11).

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
| Host-Mitspiel | **`HOST_CANNOT_PLAY_OWN_ROUND` (BESTEHEND, gepinnter PR11):** Das Host-Konto, das die Originale + Namen eingegeben hat, kann in der eigenen wer-ist-das-Runde **serverseitig nicht** blind mitspielen (Join mit 403 abgewehrt). **Nicht** durch Reveal neutralisiert — der Wissensvorteil durch die Upload-/Namen-Eingabe bleibt bestehen. Anonyme (ohne Login) Mitspieler sind nicht betroffen — das ist der vorgesehene faire Modus. | FEST (PR11, gepinnt) |
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
- **Medien-Pipeline (PR11, offen — Ist-Limits verifiziert):** Uploads
  (JPG/PNG/WebP, **konfigurierbarer Standard 10 MB** (`MAX_IMAGE_SIZE_MB`),
  **maximale Dimension 4096 px** (`MAX_IMAGE_DIMENSION`), **keine
  Mindestdimension**, EXIF-Strip, Dedupe, ROOM_TEMP), Composite-Endpoint
  (idempotent, 1024×1024, crossfade-v1), Signed URLs (shortlived,
  no-store), `visibility=ROOM_TEMP` für gameImage, Originals
  `HOST_PRIVATE`/eigentümergesichert.
- **Recovery:** `gameImageUrl` wird im Resync neu ausgeteilt (PR11),
  Originals nie.

## 5. Content-/Editor-Schema

- **IST (MVP/PR11):** Setup-basiert (Runden als Setup-Snapshot,
  Personen bleiben Session-Daten) — **prozedural**, keine ContentLibrary.
- **ZIEL (Master §6.1):** `WerIstDasPack/Round` ist im Master-
  Contentmodell ein expliziter Content-Pool-Typ. Das prozedurale Setup
  darf dieses Ziel **nicht still streichen** — V1-Ziel bleibt das
  Pack/Round-Modell, das Setup ist die V1-/BETA-Eingabeform (Target/
  Gap, nicht Vertragsänderung; Umsetzung in PR37-Katalog).
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

- **Ablaufbeispiel (Ist-Stand, gepinnter PR11):** Runde 3, Player B
  buzzt → „Da ist Angela Merkel drin!" → Host erteilt den Hint
  („Eine Person reicht") → Host-Judge: nur eine korrekt → **+1 B**
  (ohne gültig erteilten Hint ist `ONE_CORRECT` serverseitig
  abgelehnt — `HINT_REQUIRED`). Player C buzzt danach daneben
  („Das ist ein Roboter") → **−1 C**, und C ist für **dieselbe
  Runde 3** vom Buzzer ausgeschlossen (`excludedPlayerIds`; bei
  erneutem Öffnen des Buzzers in Runde 3 → `PLAYER_EXCLUDED`).

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

---

## 13. Engine-Vertrag, Late Join & Rollen-Policy (12-08)

- **Gemeinsamer Vertrag:** `wer-ist-das` referenziert `../technical-mapping.md §3.4`
  (Zustandsmaschine, Command-Guards 1–4, Projektionen/`availableActions`,
  Persistenz/Version/Recovery, Medien-/Voice-/Camera-/Mic-/Display-Defaults)
  und weicht **nur** in den folgenden Punkten ab. `INSUFFICIENT_PLAYERS`
  gilt nur an Start-/Transition-Gates, nie gegen das absichtlich sinkende
  aktive Teilnehmerfeld im Spielverlauf (§12-10).
- **Late-Join-Policy (engine-spezifisch):** Nein während `BUZZ_OPEN`/`JUDGING` der laufenden Runde → `PENDING_JOIN`, ab der **nächsten** Runde aktiv; Fusion + Punkte via Resync.
- **Ausscheidende Teilnehmer:** keine (Rundenbuzzer, keine Dauer-Ausscheidung).
- **Teamrollen/Rotation:** keine (Team-Buzzer via Core, optional).
- **Voice/Camera/Mic (Abweichung von den Defaults):** Mikrofon MUTED (Default); Reveal-Äußerungen verbal (Host-Judge). ·
  Camera: OFF (Default).
- **Medien in Phasen:** Fusion via signed `gameImageUrl` (PR11); Originals nie in Projektionen vor Reveal.
- **RESULT_REVIEW:** ausgewiesen (§6).
