# PR11 Handoff — „Wer ist das?“ mit Composite-Bild und geschütztem Medienzugriff

> Fortschrittsdatei für Chat-Abbruch-Sicherheit. Nach JEDER Etappe aktualisieren:
> Basis-Commit, letzter Commit, erledigte Dateien, Tests + Ergebnis, offene Fehler,
> nächster konkreter Schritt. Keine Tokens/Passwörter/privaten Bilder/Log-Inhalte.

## Status-Übersicht (lebendig halten)

- **Basis-Commit:** `411a5b783e5857bca5b208598fade43affc108b5` (PR #10, verifiziert = origin/main)
- **Branch:** `feature/wer-ist-das-fusion-media`
- **Letzter Commit:** —
- **Etappe:** 1/5 (Bestandsaufnahme/Design)
- **PR:** —
- **Tests:** —
- **Nächster Schritt:** —

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

### Etappe 1 — Bestandsaufnahme + Design (jetzt)
- Branch `feature/wer-ist-das-fusion-media` von `origin/main` (411a5b7) erstellt.
- `pnpm install` läuft (sharp etc.).
- Ist/Soll-Matrix + Design oben geschrieben.
- **Letzter Commit:** (nach Commit 1 unten)
- **Nächster Schritt:** Etappe 1 committen (diese Doku), dann Etappe 2 (Medienrechte/Upload) starten.
