# G3 — Abgaben, Matching, Bewertung und Sichtbarkeit

Basis: main `3d28d6f7` (G1 + G2 + PR24). Quellen: Auftrag G3, Plan G1–G5 (gepinnt
`e2ca3e25`, nur lesend), [G1-Matrix](../g1-command-contract/matrix.md),
[G2-Matrix](../g2-runtime-flow/matrix.md) und der tatsächliche Code. Historische
PR12-Istspalten sind kein Beleg. Dies ist kein neuer vollständiger Master-Audit.

**R** = real in vorhandenen Engines genutzt und belegt; **H** = Hilfsbaustein ohne
vollständige Laufzeitintegration; **O** = im gemeinsamen Kern nicht vorhanden;
**S** = bewusst später beim passenden Spiel/Cluster.

## A — Abgabe, Lock, Bewertung: Reihenfolge und Wiederholung

| Spiel / Aktion | Guard (serverseitig) | Reihenfolge und Wiederholung | Persistierte Wirkung | Stufe |
| --- | --- | --- | --- | --- |
| Wissensduell `geo:answer` | PLAYER + BUZZER_CONTROL, aktive Teilnahme, Raumcode, laufende Partie, `INPUT_OPEN`, Rundenzustand des Spielers, Frist (`now < endsAt`), gültige Option, **ausdrückliche Runde (`questionIndex`) = aktuelle Runde** | Submit (`SUBMITTED`) → Lock bei Fristende (`LOCKED`) → Judge beim Reveal (`JUDGED`). Gleiche Absicht = gespeicherte Antwort (`replayed`); gleiche ID mit anderer Option = `COMMAND_CONFLICT`; neue ID nach Abgabe = `ALREADY_ANSWERED`; parallele Abgaben = genau eine | State-CAS in einer Transaktion; Punkte erst beim Reveal | R |
| Wissensduell Reveal / Fristablauf | REVEAL_CONTENT bzw. Serverfrist | EXACT-Vergleich je Abgabe, `judgeSubmission`, Punkte, Ledger, Raumphase, State-CAS in **einer** Transaktion; Reveal ist einmalig | Punkte/`ScoreEvent` je beantwortendem Spieler; nicht Antwortende erhalten keine Zeile | R |
| Jeopardy Buzz → verbale Abgabe | PLAYER + BUZZER_CONTROL, `BUZZ_OPEN`/`STEAL_OPEN`, Teilnehmer im Spiel | Abgabe-Datensatz (`value:null`, `matchStatus: NEEDS_JUDGE`) je Person und Stufe (first/steal), nie überschrieben | State-CAS/Event | R |
| Jeopardy `judge` / `steal:judge` | JUDGE_ANSWER; nur boolesches `correct`; Antwortzug des Gewinners | `SUBMITTED` → `JUDGED`; gleiche Absicht = Replay, gleiche ID mit anderem Urteil = `COMMAND_CONFLICT`, neue ID in anderer Phase = Phasenfehler | Score, `ScoreEvent`, State, Event atomar; bewertete Datensätze bleiben je Person erhalten | R |
| WID `judge` | JUDGE_ANSWER; `BOTH_CORRECT`/`ONE_CORRECT`/`WRONG`; Antwortzug; `ONE_CORRECT` nur mit Hinweis | Replay/Konflikt wie oben; zweites Urteil in `REVEAL` abgewiesen | Score (+3 / +1 / −1), `ScoreEvent`, State, Event atomar | R |

Rejoin, Resync und Neustart entsperren keine Abgabe, erzeugen keine neue Frist und
keine zweite Punktewirkung (siehe Nachweise). Eine Ablehnung speichert ein
Fehler-Receipt (Replay der Ablehnung); alle übrigen persistierten Wirkungen bleiben
unverändert.

## B — Matching

