# BASIS-STANDARDS: Rollen, Schemas, Rechte, Commands, Config, Manifest

> **Status: Draft-PR.** Diese PR wird **nicht** gemergt und **nicht** auf
> Ready-for-Review gesetzt, bis alle Auditpunkte 14-01 … 14-10 vollständig
> behoben und an echten Grenzen (Socket/DB/HTTP) mit Regressionstests belegt sind
> und Typecheck, Lint, Build, Server-/Web-Tests und die vollständige E2E am
> finalen Head (lokal und auf GitHub) grün sind. Jede Restrotmeldung trägt eine
> nachvollziehbare Ursache.

## Ziel

Einige Spiele nutzen weiterhin eigene `MODERATOR`/`PLAYER`-Stringlogik, eigene
Fehler-/Command-Formate und eigene Config-Felder. Dieses Paket legt eine
**gemeinsame, kanonische Grundlage** für Rollen, zentrale Schemas,
Berechtigungen, Command-Verträge und Konfiguration, die von **tatsächlich
gerouteten Flows** verwendet wird (kein totes Infrastruktur-Rig).

**Nicht in diesem Paket (bekannter Folgebereich, siehe Handoff):** volles
Team-/Room-Lifecycle, Co-Host-UI, Storage-GC, neue Engines. Sie werden nicht
still mitgeliefert und nicht als erledigt deklariert.

## Kernentscheidungen

### 1. Kanonische Rollen
`ADMIN, HOST, PLAYER, VIEWER, DISPLAY`. `MODERATOR` wird **einmalig** an der
Auth-/Bestands-/Socket-Grenze zu `HOST` normalisiert (`normalizeRole`,
`Object.create(null)` + finale Rollenmenge-Prüfung, Prototype-Keys → `null`).
Unbekannte Rollen → `null` (kein String-Cast, keine Rechte).

### 2. Zentrale Schemas & Manifest-Verträge
Eine gemeinsame `packages/shared`-Grundlage für `CommandEnvelope`,
`AppError`-Vertrag, `ConfigSnapshot`, Manifest- und Engine-Schema sowie das
**Contract-Testgerüst** (`verifyManifest`), das Manifests gegen Schema,
Engine-Version, Rollen, Berechtigungen und Befehle prüft.

### 3. Berechtigungen
Zentraler Permission-Guard (Rolle + Room-Mitgliedschaft + Game-Zustand,
zeitlich geordnet) + zentrales Authorization-Policy-Registry. **Revocation
wirkt sofort** — keine `hasRole`-Cache-Reste (Audit 14-06).

### 4. Command- & Fehlerverträge
Zentrales, validiertes `resolveCommandEnvelope` (`requestId`→`commandId`,
`expectedRevision`→`stateVersion`, `roomCode` ersetzt keine Membership).
**Widersprüchliche alte/neue Felder oder ungültige Werte → Ablehnung VOR der
Mutation** (keine Umleitung in einen Legacy-Pfad, Audit 14-03).
Fehler-Vertrag `AppError { code, messageKey, detail?, traceId?, data? }` +
`wireErrorToAppError`; bestehende Wire-Codes bleiben Client-seitig lesbar
(Kompatibilität, `compatibility.md` §5).

### 5. Zentrale Konfiguration
Ein konfigurierbarer `GameConfigRegistry` (keine zweite `GAME_TITLES`-Karte) +
`configSnapshot`-Schema + atomares `updateRoomConfig` (kein Partial-Commit,
Audit 14-05). **Engine-Version aus dem kanonischen Slug** gelöst, nicht mehr aus
dem DB-Slug (Audit 14-04: WID-Snapshot behauptete v1, der State war v2).

