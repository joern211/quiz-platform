# Midnight-UI — Abnahme (Route / Rolle / Zustand → Nachweis)

Prüfumgebung: lokaler Container, Node 22, pnpm 9.12.0, isolierte SQLite-DBs (`/tmp/qp-dev-midnight.db` für Screenshots, `/tmp/test-e2e.db` für E2E, `/tmp/quiz-server-test.db` für Server-Tests), Chromium 1.63 (Playwright). Alle Screenshots mit synthetischen Testdaten (Seed-Fragen, Namen „Alexandra Mustermann-Langname“/„Bo“, 0-Punkte-Stände).

**Ehrliche Grenze:** Kein Safari und kein echtes iPhone/Android-Gerät verfügbar. „Mobil“ bedeutet hier Chromium-Emulation (`isMobile`, Touch, 320/360/390 px) – kein Ersatz für einen Hardwaretest (Safe-Area, iOS-Bildschirmtastatur, `100dvh`-Verhalten).

## Automatisierte Nachweise

| Bereich | Nachweis | Ergebnis |
| --- | --- | --- |
| Präferenz speichern/laden, Migration `quiz-theme`, defekte/alte/unbekannte Werte je Achse, blockierter Speicher, kein Storage-Echo | `apps/web/src/lib/__tests__/appearance.test.tsx` | grün |
| Kontrast aller 6 Familien × 2 Themes + Grund-/Statusfarben; Vorschau-Farben = Tokens; index.html-Frühanwendung kennt Schlüssel/Version/Familien | dito (Mutationsprobe: abgeschwächtes Token → Test rot) | grün |
| Theme-/Akzentwechsel: kein Remount, keine Aktion, Eingabe bleibt; Themewechsel behält Akzent; Tab-Sync ohne Rückschreiben | dito | grün |
| Darstellungsdialog: Namen, „Ausgewählt“-Text, sofort angewendet + gespeichert, Zurücksetzen, Escape; Hinweis bei Speicherverbot | dito | grün |
| UI-1: zwei Browser im selben Raum unabhängig; Hauptaktion nimmt Akzent sofort an; Frühanwendung bei blockiertem App-Skript; defekter Wert → Standard, App bedienbar | `apps/web/e2e/ui-midnight-e2e.spec.ts` | grün (3× ohne Retry) |
| UI-2: Wechsel (5 Akzente + Hell/Dunkel) während laufender Frage: keine Spiel-/Raum-Events, keine neue WebSocket-Verbindung, gleiche Route/Frage, Fokus zurück, Antwort danach genau einmal | dito | grün |
| UI-3: 360 px – Menü oben (≥ 44 px), Escape + Fokusrückgabe, „Räume“ führt zur echten Seite, Dialog-Focus-Trap (14× Tab), kein horizontales Scrollen | dito | grün |
| UI-4: vorzeitiges Beenden fordert Bestätigung; Fokus auf „Abbrechen“; Escape sendet kein `game:end`; Bestätigen beendet für Host und Spieler | dito | grün |
| UI-5: Spielstart, während der Spieler den Dialog offen hat: Route folgt, Dialog bleibt bedienbar, keine Commands, Antwort danach normal | dito | grün |
| UI-6 (R1): Info-Popups der echten Kategorien bei 320/390/430/1280 px in Hell und Dunkel vollständig im Viewport; Ecken, Mitte und jede Textzeile per `elementFromPoint` tatsächlich treffbar; Schließen per Mausklick und Escape mit Fokusrückgabe; Trigger/Schließen ≥ 44 px | dito; **Gegenprobe:** derselbe Test scheitert gegen das alte Popup auf allen vier Breiten | grün (3× ohne Retry) |
| Bestehende Abläufe (Geo/Wissensduell, Jeopardy J1–J10, Wer ist das? W1–W10, Teams/Raum inkl. Abbruch/Schließen über neuen Dialog, Medien M1–M5 inkl. DISPLAY, öffentliche Räume, Prejoin, Content, G5-B1 360 px mit verschärfter Überlaufmessung) | gesamte Playwright-Suite | lokal 45/45 am Commit `82b89f8`; CI siehe `handoff.md` |
| 0 / negative Punkte / Gleichstand / Revisionen | `ResultScreen.test.tsx` (unverändert grün, Texte „Alice: 0 Punkte“, „Cara: -100 Punkte“), neue Kennzeichnung „gleichauf“ | grün |
| Recovery/Read-Fehler mit „Erneut laden“ | `GeoRecovery.test.tsx`, `useGameCore.test.tsx` (unverändert grün) | grün |

## Visuelle Abnahme (selbst angesehen)

Screenshots: `docs/implementation/ui-midnight/screenshots/` (Auswahl, JPEG). Vollständige Läufe mit `qa-screens.js` (Ausgabe nicht eingecheckt):

