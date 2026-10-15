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
> **Audit-Korrektur (14-01; Datum 2026-10-15).** Die ursprüngliche Diagnose
> „vorbestehend/umgebungsbedingt, kein PR14-Regression" war **falsch** — der
> Audit-Beitrag reproduzierte es als **echte Token-Logik-Regression** (14-01):
> der WID-E2E-Ablauf „öffnen → buzz → falsch bewerten → **erneut öffnen**" wird
> vom alten, nie verbrauchten Intent-Token als Replay behandelt (State bleibt
> ROUND_READY statt BUZZ_OPEN) → der Browser-Wait bricht ab. Nach dem
> `emitCommand`-Token-Verbrauch (14-01-Fix) läuft **WID W1–W10 lokal grün
> (6,3 s)** — das bestätigt den Root-Cause. Die übrigen E2E (Geo G4-*, Jeopardy
> J1–J10) waren schon vor dem Fix grün und bleiben grün.

## Lokale Läufe nach BASIS-STANDARDS-Änderungen (finaler Stand, nach Audit-Fix)

| Prüfung | Befehl | Ergebnis |
|---|---|---|
| Typecheck (alle 5 Pakete) | `pnpm typecheck` | **0 Fehler** (shared, game-sdk, web, server, ui) |
| Lint | `pnpm lint` | **0 Fehler** (108 Vorab-Warnungen, u.a. bestehende `no-explicit-any`; keine neuen) |
| Build | `pnpm build` (server `tsc` + web `vite`) | ✓ (web: 175 Module, `built in ~1 s`) |
| Server-Tests (Migration+Seed+Vitest, nach `build`) | `pnpm --filter @quiz/server build` → `pnpm --filter @quiz/server test` | **325/325 passed, 37/37 Dateien** (Baseline 283 + 29 Abnahme-/Contract + 13 Audit-Regressionstests: `audit14.regression.test.ts` + `migration.deploy.test.ts`) — gegen frisch erzeugte Test-DB (CI-Flow) ×2 stabil |
| Web-Tests | `pnpm --filter @quiz/web test` | **61/61 passed, 7/7 Dateien** (Baseline 52 + 9 neuer `intentLifecycle.test.ts` (14-01)) |
| E2E (Chromium, frische E2E-DB) | `prisma migrate deploy` + `db:seed` → `playwright test --project=chromium` | **17/17** — WID W1–W10 **grün** (vorher Timeout, 14-01 behoben) |

### Neue Abnahme-/Contract-Tests (im PR enthalten)

| Datei | Tests | Ergebnis | Deckt ab |
|---|---|---|---|
| `persistence/migration.roles.test.ts` | 8 | 8/8 | A4/A5/A6 (Bestands-Fixtur, Idempotenz, Rejoin, UNKNOWN, DISPLAY-Leerpack) |
| `games/core/permissions.integration.test.ts` | 4 | 4/4 | B1–B4 (11 Rechte, Grant/Revoke auf verbundenem Socket, Guard, Secret≠Verwaltung) |
| `games/core/commandContract.integration.test.ts` | 6 | 6/6 | C1/C2/C4 (Envelope, Protocol-Gate, Replay seriell+parallel, Retry) |
| `games/core/config.integration.test.ts` | 3 | 3/3 | E1–E5 (Resolver 0/false, 7 Ebenen, LOCKED_AFTER_START, Start-Snapshot unveränderlich, Revision/CAS/No-op) |
| `games/contract/geo.contract.test.ts` + `jeopardy.contract.test.ts` | 4+4 | 8/8 | F5 (2 echte Engines, dieselbe `contractSuite`: Protocol, Authorization, Replay/CAS, Config-Snapshot) |

## CI-Root-Cause: `Error code 14` in den Contract-Tests (befunden + behoben)

Erster CI-Lauf (Head `529fdba`): **CI = failure** — `Server tests`-Step: die beiden neuen
Contract-Testdateien (`games/contract/{geo,jeopardy}.contract.test.ts`) scheiterten in `beforeAll`
mit `PrismaClientInitializationError … Error code 14: Unable to open the database file`
(304 passed, 8 skipped). Lokal zuvor grün — aber lokal gegen eine **bereits existierende** Test-DB.

