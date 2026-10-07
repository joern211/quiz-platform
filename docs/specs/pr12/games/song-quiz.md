# Erkenne den Song (`song-quiz`) — Spezifikation

**Status main:** PLANNED, keine Engine. **Ziel-PR:** PR21 (nach PR19/20 —
Media/Voice-Basis). **Slug FEST** (§14/§15.5).

## 1. Kurzbeschreibung & Regelquellen

Synchronisierte Audio-Runden: ein Song-Ausschnitt läuft, der erste
gültige Buzz benennt Titel + Artist verbal, Host bewertet.

- FEST §15.5: synchronisiertes Audio, erster Buzz, verbale Antwort
  Titel+Artist, Host Judge, falsche Antwort → ggf. Reopen; Scorelogik
  game-spezifisch zu definieren; zentraler Buzzer/Judge/ScoreEvent zwingend.
- OFFEN: konkrete Punktwerte, Reopen-Regel, Ladefehler → DEC-SNG-01.

## 2. Feste Regeln

- Synchronisierte Wiedergabe (serverseitiger Zeitplan, `PLAY_START` mit
  `endsAt`/Duration, alle Clients synchron über Snapshot — keine
  lokalen Timers als Quelle der Wahrheit).
- Buzzer (SERVER_ARRIVAL) nach Start; erster Buzz → verbale Antwort.
- Host-Judge: KORREKT / TEILWEIS (nur Titel oder nur Artist) / FALSCH.
- Falsche Antwort → Reopen möglich (VORSCHLAG: `reopenAllowed=true`,
  nur einmal pro Runde, alle außer Fehlbuzzer dürfen buzzen).
- Audio-Medien: kurze Ausschnitte (Vorschlag: 8–15s, `AUDIO_CLIP`-Typ),
  Preloading erlaubt (leak-safe: nur Audio, keine Metadaten!).

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 2 / 12 | V (DEC-SNG-01) |
| Teams | optional (Team-Buzzer) | V |
| Host-Mitspiel | erlaubt; Host sieht Song-Metadaten **nicht** vor Reveal (Media-Item: Titel/Artist `HOST_PRIVATE` erst im Reveal; Host kann den Song selbst hören, wie alle — fair) | V |
| Secrets | Titel/Artist/Quelle: `HOST_PRIVATE` bis REVEAL; Audio-Asset: `PUBLIC` ab `PLAY_START` (Preloading erlaubt) | V/F |

## 4. Setup (Ziel)

```
SongQuizSetup {
  pools: ContentPoolRef[]           // Song-Items (Audio + Metadaten)
  questionCount: number (default 8)
  perQuestion: {clipSeconds (default 12, range 5–30), inputTimerMs (default 15000),
                points: {full: 3, partial: 1, wrong: 0}   // VORSCHLAG DEC-SNG-01}
  reopenAfterWrong: boolean (default true, once)
  shuffle: true (Random-Core, seedRef)
  hostCanPlay: boolean (default true)
  preloading: 'PRE_JOIN'|'PRE_ROUND'|'OFF' (default PRE_JOIN — leak-safe Audio-only)
}
```

- Quick: SYSTEM-Pool „Song-Quiz Basics", 8 Runden, 12s Clip.
- Preflight: Audio-Assets `READY` (processStatus, PR19), Dauer bekannt.

## 5. Content-/Editor-Schema

- Item = `SongQuestion`: audioAssetId (Clip), title, artist, year?,
  category (Tag: Pop/Rock/…), difficulty, language, rights (Quelle/Lizenz
  — **Pflicht** bei PUBLIC-Pools, §6.42/§7.12), durationMs.
- READY: Audio READY + Titel + Artist + Rechte-Info (PUBLIC) / Source
  (PRIVATE).
- **Rechte-Hinweis:** Song-Clips unterliegen Urheberrecht — VORSCHLAG:
  PUBLIC-Pools nur mit lizenzierter/CC-Musik; PRIVATE-Pools mit
  Source-Anzeige; Review-Workflow (PR18) bei PUBLIC-Uploads.
- Editor Quick: Clip-Upload, Titel, Artist, Jahr, Tag.

## 6. Phasen/Commands

```
INTRO → (je Runde) AUDIO_LOADING → AUDIO_PLAYING → BUZZ_OPEN → BUZZ_LOCKED → JUDGING → (REOPEN?) → REVEAL (Titel+Artist+Quelle) → ROUND_END → … → GAME_END → FINALIZED
```

