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
| Wer ist das? | `wer-ist-das` | `weristdas` | AVAILABLE | ✅ |
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
  (E2E J1-J10, Integrationstests), `wer-ist-das` (E2E W1-W10, Socket-Flow).
  Genau diese drei haben einen echten `GameHandle` in der Engine-Registry.
- **PLANNED** = alle übrigen 15 Spiele: **kein** Engine-Handler.
  `isStartableSlug()` liefert `false`; Raumerstellung ohne Definition →
  `GAME_NOT_FOUND`. Die Registry enthält **keine** no-op-Placeholders.
- **BETA** = aktuell kein Spiel (Kategorie bleibt für dokumentierte
  offene Punkte bei einer bestehenden Engine).
- **HIDDEN** = intern; öffentlich nicht sichtbar (z. B. aus einer Kollisions-
  Migration resultierende Legacy-Definitionen).

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
- **Idempotent**: Jeder Schritt prüft seine Vorbedingung. Zweiter Lauf ist ein
  echtes No-op (geprüft per vollständigem Snapshot-Vergleich:
  `applied=false`, `changes=0`, keine neue Audit-Zeile).

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
`RoomGameState` wiederhergestellt werden. **Offener Punkt:** Wenn eine DB
gleichzeitig `geo`- **und** `wissensduell`-Definitionen enthält, verbleibt der
`RUNNING`-Raum nach der Kollisions-Migration korrekt an der kanonischen
Definition — dies ist getestet, ein *parallel laufender* Prozess (zwei Server
auf derselben DB) ist jedoch nicht unterstützt und wird als Betriebskonflikt
dokumentiert.

Fehlerbehandlung: Ein Migrationsfehler blockiert den Serverstart **nicht**
(wird prominent geloggt). Der Server kann trotzdem fahren, weil die
Runtime-`resolveCanonicalSlug()` Legacy-Slugs zusätzlich auflöst (Recovery-
Prinzip: besser lauten als falschen State erzeugen).

---

## 6. Kompatibilitätsregeln & Übergang (Legacy-Links)

- **Raumerstellung**: `POST /api/v1/rooms` mit Legacy-Slug (`geo`, `weristdas`)
  löst auf den kanonischen Slug auf → der Raum hängt an der kanonischen
  Definition (geprüft: Raum + `gameDefinition.slug` = kanonisch).
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

## 7. Verbleibende Kompatibilität (bekannte Grenzen)

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

- **Typecheck**: `pnpm typecheck` — alle 5 Pakete grün.
- **Lint**: `pnpm lint` — 0 Errors (verbleibende Warnungen sind
  Vorbestehendes `any`/`exhaustive-deps`).
- **Build**: `pnpm build` — Server (tsc) + Web (Vite) grün.
- **Server-Tests**: `190/190` grün (u. a. `catalog-consistency`,
  `canonicalSlugMigration` [Legacy/Idempotenz/Kollision/kanonisch],
  `rooms-canonical.integration`, `registry`, `rooms.integration`,
  Rate-Limiter, Geo-/Jeopardy-/Wer-ist-das-`socket-flow`).
- **Web-Tests**: `52/52` grün.
- **E2E (Playwright, Chromium)**: `18/18` grün — Geo G4-1…G4-6, Jeopardy
  J1…J10, Wer-ist-das W1-W10 (Setup, Buzzer, private Solution, Reload/Rejoin/
  Resync, Zuschauer-Rechte, Geheimhaltung).

### Neue Tests (dieser PR)

1. `apps/server/src/games/catalog-consistency.test.ts` — exakt 18 kanonische
   Einträge, keine Doppelungen/Legacy-Slugs, Legacy-Resolution, ehrlicher
   Status, API↔Shared-Übereinstimmung (games/categories/meta/redirects),
   Seed↔Katalog-Sync-Guard.
2. `apps/server/src/persistence/canonicalSlugMigration.test.ts` — Legacy-DB mit
   Fragepaketen/Participations/Scores + aktivem **und** abgeschlossenen Raum
   (IDs/Scores/Engine-Version/Status bleiben), **Idempotenz** (Snapshot-Vergleich,
   2. Lauf No-op), **Kollision** (kein Löschen, HIDDEN+Marker, No-op),
   kanonische DB (`applied=false`).
3. `apps/server/src/http/rooms-canonical.integration.test.ts` — neue Räume
   `wissensduell`/`wer-ist-das`, Legacy-Resolution (`geo`/`weristdas`),
   `GAME_NOT_FOUND` bei unbekanntem/geplantem Spiel, `401` ohne Session.

---

## 9. Konkrete offene Punkte (nicht in diesem PR)

- **Engine für weitere Spiele**: `song-quiz`/`imposter`/… sind PLANNED; ihre
  Engines (mit Buzzer/Judge/ScoreEvent-Contract) sind separate PRs.
- **Fusionbild-Generierung** für Wer ist das? (MVP nutzt manuelle
  Bild-Antworten) — folgt in einem eigenen PR.
- **Kollisions-Szenario im Betrieb** (zwei Server / manuelle Duplizierung):
  technisch behandelt, aber als Betriebskonflikt dokumentiert; kein
  automatisches Dedup zwischen laufenden Prozessen.
- **Historische `ScoreEvent`/`RoomGameState`** aus der Zeit *vor* PR #8/9
  mit evtl. abweichendem Format: Recovery nutzt `engineVersion`; ein
  Format-Downgrade-Weg ist nicht Teil dieses PRs.