# N2 — Abnahme (tatsächlich ausgeführte Prüfungen)

Base: `main` @ `d634e3eee3c228934ee3f8b11d01a45db66eebec` (N1 inkl. R1; main-CI-Job `CI` grün, Lauf 41306849919; der dortige `E2E`-Job lief beim Start noch und wird hier nicht als grün behauptet). Branch `feature/n2-multifield-foundation`. **Code-Head der Abschlussläufe: `b9e8928`** (letzter Produktcode-Commit, R1/R2-Nachbesserung nach unabhängigem Review; vorheriger Code-Head `a9b71c5`; `de2ff6e` und spätere Commits ändern nur Dokumentation). Node v22.23.4, pnpm 9.12.0 (`packageManager`), Lockfile unverändert (`--frozen-lockfile`). Keine neue Abhängigkeit, keine Migration.

## Lokal ausgeführt (Container, isolierte Test-DBs `/tmp/quiz-server-test.db`, `/tmp/test-e2e.db`)

| Prüfung | Ergebnis |
|---|---|
| `pnpm typecheck` | 0 Fehler |
| `pnpm lint` | 0 Fehler, 109 Warnungen — identisch zur Base, keine aus neuen Dateien |
| `pnpm build` (Server `tsc` + Web `vite build`) | erfolgreich |
| `pnpm --filter @quiz/server test` | **78 Dateien, 818 Tests bestanden, 0 übersprungen** (Base 763; +55 = 19 `textCard.test.ts` + 36 `textCardSubmission.test.ts`) |
| `pnpm --filter @quiz/web test` | **37 Dateien, 276 Tests bestanden** (Base 235; +41 `TextCardForm.test.tsx`: 32 vorherige + 9 zur R1/R2-Nachbesserung) |
| `pnpm exec playwright test --project=chromium` | **45 von 45 bestanden** (3,3 min) |
| `git diff --check origin/main` | sauber |
| `vitest list` | neue Testdateien werden von den Projekt-Testbefehlen erfasst (sie liefen in den Gesamtläufen) |
| Strip-only-Ladetest | `packages/shared/src/textcard.ts` lädt in einem Node-Kindprozess (`--experimental-strip-types`); zusätzlich lädt der bestehende Test `rate-limiter.integration` `dist/app.js` mit reinem Node (grün) |

Die ERROR/WARN-Zeilen im Serverlog stammen aus bestehenden Negativtests (`STATE_INVARIANT_FAILED`, Asset-Repair).

## Aufgeschlüsselte neue Tests

- `core/textCard.test.ts` (19): Config (1/12/13 Felder, doppelte/gefährliche IDs, strikte Schlüssel, Config-Identität), Leerwert-Semantik (null/leer/Whitespace/Auslassung/Typ), Struktur (Zusatzschlüssel, Prototypschlüssel, Mehrfachfehler, Umordnung, frisches Objekt), Textregeln (Code-Point-Grenzen, Gesamtgröße, Unicode/Umlaute/Emoji/kombinierte Zeichen, Trennzeichen verlustfrei, Steuer-/Bidi-/Surrogat-Zeichen), UI-Grenze, JSON-Roundtrip, Strip-only-Ladetest.
- `core/textCardSubmission.test.ts` (36): atomare Abgabe, Scope/Config, Frist/Pause, Rundenlock (inkl. Teilnehmer ohne Record, leere Runde, laufender Timer), abgeleiteter Status, Feldurteil (`cardRef`, Idempotenz, Abweisungen), Roundtrip, 20 korrupte Zustände, SDK-Replay (ohne Uhr/Zufall/Punkte), Legacy/N1-Kompatibilität, drei Bestandsengines, Projektion (eigener Player, Partner im Team, fremder Player, Host, Blind-Host, mitspielender Host, Viewer, Display, vor/nach Reveal), Matching-Adapter, Gruppierung.
- `TextCardForm.test.tsx` (41): Eingabe/Fehlerzuordnung/Fokus, Enter-/IME-Vertrag, genau ein `onSubmit` je Versuch, die drei N1-R1-Gegenfälle an der echten Karte, Echo alter/aktueller Versuch, `null`/fremdes Feedback, Reihenfolge im Versuch, LOCKED/fatal, Kontextwechsel, Feldumordnung mit stabilen IDs, Theme-/Akzentwechsel, 12 Felder, fünf Regressionen der Eigenprüfung sowie **neun Tests zu den Review-Befunden R1/R2** (Rundenlock: Echo-Zulässigkeit auch bei gehaltenem `LOCKED`, bestätigte Karte bleibt bei Sperre ohne `card`).

