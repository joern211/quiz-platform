# PR12 — Handoff: Regelwerk Mapping & V1-Spezifikation (19 Spiele)

**Stand dieses Dokuments:** wird nach jeder Etappe aktualisiert.
**Zuletzt aktualisiert:** Etappe A (Isolation + erster Checkpoint)

## Auftrag (Kurzform)

Eigenständige, isolierte **Vorbereitung von PR12 als Dokumentations-/Spezifikations-PR**:
vollständige Zuordnung Master-Regelwerk → Anforderungen → Module/Verträge → Roadmap-PRs →
Tests → Abnahme. Ist-Analyse auf main, getrennter Vergleich des gepinnten PR11-Snapshots,
Zielverträge (Zielmodell, keine Runtime-Änderungen), Spezifikationen aller 19 Spiele
(einschließlich **Der Dümmste Fliegt**, Slug-Vorschlag), Entscheidungsregister,
Abhängigkeitsplan. **Keine** Implementierung, **kein** Touch des PR11-Worktrees.

## Isolation (Etappe A — verifiziert)

| Wert | Status |
|---|---|
| Repository | https://github.com/joern211/quiz-platform (origin, HTTPS) |
| **Basis main (festgehalten)** | `411a5b783e5857bca5b208598fade43affc108b5` (PR10 gemerged) |
| **PR11-Head (gepinnt)** | `14708940246de105b83fdf69501ce373e2c48d21` (Etappe 3, Draft) |
| PR11-Branch | `feature/wer-ist-das-fusion-media` (remote + local, NICHT angefasst) |
| **Eigener Worktree (absolut)** | `/Users/joern.r/quiz-platform-pr12-spec` |
| **Eigener Branch** | `docs/pr12-master-spec-preparation` (basierend auf origin/main @ 411a5b7) |
| HEAD beim Start | `411a5b783e5857bca5b208598fade43affc108b5`, sauberer Start |

Vorhandene Worktrees (unberührt, nur read-only Kenntnis):
- `/Users/joern.r/quiz-platform` → `feature/jeopardy-mvp` (mit uncommitteten Änderungen — NICHT anfassen)
- `/Users/joern.r/quiz-platform-catalog` → `feature/canonical-game-catalog`
- `/Users/joern.r/quiz-platform-pr11` → `feature/wer-ist-das-fusion-media` (PR11-Arbeitsbereich — strikt NICHT anfassen)

## Freigegebene Schreibbereiche

- `docs/implementation/pr12/` (dieser Ordner)
- `docs/specs/pr12/`

Zwischendatei (lokal, nicht committen): `.work/master-regelwerk-extrahiert.md`
(Mustertext, extrahiert aus dem RTF-Wrapper; `.work/` wird vor jedem Commit geprüft
bzw. via `.git/info/exclude` lokal ignoriert — siehe Validierung).

## Quellenstatus

| Quelle | Status |
|---|---|
| `Master Regelwerk.rtf` (Desktop, Stand 28.09.2026) | VOLLSTÄNDIG GELESEN. SHA256 (Datei): `867b3519f86c427420d5de3aae5a07566371bcaff462630bf4aad9b16a6c0e15`. Enthält Python-Wrapper; Regeltext extrahiert (ohne Code-Ausführung), SHA256 (extrahierter Text): `5051ffc9ce8d8cda8b98241319d5179eea3b7928557021480ab95bd3c9a06ac0`. Alle 20 Abschnitte vorhanden (§1–§20), 3956 Zeilen. |
| Nutzerergänzung vom 07.10.2026 | V1.0 = vollständiger Master-Scope + **Der Dümmste Fliegt** (19 Spiele). |
| Roadmap 1–50 (angehängt) | Gelesen; PR-Nummern sind Planplätze. |
| main `411a5b7` | Ist-Analyse läuft (Etappe B). |
| PR11 `1470894` | Als Fix-Snapshot via `git diff/show` verglichen (keine fortlaufende Beobachtung). |
| Gesamtplan PDF | Nicht benötigt; nur historischer Kontext. |

## Etappen-Plan

