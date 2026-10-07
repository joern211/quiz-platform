# PR12 — Technisches Mapping (Zielmodell)

**Wichtig:** Dieses Dokument beschreibt das **Zielmodell/Vorschlag** für
V1.0. Es ändert keine Runtime-Datei. Bestandteile, die in `main @ 411a5b7`
bestehen, werden als „bestehend" markiert; Neues ist **Ziel** und wird erst
in den genannten PRs umgesetzt. PR11-Teile sind als „PR11 (offen)" gekennzeichnet.

**Grundprinzip (unverändert aus Master):** keine neue DB (Prisma/SQLite bleibt,
PostgreSQL-ready), kein neues Framework, kein neuer Anbieter. Speicher- und
DB-Abstraktion nach §7.2/§11.12 bleibt. WebRTC (Voice/Camera) ist die einzige
neue Technologie-Ebene — TURN/STUN und HTTPS-Vorbereitung gehören zu PR19/PR44.

---

## 1. Globales Datenmodell — Entitäten (Ziel)

### 1.1 Bestehend (main, behalten und erweitern)

| Entität | Erweiterung (Ziel) |
|---|---|
| `User` | Rolle → `ADMIN` / `HOST` (Begriffsmigration G1: `MODERATOR` wird `HOST`, `ADMIN` bleibt; DB-Werte migrieren versioniert). `isPersonalAdmin` implizit = genau ein Admin (PR43 erzwingt Einzigkeit). |
| `Session` | beibehalten; Rotation-/Revocation-Feldergänzung (PR44). |
| `GameDefinition` | wird dünner: kanonische Manifest-Felder (Status, Limits) bleiben als DB-Kopie mit Sync-Guard; `engineVersion` Pflicht; `capabilities` (JSON-Array) ergänzt. |
| `Room` | Status-Enum auf §4.3-Zustände (`DRAFT_ROOM\|SCHEDULED\|LOBBY_OPEN\|LOBBY_LOCKED\|GAME_ACTIVE\|PAUSED\|IDLE\|EXPIRED\|CLOSED`), `runPhase` bleibt Engine-Interna; neue Felder: `accessMode` (PUBLIC_JOIN\|PIN_PROTECTED\|APPROVAL_REQUIRED\|INVITE_ONLY), `allowLateJoin`, `lateJoinState`, `waitlistPolicy`, `coHostEnabled`, `scheduledStartAt` + `scheduledTimezone`, `lockState`, `configSnapshotRef` (GameConfigSnapshot, §5.24), `closeReason`. |
| `Participation` | Rolle → `HOST\|PLAYER\|VIEWER`; neue: `status` (JOINED\|PENDING_JOIN\|DISCONNECTED\|REJOINING\|LEFT\|KICKED\|BANNED), `banState` (null\|{reason, until?, byHostId, at}), `teamId` → Relation zu `Team`, `identityHistory` (Name-Historie, intern), `deviceSwitchLog` (Audit-Ref), `rejoinToken` bleibt (Rotation bei Gerätewechsel, §4.10/4.11). |
| `ViewerSession` | beibehalten; Limit-Logik bleibt. |
| `RoomGameState` | beibehalten; `stateVersion` = `revision` (Begriff), `recoveryState` (null\|ERROR_RECOVERY-Meta), `seedRef` (Random-/Seed-Metadaten, §5.16 — **niemals** der Seed selbst, wenn BLIND_HOST). |
| `ScoreEvent` | wird zum Ledger: `targetType` (PARTICIPATION\|TEAM), `targetId`, `eventKind` (ANSWER_CORRECT\|ANSWER_WRONG\|ROUND_BONUS\|HOST_ADJUSTMENT\|ROLLBACK\|…), `commandId` (Idempotenz), `reversesEventId` (Korrektur-/Rollback-Bezug), `roundRef`. |
| `ChatMessage` | wird zum `RoomFeed`-Modell (Ereignistypen + Nachrichten, §4.17). |
| `AuditLog` | wird zum kritischen Audit Trail: `criticality`, `hashChain` (prädikativer Hash, §10.12), `traceId`. |
| `MediaAsset` | PR11-Felder übernehmen (derivedFromAssetIds, processStatus, Visibility SHARED/SYSTEM/ROOM_TEMP); neu: `storageKey` (storage-neutral, nie storagePath an Clients), `rights` (JSON: source, author, license, consent), `blockState` (Admin-Block, §7.12), `adoptedFromRoomTempAt`. |
| `EventSeries` | vollständiges Event-Modell (Abschnitt 5.8). |
| `SetupDraft` | bleibt; wird von Content-/Pools- und Preset-System ergänzt. |

