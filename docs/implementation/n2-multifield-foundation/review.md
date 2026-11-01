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

## Verbleibend / bewusst nicht behauptet

- **Kein echter Verbraucher.** Socket-, Auth-, CAS-, Receipt-, DB-/Neustart-, Rejoin-, Recovery- und echte Projektionsnachweise fehlen (`matrix.md` §3, Punkt 8).
- **IME** ist nur mit synthetischen Ereignissen (`compositionstart`/`isComposing`/`keyCode 229`) in jsdom geprüft; es gibt keinen Nachweis mit einer echten IME auf einem echten Gerät.
- **Browser:** lokaler Chromium-Lauf (Emulation) gegen den dokumentierten, nie ausgelieferten Harness; kein CI-Gate, kein echtes iPhone/Safari.
- Längenmaß ist Code-Points, nicht Graphemcluster; unsichtbare Verbinder sind erlaubt (`decisions.md` #14).
- `cardRef` enthält die `participantId` (nicht geheim); es wird nur in der Judge-Sicht der Engine gebraucht und ist bewusst nicht Teil der Standardprojektion.
- Ein gemeinsames Feedback-Hook mit `NumberField` wurde bewusst nicht extrahiert (`design.md` §5).
- Das Matching kennt nur *eine* Referenz je Feld (wie `matchAnswer`); Pool-/Wörterbuchabgleich ist Aufgabe der Engine/des Content-Systems.