**Stand nach Nachbesserung (Prüfbericht PR #29), Commit `82b89f8`.** Überlauf gemessen als `documentElement.scrollWidth − documentElement.clientWidth`; bei Befund nennt das Skript den verursachenden Elementpfad.

> **Korrektur:** Die erste Abnahme verglich mit `window.innerWidth`. In Chromiums Mobil-Emulation wächst `innerWidth` mit überbreitem Inhalt (gemessen: 333 statt 320 px), Überläufe auf Handybreiten waren damit unsichtbar. Die früheren Angaben „kein Overflow“ für 320/390 px waren nicht belastbar; die korrigierte Messung fand sieben echte Überläufe (siehe `review.md`, Nachprüfung N4–N7), alle behoben.

| Lauf | Breite / Theme / Akzent | Ansichten | Überlauf |
| --- | --- | --- | --- |
| Desktop dunkel | 1440 / dunkel / Lila | statische Seiten inkl. echter Kategorien `/kategorie/quiz-wissen` und `/kategorie/buzzer-reaktion` mit geöffneten Info-Popups, Wissensduell (Lobby H/P/V, Frage H/P/V, Auswahl, Reveal, Bestätigung, Ergebnis H/P/V, DISPLAY), Jeopardy (Setup, Lobby, Board H/P/V, Frage, Buzz, Urteil), Wer ist das? (Setup, Runde H/P/V, Buzzer, Urteil, Ausschluss, Reveal, Ergebnis) | keiner |
| Desktop hell | 1440 / hell / Grün | wie oben | keiner |
| Laptop | 1280 / dunkel / Türkis | wie oben | keiner |
| Tablet | 768 / dunkel / Blau | wie oben | keiner |
| Handy | 430 / hell / Rosa | wie oben | keiner |
| Handy | 390 / hell / Lila | wie oben inkl. Mobilmenü und Darstellungsdialog | keiner |
| Schmal | 320 / dunkel / Orange | wie oben | keiner (vorher 7 Befunde) |
| Header mit aktivem Raum | 320, 390, 641, 768, 900, 1024, 1101, 1180, 1280, 1366, 1440 | Elemente außerhalb, Überlappungen, Überlauf | keiner (vorher 1101–1250 px: bis 114 px) |
| Akzentmatrix | 1100 / 2 Themes × 6 Akzente | Startbühne + Darstellungsdialog | – |

Kategorieprüfung: Vor jeder Aufnahme werden Überschrift (h1) und die erwarteten echten Spielkarten (h3 „Wissensduell“ bzw. „Jeopardy“, „Wer ist das?“) geprüft; danach wird jedes „Info zu …“ geöffnet, Lage im Viewport und Treffbarkeit gemessen. Die frühere Aufnahme `/kategorie/wissen` zeigte eine leere, nicht existierende Kategorie und war kein Nachweis (R2).

Zuvor scheiterten die Jeopardy- und Wer-ist-das?-Abläufe im Vorher-Lauf bei 390 px (Bedienelemente nicht erreichbar); im Nachher-Lauf laufen alle Abläufe auf 390 px durch.

Repräsentative Vorher/Nachher-Paare (`before-*.jpg` / `after-*.jpg`): Startseite (Desktop, Handy), Host-Lobby, Wissensduell-Frage und -Auflösung, Jeopardy-Frage, Wer ist das?-Buzzer, Ergebnis. Zusätzlich nur nachher: Jeopardy-Urteil, DISPLAY, WID-Urteil, Darstellungsdialog, Mobilmenü, Bestätigungsdialog, Akzentmatrix. Nachbesserung: geöffnete Info-Popups echter Kategorien (320 dunkel, 430 hell, Desktop dunkel), Kategorie Desktop hell, Zuschauen/Jeopardy-Setup/WID-Setup bei 320 px, Header mit aktivem Raum bei 1180 px; `after-mobile-light-jp-player-board.jpg` neu (alte Fassung zeigte „(Du) (Du)“).

## Rollen und Informationsgrenzen

- Keine neuen Daten an den Browser: Änderungen sind Darstellung/Struktur; Lösungen erscheinen weiterhin nur dort, wo sie vorher auftauchten (Jeopardy „Geheime Lösung (nur Moderator)“, WID-Originale nur Host). E2E W1–W10 und J-Tests prüfen die Secret-Grenzen unverändert.
- DISPLAY: read-only, keine Host-/Player-Aktionen (M5 unverändert), Phase in Klartext.
- Darstellungseinstellung wird nie an den Server gesendet (UI-2/UI-5 messen ausgehende Events).
- 200 % Zoom: entspricht ca. 720 CSS-px bei 1440er Fenster; über die 768-px- und 390-px-Läufe abgedeckt (Menü klappt unter 1100 px ein), nicht separat mit Browser-Zoom gemessen.