### 1.2 Neu (Ziel)

| Entität | Zweck | Abschnitt |
|---|---|---|
| `Team` | `id, roomId, name, color, iconEmoji, eventTeamId?`, `revision`; `Participation.teamId` Relation. Historie über `TeamHistory` (Snapshot pro Runde/Änderung). | §3 |
| `TeamHistory` | `teamId, roomId, roundIndex?, changedAt, snapshotJson` — Teamänderungen bleiben nachvollziehbar. | §3.4 |
| `PermissionGrant` | `roomId, participantId, permission` (GAME_START …), `grantedBy, grantedAt, revokedAt?` — granulare Rechte §2.3. | §2.3 |
| `RoomConfigSnapshot` | GameConfigSnapshot §5.24: `roomId, gameSlug, engineVersion, configJson (effective values), seedRef, contentSnapshotRef, createdAt` — immutable. | §5.24 |
| `RoundResult` | `roomId, roundIndex, gameSlug, engineVersion, stateVersionAtEnd, participantsJson, scoreDeltasRef, winnersJson, placementJson, durationMs, endReason (RoundEndReason), contentIdsJson, statsJson, createdByRoundTransition` — §5.9. | §5.9/5.31 |
| `GameResult` | `roomId, gameSlug, engineVersion, participantsJson, finalScoresJson, winnersJson, placementJson, durationMs, endReason (GameEndReason), finalizationState (GAME_END\|RESULT_REVIEW\|FINALIZED), finalizedAt, amendmentsRef` — §5.9/5.31. | §5.31 |
| `ResultAmendment` | `gameResultId, reason, correctedBy, beforeJson, afterJson, createdAt, traceId` — Änderungen nach FINALIZED §5.31. | §5.31 |
| `CommandReceipt` (kurze Retention) | `roomId, commandId, commandKind, processedAt, resultRef` — Replay/Dedup §5.17/§10.6. | §10.6 |
| `IntegrityIncident` | §10.2 (Severity, Session/Identity, Command, Grund, Reaktion, Timestamp). | §10 |
| `ContentPool` | `id, gameSlug, name, scope (PRIVATE\|SHARED\|PUBLIC\|SYSTEM), ownerId?, visibilityDefaultsJson, inheritanceJson, status, revision, qualityState, lockState` — §6.1/6.2/6.43/6.44. | §6 |
| `ContentItem` | generische Basis + game-spezifische `payloadJson` (Engine-Schema validiert): `id, poolId, gameSlug, status (DRAFT\|READY\|DISABLED\|ARCHIVED\|TRASHED), scope, ownerId, revision, tagsJson, difficulty?, language, source?, license?, usageCount, lastUsedAt, duplicatedFromId?, forkedFromPackId?, reviewState, qualityState, publishAt?, unpublishAt?` — §6. | §6 |
| `Tag` / `TagAlias` | §6.7. | §6 |
| `ContentRevision` | `contentId, revision, actorId, changedFieldsJson, diffJson, createdAt` — §6.19. | §6 |
| `CorrectionProposal` | §6.5 (Inbox). | §6 |
| `ReviewComment` / `ReviewAssignment` | §6.30/6.38. | §6 |
| `ContentNotification` | §6.31 (Website-Inbox). | §6 |
| `GamePreset` / `RoomTemplate` / `EventPreset` | §6.52/6.53/8.13. | §6/§8 |
| `PlayerProfile` | `userId?, claimedFromParticipationIds?, displayName, avatar, privacySettingsJson (Revision), statsJson-Ref, xp, achievementsRef, optOutsJson, createdAt` — §9. | §9 |
| `PlayerStatistics` | `playerProfileId, gameSlug?, gamesPlayed, wins, avgPlacement, hitRate, avgAnswerTimeMs, buzzerStatsJson, sampleSize per Kennzahl, updatedAt` — §9.2/9.13. | §9 |
| `PlayerHistoryEntry` | §9.8 (Datum, Game/Event, Placement, Score, Team, Result, Achievements, Recap-Ref). | §9 |
| `PlayerBest` / `PlayerStreak` | §9.9/9.10 (nur finalisierte Results). | §9 |
| `Achievement` (Definition) / `PlayerAchievement` | §9.5 (+ Popups-Einstellung). | §9 |
| `EventParticipant` | `eventSeriesId, participantId?, playerProfileId?, eventParticipantId (stabil), state (PARTICIPATING\|BENCHED\|OPTED_OUT\|UNAVAILABLE\|LEFT), pointsTotal, rosterLockState` — §8.6. | §8 |
| `EventGame` | `eventSeriesId, order, gameSlug, gamePresetId?, state (SCHEDULED\|SETUP\|ACTIVE\|FINALIZED\|ABORTED_*\|SKIPPED), pointsRulesJson, requiredOrBonus` — §8.1/8.11/8.18. | §8 |
| `EventPointRecord` | `eventParticipantId, eventGameId, placement, points, pointsRuleRef, awardedAt, amendmentRef?` — §8.3/8.9 (getrennt von Spielpunkten!). | §8 |
| `ContentUsageStat` | §6.39 (empirical Difficulty mit sampleSize-Regeln). | §6 |
| `BackgroundJob` / `JobDeadLetter` | §11.15. | §11 |
| `MediaAuditEvent` | §7.12. | §7 |
| `ModerationReport` | §11.6. | §11 |
| `PlatformFeatureFlag` | §11.7 (Targets, Percentage, Audit). | §11 |

