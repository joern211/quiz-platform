# BASIS-STANDARDS — Verifikation (verification.md)

Alle Belege **getrennt**: Lokal / GitHub-CI / Historisch. „Lokal\" = Worktree `~/quiz-platform-pr14`,
Node **26.7.0** (Hermes-Session), pnpm 9.12.0, Basis-Head wie angegeben. Testzahlen sind **tatsächliche** Läufe, kein starres Soll.
Lokale Server-/Web-Tests laufen gegen eine frische, geseedete SQLite-Test-DB (`/tmp/quiz-server-test.db`); E2E gegen `/tmp/test-e2e.db`.

## Baseline auf main `3dba9ff` (vor eigenen Änderungen)

| Prüfung | Befehl | Ergebnis |
|---|---|---|
| Server-Tests (Migration+Seed+Vitest) | `pnpm --filter @quiz/server build` → `pnpm --filter @quiz/server test` | **283/283 passed, 29/29 Dateien** (nach `pnpm --filter @quiz/server build`; ohne Build: `rate-limiter`-Startup-Timeout, da `dist/app.js` fehlt — bekannte Projektbeschränkung, nicht PR-fehler) |

> Baseline-Regel: Neue Fehler werden hier gegen diesen Stand abgeglichen. „Vorhanden\" gilt nur mit diesem Beleg.

## E2E-Baseline (Chromium)

| Lauf | direkt bestanden | nach Retry | fehlgeschlagen | übersprungen |
|---|---|---|---|---|
| main `3dba9ff` (lokal, nach `build` + Browser) | 17 | — | 1 (WID W1–W10, **identisch** wie auf PR-Head) | 0 |

> Historisch (Auftrag): PR13-Feature-Lauf 38071538705 = 16 direkt, 2 nach Retry (J4, W1–W10). Main-Lauf 38071998240 grün.
> **Kontroll-Experiment (final):** WID `W1-W10` (`weristdas-e2e.spec.ts`) wird isoliert auf **beiden** Heads
> (`3dba9ff` Basis **und** PR-Head `feature/pr14-…`) gegen eigene frische E2E-DBs ausgeführt. Beide Läufe schlagen
> fehl — `Test timeout of 30000ms exceeded` bzw. Browser-Context-Abbruch in der `finally`-Cleanup-Zeile
> (`weristdas-e2e.spec.ts:144:15`), **keine** Game-Logik-Assertion. Damit ist das eine rote E2E **vorbestehend /
> umgebungsbedingt** (4 Browser-Kontexte + 2 echte Sharp-Composites + Vite-Cold-Compile; die Test-Datei selbst
> dokumentiert, dass der kalte Erstlauf die 30 s-Grenze überschreitet) und **kein PR14-Regression**. Die übrigen
> 17 E2E (volle Geo G4-* + volle Jeopardy J1–J10 — alle über die neuen Guard-/Receipt-/Envelope-Flows) sind grün.

## Lokale Läufe nach BASIS-STANDARDS-Änderungen (finaler Stand)

| Prüfung | Befehl | Ergebnis |
|---|---|---|
| Typecheck (alle 5 Pakete) | `pnpm typecheck` | **0 Fehler** (shared, game-sdk, web, server) |
| Lint | `pnpm lint` | **0 Fehler** (104 Vorab-Warnungen, u.a. bestehende `no-explicit-any`; keine neuen) |
| Build | `pnpm build` (server `tsc` + web `vite`) | ✓ (web: 175 Module, `built in ~1 s`) |
| Server-Tests (Migration+Seed+Vitest) | `pnpm --filter @quiz/server build` → `pnpm --filter @quiz/server test` | **312/312 passed, 35/35 Dateien** (Baseline 283 + 29 neue Abnahme-/Contract-Tests) |
| Web-Tests | `pnpm --filter @quiz/web test` | **52/52 passed, 6/6 Dateien** |
| E2E (Chromium, frische E2E-DB) | `prisma migrate deploy` + `db:seed` → `playwright test --project=chromium` | **17/18** (1 rot = WID W1–W10, vorbestehend — siehe Kontroll-Experiment oben) |

### Neue Abnahme-/Contract-Tests (im PR enthalten)

| Datei | Tests | Ergebnis | Deckt ab |
|---|---|---|---|
| `persistence/migration.roles.test.ts` | 8 | 8/8 | A4/A5/A6 (Bestands-Fixtur, Idempotenz, Rejoin, UNKNOWN, DISPLAY-Leerpack) |
| `games/core/permissions.integration.test.ts` | 4 | 4/4 | B1–B4 (11 Rechte, Grant/Revoke auf verbundenem Socket, Guard, Secret≠Verwaltung) |
| `games/core/commandContract.integration.test.ts` | 6 | 6/6 | C1/C2/C4 (Envelope, Protocol-Gate, Replay seriell+parallel, Retry) |
| `games/core/config.integration.test.ts` | 3 | 3/3 | E1–E5 (Resolver 0/false, 7 Ebenen, LOCKED_AFTER_START, Start-Snapshot unveränderlich, Revision/CAS/No-op) |
| `games/contract/geo.contract.test.ts` + `jeopardy.contract.test.ts` | 4+4 | 8/8 | F5 (2 echte Engines, dieselbe `contractSuite`: Protocol, Authorization, Replay/CAS, Config-Snapshot) |

## Migration

| DB | Befehl | Ergebnis |
|---|---|---|
| frisch | `migrate deploy` ×2 | ✓ (Idempotenz: zweiter Lauf = No-op; `migration.roles.test.ts`) |
| Bestandskopie (ADMIN/MODERATOR, Host-Teilnahme, aktive+beendete Räume, WID v1/v2, Sessions/Rejoin) | `migrate deploy` ×2 + Invarianten | ✓ (MODERATOR→HOST, ADMIN bleibt ADMIN, UNKNOWN unverändert=keine Rechte, Rejoin-Tokens erhalten; `migration.roles.test.ts` 8/8) |

## GitHub-CI / E2E am finalen Head

(offen — erst nach finaler Push; PR-Head = Remote-Head = geprüfter Head; Draft-PR, kein Merge.)
Lokal am exakt gleichen finalen Stand: typecheck ✓, lint ✓, build ✓, Server 312/312 ✓, Web 52/52 ✓, E2E 17/18 (rotes WID = vorbestehend).

## Historische Nachweise (nur Beleg, nicht Neu-Assertion)

- PR11 Merge `d52fa52`, PR12 Merge `afef936`, PR13 Merge `3dba9ff` (alle auf main).
- Main-Run 38071998240 grün (historisch).
