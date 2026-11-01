# N1 — Zahlenantworten, technische Grundlage: Design

Base: `main` @ `2082265` (Midnight-UI, PR #29). Branch `claude/new-session-3mw74c`.
Status: **N1-Vorbereitung implementiert und geprüft; noch kein produktiver Numeric-Spielverbraucher, vollständige Core-DoD offen** (Master §13.2 verlangt zwei echte Engines; keine existiert).

## 1. Scope und ausdrückliche Grenze

Geliefert: Zahlenvertrag (Eingabe, kanonische Form, Konfiguration, öffentliche Metadaten), Auswertung ohne Spielregel, serverseitiger Abgabe-/Lifecycle-Baustein, Zahlenfeld in der Web-App, Tests, Integrationsanleitung.

Nicht geliefert (absichtlich): keine „Schätz mal“-Engine, kein `numeric:submit`-Socket-Event, kein Testraumtyp, keine Katalogänderung, keine Punktekurve/-tabelle, keine Rundungsregel, keine Teamregel, keine Einheitenkonvertierung. Die drei Bestandsengines (Wissensduell, Jeopardy, Wer ist das?) bleiben unverändert.

Quellen: Arbeitsauftrag N1 (01.11.2026), Master §§2, 4, 5, 6, 10, 12, 13, 15.12; `docs/specs/pr12/games/schaetz-mal.md` und `decision-register.md` (nur Vorschläge, siehe `decisions.md`); G5-Matrix.

## 2. Werte- und Präzisionsvertrag

**Repräsentation.** `NumericValue = { units: Ganzzahl, scale: 0 | 1 }`, Wert = `units / 10^scale`. Datei: `packages/shared/src/numeric.ts`, Import `@quiz/shared/numeric` (eigener Subpath-Export; der shared-Index bleibt unverändert).

Begründung: kleinste Lösung ohne Bibliothek. Beide Felder sind sichere Ganzzahlen → JSON/SQLite/Event-Replay sind verlustfrei; es gibt keine Binär-Floats an Vertrags-, Vergleichs- oder Persistenzgrenzen. BigInt wird nur *innerhalb* der Toleranzvergleiche benutzt (exakte Kreuzmultiplikation) und taucht in keiner serialisierten Form auf.

**Grenzen.** `|units| ≤ 10^15 − 1` (höchstens 15 Ziffern). Die Differenz zweier Operanden ist damit ≤ `2·(10^15−1)` und bleibt exakt darstellbar (< 2^53). Operanden außerhalb des Vertrags (z. B. `MAX_SAFE_INTEGER`) werden in der Auswertung mit `NUMERIC_TOO_LARGE` abgelehnt, nicht still falsch gerechnet. Rohtext ≤ 32 Zeichen, geprüft *vor* jeder Umwandlung.

**Präzision.** Technisch nachgewiesen: Ganzzahlen (`scale 0`) und eine Nachkommastelle (`scale 1`). Daraus folgt keine Spielfestlegung; jede Engine pinnt `scale` in ihrer Konfiguration. Weitere Stufen nur mit belegtem Bedarf.

**Fehlend, 0, negativ.** Fehlend (`null`/`undefined`) → `NUMERIC_MISSING`; leerer/Whitespace-Text → `NUMERIC_EMPTY`; `0` ist ein gültiger Wert. `-0` wird zu `0` normalisiert (kanonisch nie negative Null; das Schema lehnt `-0` ab). Negative Werte sind zulässig, wenn die Konfiguration es erlaubt (`min < 0`).

**Texteingabe-Grammatik (UI-Grenze).** `[-]Ziffern[(,|.)Ziffern]`. Komma **und** Punkt sind *immer* Dezimalzeichen. Es gibt keine Gruppierungserkennung: `1.234` ist die Dezimalzahl 1,234 (bei scale 0/1 `NUMERIC_TOO_PRECISE`), nie 1234. Abgelehnt: `+`, Exponent, Hex, `Infinity`/`NaN`, Gruppierung/Leerzeichen, Misch-Syntax, Nicht-ASCII (NBSP, U+2212, Fullwidth-/arabische Ziffern), führendes Trennzeichen (`,5` → `0,5` schreiben), Textsuffixe (`12abc`). Entwürfe (`-`, `12,`) ergeben `NUMERIC_INCOMPLETE`, leer `NUMERIC_EMPTY` — nie eine gültige 0. Kein `parseFloat`, kein `Number('')`.

**Überpräzision.** Stellen über `scale` hinaus werden abgelehnt, auch Nullen (`12,50` bei scale 1, `12,0` bei scale 0): keine stille Rundung, solange keine Rundungsregel beschlossen ist.

**Wire-Form.** Der Server nimmt ausschließlich das kanonische Objekt (`parseNumericValue`) entgegen — nie Zahlen, Strings oder Booleans. Der Client wandelt seinen Entwurf mit demselben Parser um; der Server validiert erneut gegen die wirksame Konfiguration (`validateNumericValue`). Lokalisierter Text ist nie Rechen- oder Persistenzvertrag (Master §12.7). Anzeige: `formatNumericCanonical(value, ',' | '.')`, ohne Intl, ohne Gruppierung.

## 3. Konfiguration, Einheit, Geheimhaltung

`NumericInputConfig` (versioniert, `schemaVersion: 1`, streng): `scale`, `min`, `max` (beide Pflicht, im Config-Scale), `unit` (`null` oder `{label, factor}`), `boundsDisclosure` (`PUBLIC`|`PRIVATE`, Pflicht). Keine stillen Standardwerte. `parseNumericConfig` liefert bei Fehlern nur `NUMERIC_CONFIG_INVALID` (keine Werte, keine Pfade). Prüfungen: `min ≤ max`, Scale-Konsistenz, darstellbare Grenzen, Schemaversion.

**Einheit.** `factor ∈ {1, 10^3, 10^6, 10^9}` ist reine Metadaten: eine eingegebene Einheit entspricht `factor` Grundeinheiten. Gespeichert und verglichen wird in der *eingegebenen* Einheit; nichts multipliziert still (weder UI noch Server). Der Faktor ist Teil der Config-Identität.

**Config-Identität.** `numericConfigKey(config)` — deterministisch, serverintern; erkennt geänderte/ältere Konfiguration.

**Getrennte Datenformen.**
| Form | Typ | Inhalt | Empfänger |
|---|---|---|---|
| Öffentliche Eingabemetadaten | `NumericPublicInput` | `schemaVersion`, `scale`, `unit`, `allowNegative`, `bounds` (nur bei `PUBLIC`, sonst `null`) | alle, auch React-Feld |
| Eigene/erlaubte Abgabe | `projectNumericRound(...).submissions` | Wert, Status, `decision` erst nach Reveal | nur Eigentümer, nach Reveal alle |
| Privater Zielwert/Auswertungsparameter | *nicht Teil von N1-State* | Engine hält ihn serverseitig | nie in Eingabe-Metadaten/Fehlern |
| Reveal-Ergebnis | Engine-Projektion | später | erlaubte Adressaten |

`allowNegative` (aus `min < 0`) wird bewusst auch bei privaten Bounds offengelegt: es steuert nur die Tastatur (iOS-Zahlenblock hat kein Minus) und ist als einziger Hinweis dokumentiert. Range-Fehler enthalten nie Grenzen, Zielwert oder fremde Werte; das Feld nennt Grenzen nur, wenn sie öffentlich sind. Der Zielwert verengt nie Bounds oder Fehlertexte (er kommt in keiner N1-Funktion zur Validierung vor).

## 4. Auswertung (`evaluateNumeric`, `checkNumericTolerance`, `groupByDistance`)

Neutrale Metriken, keine Punkte, kein Ledger, keine Results.
- `equal`, `direction` (Eingabe `BELOW`/`EQUAL`/`ABOVE` Ziel), `absoluteDeviationUnits = |Eingabe − Ziel|`.
- Relativ: exakter Bruch `|Eingabe−Ziel| / |Ziel|` als `{numerator, denominator}` (Basis ist der **Betrag** des Ziels, auch bei negativem Ziel). Zielwert **0** → `{status: 'UNDEFINED', reason: 'TARGET_ZERO'}`; keine Division, kein NaN/Infinity, keine Ersatztoleranz.
- Toleranz nur explizit: `{kind: 'ABSOLUTE' | 'RELATIVE_PERCENT', max, boundary: 'INCLUSIVE' | 'EXCLUSIVE'}`; `boundary` hat keinen Default. Vergleich per BigInt-Kreuzmultiplikation, ohne Epsilon. Relative Toleranz bei Ziel 0 → `UNDEFINED`. `EXCLUSIVE` mit `max 0` wird als leere Toleranz abgelehnt.
- `groupByDistance`: gleiche Distanz bleibt **eine Gruppe**; kein Gewinner, keine Ankunftszeit, kein Zufall. Die Id-Reihenfolge in einer Gruppe ist nur für Determinismus lexikographisch.
- Auswertungsobjekte werden bei Verwendung erneut geprüft (Grenzen, Konsistenz von `equal`/`direction`/Relativanteil).

## 5. Abgabe-/Lifecycle-Baustein (`apps/server/src/games/core/numericSubmission.ts`)

Additiver Vertrag, kein Umbau von `SubmissionRecord`: `NumericSubmissionRecord` (`kind: 'NUMERIC'`, `schemaVersion: 1`, Wert als Objekt) und `NumericRoundState` (pinnt `runIndex`, `roundId` und die wirksame Config). Reine Funktionen über serialisierbaren Zustand, keine Mutation der Eingaben, keine Uhr/Zufall/DB/Socket.
- `createNumericRound`, `submitNumeric` (Reihenfolge: gespeicherter Zustand → Scope → Frist → Duplikat → Wert), `lockNumericRound` (idempotent, degradiert nie), `judgeNumeric` (`applied: true` nur beim Übergang SUBMITTED/LOCKED → JUDGED; Wiederholung gleicher Entscheidung → identischer Zustand, `applied: false`; andere Entscheidung → `NUMERIC_ALREADY_JUDGED`, Korrekturen laufen über Korrektur-Events), `projectNumericRound` (über das vorhandene `canView`), `parseNumericRoundState` (korrupte/Legacy-/fremde Daten → `NUMERIC_STATE_INVALID`).
- Scope-Fehler: andere Partie/Runde → `STALE_ROUND`; geänderte Config → `NUMERIC_CONFIG_STALE`. Nichts wird umgehängt.
- Frist: vorhandenes `timerAcceptsInput` (Deadline selbst geschlossen, Pause/Expiry sperren).
- Fehler: bestehende Codes wiederverwendet (`ALREADY_ANSWERED`, `TIME_EXPIRED`, `STALE_ROUND`, `SUBMISSION_NOT_JUDGEABLE`, `INVALID_TIME`); neue `NUMERIC_*`-Codes tragen keine Werte und sind in `core/errors.ts` als Wire-Codes freigeschaltet. Ungültige Eingabe ist eine technische Ablehnung, **keine** Wertung „0 Punkte“.

**Vertrauensgrenze.** Diese Funktionen authentifizieren nichts. `participantId`, erwarteter Scope (`runIndex`, `roundId`, `configKey`), `timer` und `now` müssen von der serverseitigen Admission-/Command-Grenze einer späteren Engine stammen — nie aus Client-Behauptungen (auch nicht `target`, Rolle oder Punkte).

## 6. Legacy-Kompatibilität

`SubmissionRecordSchema` (`value: string|null`) und alle Engines sind unverändert. Tests belegen: alte String-/null-Records bleiben lesbar; ein Numeric-Record besteht das Legacy-Schema nicht (und umgekehrt); `submitOnce` lehnt Objektwerte ab; die drei Engines kennen keine numerische Aktion und akzeptieren kein Zahlenobjekt als Auswahl-/Urteilsantwort.

## 7. Zahlenfeld (`apps/web/src/components/NumberField.tsx`)

Ort: web statt `@quiz/ui`, weil das Feld den Parser aus `@quiz/shared` braucht und `@quiz/ui` keine shared-Abhängigkeit hat (keine Lockfile-Änderung). Es nutzt `Button` und Tokens aus `@quiz/ui`; keine Server-Importe, kein Theme-Kontext, kein `key`-Remount.

Verantwortung: Text → `NumericValue` → `onSubmit(value, attemptId)`. Das Feld verwaltet keine Commands/Sockets. Der Aufrufer (später: bestehender Intentclient, dieselbe Command-ID bei `RATE_LIMITED`) meldet über `feedback` `PENDING`/`SUBMITTED`/`LOCKED`/`ERROR{retryable}` zurück. Erfolg erscheint erst bei `SUBMITTED`.

**Attempt-Vertrag (R1, nach unabhängigem Review).** Jedes gültige Abschicken öffnet genau *einen Versuch* im aktuellen Kontext; `onSubmit` erhält dessen Id (`<contextKey>#<n>`, Zähler je Feldinstanz). Ab diesem Moment ist das Feld gegen erneutes Abschicken gesperrt — auch wenn der Aufrufer `PENDING` erst später meldet — bis eine **anwendbare, unterscheidbare** Rückmeldung zu *diesem* Versuch eintrifft.
- *Anwendbar* ist Feedback nur mit aktuellem `contextKey` und, falls es `attemptId` trägt, mit der Id des aktuellen Versuchs. Alles andere (andere Runde, älterer Versuch) verändert weder Entwurf noch gehaltenen Zustand noch Sperre.
- Das Feld **hält die letzte anwendbare Rückmeldung**. `feedback: null/undefined` oder ein altes Objekt heißt „keine neue Information“, nie „Reset“. Der einzige Reset ist ein Wechsel des `contextKey` (leert Entwurf, gehaltenes Feedback und Versuch).
- *Unterscheidbar* heißt: inhaltlich anderes Feedback. Ein inhaltlich gleiches Objekt mit neuer Identität (typisches Parent-Re-Render) ist keine Antwort und entsperrt nicht.
- Entsperrt wird durch ein echtes Folge-Feedback (`PENDING` → später `ERROR{retryable}` entsperrt zum Retry; `SUBMITTED`/`LOCKED`/`ERROR{retryable:false}` bleiben endgültig bzw. schreibgeschützt) oder durch Kontextwechsel. Ein berechtigter Retry bleibt möglich; es gibt keine automatische Freigabe und keinen automatischen Neuversand.
- Während ein Versuch auf Antwort wartet, zeigt das Feld „Wird gesendet …“ (kein Erfolg) und blendet einen älteren Fehler nicht als Antwort auf den Retry ein.

Grenzen/Pflichten des Aufrufers: `contextKey` muss je Runde/Partie eindeutig sein (Wiederverwendung gilt als derselbe Kontext). Scheitert ein Retry mit *inhaltlich identischem* Fehler und liefert der Aufrufer dazwischen kein `PENDING`, muss er `attemptId` im Feedback zurückgeben, sonst ist die Antwort nicht von einem Re-Render unterscheidbar und das Feld wartet weiter. Wer gar kein Feedback meldet, lässt das Feld wartend zurück (kein Selbst-Resend). Out-of-order-Antworten *ohne* `attemptId` innerhalb derselben Runde sind für das Feld nicht erkennbar; wer sie erwartet, gibt `attemptId` mit. Der Aufrufer verwaltet weiterhin selbst die Command-ID/den Receipt-Pfad — das Feld baut keine zweite Commandverwaltung.

Bedienung: echtes `label`, `aria-describedby` (Einheit, Regeln, Fehler, Status), `aria-invalid`/`aria-errormessage`, `role=alert`/`status`, `type=text` mit `inputMode` (`numeric`/`decimal`, bei möglichen Negativwerten `text`), Enter über `<form>`, Fehler erst nach Abgabe/Blur (nicht beim Tippen), Fokusring über `--focus-ring`, Touchziel ≥ 48 px, 16-px-Eingabeschrift (kein iOS-Zoom), `overflow-wrap` für lange Label/Einheiten.
