# N3 — Integrationsmatrix

Base: `main` @ `b38df2b`. Stufen wie G5/N1/N2: **R** in einer echten Engine verwendet · **H** Helper/Schema ohne Engine-Integration · **O** nicht vorhanden · **S** bewusst später. Es gibt **keinen** echten Sortier-Verbraucher; alle N3-Bausteine sind **H**. Testadapter, Fixtures, zwei Listen oder simulierte Spiele sind keine Engines (Master §13.2).

## 0. Anforderung → Baustein → Lücke → Änderung → Nachweis

| Anforderung (Auftrag) | Vorhanden vor N3 | Lücke | Änderung | Nachweis | Offene Engine-Anbindung |
|---|---|---|---|---|---|
| Versionierte, begrenzte Schemas (§5) | N1/N2-Muster, `SubmissionRecord` nur String/null | kein Listenvertrag | `shared/ordering.ts` | `ordering.test.ts` | Config im `GameConfigSnapshot` pinnen |
| Vollständige Permutation stabiler IDs (§5) | – | – | `validateOrdering` | `ordering.test.ts` (alle 6 Permutationen, Gegenfälle) | Aufruf an der Command-Grenze |
| Serverreferenz + neutraler Vergleich (§6) | `matchAnswer` (Freitext, ungeeignet) | kein Positionsvergleich | `validateOrderingReference`, `compareOrdering` | Orakel n = 4, 24 Permutationen, Gruppen | Referenzaufbereitung (Richtung, Gleichwertigkeit) der Engine |
| Atomare Abgabe, echter Lock, Vergleichsübernahme (§7) | `timerAcceptsInput`, N2-Muster | kein Sortierzustand | `orderingSubmission.ts` | `orderingSubmission.test.ts` | CAS/Receipt/Limiter/Persistenz in `RoomGameState` |
| Secret-Grenzen, Projektion (§8) | `canView`/`ProjectionAudience` | kein Projektor | `projectOrderingRound`, `projectOrderingSolution` | Rollentabelle, Orakel-Tests | Informationsrolle, Reveal-Phase, Socket/Rejoin |
| Midnight-Komponente (§9) | `TextCardForm`/`NumberField` | keine Sortierbedienung | `OrderingForm` | `OrderingForm.test.tsx`, Chromium-Harness | Einbindung in Engine-UI, Intentclient |
| N1-Anzeigekorrektur (§4) | `NumberField` | LOCKED ohne `value` zeigt Entwurf | `confirmed` getrennt gehalten | 5 Regressionstests, rot am Stand `b38df2b` | – |

## 1. Bausteine

| Baustein | Datei | Tatsächlicher Aufrufer | Test | Serialisierung | Rechte-/Secret-Zuständigkeit | Stufe | Offenes Engine-Wiring |
|---|---|---|---|---|---|---|---|
| Vertrag: Config, Permutation, Referenz-Gruppen, Vergleich, Identitäten, Fehlercodes | `packages/shared/src/ordering.ts` (`@quiz/shared/ordering`) | nur Tests, `OrderingForm`, `orderingSubmission` | `core/ordering.test.ts` (28), Strip-only-Ladetest | JSON-Roundtrip Config/Referenz/Abgabe/Vergleich | Config vollständig öffentlich und strikt; Referenz nie im Config-/Scopeschlüssel; Issues nur mit konfigurierten IDs | H | Config + Referenzrevision pinnen; opake IDs; Startreihenfolge persistieren |
| Rundenzustand, Abgabe, Rundenlock, Vergleichsübernahme, Projektion | `apps/server/src/games/core/orderingSubmission.ts` | nur Tests | `core/orderingSubmission.test.ts` (35) inkl. SDK-Replay, 34 korrupte Zustände | JSON-Roundtrip offen/geschlossen/verglichen; `createStateEvent`/`applyStateEvent` | `participantId`/Scope/Zeit/Rolle nur von der Admission-/Command-Grenze; Projektion über `canView` (`PLAYER_PRIVATE`); Zustand serverprivat, ohne Referenz | H | Admission, Rechte, CAS, Receipt, Limiter, Persistenz, Reveal-Phase, Rundenschluss-Aufruf |
| Wire-Codes `ORDERING_*` | `core/errors.ts` (`PUBLIC_CODES`) | `gameErrorCode` | `orderingSubmission.test.ts` (Mapping) | – | Codes ohne Inhalte | H | `messageKey`-Abbildung in `appError.ts` am ersten Verbraucher |
| Sortierkomponente | `apps/web/src/components/OrderingForm.{tsx,module.css}` | nur Tests, Harness | `OrderingForm.test.tsx` (38), `harness/n3-ordering/check.cjs` | – | erhält nur öffentliche, streng geprüfte Config | H | Einbindung in Engine-UI; Intentclient/Command-ID-Erhalt; `attemptId`-Echo |
| N1-Fix | `apps/web/src/components/NumberField.tsx` | nur Tests | `NumberField.test.tsx` (+5) | – | – | H | Zahlen-Engine (z. B. „Schätz mal“) |

## 2. Beziehung zu bestehenden Bausteinen

| Vorhanden | Verwendung in N3 | Änderung |
|---|---|---|
| `timerAcceptsInput`, `CoreRuleError` | Frist-/Pause-/Ablaufregel, `STALE_ROUND`, `ALREADY_ANSWERED`, `INVALID_TIME`, `TIME_EXPIRED` | keine |
| `canView`/`ProjectionAudience` | Projektion der eigenen Reihenfolge, Lösungsfreigabe | keine |
| `SubmissionRecord`, N1-Numerik, N2-Textkarte, Bestandsengines | Abgrenzung getestet (gegenseitig unlesbar; kein Reihenfolgeobjekt als Legacy-/Judge-/Choice-Antwort; kein `orderSubmit`/`sort.update`/`sort.lock`) | keine |
| `createStateEvent`/`applyStateEvent` | Replay-Nachweis | keine |
| `gameErrorCode` | Wire-Codes | `ORDERING_*` ergänzt |
| `shuffleServer` (`roundFlow.ts`) | **nicht verwendet**; Startreihenfolge liefert der Aufrufer; später nur bei der Vorbereitung mischen und persistieren | keine |
| `matchAnswer`/Fuzzy/String-JSON-Gleichheit | bewusst **nicht** als Ersatz für Permutationsvalidierung/Vergleich genutzt | keine |
| `recordScoreMutation`, Result-/Ledgerpfad, Intentclient, Socket | **nicht berührt**, kein neuer Socket-Event | keine |

## 3. Pflichtweg und Nachweise am späteren echten Verbraucher

Reihenfolge siehe `design.md` §7. Vom Verbraucher zusätzlich zu führen (hier nicht möglich): Socket-/HTTP-Commands mit echter Auth/Admission, CAS-Konflikte, Receipt/Duplicate, Request-Limits vor DB-Arbeit, DB-Persistenz und Serverneustart, Rejoin/Resync (gleiche Reihenfolge nie neu gemischt, Abgabe bleibt), Recovery bei Invariantenverletzung (pausieren statt falschen State), echte Rollenprojektionen (Host/Blind-Host/mitspielender Host/Viewer/Display), Timer-/Pause-Interaktion, Rundenschluss bei Timerablauf, Ergebnis-/Ledger-Pfad, Browser-E2E, Metrics/Logging (ohne Reihenfolgen/Referenzen).