Mutationsnachweise (Server 11/11, Karte 6 + 6 zu R1/R2) und der Rot/Grün-Nachweis zu R1/R2 stehen in `review.md`.

**R1/R2 Rot/Grün (Web):** Die zwei Review-Tests, unverändert als eigene Datei am Stand `712781a` ausgeführt: beide rot (`Expected: angenommen / Received: nicht angenommener Entwurf`). Mit dem Fix (`b9e8928`) grün; in der offiziellen Suite schlagen am Stand `712781a` 6 der 9 neuen Tests fehl, mit dem Fix sind alle 41 grün.

## Browser-Nachweis der Antwortkarte (lokal, kein CI-Gate)

Reproduzierbarer, **nie ausgelieferter** Harness unter `apps/web/harness/n2-textcard/` (liegt außerhalb von `src/` und `index.html`, wird von keinem Build erfasst). Start und Prüfung:

```bash
pnpm --filter @quiz/web exec vite --config harness/n2-textcard/vite.config.ts   # Port 5199
node apps/web/harness/n2-textcard/check.cjs <ausgabeverzeichnis>                 # Playwright, Chromium
```

Ergebnis: **48 Kombinationen** (320/390/430/1280 px × Hell/Dunkel × 6 Akzente, Fälle: 3 Felder, 12 Felder mit langen Titeln/Hilfen, Fehler, Pending, Bestätigt, Gesperrt): kein horizontaler Überlauf (gemessen gegen `documentElement.clientWidth`/`scrollWidth`, nicht `window.innerWidth`), keine Steuerelemente rechts außerhalb, Felder/Buttons ≥ 44 px hoch, keine Konsolen-/Seitenfehler; im echten Browser: Fokusring 3 px, Enter springt zum nächsten Feld, Tab-Reihenfolge folgt der Config, Pending-Karte ist schreibgeschützt. Die Screenshots 320 px dunkel/lila und 1280 px hell/orange wurden angesehen (sauberer Umbruch, erreichbarer Button, klar unterscheidbare Zustände).

## Echte Grenzen (nicht behauptet)

- **Kein echter Engine-Verbraucher.** Kein Socket-, Auth-, CAS-, Receipt-, DB-/Neustart-, Rejoin-/Resync- oder Recovery-Nachweis für Karten. Die Domainfunktionen sind mit reinen Funktionen, JSON-Roundtrip und dem vorhandenen SDK-Replay getestet, nicht über einen Raum.
- Die Projektionen (Host-Blind, Partner, fremder Player, Viewer, Display, vor/nach Reveal) sind **Domainprojektionen**, kein Socket-/Rejoin-Nachweis.
- IME: nur synthetische Ereignisse in jsdom; kein Test mit echter IME auf einem Gerät.
- Der Browserlauf ist lokal und Chromium-Emulation, **kein echtes iPhone/Safari**; er ist nicht Teil der CI.
- Zwei-Engines-Kriterium Master §13.2: **nicht erfüllt**.

## CI am gepushten Head

- **Code-Head `b9e8928`** (R1/R2-Fix) wurde durch den folgenden Doku-Push (`de2ff6e`) per `concurrency` abgelöst; maßgeblich ist der Lauf am direkt folgenden Head mit **identischem Produktcode**: **Head `de2ff6e11cbef3ff0d4a6c2b084dcb80ba4aa987` (Code unverändert seit `b9e8928`): Jobs `CI` und `E2E` erfolgreich** — https://github.com/joern211/quiz-platform/actions/runs/41318729244 (Typecheck, Lint, Build, Server-/Web-Tests, Playwright chromium).
- Frühere Abnahme (vor der Review-Nachbesserung): Head `712781a`, Lauf 41309784980, grün — gilt **nicht** für den R1/R2-Code.
- Der Head des letzten Doku-Commits (diese Datei) ändert keinen Produktcode; sein CI-Ergebnis steht in der PR-Beschreibung (hier nicht fortgeschrieben, damit dieser Eintrag keinen weiteren Head erzeugt).
