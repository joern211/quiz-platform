# N2 — Integrationsmatrix

Base: `main` @ `d634e3e`. Stufen wie G5/N1: **R** in einer echten Engine verwendet · **H** Helper/Schema ohne Engine-Integration · **O** nicht vorhanden · **S** bewusst später. Es gibt **keinen** echten Mehrfeld-Verbraucher; alle N2-Bausteine sind **H**. Testadapter, Fixtures, zwei Karten, zwei Felder oder simulierte Spiele sind keine Engines (Master §13.2).

## 1. Bausteine

| Baustein | Datei | Tatsächlicher Aufrufer | Test | Serialisierung | Rechte-/Secret-Zuständigkeit | Stufe | Offenes Engine-Wiring |
|---|---|---|---|---|---|---|---|
| Kartenvertrag: Config, Karte, Validierung, Text-/Leerwertregeln, Config-Identität | `packages/shared/src/textcard.ts` (`@quiz/shared/textcard`) | nur Tests, `TextCardForm`, `textCardSubmission` | `core/textCard.test.ts` (19), Strip-only-Ladetest | JSON-Roundtrip von Config/Karte | Config vollständig öffentlich, strikt (keine Referenzen möglich); Issues nur mit konfigurierten fieldIds | H | Config im `GameConfigSnapshot`/Runden-State pinnen |
| Rundenzustand, atomare Abgabe, Rundenlock, Feldurteil, Gruppierung, Projektion | `apps/server/src/games/core/textCardSubmission.ts` | nur Tests | `core/textCardSubmission.test.ts` (36) inkl. SDK-Replay | JSON-Roundtrip (offen/geschlossen/bewertet); `createStateEvent`/`applyStateEvent` | `participantId`/Scope/Zeit/Rolle nur von Admission-/Command-Grenze; Projektion über `canView` (`PLAYER_PRIVATE`, kein Team-Einblick) | H | Admission, Rechte, CAS, Receipt, Limiter, Persistenz in `RoomGameState`, Reveal-Phase |
| Matching-Adapter | `apps/server/src/games/core/textCardMatching.ts` | nur Tests | `textCardSubmission.test.ts` („matching adapter“) | Ergebnis `{status, mode, referenceRevision}` | Referenz/Synonyme bleiben serverseitig, nie im Ergebnis | H | Referenzpool/Content, Revisions-Pinning, Wahl des Modus je Kategorie |
| Wire-Codes `TEXT_CARD_*` | `core/errors.ts` (`PUBLIC_CODES`) | `gameErrorCode` | `textCardSubmission.test.ts` (Mapping) | – | Codes ohne Texte | H | `messageKey`-Abbildung in `appError.ts` am ersten Verbraucher prüfen |
| Normalisierungsschlüssel `answerMatchKey` | `core/roundFlow.ts` (nur `export`) | `findSharedAnswers` | `roundFlow.test.ts` (unverändert grün), Gruppentests | – | – | H | – |
| Antwortkarte | `apps/web/src/components/TextCardForm.{tsx,module.css}` | nur Tests, Harness | `TextCardForm.test.tsx` (41), lokaler Browserlauf (`acceptance.md`) | – | erhält nur öffentliche, streng geprüfte Config | H | Einbindung in Engine-UI; Intentclient, Command-ID-Erhalt bei `RATE_LIMITED`; `attemptId` im Feedback zurückgeben |

## 2. Beziehung zu bestehenden Bausteinen

| Vorhanden | Verwendung in N2 | Änderung |
|---|---|---|
| `timerAcceptsInput`, `CoreRuleError` | Frist-/Pause-/Ablaufregel | keine |
| `canView`/`ProjectionAudience` | Projektion der eigenen Karte | keine |
| `matchAnswer` | Einzelvergleich je Feld über den Adapter | keine (nur Export des Normalisierungsschlüssels) |
| `JudgeDecisionSchema` | Feldurteil | keine |
| `SubmissionRecord`, N1-Numerik, Bestandsengines | Abgrenzung getestet | keine |
| `createStateEvent`/`applyStateEvent` | Replay-Nachweis | keine |
| `gameErrorCode` | Wire-Codes | `TEXT_CARD_*` ergänzt |
| `recordScoreMutation`, Result-/Ledgerpfad, Intentclient, Socket | **nicht berührt**, kein neuer Socket-Event | keine |