**Globaler Datenfluss (wichtigster Zusammenhang, Master §5.31/§8.3/§9):**

```
Commands (client)
   → Command-Core (commandId, Phase, Rechte, CAS)
   → fachliche Events (unveränderlich, RoomGameState + ScoreEvent-Ledger)
   → RoundTransition → RoundResult
   → Finalisierung: GAME_END → RESULT_REVIEW → FINALIZED (GameResult)
        ↓ (einmalig, idempotent, nur aus FINALIZED)
   ├─ Eventpunkte (EventPointRecord, getrennt von Spielpunkten)
   ├─ PlayerHistory/Statistics/PersonalBests/Streaks/XP/Achievements
   ├─ Content-Usage-Stats (usageCount, empirical Difficulty)
   └─ Event-History/Recap
Amendment (nach FINALIZED):
   ResultAmendment → korrigiert GameResult →
   konsistente Nachkorrektur aller Ableitungen (idempotent, nachvollziehbar).
```

**Es gibt kein separates Punktesystem pro Ableitung** — alles leitet sich vom
ScoreEvent-Ledger + FINALIZED Results ab; Korrekturen laufen über Amendments.

---

## 2. ID-, Zeit-, Einheiten- und Revisions-Standard (Ziel, PR13)

- **IDs:** UUID (bestehend) für interne Entitäten; `commandId` = UUID (neu);
  sichtbare Codes (Raumcode NNN-NNN) getrennt; `eventParticipantId`/`eventTeamId`
  als stabile Event-Identitäten (neu). IDs nie Security.
- **Zeit:** UTC intern, ISO-8601 Transfer (bestehend); Scheduled-Räume speichern
  `timezone` (neu, mit `SCHEDULED`); `durationMs` durchgängig.
- **Einheiten:** Punkte integer (Ledger), Eventpunkte **decimal** erlaubt
  (Tie-Durchschnitt, z. B. 4 = (5+3)/2), Bytes für Größen, `percentage`
  einheitlich 0–100 (Ziel-Entscheidung, DEC-STD-01).
- **Nullability:** Zod-Defaults zentral in `shared` (bestehend); eine
  Not-Set-Repräsentation je Feld; Snapshots speichern effective values
  (neu durch `RoomConfigSnapshot`).
- **Revisions:** `revision` (fachliche Änderung) bei Content/Pool/Presets/
  RoomConfig/EventConfig/PlayerProfileSettings; Konflikt → `REVISION_CONFLICT`
  (Code neu); nur fachliche Änderungen erhöhen (bestehend bei Room/GameState).
- **Error-Codes:** `ApiResponse.error` erweitert um `messageKey`, `retryable`,
  `traceId` (neu, PR13); Game-Codes im Namespace `GEO_*`/`JEOPARDY_*`/… (bestehend
  teilweise, vereinheitlichen).