**Root Cause (vorbestehende Test-Isolationslücke, von den neuen Tests erst exposed):**
`http/e2e-endpoints.integration.test.ts` überschreibt `process.env.DATABASE_URL` auf **Modul-Ebene**
(Zeile 72) dauerhaft auf eine eigene `mkdtemp`-Temp-DB (für die Production-Guard-App) und **restored
es nie**. Vitest läuft mit `pool:'vmForks', isolate:false` → ein gemeinsamer Worker, ein gemeinsamer
`process.env`. Der `afterAll` der Datei **löscht die Temp-DB**. Jede darauffolgende Testdatei, die
ihren Prisma-Client (lazy) aus `process.env.DATABASE_URL` auflöst — der lazy Singleton `prisma` und
die Contract-Tests — zeigt danach auf die **gelöschte** Datei → `Error code 14`. Ob das zuschlägt,
hängt von der Abschlussreihenfolge ab → **nichtdeterministisch** (je nach Lauf fiel Geo oder Jeopardy
oder keines aus; bei existierender DB fiel es nie auf).

**Fix (beide Seiten):**
1. `e2e-endpoints.integration.test.ts`: Ursprungs-`DATABASE_URL` + `NODE_ENV` werden vor der
   Override gesichert und im `afterAll` der Production-Suite wiederhergestellt (Isolation für die
   ganze Suite).
2. Abnahme-Tests (B/C/E + F-Contract): verwenden jetzt **eigene, dedizierte `PrismaClient`-Instanzen**
   auf `DATABASE_URL` und patchen den worker-weiten `globalThis.__prisma` nur für die eigene Laufzeit,
   mit Reset in `afterAll` (gleicher Muster wie `composite`/`fusion` — „eigener Client, toten
   Client nie hinterlassen"). Defense-in-Depth gegen `__prisma`-Verweihung.

**Nachweis:** voller CI-Flow (frische DB: `test-database.ts && seed && vitest run`) ×2 lokal:
**35/35 Dateien, 312/312 Tests, Contract-Tests 4+4 executed (nicht skipped)** — stabil.

## Migration

| DB | Befehl | Ergebnis |
|---|---|---|
| frisch | `migrate deploy` ×2 | ✓ (Idempotenz: zweiter Lauf = No-op; `migration.roles.test.ts`) |
| Bestandskopie (ADMIN/MODERATOR, Host-Teilnahme, aktive+beendete Räume, WID v1/v2, Sessions/Rejoin) | `migrate deploy` ×2 + Invarianten | ✓ (MODERATOR→HOST, ADMIN bleibt ADMIN, UNKNOWN unverändert=keine Rechte, Rejoin-Tokens erhalten; `migration.roles.test.ts` 8/8) |

## GitHub-CI / E2E am Head `38a8e3b` (historischer Stage-2-Head — vor Audit-Fix)

> **Hinweis (Audit-Korrektur 14-09):** `38a8e3b` ist der *historische* Stage-2-Head.
> Die E2E-Wertung „WID vorbestehend/umgebungsbedingt" unten war **falsch** — sie ist
> die Ursache der 14-01-Regression. Der **aktuelle** GitHub-Abgleich (CI + E2E)
> erfolgt am **finalen Audit-Fix-Head** nach Übernahme in
> `feature/pr14-foundation-standards`; das Ergebnis wird dort (und in
> `evidence/audit-14-results.md` Abschnitt GitHub) ergänzt.

- **CI (typecheck, lint, build, Server-Tests, Web-Tests): ✅ success** am exakt gleichen Head
  (Run 38321190533). Der rote Server-Test-Lauf vom Stage-2-Head `529fdba` (`Error code 14`,
  Root Cause oben) ist damit behoben und nachgewiesen.
- **E2E (Chromium): ausgeführt am gleichen Head — Job rot (damals):**
  - `W1-W10` (weristdas): **30 s-Timeout in beiden Versuchen** — *damals* als „vorbestehend"
    gedeutet; **tatsächlich** die 14-01-Token-Regression (Audit), nach dem Fix lokal grün.
  - `G4-6` (geo): **1. Versuch flaky** (`toBeVisible`-Timeout auf langsamer CI-Maschine),
    **Retry #1 grün** → Playwright-Retry, kein Funktionsfehler.
  - Die übrigen **16/18 E2E** (Geo G4-1..G4-5, Jeopardy J1–J10 — alle über die neuen
    Guard-/Receipt-/Envelope-Flows) **grün direkt**.
- **Fazit (historisch, `38a8e3b`):** CI grün; E2E rot wegen WID W1–W10 (damals falsch als
  „vorbestehend" deklariert — siehe Audit-Korrektur oben). Der WID-Fehler ist durch den
  14-01-Fix behoben; der finale GitHub-E2E-Lauf am Audit-Fix-Head ist der maßgebliche.

## Historische Nachweise (nur Beleg, nicht Neu-Assertion)

- PR11 Merge `d52fa52`, PR12 Merge `afef936`, PR13 Merge `3dba9ff` (alle auf main).
- Main-Run 38071998240 grün (historisch).
