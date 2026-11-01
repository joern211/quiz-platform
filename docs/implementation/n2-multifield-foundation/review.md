# N2 — Getrennte Eigenprüfung

Zweiter Durchgang nach dem ersten grünen Stand: Auftrag, Bestandstabelle und Diff erneut unabhängig vom Implementierungsablauf gelesen, die Prüfliste aus Auftrag §13 aktiv gegen den Code gespielt, Tests per Mutation auf Aussagekraft geprüft.

## Prüfliste (Auftrag §13) und Ergebnis

| Gegenfall | Prüfung | Ergebnis |
|---|---|---|
| Unbemerkt entfernte Extra-Felder | Zusatzschlüssel in Config, Feldeintrag, Karte, Eintrag, gespeichertem Zustand; `__proto__` als eigener Schlüssel | überall abgelehnt (`TEXT_CARD_MALFORMED`/`TEXT_CARD_STATE_INVALID`/Config ungültig), nie still entfernt; Mutation „Extra-Keys akzeptiert“ erkannt (3 Tests) |
| Doppelte/gefährliche IDs | doppelte fieldIds (Config und Karte), `__proto__`, `constructor`, `prototype`, `toString`, Großbuchstaben, Leerzeichen, Länge | abgelehnt; keine Prototypmutation (`Object.prototype` geprüft); unbekannte IDs werden nicht zurückgespiegelt |
| Umsortierte Felder | Eintragsreihenfolge, Definitionsreihenfolge, vertauschte Labels, UI-Umordnung bei gleichem Kontext | Zuordnung nur über fieldId; Entwürfe bleiben am Feld; Config-Identität erkennt Reihenfolgeänderung |
| Teilabgabe | ein ungültiges Feld unter mehreren; Zustand vorher/nachher | byte-gleicher Zustand, danach gültige Abgabe möglich (Slot nicht verbrannt) |
| Lock nur auf vorhandenen Records | Abgabe eines Teilnehmers **ohne** Record nach dem Schließen, leere Runde, laufender externer Timer | `TEXT_CARD_ROUND_CLOSED`; Mutation „nur Records sperren“ erkannt (2 Tests) |
| Eigene vs. Partnerantwort | Partner im gleichen Team, mitspielender Host als HOST, Blind-Host, Viewer, Display, vor/nach Reveal | nur der Besitzer; Mutation „Team sieht Karten“ erkannt (2 Tests) |
| Privater Configschlüssel im Browser | Projektion JSON auf `configKey`/`reference`/`expected`/`cardRef`; Config mit Zusatzschlüssel in `TextCardForm` | Config ist öffentlich und strikt; die Komponente rendert ein Config-Objekt mit Zusatzschlüsseln nicht |
| Unbestätigte Matching-/Punkteregel | Adapter, Gruppierung, Status | `NOT_CHECKED` ohne Referenz, `NO_ANSWER` für Leerfeld, FUZZY nie `MATCH`; Gruppierung ohne Sieger/Punkte; keine Punkte-/Rang-/Zufallsschlüssel im Zustand |
| Alter ACK nach neuem Submit, identische ERROR-Objekte | drei R1-Gegenfälle, Echo alter/aktueller Versuch, null/fehlendes Feedback, Reihenfolge innerhalb des Versuchs, Kontextwechsel | siehe Befund 3; 6 Mutationen der Feedback-/Enter-/IME-Logik erkannt (eine weitere war äquivalent und wurde durch Entfernen der redundanten Variable beseitigt) |

## Befunde und Korrekturen

1. **Doppelmeldung je Feld** (erste Testläufe): ein fehlerhafter Eintrag eines bekannten Feldes wurde als `TEXT_CARD_MALFORMED` *und* `TEXT_MISSING_FIELD` gemeldet. Korrektur: das Feld gilt als „gesehen“, genau eine Meldung.
2. **Barrierefreiheit:** accessible name `Eins(erforderlich)` ohne Leerzeichen (Leerzeichen im `span` verloren). Korrektur: Leerzeichen als eigener Textknoten; Test auf den Namen.
3. **Testlücke in der Feedbacklogik (Mutation M1 überlebte):** „späteres SUBMITTED/ERROR eines *älteren Versuchs derselben Runde*, nachdem der aktuelle Versuch bereits `PENDING` gemeldet hat“ war nicht abgedeckt (die Warte-Sperre maskierte es vor dem `PENDING`). Test ergänzt (Mutation jetzt von 5 Tests erkannt); die redundante Variable `answersCurrent` entfernt (Mutation M7 war äquivalent, weil `applicable` das bereits garantiert).
4. **Lint:** ein ZWJ innerhalb einer Zeichenklasse (`no-misleading-character-class`, berechtigt) → Alternation; das CommonJS-Harness-Skript braucht einen begründeten ESLint-Header.
5. **Fünf Befunde der Gegenfallprüfung am fertigen Diff**, jeweils mit Regressionstest, gegen den Vorstand rot:
   - **IME:** endet eine Komposition nie (Fokus verlässt das Feld), blieb das Composing-Flag gesetzt und Enter dauerhaft wirkungslos → Reset beim Blur.
   - **Serverfehler:** Feldfehler vom Server wurden angezeigt, der Fokus ging aber nicht auf das erste problematische Feld (lokal schon) → Fokus-Effekt, geschlüsselt auf das *gehaltene* Feedback (ändert sich nur bei Inhaltsänderung, stiehlt bei Parent-Re-Render keinen Fokus; der Effekt entsperrt nie).
   - **Private Referenzen in Props:** `TextCardForm` übernahm jedes Config-Objekt → Config wird zur Laufzeit gegen das strikte öffentliche Schema geprüft; ungültig/zusätzliche Schlüssel ⇒ nichts gerendert (die Referenz erreicht nie das DOM).
   - **`LOCKED` ohne `attemptId`-Eigenschaft** (JS-Aufrufer) wurde ignoriert → fehlend zählt wie `null`.
   - **`findSharedAnswers`:** mehrere Gruppen eines Feldes waren nur durch die Abgabereihenfolge geordnet → kanonische Reihenfolge (der erste Test war nicht trennscharf und wurde mit Testdaten, deren Einfügereihenfolge von der kanonischen abweicht, ersetzt).