- **Protocol:** `/api/v1/` + `protocolVersion=1` im Socket-Handshake und im
  ClientCommand (neu, PR13); inkompatibel → `CLIENT_VERSION_UNSUPPORTED`.
- **Begriffe (G1):** zentrales Glossar in `shared` (neue Datei
  `glossary.ts`): `HOST` (statt Moderator), `ADMIN`, `PLAYER`, `VIEWER`,
  `DISPLAY`; `MODERATOR` bleibt nur in `LEGACY_ROLE_ALIASES` für Migration
  (analog `LEGACY_SLUG_ALIASES`, bewährtes Muster aus PR10). DB-Migration:
  `User.role`/`Participation.role` Werte umschreiben + Socket-Events behalten
  alte Namen in Compatibility-Fenster mit Deprecation-Log.

---

## 3. Command-/Event-/Snapshot-Verträge (Ziel, PR13/PR15)

### 3.1 Command-Envelope (erweitert)

```ts
// bestehend: requestId, roomCode, expectedRevision, clientTime, payload
interface ClientCommand<T> {
  commandId: string;        // NEU: UUID, client-generiert, server-seitig gededuped
  protocolVersion: number;  // NEU
  roomId: string;           // intern (bisher roomCode)
  expectedStateVersion?: number;
  payload: T;               // immer via Zod-Schema pro Command validiert
}
```

- `CommandReceipt` (kurze Retention) macht `ALREADY_PROCESSED` nachweisbar
  (Score/Buzz/Submission/Reveal/Joker/Eventpoints/Host-Actions).
- Server prüft immer: Rolle/Recht, Phase, Teilnehmer/Team, Idempotency,
  State-Version — unabhängig von `availableActions`.

### 3.2 Events

- Fachliche Events als unveränderliche Records (in-memory + persistiert, wo
  relevant für Recovery/Stats/Audit): `RoundStarted`, `BuzzerClaimed`,
  `AnswerSubmitted`, `AnswerJudged`, `ScoreChanged`, `RoundEnded`,
  `GameEnded`, `GameFinalized`, `ResultAmended`, `TeamChanged`,
  `HostTransferred`, `ContentLeaked`…
- Nicht jedes technische Kleinstereignis persistiert (§5.18).

### 3.3 Snapshots/Projektionen

- `createProjection(role, participantId?, teamId?)` → rollenabhängiger Snapshot:
  HOST / PLAYER / TEAM / VIEWER / **DISPLAY** (neu, G1).
- Felder: Phase, stateVersion, Timer (endsAt + Status), Buzzer-Status,
  Score (sichtbare), Turn, sichtbare Inhalte, eigene private Daten,
  `availableActions`.
- **Secret-Grenzen:** Secrets werden nie „vorsorglich" an falsche Clients
  gesendet (Visibility `HOST_PRIVATE\|PLAYER_PRIVATE\|TEAM_PRIVATE\|PUBLIC`);
  automatisierte Leak-Prüfung (PR41) über API, Socket, Snapshot, Medien, Preloading.

---

## 4. Game-Cores (Zielmodell, Umsetzung PR15/PR16)