- [x] **A — Isolation und Checkpoint:** Worktree/Branch angelegt, Master extrahiert, erster Commit.
- [ ] **B — Anforderungen + Iststand:** Vollständige Erfassung der Regelwerk-Unterpunkte (§1–§20);
      main-Iststand (Shared-Typen, Prisma, Cores, Registry, HTTP/Socket, Media, Tests, CI);
      PR11-Delta separat.
- [ ] **C — Zielverträge + Spieldetails:** technical-mapping.md; 19 Spielespezifikationen;
      decision-register.md.
- [ ] **D — Abhängigkeiten:** dependencies-and-parallel-work.md.
- [ ] **E — Konsistenz, Draft, Handoff:** README, verification.md, pr-body.md, Link-/ID-Prüfung,
      Commit, Push, Draft-PR gegen main.

## Erste Befunde (Etappe A/B, vorläufig — werden in der Matrix finalisiert)

**Rollennomenklatur (wichtig):** main nutzt noch `MODERATOR` als Host-Rolle
(`User.role: ADMIN|MODERATOR`, `Participation.role: MODERATOR|PLAYER|VIEWER`,
`GameManifest.roles` enthält `'MODERATOR'`). Master §2.1 schreibt vor, dass
„Moderator" vollständig durch **HOST** ersetzt wird; **DISPLAY** existiert in main
überhaupt nicht (kein Role-Value, keine Session-Art, keine Route).
→ Migration/Compatibility-Punkt für PR13 (§12.1 „alte Begriffe nur Migration/Compatibility").

**Room-Lifecycle:** main: `CREATED|LOBBY|RUNNING|ENDED|ARCHIVED` + `runPhase`;
Master §4.3 verlangt u. a. `DRAFT_ROOM|SCHEDULED|LOBBY_OPEN|LOBBY_LOCKED|GAME_ACTIVE|
PAUSED|IDLE|EXPIRED|CLOSED`. Teilweise über `runPhase` abgedeckt (z. B. PAUSED,
STARTING_COUNTDOWN), aber `DRAFT_ROOM`/`SCHEDULED`/`EXPIRED`/`IDLE` fehlen als Zustände.

**Team-Core:** kein Team-Modell in Prisma (nur `Participation.teamId String?` ohne Team-Row,
keine Team-Entität, keine Team-Limits, keine Teamhistorie, kein TEAM_SCORE-Scoring).
→ PR14 Kernthema; `hasTeams`-Manifeste (partner-challenge, same-thought) nicht bedienbar.

**Content-System:** nur `QuestionPack` + `GeoQuestion` (4-Optionen-Multiple-Choice,
`enabled` statt DRAFT/READY/DISABLED/ARCHIVED-Status, kein Visibility/Ownership-Modell,
keine Tags, keine Revisionen, kein Import, kein Editor-Backend). → PR17/18.

**Game Core (main):** vorhanden: `games/core/{buzzer,score,state,access,errors}.ts`
(Buzzer-Primitiven, ScoreEvent-Transaktion, CAS via `saveGameStateIfRevision`,
Rollen-Authorization, Fehlercodes). Fehlt als Core: Timer als Core-Modul (Geo hat
eigene In-Memory-Timer), Judge, Turn, Tie, Answer-Matching, Submission, Reveal/Visibility,
Random/Seed, Command-Idempotency (nur `requestId` + `expectedRevision` im ClientCommand),
Metrics, Invariants, Leaderboard, Round-Transition, Next-Action, Notification.
GameEngineContract (§5.2) nicht formal als Interface umgesetzt — Registry hat eine
`GameHandle` (initialize/afterStart/pause/resume/end/cleanup/registerEvents), die dem
Contract nicht vollständig entspricht (keine `validateSetup/preflightCheck/createProjection/
buildRoundResult/buildGameResult` als Contract-Methode).

**Rejoin:** vorhanden (rejoinToken + Version, `room-reconnect`-Integrationstest,
geo/jeopardy/weristdas resync). **Keine** Geräteübernahme-Logik nach §4.11
(keine Übernahme-Meldung, keine Viewer-Begrenzung pro participantId), kein Late Join
(`allowLateJoin` fehlt), keine Waitlist, kein Ban (nur `kickedAt`), kein Host-Transfer.

**Media (main):** `MediaAsset` (PRIVATE|PUBLIC|ROOM), Local Storage, kein Signed-URL-Flow,
keine Derived Assets, kein Processing-Status, kein Audit/Block. PR11 (gepinnt) fügt hinzu:
`derivedFromAssetIds`, `processStatus` (READY|PROCESSING|FAILED|REJECTED),
Visibility-Kommentar SHARED/SYSTEM/ROOM_TEMP, `http/media.ts` massiv erweitert (protected
delivery), `media/signedUrl.ts` neu, Migration `..._add_media_derivation_status.sql`,
Composite-Fusion (`weristdas/composite.ts` + Tests), Setup-Schema v2 für wer-ist-das,
`HOST_CANNOT_PLAY_OWN_ROUND`-Gate beim Join (Host-Konto kann eigene wer-ist-das-Runde
nicht mitraten — Informationsvorteil).

**Events/Olympia:** nur leeres `EventSeries`-Modell (PLANNING|ACTIVE|ENDED, settings-JSON,
keine Relationen, keine Eventpunkte, keine Intermission). Room.eventSeriesId als String ohne
Relation. → PR38.

**Profile/Stats/XP:** fehlt komplett (kein PlayerProfile-Modell, keine History/Stats/
Achievements/XP). → PR39/40. (Web `ProfilePage.tsx` = lokale Client-Daten.)

**Integrität:** nur `AuditLog` (einfach, nicht tamper-evident, nur User-Aktionen),
Rate-Limiter (Login/Join, nach Projekt-Historie nur production — zu prüfen),
kein IntegrityIncident, kein Replay/Dedup über commandId (commandId-Äquivalent: `requestId`
im ClientCommand, Server-Dedup-Verhalten zu verifizieren), kein Secret-Leak-Test-Rahmen.

**Betrieb:** keine Backups (außer `apps/server/storage/backups` gitignore-Verweis),
keine Background Jobs, kein Health-Endpoint nach §11.4 zu prüfen, keine Feature Flags,
keine Platform Modes. CI: typecheck+lint+build+server tests+web tests+E2E (Playwright).

**19. Spiel:** `der-duemmste-fliegt` ist in main NICHT im Katalog (18 Manifests) —
konsistent mit „Nutzerergänzung, Slug-Vorschlag, separat zu spezifizieren".

## Offene Decision-IDs (während der Arbeit fortgeschrieben)

- `DDF-01` … (Der Dümmste Fliegt: Mechanik-Details, Slug, Ausscheidung/Voting/Finale)
- `SNG-01` (Song-Quiz-Punktwerte/Phasen, §15.5 offen)
- weitere folgen (Undercover/Geheim Agent/Raus damit/Higher-Lower/Timeline/
  Schätz mal/Millionenfrage/Wahr-oder-Fake/SLF/Gleicher-Gedanke-Details)

## Blocker / Annahmen

- Keine Blocker bisher. PR11-Worktree bleibt strikt unangetastet.
- Annahme: `docs/pr12-master-spec-preparation` darf auf origin gepusht werden
  (Push erfolgt erst in Etappe E).

## Ausgeführte Checks (Etappe A)

- `git worktree add` + `git rev-parse`-Verifikation (Pfad/Branch/HEAD oben).
- RTF-Extraktion mit strukturiertem Parser, keine Code-Ausführung; 0 verbleibende
  RTF-Escape-Sequenzen; Abschnittsüberschriften vollständig (§1–§20).
- `git status --porcelain` im eigenen Worktree: sauber (außer neuen Dokumenten).
- PR11-Delta: `git diff --stat 411a5b7..1470894` (18 Dateien, +1946/−125) —
  bestätigt PR11-Scope (Media, weristdas, schema, seed, shared, docs/pr11-handoff).

## Nächster Schritt

Etappe B abschließen: verbleibende main-Module im Detail lesen (geo/jeopardy/weristdas
Engine+Events, sockets/room.ts, http/rooms.ts, media.ts, e2e.ts, seed.ts, tests),
dann `docs/specs/pr12/requirements-matrix.md` mit stabilen MR-IDs aufbauen.

## Commit-Log (eigener Branch)

| SHA | Inhalt |
|---|---|
| (1. Commit) | Etappe A: Handoff, Worktree-Basis |