6. **Mutationsprüfung** (je eine Mutation, Test muss rot werden):
   - Server (11): Lock nur auf Records, Frist ignoriert, Config-Bindung, `cardRef`-Bindung, Überschreiben erlaubt, JUDGED bei Teilbewertung, Team-Einblick, Extra-Keys akzeptiert, Leerstring gültig, fehlendes Feld still `null`, falscher Typ still `null`, „ohne Referenz = NO_MATCH“ → **alle erkannt**.
   - Karte (7 Mutationen): Echo-Prüfung entfernt (zunächst überlebt, nach Befund 3 von 5 Tests erkannt), Reihenfolge im Versuch, IME-Schutz, Enter-Default, LOCKED endgültig, fremder Kontext → **6 erkannt**; „jede Rückmeldung beantwortet den Versuch“ war äquivalent (redundante Variable entfernt).
7. **Berechtigungsgrenze der Umgebung (kein Produktbefund):** das Zurücksetzen des bisherigen Aufgabenbranchs `claude/new-session-3mw74c` (enthielt nur gemergte N1-Historie) per `--force-with-lease` wurde vom Berechtigungssystem abgelehnt. Statt dies zu umgehen, wurde der im Auftrag ausdrücklich vorgesehene, nicht überschreibende Weg gewählt: neuer Branch `feature/n2-multifield-foundation` direkt von `main`, normaler Push. Der alte Branch blieb unangetastet.

## Nachprüfung PR #31 — Befunde R1 und R2 (unabhängiges Review, je P2)

Das unabhängige Review am Head `712781a` fand zwei Fehler in `TextCardForm`, die meine Eigenprüfung übersehen hatte. Beide reproduziert (Remote-Head und lokaler Stand waren identisch, die zwei Review-Tests unverändert **rot**: `Expected: angenommen / Received: nicht angenommener Entwurf`).

**R1 — alter LOCKED-Echo wurde nach dem Rundenlock wieder angenommen.** Ursache: `applicable = held?.status === 'LOCKED' ? isLock : …` — sobald `LOCKED` gehalten wurde, genügte der Status allein; die Zuordnung zum aktuellen Versuch wurde nicht mehr geprüft. Ein explizit älteres Echo (`r#1`), das vor dem Lock korrekt ignoriert wird, wurde danach übernommen und ersetzte die bestätigte Karte.
**Korrektur:** `applicable = isLock ? echoOk : held?.status !== 'LOCKED' && (attempt === null || echo === attempt.id)` mit `echoOk = echo === null || attempt === null || echo === attempt.id`. Die Echo-Prüfung gilt jetzt in jedem Zustand; der echte Rundenlock (`attemptId` `null`/fehlend) bleibt zulässig; `LOCKED` bleibt endgültig (nach ihm ist nur noch `LOCKED` anwendbar).

**R2 — regulärer Rundenlock ohne `card` verwarf die bestätigte Anzeige.** Ursache: `held` wurde vollständig durch die Sperrmeldung ersetzt, `valueOf` las die Karte aus `held.card` und fiel auf den nie angenommenen lokalen Entwurf zurück. (Der Typ wurde bewusst **nicht** verschärft: ein Lock ohne Kartendaten ist Teil des Vertrags und seiner Tests.)
**Korrektur:** die zuletzt bestätigte Karte wird getrennt gehalten (`Session.accepted`); nur eine *anwendbare* (`applicable && ordered`) `SUBMITTED`/`LOCKED`-Rückmeldung mit `card` setzt oder ändert sie, eine Meldung ohne `card` löscht sie nie, ein `contextKey`-Wechsel setzt sie zurück (keine Übernahme in die neue Runde); ohne bestätigte Karte zeigt die Sperre den lokalen Entwurf schreibgeschützt.

