# BASIS-STANDARDS — Verifikation (verification.md)

Alle Belege **getrennt**: Lokal / GitHub-CI / Historisch. „Lokal" = Worktree `~/quiz-platform-pr14`,
Node 22, pnpm 9.12.0, Basis-Head wie angegeben. Testzahlen sind **tatsächliche** Läufe, kein starres Soll.

## Baseline auf main `3dba9ff` (vor eigenen Änderungen)

| Prüfung | Befehl | Ergebnis |
|---|---|---|
| Server-Tests (Migration+Seed+Vitest) | `pnpm --filter @quiz/server test` | **279 passed / 1 failed / 3 skipped (283), 29 Dateien (2 failed)** |
| ↳ fehlend: rate-limiter integration | `src/http/rate-limiter.integration.test.ts` | „Server startup timed out" — startet `dist/app.js`; **`pnpm build` vorab nötig** (bekannte Projektbeschränkung). Nach `build` separat re-geprüft (Ergebnis unten). |
| ↳ fehlend: Geo-Test | (Details unten nach Einzellauf) | — |

> Baseline-Regel: Neue Fehler werden hier gegen diesen Stand abgeglichen. „Vorhanden" gilt nur mit diesem Beleg.

## E2E-Baseline (Chromium)

| Lauf | direkt bestanden | nach Retry | fehlgeschlagen | übersprungen |
|---|---|---|---|---|
| main `3dba9ff` (lokal, nach `build` + Browser) | — | — | — | — |

> Historisch (Auftrag): PR13-Feature-Lauf 38071538705 = 16 direkt, 2 nach Retry (J4, W1–W10). Main-Lauf 38071998240 grün. Diese Wiederholungen sind Ausgangsbefund, nicht als durchgehend stabil ausgegeben.

## Lokale Läufe nach BASIS-STANDARDS-Änderungen

(wird pro Teilziel ergänzt — Befehl, Head, Zahlen, relevante Logzeilen, Skips/Flakes)

## Migration

| DB | Befehl | Ergebnis |
|---|---|---|
| frisch | `migrate deploy` ×2 | (offen) |
| Bestandskopie (ADMIN/MODERATOR, Host-Teilnahme, aktive+beendete Räume, WID v1/v2, Sessions/Rejoin) | `migrate deploy` ×2 + Invarianten | (offen) |

## GitHub-CI / E2E am finalen Head

(offen — erst nach finaler Push; PR-Head = Remote-Head = geprüfter Head)

## Historische Nachweise (nur Beleg, nicht Neu-Assertion)

- PR11 Merge `d52fa52`, PR12 Merge `afef936`, PR13 Merge `3dba9ff` (alle auf main).
- Main-Run 38071998240 grün (historisch).
