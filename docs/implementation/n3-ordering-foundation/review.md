# N3 — Getrennte Eigenprüfung

Vorgehen nach dem ersten grünen Stand (Code-Head `129ce34`, 63 Server-/38 Web-Tests grün): Auftrag, Matrix und tatsächlich exportierte APIs neu gelesen, dann gezielt gegen die im Auftrag genannten Fehlerklassen geprüft — nicht nur die eigenen Tests angesehen. Zwei Methoden: **Mutationsprüfung** (Produktivcode gezielt verfälschen, prüfen, ob die Tests es melden) und **Lesen gegen die Anforderung** (Fokus, Feedback-Vertrag, Geheimhaltung).

## 1. Mutationsprüfung

**Vertrag + Domain (`ordering.test.ts`, `orderingSubmission.test.ts`): 33 Mutationen, 32 erkannt, 1 überlebt (äquivalent).** Erkannt wurden u. a.: Duplikate/fehlende/fremde IDs akzeptiert; Längengrenze vor der Iteration entfernt; Config nicht strikt; Config-Key reihenfolgeunabhängig; Gruppenstart nicht kumuliert; `complete` falsch berechnet; Referenz mit fehlenden/doppelten IDs oder leerer Gruppe akzeptiert; Konsistenzprüfer immer wahr; Rundenlock ignoriert; Timer ignoriert; zweite Abgabe ersetzt; Vergleich bei offener Runde; Projektion zeigt alle/zeigt Vergleich vor Reveal/Status nicht geklemmt; Lösung ohne Reveal; Reveal bei offener Runde; Referenz-Scope/-Revision ungeprüft; Wiederholung meldet `applied`; stilles Überschreiben; `submissionRef` ungeprüft; fehlende Referenz „geraten“; alle Ladeinvarianten (Permutation, Besitzer, Vergleich↔Revision, Vergleich↔Abgabe, `comparedAtMs` vor Close, `submittedAtMs` nach Close). Überlebt: „Vergleich auch bei `status !== CLOSED`“ — äquivalent, weil `CLOSED ⇔ closedAtMs !== null` eine geprüfte Invariante ist (kein Verhaltensunterschied).

**Komponente (`OrderingForm.test.tsx`): 11 wirksame Mutationen, alle erkannt** (Lock ohne Echo-Prüfung → N2-R1-Test; bestätigte Reihenfolge aus `held` statt getrennt → 6 Tests; kein Wrap-Schutz → 3; keine Sofortsperre → 5; geänderte Itemmenge zusammengeführt; Kontextwechsel löscht Bestätigung nicht; Move-Button `type=submit` → 13; ungültige bestätigte Reihenfolge angezeigt; alter ACK wirkt; Status ohne `order` löscht Bestätigung → 8). Zwei Nicht-Treffer, ehrlich eingeordnet: (a) eine Mutation war wirkungslos (äquivalenter Ausdruck) und zählt nicht; (b) das **Entfernen der Fokus-Wiederherstellung wird weder in jsdom noch in Chromium erkannt** — jsdom blendet den Fokus beim Umhängen selbst aus und `userEvent` stellt ihn wieder her; in echtem Chromium behält der Browser den Fokus ohnehin (belegt: Browserlauf mit entferntem Restore unverändert grün). Ein Scheintest, der das „abdeckt“, wurde verworfen. Die Wiederherstellung ist eine defensive Maßnahme für andere Browser und **nicht als notwendig belegt**.

## 2. Befunde und Korrekturen