| Modus | Laufzeitintegration | Stufe |
| --- | --- | --- |
| EXACT | Wissensduell: Auswahl-ID gegen `correctOptionId` beim Reveal. **Das ist ein ID-Vergleich, kein Freitext-Matching** | R (nur Auswahl-IDs) |
| MANUAL_ONLY | Jeopardy: jede verbale Abgabe wird `NEEDS_JUDGE`, nie automatisch angenommen; Host bewertet | R |
| NORMALIZED | `matchAnswer` + Unit-Test; kein Produktionsaufrufer | H |
| SYNONYM | wie NORMALIZED; keine Synonymlisten im Inhaltsmodell, keine erfunden | H |
| FUZZY | höchstens `NEEDS_JUDGE` (Judge-Hilfe), nie `MATCH` bei Ähnlichkeit; kein Produktionsaufrufer; keine Schwelle verändert | H |
| Automatische verbale Jeopardy-Bewertung | nicht eingeführt | S |

Beleg „kein Produktionsaufrufer“: `grep -rn matchAnswer apps/server/src` zeigt
außerhalb von Tests nur `'EXACT'` (Geo) und `'MANUAL_ONLY'` (Jeopardy).

## C — Bewertung und Punktewirkung

| Angebotener Wert | Vertrag | Punktewirkung | Nachweis |
| --- | --- | --- | --- |
| Wissensduell richtig/falsch | Reveal, EXACT | `points` (Inhalt, `0` zulässig), `wrongPoints` (≤ 0, `0` zulässig); Risiko-Joker verdoppelt | 0/0 und 100/−25 mit Ledger-Zeile je Antwortendem; `0` geht nicht verloren (`??`, Ledger `delta:0`) |
| Jeopardy richtig/falsch | Payload `{correct:boolean}` (zod strikt) | +Wert / −½ Wert; Steal ±½ Wert | `'true'`, `1`, `{}`, `{decision:'PARTIAL'}` → `INVALID_PAYLOAD`, keine Mutation. **Keine Teilpunkte** — absichtlich nicht ergänzt |
| WID `BOTH_CORRECT` / `ONE_CORRECT` / `WRONG` | zod-Enum | +3 / +1 (Teilwertung, nur mit aktivem Hinweis) / −1 | `PARTIAL`, `CORRECT`, `0`, `{}` → `INVALID_PAYLOAD`; `ONE_CORRECT` ohne Hinweis → `HINT_REQUIRED`; jeweils keine Mutation |
| Core `scoreJudgement` | `CORRECT/WRONG/PARTIAL/CANCELLED` | `PARTIAL` ohne Teilpunktwert, nicht ganzzahlig, `NaN`, `Infinity` → `JUDGE_DECISION_UNSUPPORTED`; `partial: 0` zulässig | Unit |

Fehler in der Persistenzgrenze: ein fehlschlagender `ScoreEvent`-Write beim Reveal
rollt Phase, Scores, Teilnehmer-Score und früher geschriebene Ledger-Zeilen zurück;
der erneute Reveal wirkt genau einmal (Test mit Fehler beim 2. Ledger-Write).

## D — Sichtbarkeit und Secrets

| Geheimnis | Player | Viewer/Display | Host | Blind-Host | Nachweis |
| --- | --- | --- | --- | --- | --- |
| Wissensduell: fremde Auswahl | nein (nur eigene) | nein | ja (`answerStats`, `geo:answered:moderator`) | nein | Resync + Broadcast-Mitschnitt |
| Wissensduell: Lösung vor Reveal | nein | nein | ja | nein; nach Reveal alle | Resync vor/nach Pause, Rejoin, Reveal |
| Jeopardy: Lösung | nie (Maskierung `••••••`) | nie | ja, nicht blind | erst nach Auflösung des Feldes (am urteilenden Socket) | Mitschnitt aller Events, Resync in jeder Phase, Pause |
| WID: Personen | nein | nein bis Reveal | ja | — | Resync, Rejoin, Pause, Judge; nach Reveal sichtbar |
| Host-Receipt nach Rechteentzug | — | — | Replay wird abgewiesen, keine Daten | — | WID-Judge mit `REVOKE JUDGE_ANSWER` |

Verwaltungsrechte (GAME_*/JUDGE_*) ändern keine Informationsrolle; die Sichtbarkeit
läuft über `core/visibility.ts` und die Engine-Projektion. Entfernte/verlassene
Teilnehmer verlieren Abgabe und Resync sofort (Test mit weiter verbundenem Socket).
Display: `authorizeGameContext` bildet DISPLAY auf die öffentliche Viewer-Projektion
ab (`core/access.ts`), Mutationen verweigert `core/permissions.ts`. Test: Display-
Resync (Wissensduell/Jeopardy) ohne Lösung/Auswahl, `answer`/`reveal`/`judge`/`buzz`
abgewiesen, keine persistierte Wirkung.

