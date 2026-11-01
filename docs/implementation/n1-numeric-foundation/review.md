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
3. **Produktionsstart gebrochen (Bestandstest fand es):** `rate-limiter.integration` lädt `dist/app.js` mit reinem Node, das `@quiz/shared` als TypeScript im Strip-only-Modus liest. `NumericError` nutzte eine Parameter-Property (`constructor(readonly code …)`) → `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, „Server startup timed out“. Die eigene Nachprüfung hatte nur Vitest/tsc/Vite abgedeckt, nicht diesen Ladepfad. Korrektur: explizites Feld. Regressionstest lädt `numeric.ts` in einem Node-Kindprozess mit `--experimental-strip-types` (gegen den alten Code verifiziert rot). Regel für N1-Code in `packages/shared`: keine Enums, keine Parameter-Properties, nur strip-fähiges TypeScript.
4. **Schwache Tests entfernt/ersetzt:** ein tautologischer Format-Vergleich (`text === … ? text : text`) und eine triviale Regex-Schleife über Code-Konstanten; eine Test-Fixture kollidierte zufällig mit dem Faktor 1 000 000 (Regex `10000`) und wurde auf einen eindeutigen privaten Wert (7777,7) geändert.
5. **Mutationsprüfung** (je eine Mutation, Test muss rot werden): Überpräzision toleriert, Toleranzgrenze immer inklusiv, Frist ignoriert, Config-Bindung entfernt, leer = 0 — **alle fünf erkannt** (1/4/1/1/1 fehlschlagende Tests). Quellstand danach wiederhergestellt.

## Nachprüfung PR #30 — Befund R1 (unabhängiges Review, P2)

**Befund.** `NumberField` entsperrte die Sendesperre über `useEffect(..., [feedback, contextKey])`, also bei *jeder* neuen Feedback-Objektidentität — auch bei bewusst ignoriertem Feedback einer anderen Runde. Zudem hingen `pending`/`readOnly` nur vom gerade übergebenen Feedback ab. Folgen (mit drei roten Tests reproduziert):
- A: ein verspäteter ACK der Vorrunde entfernte Pending und Sperre der neuen Runde.
- B: danach war ein zweiter `onSubmit` der neuen Runde möglich (3 statt 2 Aufrufe).
- C: ein inhaltlich identisches ERROR-Feedback als neues Objekt (Parent-Re-Render) entsperrte den noch unbeantworteten Retry.

**Warum die eigene Eigenprüfung es übersah.** Die Tests deckten „altes Feedback im *leeren* neuen Kontext“ ab, nicht das Zusammenspiel mit einem bereits *laufenden* Versuch der neuen Runde, und kein Parent-Re-Render mit identischem Inhalt. Die Aussage „fremdes Feedback ignorieren“ galt nur für die Anzeige, nicht für die Sperre.

**Korrektur.** Sendezustand an Kontext und aktuellen Versuch gebunden (Attempt-Vertrag, siehe `design.md` §7): Versuchs-Id über `onSubmit(value, attemptId)`, Sperre ab gültigem Submit, Feedback nur anwendbar bei passendem `contextKey` (und `attemptId`, falls vorhanden), letzte anwendbare Rückmeldung wird gehalten, inhaltliche Signatur statt Objektidentität, Reset nur durch Kontextwechsel. Kein Effect mehr, keine `ref`-Sperre; Ableitung während des Renderns.

**Rot/Grün-Nachweis.** Die drei Gegenfälle des Reviews sind unverändert (nur lokale Helfernamen) in `NumberField.test.tsx` übernommen. Gegen den Stand `f71ef2c` rot (3/3), gegen den Fix grün. Zusätzliche Regressionen (7): Folgeantwort nach ignoriertem alten ACK wird normal verarbeitet; Sperre ab Submit auch vor spätem `PENDING`; Kontextwechsel räumt Versuch auf (auch bei Rückkehr); wiederholtes gleiches ERROR entsperrt und sendet nichts (inkl. `PENDING` → gleicher Fehler = echte Antwort); `null`/fremdes Feedback behält den gehaltenen Zustand; Attempt-Vertrag (`<ctx>#<n>`, Echo des alten Versuchs ignoriert, Echo des aktuellen entsperrt auch bei identischem Fehler); `LOCKED` und endgültiger Fehler wirken nach ignoriertem alten ACK. Die 15 bisherigen Tests bestehen (Erwartung an `onSubmit` um das zweite Argument ergänzt, Wertprüfung unverändert). Gegen den alten Komponentencode: 14 von 25 Tests rot (8 R1-bezogen, 6 wegen der neuen Signatur).

