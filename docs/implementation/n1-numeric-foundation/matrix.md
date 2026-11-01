# N1 — Integrationsmatrix

Base: `main` @ `2082265`. Stufen wie G5: **R** in einer echten Engine verwendet · **H** Helper/Schema ohne Engine-Integration · **O** nicht vorhanden · **S** bewusst später. Verbraucher: es gibt **keinen** echten Numeric-Verbraucher; alle N1-Bausteine sind **H**. Testadapter, Fixtures und Funktionsaufrufe zählen nicht als Engines (Master §13.2).

## 1. Bausteine

| Baustein | Datei | Tatsächlicher Aufrufer | Test | Serialisierung | Rechte/Secret-Zuständigkeit | Stufe | Offenes Engine-Wiring |
|---|---|---|---|---|---|---|---|
| Zahlenwert, Textparser, Config, Public-Metadaten | `packages/shared/src/numeric.ts` | nur Tests, `NumberField`, `numericSubmission` | `core/numeric.test.ts`, `NumberField.test.tsx` | JSON-Roundtrip (`units`/`scale` sichere Ganzzahlen) | Public-Metadaten enthalten nie Ziel/Auswertungsparameter; Bounds nur bei `PUBLIC` | H | Config im `GameConfigSnapshot` pinnen (Schemaversion, scale, unit) |
| Auswertung/Toleranz/Gruppierung | `numeric.ts` | nur Tests | `core/numeric.test.ts` | JSON-Roundtrip der Auswertung | Ziel kommt ausschließlich serverseitig aus der Engine | H | Engine bildet freigegebene Regel auf Metriken ab, schreibt Punkte über `recordScoreMutation` |
| Numerischer Abgabe-/Lifecycle-Baustein | `apps/server/src/games/core/numericSubmission.ts` | nur Tests | `core/numericSubmission.test.ts` | Zustand als JSON; SDK-Replay (`createStateEvent`/`applyStateEvent`) getestet | `participantId`/Scope/Zeit nur von Admission-/Command-Grenze; Projektion über `canView` | H | Admission, Rechte, CAS, Receipt, Limiter, Persistenz in `RoomGameState` |
| Wire-Codes `NUMERIC_*` | `core/errors.ts` (`PUBLIC_CODES`) | `gameErrorCode` | `numericSubmission.test.ts` (Mapping) | – | Codes ohne Werte | H | `messageKey`-Abbildung in `appError.ts` bei erstem Verbraucher prüfen |
| Zahlenfeld | `apps/web/src/components/NumberField.tsx` | nur Tests | `NumberField.test.tsx` (15), lokaler Browserlauf (siehe `acceptance.md`) | – | erhält nur `NumericPublicInput` | H | Einbindung in Engine-UI, Intentclient, Command-ID-Erhalt bei `RATE_LIMITED` |

## 2. Beziehung zu G1–G5-Bausteinen

| Vorhandener Baustein | Verwendung in N1 | Änderung |
|---|---|---|
| `timerAcceptsInput`, `CoreRuleError` (`runtimePrimitives.ts`) | Frist-/Pause-/Expiry-Regel der Abgabe | keine |
| `canView`/`ProjectionAudience` (`visibility.ts`) | Projektion der eigenen Abgabe | keine |
| `SubmissionRecord` (shared) | bleibt String/null; Abgrenzung getestet | keine |
| `createStateEvent`/`applyStateEvent` (game-sdk) | Replay-Nachweis | keine |
| `gameErrorCode` (`errors.ts`) | Wire-Codes | `NUMERIC_*` ergänzt |
| `recordScoreMutation`, Result-Pfad | **nicht berührt** | keine |
| Intentclient/Socket | **nicht berührt**, kein neuer Socket-Event | keine |

## 3. Pflichtweg für die spätere Anbindung (Engine-Auftrag)

Aktuelle Admission/Session → Rechte und Information getrennt → Phase/Run/Runde/Version → Limiter → Intent/Receipt (vorhandener Schutzpfad, frühe Request-Gates bleiben vor DB-Arbeit, G4) → numerische Validierung (`submitNumeric`) → atomare Zustands-/Eventwirkung (`materializeGameEvent` mit CAS auf `RoomGameState.revision`) → erlaubte Projektion (`projectNumericRound`).

1. **Metadaten öffentlich/privat:** Engine projiziert `projectNumericPublicInput(config)`; Zielwert und Auswertungsparameter bleiben im serverseitigen Setup/State, nie in Eingabe-Metadaten, Fehlern, Events an Clients oder Logs.
2. **Config/Snapshot:** wirksame `NumericInputConfig` (inkl. `schemaVersion`, `scale`, `unit.factor`) in den `GameConfigSnapshot`/Runden-State übernehmen; `numericConfigKey` als erwarteten Scope im Command prüfen.
3. **Admission/Command/Timer:** `participantId` und Rolle aus der Session, `now` aus der Serveruhr, `timer` aus dem Runden-State (`createTimer` …). Clientwerte (`runIndex`/`roundId` ja, aber nur zum Abgleich) nie als Vertrauensquelle.
4. **Persistenz/Recovery:** `NumericRoundState` als Teil des Engine-State-JSON; beim Laden `parseNumericRoundState`; Recovery darf nichts neu auswerten oder neu würfeln (Replay ist rein).
5. **Wertung:** freigegebene Regel → `evaluateNumeric`/`checkNumericTolerance` → Punkte nur über `recordScoreMutation` (Ledger = Score); `judgeNumeric().applied` entscheidet, ob Punkte vergeben werden. Gleiche Distanz ≠ Gewinner (`groupByDistance`, Tie-Core).
6. **Am echten Verbraucher verpflichtend nachzuweisen:** Socket-Pfad inkl. Auth/CAS/Receipt, DB/Neustart (zwei Prozesstode wie `g2Restart`), Rejoin/Resync, Recovery-Evidenz, Host-Blind/PLAYER/fremder PLAYER/VIEWER/DISPLAY über echte Projektion, Browser (Intentclient, `RATE_LIMITED` mit gleicher Command-ID), reales Gerät (iOS/Safari).

## 4. Zwei-Engines-Kriterium (Master §13.2)

Für alle N1-Teilumfänge: **nicht erfüllt, 0 echte Verbraucher.** Der Numeric-Core bleibt hinsichtlich Laufzeitintegration offen (H).