### 6. Receipt-/Recovery-Grundlage (Audit 14-02)
Ein `commandId` gehört zu genau einem Raum + einem Akteur. **Replay**
(gleiche Identität) liefert die gespeicherte Antwort (`replayed: true`);
**fremde** Identität → `COMMAND_CONFLICT` (keine fremden Ergebnisse/Rechte).
`FAILED` mit fortgeschrittener Revision → `COMMAND_STATE_ADVANCED` +
`resyncRequired`. Receipt-Statuswechsel sind **atomar mit der State-Mutation**
(`$transaction`), sodass kein „`RECEIVED` mit fortgeschrittener Revision“ mehr
entstehen kann.

## Abdeckung (tatsächlich geroutete Flows)

- **Rollen:** Auth-Login (REST+Socket), Bestands-Migration `20261010120000`
  (additiv, idempotent), Socket-Connect, Guard-Eingang.
- **Commands:** geprüfte Befehle in `room.ts`/`game.ts` (`room:kick`,
  `room:leave`, `room:pause`, `game:*`, WID `werIstDas:reveal`, …) über
  `resolveCommandContext` + Receipt-Wrapper.
- **Fehler:** `wireErrorToAppError` in `room.ts`/`game.ts` (Lifecycle +
  Game-Commands + Kick-Path), Legacy-Wire-Codes erhalten.
- **Config:** `room:create` (Snapshot aus Registry), `room:configure` (atomar),
  Start-Snapshots in `game.ts` (kanonische Engine-Version).
- **Manifests:** Contract-Check auf den registrierten Engines im Test (keine
  toten Manifest-Definitionen).

## Kompatibilität & Migration

- **Bestandswerte** (Raum-, State-, Score-, Rejoin-Token, Engine- und
  Setup-Schema-Versionen) bleiben erhalten. Migrationen sind **additiv**
  (neue Spalten nullable / `NOT NULL DEFAULT 0`), kein Umbauen vorhandener
  Zeilen. Vollständiger Legacy-Kontrakt-Überblick:
  `docs/implementation/pr14/compatibility.md`.
- **Wer-ist-das-Rejoin (Audit 14-08):** version-agnostischer Reader für
  `setupSchemaVersion 1` **und** `2`; inkompatible Version →
  `UNSUPPORTED_ENGINE_VERSION` (kein Crash, Raum ansonsten unverändert).
- **Bestands-Slugs:** `resolveCanonicalSlug` zur Laufzeit; optionale,
  versionierte + idempotente `migrateCanonicalSlugsOnStartup` (kollidierende
  Legacy-Definitionen → `HIDDEN`, keine Löschung/ID-Änderung).

## Tests & Evidenz (pro Auditpunkt)

Jeder der 10 Auditpunkte trägt einen gezielten Regressionstest auf der
**tatsächlichen** Fehlergrenze (Socket/DB/HTTP), kein Mock-Surrogat.
Zusammenfassung mit Test-Namen und Ergebnissen:
`docs/implementation/pr14/evidence/audit-14-results.md`. Migrationen werden
gegen **repräsentative Bestands-DBs** mit echtem `migrate deploy` geprüft
(`migration.deploy.test.ts`).

## Definition of Done (aus dem Audit-Beitrag)

- [ ] **Alle** 10 Auditpunkte 14-01 … 14-10 vollständig behoben und an echten
      Grenzen mit Regressionstests belegt.
- [ ] Typecheck, Lint, Build, Server-/Web-Tests und **vollständige E2E** am
      finalen Head (lokal + GitHub) grün; jede Restrotmeldung mit nachvollziehbarer
      Ursache.
- [ ] Abnahmedoku, `compatibility.md`, `handoff.md` und PR-Beschreibung
      konsistent; **nur belegte** Punkte als erledigt markiert.
- [ ] **PR bleibt Draft.** Kein Merge, kein Ready-for-Review.

## Nächste Schritte

Diese PR bleibt **Draft**, bis die Definition of Done erfüllt ist. Der
mergeblockierende Abhängigkeitspfad ist **PR12** (Regelwerk-Mapping +
V1-Spezifikation) — der Audit-Beitrag und das Handoff kennzeichnen diesen
Folgebereich ausdrücklich; er ist in dieser PR **nicht** erledigt.