| Core | Zustand in main | Ziel (API-Skizze) |
|---|---|---|
| Timer | Geo-eigene setTimeout | `createTimer(state, {mode: COUNTDOWN\|COUNTUP\|UNLIMITED, endsAt?})`; `pause/resume/extend/end`; serverautoritativ; Persistenz als echte Zeitpunkte (rekonstruierbar nach Restart); `endsAt` im Snapshot. |
| Buzzer | vorhanden (2 Engines) | erweitern: TEAM-Buzz, `reopen/reset`, selektierte Teilnehmer, Host-Override mit Audit, `SERVER_ARRIVAL`-Festlegung, RTT-Messung (PR41), Rejoin ändert Reihenfolge nicht. |
| Judge | Engine-intern | `judge(state, {byJudgeId, decision: CORRECT\|WRONG\|PARTIAL\|CANCELLED, reason?})`; Korrektur-Events; Automatik-Override. |
| Turn | fehlt | `createTurnOrder({mode: FIXED\|RANDOM\|ROTATING_START\|CUSTOM_HOST_ORDER, seedRef})`; serververwaltet; Disconnect ändert nicht; Host-Override. |
| Tie | fehlt | `resolveTie(state, strategy)`; Strategie **vor Start** im ConfigSnapshot; keine stille Zufallsentscheidung. |
| Answer-Matching | fehlt | `matchAnswer(submission, item, {mode: EXACT\|NORMALIZED\|SYNONYM\|FUZZY\|MANUAL_ONLY})` → `MATCH\|NEEDS_JUDGE\|NO_MATCH`; Synonyme aus ContentItem. |
| Submission | fehlt | `submitDraft/submit/lock` (`DRAFT\|SUBMITTED\|LOCKED\|JUDGED`); Timer-Lock; Dedup; private bis Reveal. |
| Reveal/Visibility | Engine-intern | zentrales `reveal(state, {visibility})` + Projektionen (3.3); Secret-Grenzen. |
| Random/Seed | teils (randomUUID) | `drawRandom(seedRef, domain)` serverseitig; Entscheidungen persistieren; Rejoin würfelt nicht neu; BLIND_HOST-Seed nicht rekonstruierbar (separater Secret-Bereich). |
| Command | requestId/expectedRevision | + `commandId` + Receipt (3.1). |
| Event | fehlt | 3.2. |
| State/CAS | vorhanden (CAS) | `stateVersion`-Begriff, veraltete Commands: ablehnen/neu validieren/Resync (Contract-Festlegung). |
| Resync/Snapshot | Engine-intern | rollenabhängig (3.3) inkl. TEAM + DISPLAY. |
| Recovery | vorhanden (Restore) | + `ERROR_RECOVERY`-Zustand, Konsistenzprüfung (Invariants), „unsicher → Pause", keine Doppel-Erzeugung von Buzz/Random/Reveal/Score. |
| Versioning | vorhanden | beibehalten (Pin beim Start, Recovery gleiche Version). |
| Migration/Compatibility | vorbildlich (Slug) | Muster übernehmen: versioniert, atomar, idempotent, keine stillen Änderungen, historische Results nie umschreiben. |
| GameConfigSnapshot | Setup-Snapshot | vollständige §5.24-Feldliste; `CONFIG_CHANGED`-Event bei Live-Änderung. |
| Error/Fallback | ad-hoc | je Engine definierte Reaktionen (RETRY/SKIP_ROUND/PAUSE_AND_NOTIFY_HOST/FALLBACK_CONTENT/ABORT_ROUND). |
| Rate-Limit | HTTP-only | + Socket-Drosselung pro participant/session/command (BUZZ/SUBMIT/Join/Rejoin/Chat), Stufen. |
| Metrics | fehlt | spielerisch + technisch (5.27), Rohdaten begrenzt. |
| Test-Contract | E2E vorhanden | 10 Pflichttests je Engine als Contract-Suite (Framework PR13, Matrix PR48). |
| Invariants | implizit | `checkInvariants(state)` global + engine-spezifisch; Verletzung → Pause/ERROR_RECOVERY. |
| Undo/Rollback | fehlt | `undoable`-Markierung, Gegen-/Korrektur-Events, irreversible Secrets nicht rücknehmbar. |
| Finalisierung | fehlt | 5.31: GAME_END → RESULT_REVIEW → FINALIZED + Amendment (1.2). |
| Next-Action | fehlt | `computeAvailableActions(state, role, participant?, team?)` serverseitig. |
| Round-Transition | Engine-intern | zentrale Übergabe-Checkliste (5.33). |
| Progress | teils | `currentRound/totalRounds?/remainingRounds?/progressPercent?/currentStage?`. |
| Leaderboard | Scoreboard-UI | Ledger-basiert, Ties, Zwischen-/Endstand, optional versteckt. |
| Result-Screen | je Engine | gemeinsame Bausteine (5.36), rollenabhängig. |
| Notification | Toast | `notify({kind, target: role\|participant\|team\|all, messageKey, payload?})`; wichtiges nicht nur als Toast. |

**DoD Core (§13.2):** API/Schema, Permissions, Persistenz, Rejoin/Recovery,
Error/Fallback, Tests, Monitoring/Logging, Doku + **Nutzung durch ≥2 Engines**.
Die bestehenden drei Engines (wissensduell, jeopardy, wer-ist-das) sind die
natürlichen ersten Nutzer — deshalb gehören Core-Vollständigung (PR15/16)
vor den meisten neuen Spielen, und PR37 bringt die Bestands-Engines nach.

---

## 5. Fachbereichs-Mapping (Kurzform; Details in requirements-matrix.md)

