# N4 — Abnahme (tatsächlich ausgeführte Prüfungen)

Base: `main` @ `7ce1a785206af69d72c7ff02d14ca188fc68a5f2` (N3-Merge). Branch `claude/new-session-t4thly`, PR [#33](https://github.com/joern211/quiz-platform/pull/33) (Draft). **Code-Head der Abschlussläufe: `292e003`** (letzter Produktcode-/Testcommit); `458916d` und spätere Commits ändern nur Dokumentation. Node v22.23.4, pnpm 9.12.0, Lockfile unverändert (`--frozen-lockfile`), keine neue Abhängigkeit, keine Migration.

## Lokal ausgeführt (Container; frische Test-DBs `/tmp/quiz-server-test.db` bzw. `/tmp/test-e2e.db`)

| Prüfung | Ergebnis |
|---|---|
| `pnpm typecheck` | 0 Fehler |
| `pnpm lint` | 0 Fehler, 109 Warnungen — identisch zur Base, keine aus neuen Dateien |
| `pnpm build` | erfolgreich |
| `pnpm --filter @quiz/server test` | **82 Dateien, 958 Tests bestanden**, 0 übersprungen (Base 881; +1 Audio-Regressionstest, +27 `voting.test.ts`, +49 `votingPoll.test.ts`) |
| `pnpm --filter @quiz/web test` | **39 Dateien, 373 Tests bestanden** (Base 321; +52 `VoteForm.test.tsx`) |
| `pnpm exec playwright test --project=chromium` (frische DB, wie CI) | **45 von 45 bestanden** (3,8 min) |
| `content.integration.test.ts` allein | 42 Tests bestanden (41 + Regressionstest); Dedupe-Erwartung 201 unverändert |
| Strip-only-Ladetest | `packages/shared/src/voting.ts` lädt in einem Node-Kindprozess (`--experimental-strip-types`) und validiert Stimmzettel; zusätzlich lädt `rate-limiter.integration` `dist/app.js` (importiert `voting.ts` über `errors.ts`) mit reinem Node — grün |
| Browser-Harness (Chromium) `apps/web/harness/n4-voting/check.cjs` | 48 Kombinationen (320/390/430/1280 px × hell/dunkel × 6 Akzente): kein Überlauf (`documentElement.clientWidth/scrollWidth`), keine abgeschnittenen Elemente, Abgeben-Button erreichbar, Buttons und Optionszeilen ≥ 44 px, keine Konsolenfehler. Tastatur **assertiert** (Exit-Status 1 bei jeder Abweichung; mit entferntem Enter-Schutz belegt fehlschlagend): nichts vorausgewählt, Fokusring 3 px, Pfeiltasten/Space ändern nur die Auswahl, Enter auf Radio sendet nichts, Tab verlässt die Gruppe zum Button, leerer Submit → Fehler + Fokus auf ersten wählbaren Radio + nichts gesendet, deaktivierte Optionen werden übersprungen, genau ein vollständiger Stimmzettel, Fokus danach auf der Statuszeile, danach gesperrt, Enthaltung nur als bewusste Auswahl, Pending/Bestätigt (Option und Enthaltung)/Gesperrt/Gesperrt-ohne-Bestätigung/Fatal schreibgeschützt. Screenshots (390/320 px, hell/dunkel) angesehen |
| `git diff --check origin/main` | sauber |

Die ERROR/WARN-Zeilen im Serverlog stammen aus bestehenden Negativtests.

## Remote-CI (GitHub Actions, PR #33)

| Head | Lauf | Ergebnis |
|---|---|---|
| `458916d` (Code `292e003`) | [41333519393](https://github.com/joern211/quiz-platform/actions/runs/41333519393) | `CI` **grün**, `E2E` **grün** (erster Anlauf, kein Re-run) |

Spätere Doku-Commits lösen weitere Läufe aus; der Lauf am letzten Head steht im PR (nicht im Repo, um keinen Doku-Regress zu erzeugen).

## Zählerableitung (aus echten Läufen)

- Server: 881 + 1 + 27 + 49 = **958**; Dateien 80 → 82.
- Web: 321 + 52 = **373**; Dateien 38 → 39.
- Browser: 45 unverändert (der N4-Harness ist **kein** CI-Gate).

## Neue Tests im Überblick

- `core/voting.test.ts` (27): Config (2/32/33 Optionen, gleiche Labels, gefährliche IDs, strikte Schlüssel auf beiden Ebenen, Textgrenzen, Parität zu N2/N3, Schlüssel/Kontext), Roster (Bounds 1/100/101, Duplikate, unbekannt, Kein-Choice, Pflichtfeld, Vorab-Bound bei 200 000 Einträgen, keine Eingabe-Echos), Stimmzettel (Option/Enthaltung, kein reservierter Abstain-String, Allowlist, fehlend/Typen/Mehrfach/Zusatzschlüssel/`__proto__`), Tally-Konsistenz (13 Manipulationen), JSON-Roundtrip, Strip-only-Ladetest.
- `core/votingPoll.test.ts` (49): atomare Stimme, Berechtigung, Allowlist (gesperrt/erlaubt), Scope inkl. zweitem Wahlgang, Frist/Pause/Ablauf, echter Schluss (leer, Nichtwähler bei laufendem Timer, idempotent), 25 beschädigte Zustände in allen Einstiegspunkten, Frozen-State, Auszählung (handgerechnet, 125 Belegungen gegen Orakel, Reihenfolgeunabhängigkeit, 0 Stimmen, nur Enthaltungen, Tie, Summeninvarianten, kein Live-Tally, Determinismus), Roundtrip, SDK-Replay, Legacy/N1/N2/N3, Bestandsengines, Wire-Codes, Fehler ohne Leaks, Projektion (10 Audiences, Freigaben getrennt, nach Freigabe keine Stimmzettel).
- `VoteForm.test.tsx` (52): Gruppe/Auswahl/Tastatur/Enter-Vertrag/Fokus, eigene Liste, Enthaltung, ungültige Props, N1-R1 (Sofortsperre, Echo, Retry, null/fremd), N2-R1/R2 (Lock vor und nach aktuellem Lock, bestätigte Option **und** Enthaltung, Lock ohne Bestätigung, ungültige Bestätigung), Kontext/zweiter Wahlgang, Re-Render/Theme/Akzent, geänderte Konfiguration, 2/32 Optionen.
- `content.integration.test.ts` (+1): Audio-Dedupe-Regression.

Rot/Grün: E3 (Statuszeile bei SUBMITTED ohne Daten) am Vorgängerstand rot, mit Korrektur grün; E1/E2 als Mutationen erst überlebend, nach Testergänzung erkannt (`review.md`).

## Grenzen

- Harness ist testseitig (liegt außerhalb `src/` und `index.html`, nie gebaut oder ausgeliefert), lokal ausgeführt, kein CI-Gate. Chromium-Emulation ist kein echtes iPhone/Safari.
- Keine Socket-/DB-/Neustart-/Rejoin-/Recovery-/Auth-Nachweise: es gibt keinen Verbraucher. Die Projektionstests sind Domainprojektionen.
- `@quiz/shared` hat kein eigenes Testskript; seine Logik wird über die Server-Suite geprüft.

## Harness reproduzieren

```bash
pnpm --filter @quiz/web exec vite --config harness/n4-voting/vite.config.ts   # Port 5199
node apps/web/harness/n4-voting/check.cjs [Ausgabeordner für Screenshots]
```