| # | Befund | Art | Korrektur | Nachweis |
|---|---|---|---|---|
| E1 | **Fokus nach retryable Fehler verloren.** Nach dem Absenden liegt der Fokus auf der Statuszeile; ein retryable Error entfernt sie, der Fokus fiel auf `body` — „im entfernten Control stecken bleiben“, was der Auftrag ausdrücklich verbietet. | echter Fehler (Bedienbarkeit) | Effekt: bei retryable Fehler Fokus auf „Erneut senden“, **nur** wenn der Fokus tatsächlich verloren ging (ein Nutzer, der woanders ist, behält ihn) | Test `does not strand the keyboard on a removed status line …` — am Stand `129ce34` rot (`toHaveFocus`), mit der Korrektur grün; Schutzfall „zieht den Fokus nicht zurück“ |
| E2 | Ein nicht verbrauchter Status-Fokuswunsch (`pendingFocus`), wenn die Statuszeile nicht erscheint (z. B. synchroner Fehler), blieb bestehen und hätte später Fokus stehlen können | latenter Fehler | Wunsch wird in jedem Fall verbraucht | durch E1-Schutzfall und Gesamtsuite |
| E3 | `pnpm typecheck`/`pnpm lint` des ersten grünen Stands waren **nicht** grün: Typfehler in `ordering.test.ts` (`input.groups` unbekannter Typ), ungenutzter Import `OrderingValue` | Qualitätslücke (gefunden beim ersten Gesamtlauf) | Typ ergänzt, Import entfernt | typecheck 0 Fehler, lint 0 Fehler (109 Warnungen = Basis) |
| E4 | Erster Server-Basislauf war **kontaminiert**: Ich habe während des Laufs `ordering.ts` (Tippfehler `RevisionSchema`) bearbeitet; drei Neustart-/Strip-only-Dateien (`g2Restart`, `g4Restart`, `rate-limiter`) laden `@quiz/shared` per Node-Kindprozess und scheiterten an meiner Zwischenfassung (`ordering.ts:203`). Kein Vorbefund der Basis. | Prozessfehler | Datei korrigiert, die drei Dateien erneut: grün; danach Servertests nie mehr bei laufenden Änderungen am geladenen Code | Wiederholungslauf der drei Dateien grün; vollständiger Lauf 880/881 |
| E5 | Voller Serverlauf: 1 Fehler in `content.integration` (Audio-Upload 200 statt 201) — zuerst lokal auf wiederverwendeter DB, **später auch im ersten CI-Lauf auf frischer Maschine**. Meine erste Erklärung („nur DB-Wiederverwendung“) war unvollständig. **Ursache (belegt am Testcode):** `uploadContentAudio` erzeugt WAVs mit `440 + floor(Math.random() * 400)`; der Test lädt pro Lauf 4 davon für denselben Owner hoch, und der Medienpfad dedupliziert gleichen normalisierten Inhalt je Owner mit **200** — eine Frequenz-Kollision (≈ 1,5 % je Lauf, auf wiederverwendeter DB höher) lässt den Test scheitern. | **vorbestehender Flake**, nicht N3 (kein Medien-/Serverpfad berührt; die übrigen 880 Tests grün) | Nicht im Scope geändert (Empfehlung: eindeutige statt zufälliger Frequenz je Aufruf). Einmal erneut ausgeführt: `CI`-Job im Wiederholungslauf (Attempt 2) grün; lokal auf frischer DB 80/80 Dateien, 881/881 Tests | CI-Lauf [41326363071](https://github.com/joern211/quiz-platform/actions/runs/41326363071): Attempt 1 rot (Flake), Attempt 2 `CI` grün |

## 3. Gezielte Gegenprüfung der im Auftrag genannten Fehlerklassen

| Fehlerklasse | Ergebnis |
|---|---|
| Set-Gleichheit statt Reihenfolgevergleich | Nicht vorhanden: alle 24 Permutationen von 4 IDs enthalten dieselbe Menge und werden positionsweise unterschieden; Histogramm 9/8/6/0/1 gegen unabhängiges Orakel; Gruppenfälle gegen vollständige Aufzählung |
| Item-ID / Label / Index verwechselt | Doppelte Labels: Abgabe/Vergleich/UI arbeiten über IDs (Test mit zwei „Gleich“); Entwurf bleibt bei Items-Umordnung an IDs gebunden; Scope-Key ohne Labels |
| Unbekannte/doppelte IDs still entfernt | Nein — Gesamtablehnung; Längengleiche falsche Menge (`[a,a,c]`) wird erkannt |
| Lösungs-/Gruppen-/Sortierwert im Browser | Config strikt (auch auf Item-Ebene); `OrderingForm` rendert Config mit Zusatzschlüsseln nicht (Text taucht nicht im DOM auf); Referenz weder in Props noch im Zustand noch in Config-/Scope-Key |
| Korrektheitsorakel vor Reveal | Projektion: auch Besitzer ohne Fakten/Revision, `COMPARED` geklemmt; Reveal nur bei geschlossener Runde; Fehlercodes ohne Inhalte; **neue Beobachtung:** `ORDERING_ALREADY_COMPARED`/`_STALE_SUBMISSION` sind rein serverseitige Codes der Übernahme (Host/Engine), keine Spielerfunktion |
| Config-/Referenzwechsel ohne neue Bindung | Scope pinnt Run, Runde, Item-IDs **mit Reihenfolge** und Referenzrevision; neu gemischte Startliste wird abgewiesen. **Restgrenze:** Der *Inhalt* einer Revision ist nicht im Zustand gepinnt (Hash erwogen und bewusst verworfen, `decisions.md` §3.4) — er muss je Revision unveränderlich sein |
| Lock nur auf vorhandenen Records | Nein — Rundenlock; Teilnehmer ohne Record und leere Runde getestet |
| Mutations-Aliase | Eingabe/Zustand/Projektion/Outcome getestet; Mutation einer Kopie verändert Original nie |
| UI-Fokus nach Randbewegung | Chromium: Fokus bleibt am Rand und bei wiederholten Tasten; Shift+Tab → „nach oben“; nach Submit Statuszeile; nach retryable Fehler Retry-Button (E1) |
| Move-Button als Submit | `type=button` für alle Move-Buttons; Enter/Space bewegen genau einmal und senden nie (jsdom + Chromium) |
| Feedback vor UND nach `LOCKED` | alter Versuch bleibt ignoriert (mit/ohne Daten, vor/nach dem Lock); regulärer Lock ohne Daten erhält die bestätigte Reihenfolge; Kontextwechsel löscht sie; ohne Bestätigung zeigt Lock den Entwurf |

## 4. Verbleibend (bewusst nicht behauptet)

- Kein echter Engine-Verbraucher; Socket-/DB-/Neustart-/Rejoin-/Recovery-/echte Projektions-/Limiter-/CAS-/Receipt-/E2E-Nachweise fehlen (`matrix.md` §3).
- Fokus-Wiederherstellung nach Move: Kontrakt in Chromium belegt, die Wiederherstellung selbst nicht als notwendig; kein Safari/iPhone-Nachweis (Chromium-Emulation ersetzt ihn nicht).
- Referenzinhalt je Revision unveränderlich: Pflicht des Content-Snapshots, in N3 nicht erzwingbar.
- Item-IDs öffentlich: wertcodierte/zufällig korrekt sortierte Startlisten kann kein Parser erkennen.
- Kein Drag & Drop (bewusst).
- Die Ladeinvariante `submittedAtMs ≤ closedAtMs` setzt eine monotone Serverzeit voraus; ein Close mit früherer Zeit wird abgewiesen statt einen beschädigten Zustand zu erzeugen.