### 5.1 Rollen/Permissions (PR13/14)
Begriffsmigration G1 (HOST/DISPLAY), `PermissionGrant`, Co-Host-Delegation,
Trennung Admin-/Informationsrechte (Tests: spielender Host ohne Info-Vorteil).

### 5.2 Team (PR14)
`Team`/`TeamHistory`, 4 Zuweisungsmodi inkl. `ROTATION` (Event-Historie),
Gleichheitsregel, Lock nach Start, `allowTeamReshuffleBetweenRounds`,
Team-Scoring über denselben Ledger (`targetType=TEAM`).

### 5.3 Room/Lobby (PR14)
Zustandsmodell §4.3, Zugangstypen, Ready-Regeln, Preflight, Host-Transfer
(`HOST_MISSING`), Ban/Unban, Geräteübernahme (ein aktive Player-Session,
`session:replaced` erweitern + Audit), Late Join (`PENDING_JOIN`),
Waitlist, Namensregeln, Feed, Status-Übersicht, Config-Klassen,
Rematch/Spielwechsel/CLOSE, Archivierung (mit PR42).

### 5.4 Game Core (PR15/16)
siehe Abschnitt 4.

### 5.5 Content/Editor (PR17/18)
`ContentPool`/`ContentItem` (game-spezifische Schemas je Engine über ein
gemeinsames Editor-Framework), Scope/Ownership, Revisionen, Tag-System,
Multi-Pool + Snapshot, Repeat-Regeln, BLIND_HOST, Ready-Standard,
Autosave/Validierung/Preview, Bulk Edit/Search, Version History/Concurrent
Editing, Duplicate, Release/Review/Inbox/Comments/Notifications/Trash/
Dashboard/Scheduled Publishing/Source-License/i18n/Usage/Review Assignment/
Quality/Locks/Custom Metafields/Feldsets, Quick/Advanced, Quick Setup,
Presets, Room Templates, Import/Export (CSV/XLSX/JSON/Media-ZIP), AI-DRAFT.
**Bestehend:** `QuestionPack`/`GeoQuestion` werden migriert (versionierte
Migration im PR10-Muster: atomar, idempotent, Refs stabil).

### 5.6 Media/Voice/Broadcast (PR19/20)
PR11-Grundlage (signed URLs, processStatus, derivedFrom) ausbauen:
Storage-Abstraktion, Visibility (ROOM_TEMP-Lebenszyklus 7d), immutability,
Derived Assets, Formate/Processing, Preload leak-safe, Runtime-Failure-
Aktionen, Audit/Block, Rights/Consent, Prejoin, Device-Switch, Mute,
Camera-Visibility, Voice Channels (MAIN/TEAM, Viewer nie TEAM), PTT,
Multiple Speakers, Defaults, Audio-Processing, Bandwidth, Screen Sharing,
Broadcast-Route (DISPLAY, mehrere, keine Secrets). WebRTC: SFU nicht in V1
(Simulcast/SFU = ausdrücklich später), TURN/STUN-Vorbereitung PR19,
echter Internetbetrieb PR44.

### 5.7 Event/Olympia (PR38)
siehe 1.2 (EventSeries-Erweiterung, EventParticipant/EventGame/
EventPointRecord), Intermission, Finalisierung + Amendment, Leaderboard,
Abbruch-Regeln, Progress, Presets, History, Achievements, Recovery,
Suspend, Required/Bonus, Joker, Aussetzen, Mindestspiele, Siegerehrung,
Recap, Duplizieren.

### 5.8 Profile/Stats/XP (PR39/40)
PlayerProfile (optional, Claim nie nur per Name), Statistics per Game +
aggregiert, XP (kosmetisch, Anti-Farming), Achievements (+ Event-Achievements),
Privacy-Defaults, History, Personal Bests, Streaks, Self Comparison,
Game-Dashboards, sampleSize, Export (keine Secrets), Reset/Delete,
Opt-outs, Popups.

### 5.9 Integrität (PR41)
GameIntegrity-Core, IntegrityIncident, kein Fingerprinting, Buzzer-Fairness
(RTT), Clock Sync/Grace, Replay/Dedup (commandId), Secret-Leak-Suite
(alle 19 Engines), Host-Actions, ContentLeakIncident, Client-Trust,
tamper-evident Audit (Hashverkettung).

