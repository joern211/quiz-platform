# N3 — Abnahme (tatsächlich ausgeführte Prüfungen)

Base: `main` @ `b38df2bb665dc77c5a29d18156251046a31e1967` (N2 inkl. R1/R2; main-CI zum Merge: `CI` und `E2E` erfolgreich, Lauf [41321525563](https://github.com/joern211/quiz-platform/actions/runs/41321525563), unabhängig am 01.11.2026 abgerufen). Branch `feature/n3-ordering-foundation`. **Code-Head der Abschlussläufe: `a94025b`** (letzter Produktcode-Commit; spätere Commits ändern nur Dokumentation). Node v22.23.4, pnpm 9.12.0 (`packageManager`), Lockfile unverändert (`--frozen-lockfile`). Keine neue Abhängigkeit, keine Migration.

## Lokal ausgeführt (Container; isolierte frische Test-DBs `/tmp/quiz-final.db` bzw. `/tmp/test-e2e.db`)

| Prüfung | Ergebnis |
|---|---|
| `pnpm typecheck` | 0 Fehler |
| `pnpm lint` | 0 Fehler, 109 Warnungen — identisch zur Base, keine aus neuen Dateien |
| `pnpm build` (Server `tsc` + Web `vite build`) | erfolgreich |
| `pnpm --filter @quiz/server test` (frische DB) | **80 Dateien, 881 Tests bestanden**, 0 übersprungen (Base 818; +63 = 28 `ordering.test.ts` + 35 `orderingSubmission.test.ts`). Ein früherer Lauf auf wiederverwendeter DB zeigte einen Dedupe-Treffer in `content.integration` (kein Codefehler, siehe `review.md` E5) |
| `pnpm --filter @quiz/web test` | **38 Dateien, 321 Tests bestanden** (Base 276; +5 `NumberField.test.tsx`, +40 `OrderingForm.test.tsx`) |
| `pnpm exec playwright test --project=chromium` (frische DB, wie CI) | **45 von 45 bestanden** (3,8 min) |
| `git diff --check origin/main` | sauber |
| Strip-only-Ladetest | `packages/shared/src/ordering.ts` lädt in einem Node-Kindprozess (`--experimental-strip-types`) und führt `compareOrdering` aus; zusätzlich lädt der bestehende Test `rate-limiter.integration` `dist/app.js` (importiert über `errors.ts` den neuen Export) mit reinem Node (grün); `g2Restart`/`g4Restart` laden den Produktionspfad ebenfalls |
| Browser-Harness (Chromium) | `apps/web/harness/n3-ordering/check.cjs`: 48 Kombinationen (320/390/430/1280 px × hell/dunkel × 6 Akzente) ohne Überlauf (`documentElement.clientWidth/scrollWidth`), alle Buttons ≥ 44 × 44 px, Abgeben-Button erreichbar, keine Konsolenfehler; Tastatur: Fokusring `solid 3px`, drei Moves per Enter/Space/Enter, Fokus bleibt auf dem benutzten Button (auch am Rand), kein Wrap-around, Shift+Tab → „nach oben“, `__submits` nach Moves = 0, nach explizitem Abgeben genau eine vollständige Reihenfolge, Fokus danach auf der Statuszeile, Moves danach deaktiviert; Pending/Confirmed/Locked: alle Move-Buttons und Abgeben deaktiviert, bestätigte Reihenfolge `cc,aa,dd,bb` statt Startliste |

Die ERROR/WARN-Zeilen im Serverlog stammen aus bestehenden Negativtests (`STATE_INVARIANT_FAILED`, Asset-Repair).

## Zählerableitung (aus echten Läufen)

- Server: Base 818 (unabhängig bestätigt) + 28 `ordering.test.ts` + 35 `orderingSubmission.test.ts` = **881**; Dateien 78 → 80.
- Web: Base 276 + 5 N1-Regressionen (`NumberField.test.tsx`: 25 → 30) + 40 `OrderingForm.test.tsx` = **321**; Dateien 37 → 38.
- Browser: 45 unverändert (der N3-Harness ist **kein** CI-Gate, siehe Grenzen).

## Aufgeschlüsselte neue Tests

- `core/ordering.test.ts` (28): Config (2/12/13 Items, doppelte/gefährliche IDs, strikte Schlüssel auf beiden Ebenen, Textgrenzen, Paritätstest zur N2-Textpolicy, Identitäten), Permutation (alle 6 Permutationen, fehlend/fremd/doppelt/falsch typisiert/Version/Zusatzschlüssel/`__proto__`/Nicht-Plain-Objekte, Vorab-Größenbegrenzung bei 200 000 Einträgen, keine Eingabe-Echos, keine Aliase, doppelte Labels), Referenz (Strict/Gruppen, leer/überlappend/fehlend/unbekannt/Revision, anderer Item-Satz), Vergleich (Handwerte, alle 24 Permutationen + Histogramm, andere Richtung, Gruppenbereiche, unabhängiges Aufzählungsorakel für 6 Referenzen, Labels irrelevant, Determinismus/keine Uhr/kein Zufall, kontrollierte Fehler, Konsistenzprüfer), JSON-Roundtrip, Strip-only-Ladetest.
- `core/orderingSubmission.test.ts` (35): atomare Abgabe, Scope (Run, Runde, umgemischte/geänderte Items, andere Referenzrevision, Label-Änderung = gleicher Scope), Frist/Pause/Ablauf/Zeitvalidierung, Rundenlock (Teilnehmer ohne Record, leere Runde, laufender Timer, Idempotenz, Close vor Abgabe), abgeleiteter Status, Vergleichsübernahme (nur geschlossen, Fakten, keine Abgabe/nicht geprüft/0 Treffer, ohne Referenz, falsche Revision/ungültige Referenz/fremde Abgabe/alter Run/Zeit, Idempotenz, kein stilles Überschreiben, keine Punkte/Uhr/Zufall, keine Aliase), Roundtrip, 34 korrupte Zustände, SDK-Replay, falscher Scope/Version, manipulierte Permutation, Legacy/N1/N2-Abgrenzung, drei Bestandsengines ohne Sortier-Command, Wire-Codes, Projektion (Besitzer, Partner im Team, fremder Player, Host, Blind-Host, mitspielender Host-als-HOST, Viewer, Display; vor/nach Reveal; kein Orakel; nur öffentliche Config; Lösung nur nach Reveal; keine Aliase).
- `OrderingForm.test.tsx` (40): Liste/Positionen/Namen, Moves per Klick und Tastatur, kein Wrap, doppelte Labels, Fokus, genau ein `onSubmit` je Versuch, Sofortsperre (Doppelklick/Enter/spätes PENDING), Fokus nach Submit und nach retryable Fehler (E1), die drei N1-R1-Gegenfälle, Echo alter/aktueller Versuch, retry/fatal, `null`/fremdes Feedback, N2-R1/R2 (alter LOCKED mit/ohne Daten vor/nach Lock, Lock ohne Daten erhält Bestätigung, Lock ohne Bestätigung zeigt Entwurf, aktueller ACK nach altem, Kontextwechsel löscht Bestätigung, ungültige Bestätigung), Re-Render/Labeländerung/Items-Umordnung, geänderte Itemmenge (gleicher/neuer Kontext), Theme-/Akzentwechsel, strikte Config, ungültige Startlisten, 2/12 Items und lange Texte.
- `NumberField.test.tsx` (+5, N1-Vorarbeit): Reproduktion des Abschnitt-4-Fehlers, Lock ohne Bestätigung, alter ACK mit Wert, Kontextwechsel, späterer Wert ersetzt früheren.

**Rot/Grün N1-Fix:** Die Reproduktion am Stand `b38df2b` (unveränderte Komponente): `Expected value 5, Received 9`; mit dem Fix (`b72ac34`) grün; die vier Schutzfälle waren schon vorher grün (sie verhindern Regressionen).
**Rot/Grün E1 (Eigenprüfung):** `does not strand the keyboard …` am Stand `129ce34` rot, mit der Korrektur grün.
Mutationsnachweise: `review.md`.

## Browser-Harness reproduzieren

```bash
pnpm --filter @quiz/web exec vite --config harness/n3-ordering/vite.config.ts   # Port 5198
node apps/web/harness/n3-ordering/check.cjs [Ausgabeordner für Screenshots]
```

## Grenzen

- Der Harness ist testseitig (liegt außerhalb `src/` und `index.html`, wird nie gebaut oder ausgeliefert) und **kein CI-Gate**; er wurde lokal ausgeführt. Chromium-Emulation ist kein echtes iPhone/Safari.
- Keine Socket-/DB-/Neustart-/Rejoin-/Recovery-Nachweise: es gibt keinen Verbraucher. Die Projektionstests sind Domainprojektionen.
- Der Produktions-Web-Build bündelt die ungenutzte Komponente nicht (Tree-Shaking); die Pfadauflösung `@quiz/shared/ordering` ist durch Vitest (web/server), Typecheck, Lint, Vite-Dev (Harness) und Server-`tsc`/`dist/app.js` belegt.
- `@quiz/shared` hat kein eigenes Testskript; seine Logik wird über die Server-Suite geprüft.
