# PR11 Handoff — „Wer ist das?“ mit Composite-Bild und geschütztem Medienzugriff

> Fortschrittsdatei für Chat-Abbruch-Sicherheit. Nach JEDER Etappe aktualisieren:
> Basis-Commit, letzter Commit, erledigte Dateien, Tests + Ergebnis, offene Fehler,
> nächster konkreter Schritt. Keine Tokens/Passwörter/privaten Bilder/Log-Inhalte.

## Status-Übersicht (lebendig halten)

- **Basis-Commit:** `411a5b783e5857bca5b208598fade43affc108b5` (PR #10, verifiziert = origin/main)
- **Branch:** `feature/wer-ist-das-fusion-media` (lokal = remote = `7d50381`, Arbeitsbaum sauber, 07.10. verifiziert)
- **Letzter Commit:** `cd2ec0f` — **A erledigt** (Composite überlebt Wiederholungsaufruf, atomar, 232/232 grün)
- **Etappe:** **Nacharbeit A–E** (Merge-Blocker aus Codex-Review) — in Arbeit
- **PR:** **Draft-PR #11** → https://github.com/joern211/quiz-platform/pull/11 (Basis main)

### Nacharbeit: verifizierte Befunde (am Head `7d50381`, 07.10.)
- **A (Composite-Datenverlust):** `composite.ts` schreibt `fusion-<round>-<digest>.webp` (deterministisch),
  sucht dann per sha256 ein vorhandenes Asset und **löscht bei Treffer denselben Pfad** → zweiter Aufruf
  (UI-Button „Spielbild neu erzeugen") kann die einzige persistierte Datei löschen. Verifiziert: Code +
  Idempotenztest liest Datei nach Wiederholungsaufruf nicht erneut.
- **B (Upload-Dedupe/500/Cleanup):** `sha256 @unique` global; bei gleichem Content eines ANDEREN Hosts
  → Insert mit gleichem Hash → P2002 → 500; `catch` räumt nur `uploadedPath` auf, `outPath` bleibt liegen.
  Verifiziert: `media.ts` L.178-213. Parallel-Race desselben Hosts zwischen Lookup und Insert gleich.
- **C (Host-Routen):** `GET /media/host/:id` existiert OHNE Signed-URL-Prüfung (nur Session + Eigentum),
  und dort wie im `host`-Pfad von `/:id` werden `revokedAt`/`expiresAt` der Session **nicht** geprüft.
  `/media/host/:id` wird nirgends im Web/E2E genutzt (verifiziert via grep) → Kandidat für Entfernung.
  `game`-Audience am Endpunkt: Signatur prüft nur assetId|audience|exp — es fehlt ein Endpunkt-Check,
  dass das Asset tatsächlich ein als Spielbild freigegebenes Bild ist (z. B. Original mit game-Signatur).
- **D (Versionen/Recovery):** Setup-UI schreibt `setupVersion: 2` (Runden-ebene), Schema liest
  `setupSchemaVersion` (Top-Level, Default 1) → Felder inkonsistent; `rooms.ts` setzt
  `Room.setupSchemaVersion` nie (Default 1). `engineVersion=2` wird gespeichert, aber in
  `act()`/`resync()` nicht gelesen → keine geprüfte Kompatibilitätsentscheidung. Der „Recovery"-Test
  (fusion.integration) nutzt denselben laufenden Server — kein Prozessneustart.
- **E (Lebenszyklus):** UI erzeugt Composite VOR der Raumerstellung ohne roomId → API setzt
  `roomId = tmp-<hostUserId>`; nach `POST /rooms` gibt es keine Re-Bindung an die echte Raum-ID.
  Abbruch/Quelltausch hinterlässt verwaiste `ROOM_TEMP`-Assets mit Pseudo-RoomIds.

### Nacharbeit: Plan & Datenstrategie-Entscheidungen
- **A:** sha256-Lookup VOR dem Schreiben; bei Treffer: Datei niemals löschen, stattdessen (i) wiederverwenden
  und (ii) bei fehlender Datei kontrolliert re-materialisieren (deterministische Bytes → bytegleich).
  Schreiben nur bei Neu; bei P2002-Race: eigene (unterschiedliche) Datei löschen, fremde nie.
- **B:** `sha256 @unique` → `@@unique([sha256, uploadedBy])` (additive Migration; Content-Identität ist
  je Owner). Gleicher Host+Content → Dedupe (200); fremder Host+Content → eigenes Asset (201), kein 500,
  kein Ownership-Leak. P2002-Race → kontrolliert auf bestehendes Asset desselben Owners auflösen.
  Cleanup für `uploadedPath` UND `outPath` auf allen Pfade (fremde Dateien nie löschen).
- **C:** `/media/host/:id` entfernen (unused); `host`-Pfad von `/:id`: Session auf `revokedAt`/`expiresAt`
  prüfen. `game`-Audience am Endpunkt nur für Assets, die in einem Raumsnapshot als freigegebenes
  Spielbild referenziert sind (`imageAssetId` v1 / `gameImageAssetId` v2) — verhindert, dass eine
  game-Signatur versehentlich ein Original oder fremdes Rundenbild freigibt.
- **D:** Setup-UI sendet zusätzlich `setupSchemaVersion: 2` (Top-Level); `rooms.ts` setzt bei wer-ist-das
  `Room.setupSchemaVersion` aus dem Snapshot (nur bei Create, alte Räume unangetastet). Engine-Versionen:
  gemeinsame Reader unterstützt v1+v2 State exakt (gleiche State-Form); `SUPPORTED = [1,2]`; alles andere
  → kontrollierter Fehler (`ENGINE_VERSION_MISMATCH`) statt falschem State. ECHTER Prozess-Restart-Test
  (Child-Process-Server stoppen/neu starten, dieselbe DB) für v1-Raum (engineVersion=1) UND v2-Raum.
- **E:** Bei wer-ist-das-Raumerstellung: referenzierte `gameImageAssetId`-Assets mit `roomId = tmp-<host>`
  bzw. null und `uploadedBy = host` werden an den echten Raum gebunden (kompensierend, keine
  Überschreibung echter Bindungen). Nach erfolgreicher Raumerstellung: verwaiste `tmp-<host>`-Composites
  des Hosts, die in KEINEM Raumsnapshot referenziert sind, werden bereinigt (Datei + Zeile). Verbleibende
  BETA-Grenze (Crash zwischen Composite und Raumerstellung) ehrlich dokumentiert.

- **Nächster Schritt:** A implementieren (Test-first), dann B, C, D, E. Nach jedem Fix: Tests, Commit,
  Handoff-Update, Push. Am Ende: Doku + PR-Beschreibung (falsche Behauptungen zu Dedupe/Signaturen/
  Recovery korrigieren) + CI am finalen Head + Report mit Abnahme-Matrix A–E.

---

## 1. Bestandsaufnahme (Ist, verifiziert am Basis-Commit)

### Setup-Vertrag
- `apps/server/src/http/validators.ts` → `CreateRoomSchema.setupSnapshotJson`: akzeptiert
  Objekt ODER JSON-String, wird via `JSON.stringify` in `rooms.ts` gespeichert.
  **Keine spielspezifische Validierung beim Raum-Create.**
- `apps/server/src/http/rooms.ts` (POST `/`): prüft Startfähigkeit (Registry + Status
  AVAILABLE/BETA, DB-Zeile UND kanonisches Manifest) — prüft ABER nicht das Setup.
- `apps/server/src/games/weristdas/engine.ts` → `initialize()`: parse via
  `WerIstDasSetupSchema` und prüft **nur** `imageAssetId`-Eigentum
  (`uploadedBy: hostUserId`, `type: 'image'`). Fehler → `INVALID_SETUP` →
  `game.ts` rollt LOBBY→RUNNING zurück und löscht `roomGameState` (sauber, kein halb
  gestartetes Spiel).

### Asset-Modell (`prisma/schema.prisma`)
- `MediaAsset`: `id, type(image|audio|video), mimeType, filename, originalName, fileSize,
  width?, height?, duration?, sha256 UNIQUE, storagePath, uploadedBy?, visibility
  (default PRIVATE; Kommentar „PRIVATE | PUBLIC | ROOM“), roomId?, processed (default false),
  thumbnailPath?`.
- **Fehlt für PR11:** `derivedFromAssetIds` (Fusion-Quellen, §7.5), `processStatus`
  (PROCESSING/READY/FAILED/REJECTED, §7.7), `width/height` werden beim Upload nie
  gefüllt. `visibility`-Werte in Doku ≠ Regelwerk (§7.3: PRIVATE/SHARED/PUBLIC/SYSTEM/ROOM_TEMP).
- Keine `displayable`-Klammer-Logik; `processed` ist ein roher Boolean, nie `true`
  (Upload setzt ihn nicht) — für wer-ist-das aber irrelevant, da MVP-Bilder „fertige“ Assets.

### Medienzugriff (`apps/server/src/http/media.ts`)
- **POST `/api/v1/media`**: auth (verifySession), multer disk-storage, MIME-Whitelist
  (client-beschrieben!), Dateigröße `maxFileSizes.upload` (50 MB), sha256, `visibility:
  'PRIVATE'`, `uploadedBy: session.userId`. **Nicht:** Decodieren, Dimensionsprüfung,
  Metadaten-Sanierung, `width/height`, Dedupe-Ablage (identische Uploads erzeugen duplizierte
  Dateien, aber `sha256` UNIQUE → **zweiter identischer Upload = Prisma-P2002 → 500**).
- **GET `/api/v1/media/:id`**: **KEINE Zugriffskontrolle** (beliebiger Client, auch anonym,
  lädt JEDES Asset — inkl. PRIVATE), `Cache-Control: public, max-age=31536000` (1 Jahr!),
  `Content-Disposition: inline` (Originalname wird NICHT geleakt — OK), sendFile(
  `storagePath`). `storagePath` selbst wird nie ausgeliefert, aber die ID ist
  erratbar/teilbar.

### Projektion & Reveal
- `apps/server/src/games/weristdas/resync.ts` → `projectWerIstDas`: Allowlist-Projektion.
  `imageAssetId` geht an **alle** (MVP-Bild = Spielbild, public im Sinne der MVP-Logik).
  `person1/person2` nur für MODERATOR oder `revealed`. `aliases1/2` nur MODERATOR.
  `description` nur MODERATOR/revealed. **Kein Leaking von storagePath/originalName** (OK).
  Aber: das MVP-Bild ist ein PRIVATE-Asset, das über die offene GET-URL für jedermann
  ladbar ist (s.o.).

### Rejoin/Recovery
- `roomGameState` mit `revision` + CAS (`saveGameStateIfRevision`), `finishRunningGame`
  idempotent, Rejoin via `weristdas:resync` (rohlbezogene Projektion). State-JSON enthält
  nur Zähler/Phasen — **keine Asset-IDs im stateJson** (die sitzen im Setup-Snapshot).
- `engineVersion` wird beim `upsertGameState` nicht gesetzt (default 1) — §5.22 will
  gepinntes `engineVersion` im State. **Offen, klein.**

### Setup-UI
- `apps/web/src/pages/WerIstDasSetupPage.tsx`: pro Runde 1 Bild-Upload + Person 1/2.
  Kein Vorschau-Komposit, kein Upload-Status, keine Zweitbild-Semantik.
- `apps/web/src/pages/WerIstDasGamePage.tsx`: `<img src=/api/v1/media/{imageAssetId}>`.
  Auflösung (Namen) für MODERATOR immer sichtbar (geplante Geheimhaltung OK) + revealed.

### Geo-/Wissensduell- und Jeopardy-Medien (Verbraucher-Check)
- **UI-Konsumenten von `GET /api/v1/media/:id`:** NUR `WerIstDasGamePage` (img) +
  `WerIstDasSetupPage` (Upload). Geo/Jeopardy rendern Bilder aktuell **nicht** über die
  Medien-URL im Web (seeded Geo-Fragen haben kein `mediaAssetId`; Jeopardy `field:open`
  trägt `mediaAssetId` mit, aber kein Web-Consumer rendert es heute).
- **Folge:** Eine schärfere GET-Politik (PRIVATE → nur berechtigter Kontext) kann die
  Geo-/Jeopardy-Abläufe nicht still brechen — sie müssen aber weiter **funktionsfähig**
  bleiben, wenn später Medien drin sind (Policy wird generisch über Visibility +
  Kontext, nicht game-hackig).

### Tests
- `apps/server/src/games/weristdas/socket-flow.integration.test.ts`: 2 Runden, CAS-
  Buzzer, Rollen-Security, Scores, Reload, „no early secrets“ (Aber: prüft nur
  Socket-Events, **nicht** die GET-Medien-URL).
- `apps/web/e2e/weristdas-e2e.spec.ts`: Setup→Upload→Spiel→Reveal→Reload→Viewer;
  prüft, dass `secret` (Name) nicht in Client-Text erscheint und Header den
  Originalnamen nicht enthalten. **Nicht geprüft:** direkter GET-Zugriff auf
  PRIVATE-Assets durch Fremde, Cache-Header, Composite.
- **Keine** Upload-/Media-Integrationstests (MIME-Spoofing, korrupte Datei, Größenlimit,
  Dedupe-Aufräumen).

### CI (`.github/workflows/ci.yml`)
- Job 1 „CI“: pnpm install → prisma generate → migrate deploy → typecheck → lint → build →
  `pnpm --filter @quiz/server test` → `pnpm --filter @quiz/web test`.
- Job 2 „E2E“: playwright chromium, build, fresh DB + migrations + seed, E2E läuft.
- **Hinweis:** Server-Test-Script läuft `test-database.ts` + `seed.ts` + `vitest run`.
  Neue Migrationen müssen in `prisma/migrations/` liegen (deploy + test-database laufen sie).

## 2. Soll-Ziele (PR11-Scope, aus Arbeitsauftrag + Regelwerk)

### A. Datenmodell (additiv, versioniert)
- `MediaAsset.derivedFromAssetIds String?` (JSON-Array) — §7.5 (Fusion = mehrere Quellen).
- `MediaAsset.processStatus String @default("READY")` — Werte READY|PROCESSING|FAILED|
  REJECTED (§7.7). Default READY, damit existierende Assets unverändert bleiben.
- Setup-Schema v2 (wer-ist-das): Runde erhält ODER:
  - `imageAssetId` (v1, fertig vorbereitetes Spielbild) — bleibt lauffähig, ODER
  - `personAImageAssetId` + `personBImageAssetId` + `personAName` + `personBName` +
    `gameImageAssetId` (v2: zwei Originale + erzeugtes Composite).
- `setupSchemaVersion` des wer-ist-das-Manifests + `GameDefinition.setupSchemaVersion`
  in Seed/DB → **2** (begründet unten). `engineVersion` State → 2.
- Namensfeld-Mapping: v1 hat `person1/person2`; v2 nutzt `personAName/personBName`
  (canon, §15.3). Reader normalisiert beides auf `personAName/personBName`.

### B. Medienzugriff (Server, generische Policy)
- `GET /api/v1/media/:id`:
  - `PUBLIC`/`SYSTEM` → weiterhin offen (Geo-Wissensduell-Public-Medien bleiben anzeigenbar),
    Cache `public, max-age=…` erlaubt.
  - `PRIVATE`/`SHARED`/`ROOM_TEMP` → **Auth + Berechtigung**:
    - Raum-Kontext via Session: nur Room-Host (über den Host-User) darf PRIVATE-Assets
      laden, die diesem Raum gehören / von ihm hochgeladen wurden.
    - Für aktive Spielrunden: **nur das freigegebene Spielbild** wird an
      Player/Viewer/Display geliefert — über die Projektion als `imageAssetId`, deren
      GET-Zugriff für den Kontext der Runde freigegeben ist (Reveal-Gate).
  - `Cache-Control: no-store` für private Inhalte; nie `public, max-age=1y`.
  - Keine `storagePath`/`originalName` in Header (besteht bereits).
- **Kein** Client-Vertrauen: die Entscheidung obliegt immer dem Server (ID + Session +
  Raum + Phase).

### C. Upload/Verarbeitung
- Mime-Mapping: `image/png, image/jpeg, image/webp` (Bilder). Decodieren via `sharp`
  (serverseitig, existierende Dependency) → `width/height`, `format` normalisieren →
  `image/webp` (oder JPEG) als `processed`-Asset; EXIF/Metadaten werden durch sharp
  Strip entfernt.
- Größen-/Abmessungslimits: `maxFileSizes.image` (10 MB), max 4096×4096 (config).
- Korrupte/nicht unterstützte Datei → `MEDIA_REJECTED` (400/415), Datei + DB-Eintrag
  aufräumen.
- **Dedupe via sha256:** identischer Upload → bestehendes Asset wiederverwenden
  (kein 500, keine duplizierte Datei), aber **Ownership-Transfer vermeiden**:
  Wenn das Asset einem anderen `uploadedBy` gehört → neues privates Asset für den
  Uploadenden (oder klarer Fehler). Entscheidung: **neues Asset, eigene Ownership**
  (keine stillen Rechteüberträge, §7.3/§12.12).
- `processStatus`-Lebenszyklus: Upload → `PROCESSING` → (async/sync) → `READY`/
  `FAILED`. Für wer-ist-das: Verarbeitung synchron im Request (klein, < 10 MB),
  aber mit `processStatus`-Flag, damit die Engine/Validierung nur `READY` akzeptiert.

### D. Composite (Fusion)
- Neue serverseitige Funktion `createGameImage(personAAsset, personBAsset)`:
  - Lädt beide Originale via sharp, normalisiert auf quadratisches 1024×1024
    (center-crop), blendet über 50% (Alpha 0.5 / `composite` mit `blend`),
    Ergebnis `image/webp` (oder PNG) → neues `MediaAsset` mit:
    - `visibility: 'ROOM_TEMP'` (oder `PRIVATE`),
    - `roomId: <roomId>`,
    - `uploadedBy: hostUserId`,
    - `derivedFromAssetIds: [personAImageAssetId, personBImageAssetId]`,
    - `processStatus: 'READY'`,
    - `filename`: `fusion-{roomId}-{roundId}-{hash}.webp` (keine Personen-Namen!),
    - `originalName`: `fusion.webp` (keine Lösung).
  - **Reproduzierbar:** deterministisch aus den beiden Quell-Bildern + fester
    Algorithmus-Version (in `derivedFromAssetIds` + `engineVersion`/`compositeAlgorithm`
    vermerkt). Kein Zufall, kein zeitabhängiges Verhalten.
  - **Persistiert einmal:** `gameImageAssetId` wird im Setup-Snapshot gespeichert;
    bei Rejoin/Reload/Resync/Restart wird es NICHT neu erzeugt — es wird nur
    referenziert (idempotent).
  - **Austauschbar:** Algorithmus hinter einer Funktion kapselt; späterer Morph
    ersetzt nur die Funktion (gleiche Signatur, gleiches Asset-Modell).
- **Fremd-ID-Schutz:** Beim Raumerstellung/Composite-Aufruf werden beide
  `personAImageAssetId`/`personBImageAssetId` geprüft: `uploadedBy == hostUserId`,
  `type == 'image'`, `processStatus == 'READY'`, existiert. `gameImageAssetId`
  muss zu genau diesen beiden Quellen gehören (`derivedFromAssetIds` match).

### E. Setup-Validierung & Engine
- `rooms.ts` / `engine.initialize`: v2-Setup-Prüfung (siehe D).
- `resync.ts`: v2-Projektion — `imageAssetId` = `gameImageAssetId` (v2) bzw.
  `imageAssetId` (v1). Vor Reveal: nur `gameImageAssetId` (v2) / `imageAssetId` (v1).
  Nach Reveal: + `personAName`/`personBName` (+ `person1`/`person2` aus v1).
- **Keine** neue Punkte-/Rollenregeln. Buzz/Judge/Hint/Reveal/Next/Score/Rejoin
  bleiben identisch.

### F. Host-als-Player (Setup-Konflikt, §2.2)
- **Kein** „fairer“ Host-als-Player-Modus mit Composite: Wer die Originale + Namen
  eingegeben hat, kann nicht blind mitraten.
- **Sperre:** Wenn der Host als Player mitspielt, zeigt die Host-UI einen Hinweis
  und der Host wird in der Runde **automatisch ausgeschlossen** vom Buzzern
  (oder: das Spiel wird ohne Host-Partizipation gespielt).
- **Dokumentiert** in `docs/wer-ist-das.md` + PR-Beschreibung.
- **Kein** „reines Client-Verstecken“ — die Geheimhaltung ist serverseitig.

### G. Versionierung & Migration
- `setupSchemaVersion` (wer-ist-das): **1 → 2**. Begründung: Das Setup-Feld ist
  backward-incompatible erweitert (neue Runden tragen v2-Felder; alte Runden tragen
  v1-Felder). Der Reader muss beide lesen (kein stiller Umschreib).
- `engineVersion` (State): **1 → 2**. Begründung: Die Projektion ändert sich
  (v2 liefert `gameImageAssetId` als `imageAssetId`); der State selbst ändert
  sich nicht (Zähler/Phasen), aber die Engine-Logik (Setup-Lesen, Composite-
  Referenz) ist neu. `engineVersion` wird beim `upsertGameState` gesetzt.
- **Migration:** Neue Prisma-Migration für `MediaAsset` (`derivedFromAssetIds`,
  `processStatus`). Additiv, keine Datenänderung. `setupSchemaVersion` in
  `GameDefinition` wird via Seed/`upsert` auf 2 gesetzt (oder Migration).
- **Recovery:** Laufendes Spiel wird mit dem gepinnten State + denselben
  Bild-IDs wiederhergestellt. Unsicherer Migrationszustand → pausieren
  (`ERROR_RECOVERY`), nicht falschen State erzeugen.

## 3. Etappenplan (überprüfbare Commits)

1. **Etappe 1 (diese Doku + Bestandsaufnahme):** `pr11-handoff.md` mit Ist/Soll-Matrix,
   Design-Entscheidungen, Etappenplan. → Commit.
2. **Etappe 2 (Medienrechte/Upload):** `media.ts` schärfen (GET-Zugriffspolitik,
   Cache-Header, Upload-Validierung via sharp, Dedupe, Metadaten-Strip, `processStatus`),
   Prisma-Schema erweitern (`derivedFromAssetIds`, `processStatus`), Migration,
   Tests (Media-Integration). → Commit.
3. **Etappe 3 (Composite/Modell):** `createGameImage()` (sharp, deterministisch),
   Setup-Schema v2 (`contracts.ts`), Validierung (fremde IDs, Typ, Status, Quellen-
  zuordnung), Engine `initialize` v2, `resync.ts` v2-Projektion. → Commit.
4. **Etappe 4 (Setup-UI/Engine/Recovery):** `WerIstDasSetupPage` (2 Bilder + Namen +
   Vorschau + Status), `WerIstDasGamePage` (v2-Image-Rendering), `useWerIstDas`
   (v2-View), Rejoin/Recovery (engineVersion, State-Pinning), Host-als-Player-Sperre.
   → Commit.
5. **Etappe 5 (Tests/Doku/PR):** Alle Tests (Upload, API-Zugriff, Setup-Validierung,
   Geheimhaltung, Spielintegration, Migration), `docs/wer-ist-das.md`, Medien-Doku,
   Setup-Vertrag, PR-Beschreibung, CI grün, Draft-PR. → Commit + PR.

## 4. Offene Risiken / Entscheidungen

- **Keine** Grundsatzfragen offen (Regelwerk §17 deckt alles).
- **Einzige** mögliche Rückfrage: ob `visibility` der Fusion `ROOM_TEMP` oder
  `PRIVATE` sein soll. **Entscheidung:** `ROOM_TEMP` (§7.3: spontane Uploads,
  Host kann übernehmen; wer-ist-das-Runden sind „spontan“). Nach Game-Ende
  wird `roomId` gesetzt, damit Cleanup weiß, dass es zum Raum gehört.
- **Kein** externer Bilddienst, keine KI — `sharp` serverseitig (entfällt
  Browser-Bildverarbeitung + Storage-Abhängigkeit).

## 5. Logbuch (Chronik, nach jeder Etappe ein Eintrag)

### Etappe 3 — Composite/Fusion + Setup-Schema v2 + Engine/Resync/Geheimhaltung (fertig, wartet auf Commit/Push)
Geändert/neu:
- `apps/server/src/games/weristdas/composite.ts` (neu): `createGameImage()` — echtes,
  reproduzierbares Fusion-Bild: beide Originale center-crop 1024×1024, B als 50%-Alpha-Crossfade
  über A (verlustfreies PNG-Overlay → WebP), **deterministisch** (crossfade-v1), `derivedFromAssetIds`
  = [A,B], `visibility ROOM_TEMP`, `processStatus READY`, Filename `fusion-<round>-<digest>` (KEINE
  Lösung). Idempotent über sha256 (gleiche Quellen+Algo → gleiche Asset-ID, keine Duplikate).
  Ownership-/Typ-/Status-/Existenz-Check pro Quelle; identische A/B abgelehnt (`SOURCES_MUST_DIFFER`);
  Fehler → `COMPOSITE_FAILED` + Datei-Cleanup (keine Orphan/Geheimdatei). Algorithmus hinter einer
  Funktion gekapselt → späteres Morphing tauscht nur `createGameImage()`.
- `apps/server/src/http/media.ts`: `POST /api/v1/media/composite` (Host-Session, prüft Raum-Eigentum
  wenn roomId), Fehler-Mapping (404/400/500) mit verständlichen deutschen Meldungen, liefert
  `gameImageUrl` (Signed, audience `game`).
- `apps/server/src/games/weristdas/contracts.ts`: Setup-Schema v2 — `setupVersion` 1|2,
  `WerIstDasRoundV2` (`personAImageAssetId`, `personBImageAssetId`, `gameImageAssetId`,
  `personAName`, `personBName`, `aliasesA?`, `aliasesB?`), `isV2Round()`, `normalizeRound()`
  (→ `imageUrlAssetId` = freigegebenes Spielbild, `secretAssetIds` = Originale), `WER_IST_DAS_ENGINE_VERSION=2`.
- `apps/server/src/games/weristdas/engine.ts`: `validateSetup()` serverseitig (Eigentum, Typ, READY,
  (v2) Spielbild gehört zu GENAU den beiden Quellen via `derivedFromAssetIds`), `initialize()` pinnt
  `engineVersion` + validiert → `INVALID_SETUP` → `game.ts` rollt LOBBY→RUNNING zurück (kein halb
  gestartetes Spiel).
- `apps/server/src/games/weristdas/resync.ts`: v2-Rollenprojektion — Player/Viewer/Display erhalten
  vor Reveal NUR das freigegebene Spielbild (`imageAssetId` + `gameImageUrl` = Signed `game`-URL),
  KEINE Namen/Original-IDs/Original-URLs; Host erhält zusätzlich `hostImageUrls` (Signed `host`-URLs
  der Originale, nur mit Host-Session ladbar). Nach Reveal: Namen für alle (das ausdrücklich
  Freigegebene). `storagePath`/`originalName`/rohe Secret-IDs nie in der Projektion.
- `apps/server/src/http/rooms.ts`: `POST /:code/join` — **Host-als-Player-Sperre** (Regelwerk §2,
  Arbeitsauftrag §2C): wer die Bilder/Namen selbst eingegeben hat, wird serverseitig als Player
  in der eigenen wer-ist-das-Runde abgelehnt (`HOST_CANNOT_PLAY_OWN_ROUND`, 403). Anonyme Player
  (ohne Login = fairer Modus) sind nicht betroffen. Client-seites Verstecken würde den Wissensvorteil
  NICHT lösen → daher harte Sperre, kein „fairer Host-als-Player-Modus".
- `packages/shared/src/index.ts` + `prisma/seed.ts` + Konsistenz-Tests: wer-ist-das
  `setupSchemaVersion` 1→2, Beschreibung/Begründung auf die Fusion aktualisiert (Seed ↔ Manifest
  deckungsgleich, `catalog-consistency` + `seed-partial-db` angepasst).
- Neue Tests: `composite.test.ts` (5: echtes gespeichertes 1024²-Composite mit Quelle + nicht-Kopie,
  Idempotenz, Fremd-ID/Ownership, identische A/B, Fehler-Cleanup ohne Orphan) und
  `fusion.integration.test.ts` (4: v2-Rolle-Geheimhaltung + Full-Round, Reconnect/Recovery mit
  pinned `engineVersion` + nicht-neu-erzeugtem Composite, 3× Invalid-Setup-Rollback, Host-als-Player-Block).

Teststand (CI-Reihenfolge): prisma generate ✅ · migrate deploy ✅ · `pnpm typecheck` ✅ (0) ·
`pnpm lint` ✅ (0 errors / 97 pre-existing warnings) · `pnpm build` ✅ · `pnpm --filter @quiz/server test`
→ **228/228 grün** (v1-`socket-flow`-Regression 3/3 + `media` 14/14 + `catalog-consistency` 26/26 +
`seed-partial-db` 2/2 + neue `composite` 5/5 + `fusion` 4/4, u. a.).
Bemerkung: Test-Pool `vmForks` + `isolate:false` teilt `globalThis.__prisma` worker-weit → beide neuen
Test-Dateien sichern den vorherigen Prisma-Client und stellen ihn in `afterAll` wieder her
(sonst erbt eine spätere Datei im selben Worker die geschlossene Temp-DB).

### Etappe 2 — Medienrechte + sichere Upload-Verarbeitung (fertig, gepusht)
Geändert:
- `prisma/schema.prisma` + Migration `20261005211743_add_media_derived_from_and_process_status`:
  `MediaAsset.derivedFromAssetIds` (JSON-Array, §7.5) + `MediaAsset.processStatus` (Default "READY", §7.7).
  Additive, kein Datenumschreiben; SQLite RedefineTable mit Daten-Kopie.
- `apps/server/src/config/index.ts`: `MAX_IMAGE_DIMENSION` (Default 4096).
- `apps/server/src/media/signedUrl.ts` (neue): HMAC-Signed-URLs (assetId|audience|exp, §10.8),
  `buildSignedMediaUrl`/`verifySignedAccess`, TTL 5 Min (game) / 60 Min (host).
- `apps/server/src/http/media.ts` (umgeschrieben):
  - GET-Zugriffspolitik: PUBLIC/SYSTEM offen (Geo bleibt funktionieren), sonst **nur** via
    Signed URL — audience `game` = freigegebenes Spielbild (ohne Login, für Player/Viewer/Display),
    audience `host` = Originale, zusätzlich mit Session + (uploader == user ODER user == Raum-Host).
    `Cache-Control: no-store` für private Inhalte (vorher `public, max-age=1y`!). `Content-Disposition`
    neutral, nie storagePath/originalName. 403 generisch (keine Leaks).
  - Upload: echter Content-Check (sharp `metadata()`, Format aus Bytes), EXIF-Orientation +
    Metadaten-Strip, WebP-Normalisierung (Bilder), Audio über Magic-Bytes (MP3/WAV/M4A/AAC/OGG)
    unverändert weiter; Limits: MAX_IMAGE_SIZE_MB + MAX_IMAGE_DIMENSION; Dedupe über sha256
    (gleicher Uploader → Asset wiederverwenden, sonst eigenes Asset, kein 500); Fehler → Datei-Cleanup,
    keine Orphan/DB-Zeile.
- `apps/server/src/http/media.integration.test.ts` (neu, 14 Tests): MIME-Spoofing 415 + Cleanup,
  valides PNG → WebP + width/height + READY, 401, Dedupe, PUBLIC offen, PRIVATE ohne/veraltete/
  foreign-Signatur 403, game-URL ohne Session 200 + `no-store`, host-URL mit/ohne Session,
  Raum-Host-Recht, Asset-Getausche 403, Header-Leaks, 404.

Teststand: `pnpm --filter @quiz/server typecheck` ✅ · `vitest run media.integration.test.ts` → 14/14 ✅
Offen: WID-Engine muss das freigegebene Spielbild künftig als Signed `game`-URL projizieren
(Etappe 3/4), sonst lädt die laufende MVP-GamePage nicht mehr (bewusst: alte offene URL ist weg).

### Etappe 1 — Bestandsaufnahme + Design (jetzt)
- Branch `feature/wer-ist-das-fusion-media` von `origin/main` (411a5b7) erstellt.
- `pnpm install` läuft (sharp etc.).
- Ist/Soll-Matrix + Design oben geschrieben.
- **Letzter Commit:** (nach Commit 1 unten)
- **Nächster Schritt:** Etappe 1 committen (diese Doku), dann Etappe 2 (Medienrechte/Upload) starten.
