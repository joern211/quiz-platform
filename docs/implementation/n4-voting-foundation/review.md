# N4 — Getrennte Eigenprüfung

Durchgang nach dem ersten grünen Stand (Code-Head `7cb4569`, Server 958/958, Web 372/372), getrennt vom Umsetzungsablauf: Auftrag, Matrix und tatsächlich exportierte APIs neu gelesen, dann gegnerische Fälle und gezielte Mutationen (kein „100 % bewiesen“: Mutationen sind eine Stichprobe von 31 Änderungen, äquivalente Mutanten sind getrennt ausgewiesen).

## Gegnerische Fälle (Auftrag §12.2) — wo belegt

| Fall | Ergebnis |
|---|---|
| Wahlroster als Auth missverstanden | Domain authentifiziert nichts (Kopf von `votingPoll.ts`, `design.md` §2/§6); `participantId` kommt als Argument. Kein Domainnachweis für Kick/Rechteentzug möglich — **offen für die Engine** |
| Option-ID / Label / Autor verwechselt | gleiche Labels = verschiedene Optionen, Stimme per ID; strikte Config ohne Autor/Rolle/„korrekt“ (Test) |
| Eigene Auswahl fälschlich immer verboten/erlaubt | nur explizite Allowlist; Test mit gesperrter **und** erlaubter Selbst-Option-Konstellation, ohne Defaultregel |
| Enthaltung = fehlend | drei Zustände (`votingOutcome`), `missingCount` getrennt von `abstainCount` |
| 0 Stimmen = alle gewinnen | `top.kind: NONE`, leere Liste; 125-Belegungen-Orakel |
| Tie löscht Einzelstimmen | Test: Tie ändert keine Stimme, `votingOutcome` bleibt |
| Zweiter Wahlgang übernimmt alte Votes | andere `pollId` → `VOTING_POLL_STALE`; neuer Poll startet leer; UI: neuer `contextKey` löscht Auswahl **und** Bestätigung |
| Lock nur auf bestehende Records | Nichtwähler bei laufendem Timer nach Schluss abgewiesen |
| Client-Tally vertraut | kein Pfad nimmt einen Tally entgegen; `votingTallyIsConsistent` erkennt 13 Manipulationen |
| Aliasmutationen | tief eingefrorener Zustand, Kopier-Tests für Config/Roster/Ergebnis/Projektion |
| Geheimhaltung nach Ergebnisfreigabe | Test mit allen 10 Audiences und voller Freigabe: keine Stimmzettel-Form, keine Zeitstempel/Roster/Allowlist-Schlüssel |

## Befunde und Korrekturen

| # | Befund | Art | Korrektur |
|---|---|---|---|
| E1 | `VoteForm`-Mutation „Kontextwechsel behält bestätigte Stimme“ überlebte: ein Lock ohne Daten im **zweiten Wahlgang** hätte die alte Bestätigung gezeigt | Testlücke (Code korrekt) | Test „the confirmation of poll 1 cannot reappear in poll 2“; Mutation danach erkannt |
| E2 | Mutation „Freigabe-Guard bei offener Abstimmung entfernt“ überlebte: für nicht gelistete Zielgruppen hätte eine Ergebnisfreigabe einer offenen Abstimmung still `null` geliefert statt abgewiesen zu werden | Testlücke | Test über vier Zielgruppen und leere Liste; Mutation danach erkannt |
| E3 | `VoteForm`: `SUBMITTED` **ohne** `ballot` meldete „Stimme abgegeben.“ auch bei lokaler Enthaltung | echter (kleiner) Produktfehler | Statuszeile folgt der gesendeten, eingefrorenen Auswahl; Test rot am Vorgängerstand, grün danach (`292e003`) |
| E4 | Beim Schreiben der Datei wurden Unicode-Escapes in den Regexen von `voting.ts` zu Rohzeichen (U+2028 brach die Syntax) | Eigenfehler im Ablauf, vor Commit entdeckt (Typecheck) | aus `ordering.ts` wörtlich übernommen; Scan auf versteckte Steuerzeichen; Tests bauen Sonderzeichen per `String.fromCodePoint` |
| E5 | Mein erster Test „kein fremder Stimmzettel“ suchte nach `"optionId":"bb"`, das die legitim freigegebene Optionsliste enthält | Testfehler | prüft auf die Stimmzettelform (`"kind":"OPTION"`) |
| E6 | Entwurf: Auswahlliste nach dem Abstimmen leeren würde in der UI den Kontext ändern (`CHANGED_ERROR`) | Entwurfsfehler vor Implementierung | `own.selectableOptionIds` bleibt über Stimme/Schluss stabil; Test |

