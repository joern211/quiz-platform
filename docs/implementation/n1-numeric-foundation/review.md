# N1 — Getrennte Eigenprüfung

Zweiter Durchgang nach dem ersten grünen Stand: Auftrag und Diff erneut unabhängig vom Implementierungsablauf gelesen, Gegenfälle aktiv geprüft, Rechenwerte gegen handgerechnete Referenzen verglichen, Tests per Mutation auf Aussagekraft geprüft.

## Gegenfälle (Auftrag §14) und Ergebnis

| Gegenfall | Prüfung | Ergebnis |
|---|---|---|
| Leere Eingabe wird 0 | Parser-Tests; Mutation „leer = 0“ | abgelehnt (`NUMERIC_EMPTY`); Mutation vom Test erkannt |
| Dezimalverlust / Binärfloat | 0,1/0,2/0,3-Grenzen mit EXCLUSIVE/INCLUSIVE, Gegenbeispiel mit echten Float-Differenzen im Test | exakt; Float würde beide Grenzfälle falsch entscheiden |
| Overflow nur in der Zwischenrechnung | `MAX_SAFE_INTEGER`-Operanden, Extremwerte ±(10^15−1), 200 %-Fall, Kreuzmultiplikation ~10^18 | Operanden außerhalb des Vertrags → `NUMERIC_TOO_LARGE`; Extremwerte exakt (BigInt) |
| Negative/0-Zielwerte | Betrag als relative Basis; Ziel 0 → `UNDEFINED`, absolut weiter berechenbar | wie definiert |
| Falsch erlaubte Typen | Zahl, Boolean, Array, Objekt, `10n`, Funktion am Textparser; String/Zahl am Wire-Parser | `NUMERIC_WRONG_TYPE`, keine Coercion |
| Überpräzise Werte | `12,55`, `12,50`, `12,0` bei scale 0, `1.234` | `NUMERIC_TOO_PRECISE`; nie 1234 |
| Alter Kontext | andere Partie, andere Runde, geänderte Config/Einheitenfaktor | `STALE_ROUND` / `NUMERIC_CONFIG_STALE`, nichts umgehängt |
| Doppelte Abgabe / Urteil | zweite Abgabe (auch nach Lock), zweites Urteil gleich/anders | `ALREADY_ANSWERED`; gleiches Urteil `applied:false`; anderes `NUMERIC_ALREADY_JUDGED` |
| Zielwert/Grenzen im Fehlertext | private Bounds: Fehlercode, Wire-Code, UI-Text, Projektion | keine Zahlen/Grenzen enthalten |
| Neue Datei läuft nicht in CI | `vitest list` in server und web | alle drei Testdateien werden von `pnpm --filter … test` erfasst |
| Legacy-Engine bekommt unerwartete Daten | Legacy-Schema, `submitOnce`, `validateCommand` aller drei Engines | Zahlenobjekte abgelehnt; String/null unverändert lesbar |
| `__proto__` als Teilnehmer-Id | Sonde | kontrolliert abgelehnt (`NUMERIC_STATE_INVALID`) |

## Befunde und Korrekturen

1. **Manipuliertes Auswertungsobjekt wurde angenommen** (`relativeDeviation.numerator = 1e300` ergab ein stilles Ergebnis). Ursache: `NumericEvaluationSchema` ohne Obergrenzen/Konsistenzprüfung. Korrektur: Grenzen für Zähler/Nenner und Konsistenz von `equal`/`direction`/`numerator` gegen `absoluteDeviationUnits`. Regressionstests ergänzt (fünf manipulierte Varianten werfen `NumericError`).
2. **Doppelter Punkt im Einheitenhinweis** („Eingabe in Mio.. Eine …“) im Screenshot festgestellt. Korrektur: „Einheit: Mio. · …“, Test auf `..` ergänzt, Browserlauf wiederholt.
3. **Schwache Tests entfernt/ersetzt:** ein tautologischer Format-Vergleich (`text === … ? text : text`) und eine triviale Regex-Schleife über Code-Konstanten; eine Test-Fixture kollidierte zufällig mit dem Faktor 1 000 000 (Regex `10000`) und wurde auf einen eindeutigen privaten Wert (7777,7) geändert.
4. **Mutationsprüfung** (je eine Mutation, Test muss rot werden): Überpräzision toleriert, Toleranzgrenze immer inklusiv, Frist ignoriert, Config-Bindung entfernt, leer = 0 — **alle fünf erkannt** (1/4/1/1/1 fehlschlagende Tests). Quellstand danach wiederhergestellt.

Rechenvergleich: Erwartungswerte (z. B. 2970−2962 = 8; 8/2962 ≈ 0,27 %; 5 % von 200 = 10; 12,5 % von 80 = 10; Extremdifferenz 2·(10^15−1) = 1 999 999 999 999 998) sind von Hand gerechnet, nicht aus der Implementierung abgeleitet.

## Verbleibend / bewusst nicht behauptet

- Kein echter Engine-Verbraucher: Socket-, Auth-, CAS-, Receipt-, DB-, Neustart-, Rejoin-, Recovery- und echte Projektions-Nachweise fehlen und sind am Verbraucher verpflichtend (`matrix.md` §3).
- Browser: Layout-/Fokus-/Akzentprüfung lief lokal in Chromium gegen eine **nicht eingecheckte** Fixture (siehe `acceptance.md`); sie ist kein CI-Gate. Kein iPhone-/Safari-Nachweis (Chromium-Mobile-Emulation ersetzt ihn nicht).
- `@quiz/shared` hat kein eigenes Testskript; seine Numeric-Logik wird über die Server-Suite geprüft.
- Das Feld wartet, wenn der Aufrufer nach `onSubmit` nie Feedback meldet (dokumentierte Zuständigkeit).
- Die Pfadauflösung `@quiz/shared/numeric` ist in Vitest (web/server), Typecheck, Lint, Vite-Dev (Fixture) und Server-`tsc` belegt; der Produktions-Web-Build bündelt das ungenutzte Feld (Tree-Shaking) und beweist den Pfad daher nicht — das tut erst der erste Verbraucher.