## 3. Pflichtweg für die spätere Anbindung (Engine-Auftrag)

Öffentliche Feldmetadaten → gepinnter Snapshot → aktueller Auth-/Admission-/Rechte-/Phase-/Run-/Runden-/Versionspfad → vorhandene Request-/Action-Limits, Intent und Receipt → Kartenvalidierung → atomare State-/Eventwirkung mit CAS → erlaubte Projektion → freigegebene Bewertung/Punkte nur über zentrale Ledger-/Resultpfade. Frühe Request-Gates (G4) bleiben vor neuer DB-Arbeit.

1. **Öffentliche Feldmetadaten:** die `TextCardConfig` selbst (Labels, Reihenfolge, Hilfe, `required`, Limits) geht an die Clients. Referenzwörter, Synonyme, Lösungen, Pools und `configKey` bleiben im serverseitigen Setup; die Config hat keinen Platz dafür.
2. **Snapshot:** die wirksame Config (inkl. `schemaVersion`, Feld-IDs, Reihenfolge, `required`, Limits) in den `GameConfigSnapshot` bzw. den Runden-State übernehmen (`createTextCardRound`); `textCardConfigKey` als erwarteten Scope im Command prüfen (Änderung ⇒ `TEXT_CARD_CONFIG_STALE`). Neue Definition/Revision deutet alte Zustände nie um.
3. **Admission/Command/Timer:** `participantId`, Rolle und Informationsadressat aus der Session, `now` aus der Serveruhr, `timer` aus dem Runden-State; `runIndex`/`roundId` des Commands nur zum Abgleich (`STALE_ROUND`), nie als Vertrauensquelle. Die Engine ruft `closeTextCardRound` bei Phasenende/Timerablauf — erst das schließt den Annahmepfad.
4. **Persistenz/Recovery:** `TextCardRoundState` als Teil des Engine-State-JSON; beim Laden `parseTextCardRoundState`; Recovery darf nichts neu matchen, neu bewerten oder neu auslosen (Replay ist rein).
5. **Matching/Bewertung:** `matchTextField` liefert Vorschläge; Modus, Referenz-Revision und Ergebnis nebeneinander im Runden-State pinnen. Ein Host-/Auto-Urteil läuft über `judgeTextCardField` mit `cardRef` aus der Judge-Projektion; `applied` entscheidet, ob die Engine Punkte vergibt — und zwar nur über `recordScoreMutation`.
6. **Duplikate:** `findSharedAnswers` liefert Gruppen; ob „beide 0“, „spätere verliert“ o. Ä. gilt, ist eine offene Spielregel (`decisions.md`).
7. **Projektion:** `projectTextCardRound` je Informationsrolle; die Engine bestimmt Reveal-Phase und Judge-Einsicht ausdrücklich (ein Verwaltungsrecht allein genügt nicht); ein mitspielender Host wird als PLAYER projiziert.
8. **Am echten Verbraucher verpflichtend nachzuweisen:** Socket-Pfad inkl. Auth/CAS/Receipt, DB-/Neustartverhalten (zwei Prozesstode wie `g2Restart`), Rejoin/Resync, Recovery-Evidenz, echte Projektionen für Host-Blind/PLAYER/Partner/fremder PLAYER/VIEWER/DISPLAY über Socket, Browser (Intentclient, `RATE_LIMITED` mit gleicher Command-ID), reales Gerät (iOS/Safari) und IME-Eingabe auf echten Geräten.

## 4. Zwei-Engines-Kriterium (Master §13.2)

Für alle N2-Teilumfänge: **nicht erfüllt, 0 echte Verbraucher.** Die Core-DoD bleibt hinsichtlich Laufzeitintegration offen (H).