| Command | Rolle | Phase |
|---|---|---|
| `buzz` | PLAYER | BUZZ_OPEN |
| `answer.submit` (Titel + Artist, verbal → optional eingegeben) | Winner | JUDGING |
| `judge.decide` (CORRECT\|PARTIAL\|WRONG) | HOST (JUDGE_ANSWER) | JUDGING |
| `round.reopen` | HOST | JUDGING (nach WRONG) |
| `audio.play / audio.stop / audio.retry` | SYSTEM/HOST (Fehlerfall) | AUDIO_PLAYING |
| `round.next` / `pause`/`resume` / `emergency.*` | HOST | — |

- **Synchronisation:** `AUDIO_PLAYING` Snapshot enthält `playStartedAt`
  (serverzeit) + `durationMs`; Client rechnet Rest; bei Rejoin wird
  aktuelle Position serverseitig mitgeteilt.
- **Ablaufbeispiel:** Clip läuft 12s, Player A buzzt nach 4s → „Bohemian
  Rhapsody, Queen" → KORREKT → +3. Player B buzzt daneben → WRONG →
  Reopen → Player C → +3 (oder +1 Teil).

## 7. Wertung & Endgründe

- **VORSCHLAG DEC-SNG-01:** `full=+3` (Titel+Artist), `partial=+1`
  (einer korrekt), `wrong=0` (kein Minus — VORSCHLAG, Alternative −1);
  Speed-Bonus optional (Preset).
- Reopen: einmal, Punkte-Values bleiben identisch.
- Ladefehler (Audio nicht verfügbar): VORSCHLAG `FALLBACK_ROUND`
  (nächster Song) nach 2 automatischen Retries; Host kann `SKIP_ROUND`.
- Ledger-Events: `ANSWER_CORRECT (+3)`, `PARTIAL (+1)`, `ANSWER_WRONG`.
- Endgründe: `COMPLETED`, `HOST_ABORTED`, `TECHNICAL_ABORT`,
  `INSUFFICIENT_PLAYERS`, `NO_VALID_MEDIA` (alle Clips defekt).

## 8. Projektionen & Secrets

- PLAYER: eigene Punkte, Buzzer-Status, Audio (ab PLAY_START);
  **keine** Titel/Artist-Metadaten im Payload (Leak!).
- HOST: + Metadaten ab REVEAL, Judge-Tools, Audio-Fehler-Steuerung.
- VIEWER/DISPLAY: Audio, Punkte; Metadaten nur nach Reveal.
- Preloading: Audio-only, nie Metadaten (Leak-Prüfung PR41).

## 9. Rejoin/Pause/Host-Ausfall/Recovery

- Rejoin: Audio-Position (serverseitig), Punkte, Phase; Buzzer-Reihenfolge
  nicht verändert.
- Pause: Audio stoppt, Phase `PAUSED`; Resume setzt Audio ab
  Pause-Position fort (serverseitig persistiert `playPositionMs`).
- Host-Ausfall: Runde pausiert (Judge nötig); Auto-Reveal **nicht**
  vorgesehen (verbale Antwort braucht Judge) → Host-Transfer.
- Recovery: Audio-Position + State persistiert; keine Doppel-Buzz (commandId).

## 10. Results/Stats/Events/Versionierung

- RoundResult: Song-Ref, Buzz-Abgabe, Judge-Entscheidung, Punkte,
  Audio-Dauer, Reopen-Flag.
- GameResult: Platzierungen, Endpunkte.
- Stats: games, wins, avg buzz time, correct/total (§9.12),
  Content-Usage (welche Songs).
- Engine-Version: `1` (neu).

## 11. Tests & DoD

- 10 Pflichttests + spezifisch: Metadaten-Leak (kein Titel/Artist in
  Player/Viewer-Payload vor Reveal), Synchronisations-Test (Rejoin bei
  laufendem Audio), Ladefehler-Test (FALLBACK_ROUND), Reopen-Test,
  Preloading-Leak-Test (Audio-only).
- Cores: Audio-Sync (PR19), Buzzer, Judge, Timer, Submission, Reveal/
  Visibility, Score, Round-Transition, Leaderboard, Result-Screen,
  Notification, Recovery.

## 12. Offene Punkte

| ID | Frage | Vorschlag (default) |
|---|---|---|
| DEC-SNG-01 | Punktwerte (full/partial/wrong), Reopen-Count, Ladefehler-Fallback, min/max, Speed-Bonus | 3/1/0, 1 Reopen, FALLBACK nach 2 Retries, 2–12, Speed-Bonus optional Preset |