## E — Künftige Eingabeformen (nur Bedarf, keine Vorratsimplementierung)

`SubmissionRecord.value` ist `string|null`; das ist **kein** Vertrag für die
folgenden Formen. Jede ist ein eigener Bedarf mit offenen DEC-Punkten.

| Form | Künftige Verbraucher (Quelle: Bestandsaufnahme §2) | Vorhandener Baustein | Fehlt | Offen |
| --- | --- | --- | --- | --- |
| Freitext + Matching | Last Man Standing, Gleicher Gedanke, Erkenne den Song (manuell), Der Dümmste Fliegt | `matchAnswer` (H), `submitOnce`/`judgeSubmission` | Inhaltsmodell für Synonyme, Editor, Entwurfsphase, UI | DEC-LMS-01, DEC-SAM-01, DEC-SNG-01, DEC-DDF-01…06 |
| Zahl mit Einheit | Schätz mal, Higher or Lower | — (O) | Zahl-/Einheitstyp, Nähe-/Toleranzfunktion, Rangwertung | DEC-SCH-01, DEC-HOL-01 |
| Mehrere Felder | Stadt, Land, Fluss | — (O) | Feldschema, Fristlock für alle Felder, Duplikatwertung | DEC-SLF-01 |
| Reihenfolge | Timeline | — (O) | Listenabgabe, Teilbewertungsformel | DEC-TIM-01 |
| Binär / Auswahl | Wahr oder Fake?, Millionenfrage, Imposter (Vote) | Auswahlabgabe aus Wissensduell (R) | Serienwertung, Joker/Leiter, anonyme Optionen | DEC-WOF-01, DEC-MIL-01, DEC-SPI-01 |

Es wurden keine Tabellen, Editoren, Schemas oder UI-Optionen dafür angelegt.

## Nachweise (neu in G3)

- `games/core/g3Submission.integration.test.ts` — 19 echte Socket/DB/Engine-Fälle.
- `games/core/g3Restart.integration.test.ts` — 3 Fälle mit wirklich beendeten und
  frisch gestarteten Serverprozessen.
- 2 Unit-Tests in `runtimePrimitives.test.ts`, 1 in `roundFlow.test.ts`.

## Befunde und Behebung

| Befund | Beleg | Behebung |
| --- | --- | --- |
| `geo:answer` akzeptierte `questionIndex`, prüfte ihn nicht (G1-Matrix sprach von „gültiger Runde“). Option-IDs wiederholen sich je Frage, eine verspätete Antwort einer alten Runde hätte in der neuen Runde gezählt. | Test schlug gegen unveränderten Code mit `success:true` fehl | Server weist abweichende Runde mit `STALE_ROUND` ohne Mutation ab (Wire-Code → `STALE_STATE`); Web-Client sendet die Rundennummer mit |

Geprüft und ohne Änderungsbedarf (nur als Regression abgesichert): späte Teilnahme
nach Rundenstart (`PLAYER_NOT_IN_ROUND`), Rechteentzug bei verbundenem Socket,
Receipt-Replay nach Rechteentzug, 0-Punkte-Pfade, Teilurteil WID, Auto-Reveal bei
Fristablauf (G2).

## Grenzen / bewusst offen

- Count-up, Mehrspieler-Zugzyklen, Normalisierung/Synonym/Fuzzy als Spielfunktion,
  Zahl/Mehrfeld/Reihenfolge bleiben H/O/S (siehe oben).
- Core-DoD „zwei Verbraucher“: Auswahlabgabe hat nur den Wissensduell-Verbraucher,
  verbale Abgabe/Bewertung hat Jeopardy und WID. Kein fachfremder Verbraucher wurde
  eingebaut; die Abnahme der Auswahlabgabe als gemeinsamer Core bleibt offen bis
  zu einem zweiten Auswahl-Spiel (Wahr oder Fake?/Millionenfrage).
- G4 (Ergebnis-Amendments, Limits pro Aktion, Fehlerdiagnose) und G5 nicht begonnen.
- Rate-Limit pro Spielaktion: nicht Teil von G3 (G4).
