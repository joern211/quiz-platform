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
| Bestehende Abläufe (Geo/Wissensduell, Jeopardy J1–J10, Wer ist das? W1–W10, Teams/Raum inkl. Abbruch/Schließen über neuen Dialog, Medien M1–M5 inkl. DISPLAY, öffentliche Räume, Prejoin, Content, G5-B1 360 px) | gesamte Playwright-Suite | siehe `handoff.md` (Lauf am finalen Stand) |
| 0 / negative Punkte / Gleichstand / Revisionen | `ResultScreen.test.tsx` (unverändert grün, Texte „Alice: 0 Punkte“, „Cara: -100 Punkte“), neue Kennzeichnung „gleichauf“ | grün |
| Recovery/Read-Fehler mit „Erneut laden“ | `GeoRecovery.test.tsx`, `useGameCore.test.tsx` (unverändert grün) | grün |

## Visuelle Abnahme (selbst angesehen)

Screenshots: `docs/implementation/ui-midnight/screenshots/` (Auswahl, JPEG). Vollständige Läufe mit `qa-screens.cjs` (Ausgabe nicht eingecheckt):

| Lauf | Breite / Theme / Akzent | Ansichten | Overflow |
| --- | --- | --- | --- |
| Desktop dunkel | 1440 / dunkel / Lila | 16 statische Seiten, Wissensduell (Lobby H/P/V, Frage H/P/V, Auswahl, Reveal, Bestätigung, Ergebnis H/P/V, DISPLAY), Jeopardy (Setup, Lobby, Board H/P/V, Frage, Buzz, Urteil), Wer ist das? (Setup, Runde H/P/V, Buzzer, Urteil, Ausschluss, Reveal, Ergebnis) | keiner |
| Handy hell | 390 / hell / Lila | wie oben inkl. Mobilmenü und Darstellungsdialog | keiner |
| Desktop hell | 1440 / hell / Lila | statisch, Wissensduell, Jeopardy | keiner |
| Tablet | 768 / dunkel / Türkis | statisch, Wissensduell, Wer ist das? | keiner |
| Schmal | 320 / dunkel / Orange | statisch, Wissensduell | keiner |
| Akzentmatrix | 1100 / 2 Themes × 6 Akzente | Startbühne + Darstellungsdialog mit Vorschau (Hauptaktion, Ausgewählt, Link), Fokus | – |

Zuvor scheiterten die Jeopardy- und Wer-ist-das?-Abläufe im Vorher-Lauf bei 390 px (Bedienelemente nicht erreichbar); im Nachher-Lauf laufen alle Abläufe auf 390 px durch.

Repräsentative Vorher/Nachher-Paare (`before-*.jpg` / `after-*.jpg`): Startseite (Desktop, Handy), Host-Lobby, Wissensduell-Frage und -Auflösung, Jeopardy-Frage, Wer ist das?-Buzzer, Ergebnis. Zusätzlich nur nachher: Jeopardy-Urteil, DISPLAY, WID-Urteil, Darstellungsdialog, Mobilmenü, Bestätigungsdialog, Akzentmatrix.

## Rollen und Informationsgrenzen

- Keine neuen Daten an den Browser: Änderungen sind Darstellung/Struktur; Lösungen erscheinen weiterhin nur dort, wo sie vorher auftauchten (Jeopardy „Geheime Lösung (nur Moderator)“, WID-Originale nur Host). E2E W1–W10 und J-Tests prüfen die Secret-Grenzen unverändert.
- DISPLAY: read-only, keine Host-/Player-Aktionen (M5 unverändert), Phase in Klartext.
- Darstellungseinstellung wird nie an den Server gesendet (UI-2/UI-5 messen ausgehende Events).
- 200 % Zoom: entspricht ca. 720 CSS-px bei 1440er Fenster; über die 768-px- und 390-px-Läufe abgedeckt (Menü klappt unter 1100 px ein), nicht separat mit Browser-Zoom gemessen.