**Zweiter Eigenprüfungsdurchgang nach dem Fix** (Fokus laut Auftrag): alte ACKs nach neuem Submit, beliebige Parent-Re-Renders, wiederholter Fehler, Wechsel Retry/Pending/Submitted/Locked und neue Runde — durch Tests abgedeckt; frische Durchsicht des Diffs ergab keinen weiteren Codefehler. Dokumentierte Restgrenzen (kein Fehler, sondern Vertrag): identische Folgefehler ohne dazwischenliegendes `PENDING` brauchen das `attemptId`-Echo; `contextKey` muss je Runde eindeutig sein; Out-of-order-Antworten ohne `attemptId` in derselben Runde sind nicht erkennbar; das Feld wartet endlos, wenn der Aufrufer nie antwortet.

Rechenvergleich: Erwartungswerte (z. B. 2970−2962 = 8; 8/2962 ≈ 0,27 %; 5 % von 200 = 10; 12,5 % von 80 = 10; Extremdifferenz 2·(10^15−1) = 1 999 999 999 999 998) sind von Hand gerechnet, nicht aus der Implementierung abgeleitet.

## Verbleibend / bewusst nicht behauptet

- Kein echter Engine-Verbraucher: Socket-, Auth-, CAS-, Receipt-, DB-, Neustart-, Rejoin-, Recovery- und echte Projektions-Nachweise fehlen und sind am Verbraucher verpflichtend (`matrix.md` §3).
- Browser: Layout-/Fokus-/Akzentprüfung lief lokal in Chromium gegen eine **nicht eingecheckte** Fixture (siehe `acceptance.md`); sie ist kein CI-Gate. Kein iPhone-/Safari-Nachweis (Chromium-Mobile-Emulation ersetzt ihn nicht).
- `@quiz/shared` hat kein eigenes Testskript; seine Numeric-Logik wird über die Server-Suite geprüft.
- Das Feld wartet, wenn der Aufrufer nach `onSubmit` nie Feedback meldet (dokumentierte Zuständigkeit).
- Die Pfadauflösung `@quiz/shared/numeric` ist in Vitest (web/server), Typecheck, Lint, Vite-Dev (Fixture) und Server-`tsc` belegt; der Produktions-Web-Build bündelt das ungenutzte Feld (Tree-Shaking) und beweist den Pfad daher nicht — das tut erst der erste Verbraucher.

## Nachtrag R2-analog (N3-Vorarbeit, Anzeigefehler bestätigter Wert)

**Befund** (aus dem finalen N2-Review, hier an der echten exportierten Komponente reproduziert): `NumberField` las den angezeigten bestätigten Wert aus der gehaltenen Rückmeldung (`active.value`). Eine gültige, kontextgebundene `LOCKED`-Meldung ohne `value` ersetzte die gehaltene Rückmeldung; danach erschien wieder der lokale Entwurf, obwohl der Server zuvor einen anderen Wert bestätigt hatte.

**Reproduktion (vor der Korrektur rot):** Entwurf 5 senden (`#1`) → retryable ERROR für `#1` → Entwurf auf 9 ändern, manuell erneut senden (`#2`) → aktuelles `SUBMITTED` für `#2` mit bestätigtem Wert 5 (Anzeige 5) → aktuelles `LOCKED` ohne `value` (ohne `attemptId`, bei N1 optional) → **Anzeige war 9**, erwartet 5 (gesperrt).

**Korrektur (klein, eigener Commit):** In der Sitzung wird der zuletzt bestätigte `NumericValue` getrennt vom Status gehalten (`confirmed`). Nur anwendbares `SUBMITTED`/`LOCKED` mit `value` setzt oder ändert ihn; eine Statusmeldung ohne `value` löscht nichts; nicht anwendbares Feedback (fremder Kontext, älterer Versuch) setzt ihn nie; nur der Kontextwechsel setzt ihn zurück; ohne bestätigten Wert zeigt `LOCKED` den lokalen Entwurf schreibgeschützt. Schnittstelle, Attempt-Vertrag und alle R1-Tests unverändert; keine Änderung an Numerik, Toleranz oder Scoring.

**Nachweis:** 5 neue Tests in `NumberField.test.tsx` (Block „N3 pre-work“): die Reproduktion (gegen den Stand `b38df2b` rot: erwartet 5, erhalten 9), Lock ohne Bestätigung zeigt Entwurf, alter ACK mit Wert aus anderem Kontext bzw. älterem Versuch setzt nichts, Kontextwechsel löscht den bestätigten Wert, späterer anwendbarer Wert ersetzt den früheren. Die 25 bisherigen Tests laufen unverändert grün. Das macht N1 nicht zu einem integrierten Zahlen-Spielcore; Engine-Wiring bleibt offen (`matrix.md` §3).
