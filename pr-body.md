# BASIS-STANDARDS — Kanonische Rollen, Rechte, Commands, Fehler, Config, Manifest + Contract-Tests

**⚠️ DRAFT — nicht mergen, nicht Ready-for-review.** Ich prüfe und merge selbst.

Arbeitspaket **BASIS-STANDARDS** (Roadmap-Planplatz „PR13: Globale Schemas Rechte und Konfiguration").
Basis: `main` @ `3dba9ff` (PR13-Merge). Gemergt vorab: PR11 `d52fa52`, PR12 `afef936`.

## Was das Paket schafft (gemeinsame Grundlage)

Kanonische Rollen/Begriffe, zentrale Schemas, feingranulare Berechtigungen, Command-/Fehlerverträge,
zentrale Konfiguration, Manifest-Verträge und ein wiederverwendbares Contract-Testgerüst —
sodass Wissensduell, Jeopardy und „Wer ist das?" danach auf einer gemeinsamen, getesteten Grundlage laufen.
Alle neuen Verträge sind in **tatsächlich gerouteten** HTTP-/Socket-/Frontend-Flows eingebunden
(nicht nur exportiert/typisiert).

## Abnahme A–F (alle VERIFIED, positiv + negativ belegt)

Details + Belege: `docs/implementation/pr14/acceptance.md` (jeweils Code-/Test-Ref) und
`docs/implementation/pr14/verification.md` (getrennt Lokal/CI/Historisch).

| Bereich | Kern | Beleg |
|---|---|---|
| **A** Rollen | `MODERATOR`→`HOST`; kanonisch `ADMIN,HOST,PLAYER,VIEWER,DISPLAY`; sichere versionierte Bestandsmigration (idempotent, Rejoin/intakt) | `migration.roles.test.ts` **8/8** |
| **B** Rechte | 11 Rechte zentral; Grant/Revoke wirkt **auch auf bereits verbundenem Socket**; Guard in allen kritischen Mutationen; Secret ≠ Verwaltung; kein generischer Host-as-Player | `permissions.integration.test.ts` **4/4** |
| **C** Commands | Envelope (`commandId`/`protocolVersion`/Revisions-erwartung) kompatible Abbildung `requestId/expectedRevision`; Replay/CAS: Duplicate → gespeicherte Antwort, **genau eine** fachliche Wirkung (seriell + parallel); Frontend: 1 Token pro Absicht | `commandContract.integration.test.ts` **6/6** |
| **D** Fehler | AppError-Vertrag (`code/messageKey/traceId`); Permission-Denials auf **Legacy-Wire-Codes** abgebildet (Engine `FORBIDDEN`/`NOT_IN_ROOM`, Lifecycle `UNAUTHORIZED`/`NOT_IN_ROOM`) → keine Breaks; kein Detail-Leak | Server-Suite + E2E |
| **E** Config | 7-Ebenen-Resolver (0/false/null erhalten); geroutetes `room:config:update`; `LOCKED_AFTER_START`; **unveränderlicher** Start-Snapshot (`gameSlug`+`engineVersion`); Revision/CAS + No-op + `REVISION_CONFLICT` | `config.integration.test.ts` **3/3** |
| **F** Manifest + Contracts | Manifest-Vollständigung + `normalizeManifest()` (Single Source of Truth); **wiederverwendbares Contract-Gerüst auf 2 echten Engines (Geo + Jeopardy)**: Protokoll, Autorisierung (Viewer-Denial negativ), Replay/CAS, Config-Snapshot | `games/contract/*` **8/8** |

## Volle Regression (finaler Stand, lokal)

| Check | Ergebnis |
|---|---|
| `pnpm typecheck` (5 Pakete) | ✓ 0 Fehler |
| `pnpm lint` | ✓ 0 Fehler (bestehende Vorab-Warnungen unverändert) |
| `pnpm build` (server `tsc` + web `vite`) | ✓ |
| Server-Tests (Migration+Seed+Vitest) | **312/312** (35 Dateien) — Baseline 283 + 29 neue Abnahme-/Contract-Tests |
| Web-Tests | **52/52** (6 Dateien) |
| E2E (Chromium) | **17/18** |

### CI-Isolations-Fix (Stage 3)

Der erste CI-Lauf am Stage-2-Head war **rot**: `Server tests` — die neuen Contract-Tests
(`Error code 14: Unable to open the database file`). Root Cause: **vorbestehende**
Test-Isolationslücke in `e2e-endpoints.integration.test.ts`, von den neuen Tests erst exposed:
Die Datei überschreibt `process.env.DATABASE_URL` auf Modul-Ebene (Temp-DB für die
Production-Guard-App) und stellt sie nie wieder her; ihr `afterAll` löscht die Temp-DB.
Da Vitest mit `vmForks, isolate:false` in einem gemeinsamen Worker läuft, zeigen alle
darauffolgenden Dateien, die ihren Prisma-Client lazy aus `DATABASE_URL` auflösen, auf die
gelöschte Datei. Fix: env-Restore in der Datei **+** dedizierte Prisma-Clients in den
Abnahme-Tests (B/C/E/F) als Defense-in-Depth. Nachweis: exakter CI-Flow (frische DB) ×2
lokal grün — 35/35 Dateien, 312/312 Tests.

### E2E: das eine rote (nicht PR-Regression)

`weristdas-e2e.spec.ts` › **W1-W10** schlägt isoliert **auf beiden Heads** fehl — Kontroll-Experiment:
gleicher Lauf auf Basis `3dba9ff` **und** auf diesem PR-Head → jeweils `Test timeout of 30000ms` bzw.
Browser-Context-Abbruch in der `finally`-Cleanup-Zeile (`:144:15`), **keine** Game-Logik-Assertion.
Ursache: der Test ist sehr schwer (4 Browser-Kontexte + 2 echte Sharp-Composites + Vite-Cold-Compile)
und überschreitet die 30 s-Grenze — die Test-Datei dokumentiert das selbst. Damit ist das eine rote
**vorbestehend/umgebungsbedingt**, **kein PR14-Regression**. Die übrigen 17 E2E (volle Geo G4-* +
volle Jeopardy J1–J10 — alle über die neuen Guard-/Receipt-/Envelope-Flows) sind grün.

## Bewusst nicht in diesem PR (gekennzeichneter Folgebereich)

Neue Game-Engines, volles Team-/Room-Lifecycle (→ TEAM-ROOM, Planplatz PR14 — bleibt offen),
Co-Host-Bedienablauf + Room-Settings-UI, neues Display-Bedienflow, Content-Pool/-Editor,
Events/XP/Statistik, Voice/Audio/Musik/Broadcast, UI-Redesign, Storage-GC (Receipt-/Asset-GC),
Hosting/Produktion. Kleine Änderungen in bestehenden Engines zur Integration **gehören dazu** und sind enthalten.

## Offene Punkte (ehrlich)

- **CI-Lauf am finalen (Stage-3-)Head:** steht **nach Push** in der PR (Draft, kein Merge). Der
  erste CI-Lauf (Stage-2) war rot (Root Cause + Fix oben); lokal ist der exakt gleiche CI-Flow
  (frische DB) ×2 grün (Server 312/312, E2E-Bestandteil der Web-Regression 52/52; Playwright-E2E 17/18, rotes WID = vorbestehend).
- Folgebereich wie oben — nicht als erledigt ausgegeben.

## Commits (Staging)

- Stage 1 `1097cb8`: Doku (Handoff/Acceptance/Verification) + Shared-Schemas + Rollen-Migration + Manifest-Split + `liveConfigJson`-Grundlage.
- Stage 2: Server-Kerne (Permission/Command-Receipt/Config/AppError), Guard- + Receipt-Integration in Geo/Jeopardy/WID + Game-Lifecycle, geroutetes `room:config:update`, Frontend-Envelope/Intent-Tokens, Abnahme-Tests A/B/C/E + Contract-Gerüst F (2 Engines), volle Regression + finale Doku.
- Stage 3 (dieser): CI-Isolations-Fix (`e2e-endpoints` env-Restore) + Test-Härtung (dedizierte Prisma-Clients in B/C/E/F-Abnahme-Tests) + finale Doku (CI-Root-Cause dokumentiert).