**Äquivalente Mutanten (keine Lücke):** `canView(..., publiclyRevealed: resultVisible)` auf den **eigenen** Record gesetzt ändert nichts — `own` liest ausschließlich den Record des Aufrufers, es gibt keinen Codepfad, der einen fremden Stimmzettel liest. Der Schutz ist strukturell. Die Mutation „Teammitglied sieht Stimmzettel“ wurde wegen eines Syntaxfehlers der Mutation selbst nicht gewertet und aus demselben Grund als äquivalent behandelt.

Mutationsliste: UI 9 (Enter-Sperre, Echo, Bestätigung gelöscht, Enthaltung truthy, leerer Submit = Enthaltung, Sofortsperre, Kontext behält Bestätigung, Vorauswahl, geänderter Satz gemischt) — 8 sofort erkannt, 1 nach Testergänzung (E1); Server/Vertrag 22 — 19 sofort erkannt, 1 nach Testergänzung (E2), 2 äquivalent/ungültig (siehe unten). Die E3-Korrektur ist kein Mutationsbefund, sondern ein Leseergebnis. Browser-Harness: mit entferntem Enter-Schutz Exit-Status 1 (und das bestätigt, dass Enter ohne die Sperre in Chromium tatsächlich sendet).

## Audio-Fixture-Flake E5 (N3-Review) — Ursache, Korrektur, Nachweis

- **Ursache** (am alten Test belegt): `frequency = 440 + floor(random * 400)`; vier Audio-Uploads je Lauf desselben Owners; der Medienpfad (`http/media.ts`) dedupliziert nach `sha256` des **normalisierten** MP3 und antwortet bei gleichen Daten 200 (`deduplicated: true`), der Test erwartet 201. Kollisionswahrscheinlichkeit 1 − (400·399·398·397)/400⁴ ≈ 1,5 %. Kontrolliert belegt: identisches Fixture zweimal hochgeladen → 200 + gleiche ID (Regressionstest).
- **Korrektur** (`c229094`, eigener Commit): Zähler-Index je tatsächlichem Upload, Frequenz 440 + 50 Hz · Index (Obergrenze 300, < Nyquist), Unterschied bleibt nach Normalisierung erhalten (sechs Fixtures → sechs verschiedene `sha256`/IDs, je 201). Aktuelle/zukünftige Assets beider Engines bleiben getrennt; Erwartung 201, Dedupe, HTTP-Verhalten, Retries und Timeouts unverändert; keine Zufallswiederholungen als Nachweis. main hatte den Fehler nicht separat behoben.

## Verbleibend / Grenzen

- Kein Socket-/DB-/Neustart-/Rejoin-/Recovery-/Auth-Nachweis (kein Verbraucher). Domainprojektion ist kein Geheimhaltungsnachweis der Auslieferung.
- Browserharness ist testseitig und kein CI-Gate; Chromium-Emulation ist kein echtes iPhone/Safari.
- Das UI-Verhalten „Enter auf Radio sendet nicht“ ist eine bewusste, dokumentierte Festlegung; ob eine spätere Engine Enter-Bestätigung wünscht, ist Produktentscheidung.
- Vollständige Core-DoD (Master §13.2) offen: 0 echte Engines.