### 5.10 Plattformbetrieb (PR42–46)
Quotas, Cleanup (Dry-run, Referenzschutz), Backup/Restore (RPO 24h/RTO 4h,
isolierte Restore-Tests), Health (alle Komponenten), Platform Modes,
Moderation, Feature Flags, Deployment (Staging-Remote-Joins, Rollback mit
laufenden Räumen), Retention, Admin Ops, Secrets, Migration (dry-run,
Checksums), Komplett-Import/Export, Configuration-Core (versioniert,
Session-Snapshot), Background Jobs (Retry, Dead-letter), Logging (traceId),
Alerting, Capacity (Lasttests), Horizontal Scale (Adaptergrenzen, 1 Instanz
zulässig), Distributed Coordination (Atomarität), Disaster Recovery.

### 5.11 UX/i18n (PR47)
UI in de/en/tr (Framework neu), Content-Sprache getrennt, Mobile/Tablet,
PWA ohne aktive Partien zu brechen, Accessibility, Hilfetexte, Medienfehler.

---

## 6. Migration & Recovery (globale Annahmen)

1. **Begriffs-Migration G1** (MODERATOR→HOST, ROOM→ROOM_TEMP, Status-Enums):
   versionierte DB-Migration im PR10-Muster (atomar, idempotent,
   compare-before-write, keine ID-Änderung, Refs stabil); Socket-Event-Namen
   mit Compatibility-Fenster.
2. **Content-Migration** (QuestionPack→ContentPool/Item): 1:1 mit Scope=PRIVATE,
   Status-Mapping (PUBLISHED→READY, DRAFT→DRAFT, ARCHIVED→ARCHIVED),
   Media-Referenzen bleiben (Asset-IDs stabil).
3. **Aktive Räume während Migration:** In-Memory-State hängt an roomId
   (bewiesen in PR10-E2E); Migration läuft beim Start, keine aktive
   In-Memory-Session; Recovery via RoomGameState + Engine-Version.
4. **Historische Results:** nie umschreiben; Amendments als neue Records.
5. **Recovery nach Restart:** State + Timer (echte Zeitpunkte) + Buzzer/
   Random/Reveal/Score nie neu oder doppelt; unsicher → Pause (ERROR_RECOVERY).
6. **Kein zweiter Server auf derselben DB** (dokumentierter Betriebskonflikt
   aus PR10, bleibt in V1; horizontale Skalierung = später, Adaptergrenzen PR46).

## 7. Monitoring/Audit (Ziel)

- traceId durchgängig (Logging, Error-Codes, Audit, Integrity).
- Kritische Events (Score corrections, Host transfer, Bans, Reveals,
  Amendments, Eventpoint corrections, Integrity actions) → Audit mit
  Hashverkettung; Rest → normales Log.
- Metriken: spielerisch (Antwort-/Buzzzeit, korrekt/falsch, Skips, Abbrüche)
  + technisch (Reconnects, verlorene Events, Recovery, Media-Fehler, Latenz,
  Command-Fehler); Rohdaten mit Retention.
- Health/Alerts: API/Socket/DB/Storage/Jobs/Backups; Critical → Auto-Actions
  (READ_ONLY/MAINTENANCE/Block neu Räume).

## 8. Technische Optionen, die der Master offenlässt (dokumentiert, keine Auswahl)

| Thema | Option A | Option B | Entscheidung |
|---|---|---|---|
| WebRTC-Signalisierung/Transport | P2P-Mesh (V1) | SFU | **P2P-Mesh für V1** (Master: SFU/simulcast ausdrücklich später); SFU-Grenze als Adapter (PR46) |
| Socket-Backplane | In-Prozess (1 Instanz) | Redis | **In-Prozess für V1** (Master: eine Instanz okay); Adapter PR46 |
| Empirical Difficulty-Quelle | ScoreEvent-Ledger | separate Stats-DB | **Ledger + ContentUsageStat** (idempotente Ableitung) |
| Eventpunkte-Typ | integer ×10 | decimal | **decimal** (Master erlaubt; Tie-Durchschnitt 4 = (5+3)/2) |
| Percentage-Darstellung | 0–1 | 0–100 | **DEC-STD-01** (Vorschlag: 0–100 integer für UI-Konsistenz) |
| Audit-Hashverkettung | SHA-256-Prädikat | Merkle | **Prädikat** (einfach, nachvollziehbar, Master „möglich") |
