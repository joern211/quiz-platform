# Kanonischer Spielekatalog & Slug-Migration

**Status:** Ausgeführt (PR „Kanonischer Spielekatalog und Slug-Migration")
**Basis:** `main` nach PR #9 · **Regelwerk:** MASTER-REGELWERK §5 (GameManifest, Engine-Versionierung, Migration), §12 (Konsistenz), §13 (DoD), §14 (Kanonischer Spielekatalog)

Ziel dieses PRs: Katalog, API, Website, Game-Registry und Datenbank verwenden
dieselben **kanonischen Spielidentitäten** und **ehrliche Verfügbarkeitsstatus**.
Bestehende Räume, Fragepakete, Ergebnisse und Abläufe bleiben bei der Umstellung
erhalten. Dieser PR schafft die Grundlage für weitere Spiele; er implementiert
**keine** neue Spiel-Engine.

---

## 1. Single Source of Truth

`packages/shared/src/index.ts` ist die EINE verbindliche Quelle für Slugs,
Anzeigennamen, Status und Legacy-Aliasse (Regelwerk §12.1). Server
(Catalog-API, Registry, Raumerstellung) **und** Web (Katalog, Kategorien,
Routen) importieren ALLE diese Daten. Es gibt keine doppelten Hardcodes mehr.

> WICHTIG: Der Katalog ist in `index.ts` **inline** eingebettet (kein separates
> `gameCatalog.ts`). `@quiz/shared` wird in der Produktion als
> TypeScript-Quelle konsumiert (`main`/`exports` → `src/index.ts`, von Node
> type-stripped). Nodes natives Type-Stripping löst **relative `.js`→`.ts`-Imports
> NICHT** auf – eine eigene Datei würde `node dist/app.js` brechen. Deshalb eine
> einzige Quelldatei mit nur bare-Module-Import (`zod`).

`prisma/seed.ts` läuft vom Repo-Root, wo `@quiz/shared` nicht aufgelöst werden
kann (pnpm verlinkt den Workspace-Import nur in `apps/*`/`packages/*`). Der Seed
ist daher selbstbelegt und wird über `catalog-consistency.test.ts` (Seed↔Katalog-
Sync-Guard) mit `@quiz/shared` abgeglichen.

---

## 2. Slug-Mapping-Tabelle (Regelwerk §14 „FESTGELEGT")

| Anzeigename | Kanonischer Slug | Legacy-Slug(s) → | Status | Startbar (Engine-Handler)? |
|---|---|---|---|---|
| Wissensduell | `wissensduell` | `geo`, `allgemeinwissen` | AVAILABLE | ✅ |
| Jeopardy | `jeopardy` | — | AVAILABLE | ✅ |
| Wer ist das? | `wer-ist-das` | `weristdas` | BETA | ✅ |
| Imposter | `imposter` | `wer-luegt`, `luegen` | PLANNED | ✗ |
| Erkenne den Song | `song-quiz` | `song`, `song-erraten` | PLANNED | ✗ |
| Last Man Standing | `last-man-standing` | — | PLANNED | ✗ |
| Higher or Lower | `higher-lower` | — | PLANNED | ✗ |
| Timeline | `timeline` | — | PLANNED | ✗ |
| Wie weit gehst du? | `partner-challenge` | — | PLANNED | ✗ |
| Stadt, Land, Fluss | `stadt-land-fluss` | — | PLANNED | ✗ |
| Gleicher Gedanke | `same-thought` | — | PLANNED | ✗ |
| Schätz mal | `schaetz-mal` | — | PLANNED | ✗ |
| Millionenfrage | `millionenfrage` | `wer-wird-millionaer` | PLANNED | ✗ |
| Wahr oder Fake? | `wahr-oder-fake` | `wahrheit-oder-fake` | PLANNED | ✗ |
| Undercover | `undercover` | — | PLANNED | ✗ |
| Raus damit! | `board-race` | — | PLANNED | ✗ |
| Geheim Agent | `secret-agent` | — | PLANNED | ✗ |
| Yacht | `yacht` | — | PLANNED | ✗ |

**Nicht als eigenes Game** (Regelwerk §14): `Allgemeinwissen` und `Geo` sind
**Content-Kategorien/Pools** in `wissensduell`; `Wer bin ich?` vorerst nicht
aufgenommen.

---

## 3. Slug vs. interner Name (bewusst NICHT migriert)

Ein **Spiel-Slug** ist die sichtbare Identität (DB, API, URL). Folgendes ist
**kein** Slug und bleibt unverändert (Regelwerk §5.23, §12.1):

- **Modulpfade**: `apps/server/src/games/geo/`, `games/weristdas/`, `games/jeopardy/`
- **Socket-Event-Namen**: `geo:resync`, `geo:answered`, `weristdas:buzzer:open`, `weristdas:buzz`, `jeopardy:*`
- **DB-Tabellen-/Modellnamen**: `GeoQuestion`, `RoomGameState`, `ScoreEvent`, `game_definitions`
- **Frage-IDs**: `geo-1` … `geo-5` (Content-IDs im Seed, keine Slugs)

Die Registry löst trotzdem Legacy-Slugs auf (`getGameHandler('geo')` → Handler
`wissensduell`), damit alte Räume/Links kontrolliert weiter funktionieren.

---

## 4. Ehrliche Verfügbarkeitsstatus (Regelwerk §13.1)

`AVAILABLE` **nur** wenn startbare Engine + vollständig getesteter Ablauf
existieren (E2E + Integrationstests, CI grün). Ableitung, nicht Label:

- **AVAILABLE** = `wissensduell` (E2E G4-*, Integrationstests), `jeopardy`
  (E2E J1-J10, Integrationstests). Beide haben einen echten `GameHandle` in
  der Engine-Registry und erfüllen die vollständige DoD.
- **BETA** = `wer-ist-das`: startbare, getestete Engine (E2E W1-W10,
  Socket-Flow), aber mit **dokumentierter nichtkritischer Einschränkung**:
  das MVP erzeugt **keine Fusionsbilder** (`docs/wer-ist-das.md` — folgt in
  einem eigenen PR); das Spiel läuft mit vorbereiteten Bildern. Regelwerk
  §13.1 verlangt für `AVAILABLE` die vollständige DoD-Erfüllung, daher ist
  der ehrliche Status `BETA` (startbar, Einschränkung dokumentiert) — nicht
  `AVAILABLE`.
- **PLANNED** = alle übrigen 15 Spiele: **kein** Engine-Handler.
  `isStartableSlug()` liefert `false`; Raumerstellung →
  `GAME_NOT_STARTABLE` (siehe §6). Die Registry enthält **keine**
  no-op-Placeholders.
- **HIDDEN** = intern; öffentlich nicht sichtbar (z. B. aus einer Kollisions-
  Migration resultierende Legacy-Definitionen). Raumerstellung gesperrt
  (§6).

Die früher als „AVAILABLE" gelabelten `song-erraten`/`timeline`/`luegen`
bestanden diese Prüfung nicht (keine Engine) → PLANNED.

---

## 5. Versionierte Datenmigration

Modul: `apps/server/src/persistence/canonicalSlugMigration.ts`
Version: `CANONICAL_SLUG_MIGRATION_VERSION = 1`. Läuft **beim Server-Start**
(`migrateCanonicalSlugsOnStartup`) und ist idempotent aufrufbar.

Eigenschaften (Regelwerk §5.22/§5.23):

- **Atomar** (ein `$transaction`), **versioniert** (Audit-Log-Zeile
  `canonical_slug_migration` mit `metadata.version`, nur bei Änderungen).
- **Idempotent**: Jeder Schritt prüft seine Vorbedingung. Schritt 3 (Manifest-
  Ausrichtung) vergleicht jede Definition über `slugMatchesManifest()` und
  schreibt **nur bei inhaltlicher Abweichung** → ein bereits ausgerichteter
  zweiter Lauf ist ein echtes No-op **ohne jedes `UPDATE`-Statement**:
  `applied=false`, `changes=0`, keine neue Audit-Zeile **und `updatedAt`
  aller 18 Definitionen unverändert** (nachgewiesen per Snapshot-Vergleich
  inkl. `updatedAt`, `canonicalSlugMigration.test.ts` →
  „bereits kanonische DB“).
  (Prisma 5.x setzt `@updatedAt` auch bei inhaltsgleichem Update-Call —
  empirisch verifiziert; deshalb expliziter Compare-before-write, nicht
  blindes `upsert`.) Dieselbe Technik nutzt jetzt auch `prisma/seed.ts`
  (zweiter Seed-Lauf = No-op, siehe §7).

**Normalfall** (nur Legacy vorhanden): `GameDefinition` wird per `slug`-
Update auf den kanonischen Slug umbenannt (ID bleibt stabil), Fragepakete
werden auf den kanonischen `gameSlug` umgeschrieben, Attribute werden an den
Manifest (Name/Kategorie/Status) ausgerichtet.

**Kollisionsfall** (alter UND neuer Slug gleichzeitig als `GameDefinition`):
**Kein Löschen.** Kinder der Legacy-Definition (`Room`, `SetupDraft`) werden
auf die kanonische Definition umgebunden, Fragepakete umgeschreiben, und die
Legacy-Definition bleibt **erhalten** (ID stabil), wird `HIDDEN` + mit Marker
`[slug-migrated]` versehen. Der Marker macht den zweiten Lauf zu einem No-op.

**Was NICHT angefasst wird:**

- **IDs & Relationen**: Bei einem reinen Rename bleibt `gameDefinitionId`
  unverändert → aktive UND abgeschlossene Räume verweisen automatisch korrekt.
- **Scores/Results**: `Participation.score`, `ScoreEvent` bleiben unverändert;
  historische `ScoreEvent`-Zeilen werden **nicht** umgeschrieben.
- **Engine-Version / State**: `RoomGameState.engineVersion`, `stateJson` und
  `setupSchemaVersion` bleiben unberührt → Recovery nutzt exakt dieselbe
  Engine (Regelwerk §5.21/§5.22).
- **Aktive vs. abgeschlossene Räume**: werden getrennt betrachtet — beide
  laufen über die stabile `gameDefinitionId`. Ein `RUNNING`-Raum bleibt
  `RUNNING`; ein `ENDED`-Raum bleibt `ENDED` (beides im Migrationstest
  abgedeckt).

**Aktive Spiele & State-Modell:** Eine Migration eines *aktiven* Spiels
während laufendem Spiel ist mit dem heutigen State-Modell **sicher**, weil der
In-Memory-Spielzustand an `roomId` hängt und die `GameDefinition-ID` beim
Rename unverändert bleibt; der Server-Start (Migration) findet kein aktives
In-Memory-Spiel, da diese beim Restart ohnehin via `restoreActiveTimers` /
`RoomGameState` wiederhergestellt werden.

**Kollisionsfall mit LAUFENDEM Raum — nachgewiesen (e2e):** Der kritische
Fall „DB enthält gleichzeitig `geo`- und `wissensduell`-Definition, der Raum
läuft auf der Legacy-Definition“ ist jetzt **end-to-end getestet**
(`canonicalSlugMigration.test.ts` → „Kollision mit LAUFENDEM Raum“): Raum mit
`RUNNING`-Status, `RoomGameState` (`engineVersion`, Setup-Snapshot) und
echtem Socket-Server; danach Kollisions-Migration und der komplette
Fortsetzungs-Nachweis über die **umgebundene** kanonische Definition:
Rejoin (Spieler per Rejoin-Token, Moderator per Host-Session-Cookie) →
`geo:resync` liefert Phase/Score → `geo:answered` wird akzeptiert und
autorisiert → `geo:timer`-Abfrage stimmt mit dem wiederhergestellten
Timer überein → Runde läuft zu `ENDED` mit korrektem Ergebnis/Score.
`RoomGameState.engineVersion` und `Room.setupSnapshotJson` bleiben während
der Umbindung unverändert. Das heißt: **laufende Räume werden nur dann
stillschweigend umgebunden, wenn die sichere Fortsetzung nachweislich
funktioniert** —
weil sie das tut (stabile `roomId` + `gameDefinitionId`-Umbindung, Engine-
Version und State unangetastet). **Nicht unterstützt** (Betriebskonflikt,
nicht migrierbar): zwei Server-Prozesse auf derselben DB parallel.

Fehlerbehandlung: Ein Migrationsfehler blockiert den Serverstart **nicht**
(wird prominent als `error` geloggt, inkl. Anzahl betroffener
`wissensduell`/`geo`-Räume; globaler Zustand über `isSlugMigrationDegraded()`
abfragbar). Der Server darf dann **keinen „sauberen“ Betrieb behaupten**,
fährt aber funktionsfähig weiter, weil **beide** zuvor alte Slugs ablehnenden
Punkte Legacy-Slugs auflösen:
- Autorisierung (`authorizeGameContext`): Raum-Slug und Client-Slug werden
  jeweils per `resolveCanonicalSlug()` normalisiert, bevor verglichen wird
  → ein Raum auf `geo` bleibt erreichbar, auch wenn der Client `geo` sendet.
- Timer-Restoration (`restoreActiveTimers`): filtert über
  `slugWithLegacy('wissensduell')` = `[wissensduell, geo]` →
  `RUNNING`-`geo`-Räume erhalten ihre Timer nach dem Start zurück.

Beides ist nachweislich getestet (`canonicalSlugMigration.test.ts` →
„Migrationsfehler“): injizierter Migrationsfehler bei einem bestehenden
laufenden `geo`-Raum → Server bleibt im Legacy-Kompatibilitätsbetrieb,
Autorisierung akzeptiert den Raum und der Timer wird wiederhergestellt
(Test-Hook `__activeTimerRoomIdsForTest()` zeigt den Raum als aktiv).
Recovery-Prinzip: besser lauten als falschen State erzeugen (Regelwerk §5.23).

---

## 6. Kompatibilitätsregeln & Übergang (Legacy-Links)

- **Raumerstellung — serverseitige Start-Sperre (neuer Server-Gate):**
  `POST /api/v1/rooms` akzeptiert `gameSlug` und/oder `gameDefinitionId`.
  Beide Aufrouten werden gegen die **Engine-Registry + ehrlichen
  Manifest-Status** geprüft (Regelwerk §13.1):
  - `gameSlug`: Legacy-Auflösung (`geo` → `wissensduell`) → unbekannter
    Slug → `400 GAME_NOT_FOUND`; Status `PLANNED`/`HIDDEN` **oder**
    fehlender Engine-Handler → `400 GAME_NOT_STARTABLE`.
  - `gameDefinitionId` (direkt): Definition wird aus der DB geladen — auch
    eine **in der DB existierende** PLANNED-/HIDDEN-Definition (z. B. wie
    nach dem echten Seed) wird abgelehnt: `GAME_NOT_STARTABLE`;
    nicht existierende ID → `GAME_NOT_FOUND`; fehlender Handler →
    `GAME_NOT_STARTABLE`.
  - AVAILABLE/BETA mit Handler (z. B. `wissensduell`, `wer-ist-das`) →
    `201`; Legacy-Slugs erzeugen Räume an der kanonischen Definition.
  (Nachgewiesen: `rooms-canonical.integration.test.ts` — 4 neue
  Gate-Tests, inkl. „geplantes Spiel MIT Definition wie nach Seed“ für
  beide Aufrouten und HIDDEN-Legacy-Definition.)
- **Registry**: `getGameHandler(legacy)` → kanonischer Handler.
- **Katalog-API**:
  - `GET /catalog/games/:legacySlug` → **301-Redirect** auf
    `/catalog/games/:canonicalSlug` (alte Links funktionieren kontrolliert).
  - `GET /catalog/games/:slug` (kanonisch) → Manifest; unbekannt → `404`.
- **Website-Routen**: `/moderator/vorbereitung/:gameSlug`, `/spiel/:slug`,
  `/raum/:code/...` etc. — `gamePaths.ts`/`App.tsx` halten kanonische Routen;
  für `wer-ist-das`/`weristdas` existieren Alias-Routen, die auf dieselbe
  Komponente zeigen (alte Links → kanonischer Pfad).
- **Rejoin/Resync/Reload**: laufen über die stabilen `roomId`/`rejoinToken`
  und `engineVersion`; von der Slug-Umstellung unberührt (E2E J7/W-Rejoin grün).
- **Rollenrechte & Secrets**: unverändert; E2E J9 (Lösung nicht in
  Player-DOM/Payload) und J8 (nur Moderator darf Feld öffnen/bewerten) grün.

---

## 7. Seed-Konvergenz auf bestehender DB (Regelwerk §14)

`prisma/seed.ts` verhält sich je nach DB-Zustand unterschiedlich
(nachgewiesen: `seed-partial-db.integration.test.ts`, fährt das **echte**
Seed-Script als Subprozess):

- **Spiel-Definitionen: immer konvergieren** (create/compare/update). Ein
  bereits existierender Eintrag wird **nur** aktualisiert, wenn sich eines
  der Katalog-Felder (Name, Kategorie, Status, min/maxPlayers,
  estimatedMinutes, hasBuzzer/hasTeams/hasCamera/hasAudio/hasTimer,
  shortDescription/description) vom Seed unterscheidet. So wird z. B. ein
  alter `wer-ist-das`-Status `AVAILABLE` + alte Beschreibung auf `BETA` +
  MVP-BETA-Text konvergiert und ein fehlendes Spiel (unterbrochener Seed)
  nachgeholt. **Vergleichen vor Schreiben** (kein blindes `upsert`) —
  Prisma 5.x würde sonst `@updatedAt` auch bei inhaltsgleichem Update
  setzen (empirisch verifiziert).
- **Nutzer, Fragepaket, Demo-Fragen: nur bei NEUER DB**
  (`gameDefinition.count() === 0`). Ein Re-Seed überschreibt damit keinen
  bestehenden Content (eigene Pakete/Fragen bleiben erhalten).
- **Zweiter Seed-Lauf = No-op**: `updatedAt` aller 18 Definitionen bleibt
  unverändert (im Test per vor/nach-Snapshot verglichen).
- **Seed↔Katalog-Sync** wird über `catalog-consistency.test.ts`
  durchgesetzt: neben Slug/Status auch die Relevanzfelder
  (Name/Kategorie/Player/Zeit/Feature-Flags) **und** die
  `wer-ist-das`-Beschreibung müssen mit dem Manifest in `@quiz/shared`
  identisch sein — die DB darf nichts anderes behaupten als der Katalog.

**Upload-Testdateien:** `.gitignore` verankerte `storage/uploads/*` auf dem
Repo-Root, schreibt aber der Server unter `apps/server/storage`
(`STORAGE_ROOT=./storage` relativ zu `apps/server`) — die Regel traf daher
nie und Upload-Artefakte wurden committet. Fix: `apps/server/storage/
{database,uploads,backups}/*` (mit `.gitkeep`-Negation) zusätzlich
ignorieren; die zwei versehentlich committeten PNGs wurden entfernt.

---

## 7a. Verbleibende Kompatibilität (bekannte Grenzen)

- `GeoSetupPage` (alte, ungeroutete Legacy-Seite) bleibt als Datei erhalten,
  ist aber nicht mehr verlinkt — das Geo-Setup läuft über die generische
  `ModeratorSetupPage` auf `/moderator/vorbereitung/wissensduell`.
- `weristdas`-Socket-Event-Namen und `games/weristdas/`-Modulpfad bleiben
  (siehe Abschnitt 3) — Migration wäre nur bei einer Protokolländerung nötig.
- Interne `test-helpers`-Funktionen (`getOrCreateGeoGame`) erzeugen zeitgestempelte
  Test-Definitionen und sind von der Slug-Migration unabhängig.
- Parallel laufende Serverprozesse auf derselben SQLite-DB sind nicht
  unterstützt (Betriebskonflikt, oben Abschnitt 5).

---

## 8. Test- & Verifikationsstand (lokal)

- **Typecheck**: `pnpm --filter @quiz/{shared,server,web} typecheck` — grün.
- **Lint**: `pnpm lint` — **0 Errors** (97 Vorbestehende Warnungen,
  `any`/`no-console`/`exhaustive-deps`).
- **Build**: `pnpm build` — Server (tsc) + Web (Vite) grün.
- **Server-Tests**: `204/204` grün (23 Dateien; `pnpm --filter @quiz/server
  test`).
- **Web-Tests**: `52/52` grün (6 Dateien; `pnpm --filter @quiz/web test`).
- **E2E (Playwright, Chromium)**: `17/17` grün für die relevanten Specs —
  Geo G4-1…G4-6, Jeopardy J1…J10, Wer-ist-das W1-W10 (Setup, Buzzer,
  private Solution, Reload/Rejoin/Resync, Zuschauer, Geheimhaltung).

### Neue / erweiterte Tests (dieser PR)

1. `apps/server/src/http/rooms-canonical.integration.test.ts` — **4 neue
   Server-Gate-Tests**: geplantes Spiel **mit** DB-Definition (wie nach
   Seed) → `GAME_NOT_STARTABLE` über `gameSlug` **und** `gameDefinitionId`;
   HIDDEN-Legacy-Definition → `GAME_NOT_STARTABLE`; AVAILABLE mit Handler →
   `201`. (Bestehend: `wissensduell`/`wer-ist-das`-Räume, Legacy-Resolution,
   `GAME_NOT_FOUND` bei unbekanntem/geplantem Spiel, `401`.)
2. `apps/server/src/persistence/canonicalSlugMigration.test.ts` — erweitert:
   **Migrationsfehler** bei bestehendem **laufendem `geo`-Raum** (Legacy-
   Kompatibilitätsbetrieb bleibt funktionsfähig: Autorisierung akzeptiert den
   Raum, `restoreActiveTimers` restauriert den Timer — via
   `__activeTimerRoomIdsForTest()`), und **Kollision mit LAUFENDEM Raum e2e**
   (Rejoin → Resync → `geo:answered` → Timer → `ENDED`/Ergebnis;
   `engineVersion` + Setup unverändert). Bestehend: Legacy-DB, Idempotenz
   (Snapshot inkl. `updatedAt`), Kollision (kein Löschen), kanonische DB.
3. `apps/server/src/persistence/seed-partial-db.integration.test.ts` — **neu**:
   reales Seed-Script auf bestehender teilgefüllter DB (Definitionen
   konvergieren, Nutzer/Content bleiben, 2. Lauf No-op per `updatedAt`) +
   frische DB (vollständiger Seed).
4. `apps/server/src/games/catalog-consistency.test.ts` — erweitert:
   Seed↔Katalog über **Relevanzfelder** (Name/Kategorie/Player/Zeit/Features)
   **und** die `wer-ist-das`-Beschreibung; `wer-ist-das` = BETA.

---

## 9. Konkrete offene Punkte (nicht in diesem PR)

- **Engine für weitere Spiele**: `song-quiz`/`imposter`/… sind PLANNED; ihre
  Engines (mit Buzzer/Judge/ScoreEvent-Contract) sind separate PRs.
- **Fusionbild-Generierung** für Wer ist das? (MVP nutzt vorbereitete
  Bilder) — folgt in einem eigenen PR; bis dahin ist der ehrliche Status
  `BETA` (Abschnitt 4), nicht `AVAILABLE`.
- **Kollisions-Szenario im Betrieb** (zwei Server / manuelle Duplizierung):
  technisch behandelt, aber als Betriebskonflikt dokumentiert; kein
  automatisches Dedup zwischen laufenden Prozessen.
- **Historische `ScoreEvent`/`RoomGameState`** aus der Zeit *vor* PR #8/9
  mit evtl. abweichendem Format: Recovery nutzt `engineVersion`; ein
  Format-Downgrade-Weg ist nicht Teil dieses PRs.