**Warum meine Eigenprüfung es übersah.** Die R1-Tests deckten „alte Rückmeldung *vor* dem Lock“ ab, nie „*nach* dem Lock“; und `LOCKED` wurde nur mit mitgelieferter `card` oder vor jeder Abgabe getestet — nie als Statusmeldung nach einer bestätigten Karte, deren Inhalt vom lokalen Entwurf abweicht. Meine Mutation „LOCKED nicht final“ prüfte die Reihenfolge, nicht die Echo-Zulässigkeit im Zustand `LOCKED`.

**Rot/Grün-Nachweis.** Die zwei Review-Tests sind (verhaltensgleich, mit eigenem Hilfsaufbau) Teil von `TextCardForm.test.tsx`. Am Stand `712781a` waren sie rot (unverändert als separate Datei ausgeführt); dort schlagen insgesamt 6 der 9 neuen Kontrolltests fehl, mit der Korrektur sind alle 41 Tests der Datei grün. Zusätzliche Kontrollen (7): alter `LOCKED` mit und ohne `card`, vor und nach dem Rundenlock (inkl. explizit fremdem Echo `r#7`); Sperre ohne bisherige Karte (auch nach `PENDING`) zeigt den Entwurf schreibgeschützt; `LOCKED` bleibt endgültig (spätere `PENDING`/`ERROR`/`SUBMITTED` ändern nichts, bestätigte Karte bleibt); `LOCKED` ohne `attemptId`-Eigenschaft; ein anwendbarer Lock *mit* `card` ersetzt die bestätigte Karte (Server ist maßgeblich); Kontextwechsel löscht die bestätigte Karte (auch bei Rückkehr); korrekt aktueller ACK nach ignoriertem altem ACK setzt die bestätigte Karte.
**Mutationen der Korrekturen (6), alle erkannt:** Echo bei gehaltenem `LOCKED` nicht geprüft; unzulässiges Feedback setzt die bestätigte Karte; Kontextwechsel behält sie; Anzeige aus `held.card` statt `accepted`; bestätigte Karte wird gelöscht statt gesetzt; `LOCKED` nicht mehr endgültig.

**Zweiter Durchgang am finalen Diff** (Fokus: Rückmeldungszulässigkeit und Erhalt des bestätigten Inhalts): jede Verzweigung gegen die Zustände {kein Versuch, Versuch offen, beantwortet} × {kein `held`, `held` PENDING/ERROR/SUBMITTED/LOCKED} gelesen; kein weiterer Fehler in `TextCardForm` gefunden.

**Beobachtung außerhalb des beauftragten Umfangs (nicht geändert):** Eine Wegwerf-Probe an der gemergten N1-Komponente `NumberField` zeigt den **R2-analogen Anzeigefehler**: nach bestätigtem `SUBMITTED` (Wert 5, abweichender Entwurf 9) zeigt ein `LOCKED` ohne `value` wieder den Entwurf 9. R1 besteht dort **nicht** (ein explizit alter `attemptId` wird auch bei `LOCKED` ignoriert). Auftragsgemäß wurde N1 nicht angefasst; empfohlen ist ein kleines eigenes Nachbesserungspaket (gleicher Ansatz: bestätigten Wert getrennt halten, nur anwendbare Rückmeldungen setzen ihn, Kontextwechsel setzt zurück) mit Regressionstest.

## Verbleibend / bewusst nicht behauptet

- **Kein echter Verbraucher.** Socket-, Auth-, CAS-, Receipt-, DB-/Neustart-, Rejoin-, Recovery- und echte Projektionsnachweise fehlen (`matrix.md` §3, Punkt 8).
- **IME** ist nur mit synthetischen Ereignissen (`compositionstart`/`isComposing`/`keyCode 229`) in jsdom geprüft; es gibt keinen Nachweis mit einer echten IME auf einem echten Gerät.
- **Browser:** lokaler Chromium-Lauf (Emulation) gegen den dokumentierten, nie ausgelieferten Harness; kein CI-Gate, kein echtes iPhone/Safari.
- Längenmaß ist Code-Points, nicht Graphemcluster; unsichtbare Verbinder sind erlaubt (`decisions.md` #14).
- `cardRef` enthält die `participantId` (nicht geheim); es wird nur in der Judge-Sicht der Engine gebraucht und ist bewusst nicht Teil der Standardprojektion.
- Ein gemeinsames Feedback-Hook mit `NumberField` wurde bewusst nicht extrahiert (`design.md` §5).
- Das Matching kennt nur *eine* Referenz je Feld (wie `matchAnswer`); Pool-/Wörterbuchabgleich ist Aufgabe der Engine/des Content-Systems.
