# Midnight-UI — getrennte Eigenprüfung

Erster Durchgang: durchgeführt nach dem ersten integrierten Stand (Commit `155a237`: Typecheck, Lint, Web-Tests und neue E2E grün), unabhängig vom Umsetzungsablauf: Diff gegen `origin/main` gelesen, Auftragsmatrix (`matrix.md`) erneut abgeglichen, Screenshots aller Rollen in Dunkel/Hell, 320/390/768/1440 px und alle 12 Theme×Akzent-Kombinationen angesehen.

## Gegenfragen und Ergebnis

| Gegenfrage | Prüfung | Ergebnis |
| --- | --- | --- |
| Midnight erkennbar oder nur Tokens? | Vergleich mit Entwurfs-Screenshots (Start, Lobby, Spiel, Ergebnis) | Erkennbar: Bühne mit Lichtkegeln, Programmkarten, Code-Banner, Spielerkarten, zentrierte Frage im Licht, runde Antworten, Pokal-Ergebnis. Strukturänderungen in Home, Header, Lobby, GameShell, Spielseiten, Ergebnis, DISPLAY. |
| Ungestaltete echte Seiten/Dialoge? | Skript prüft, ob jede in TSX benutzte CSS-Modulklasse existiert; Kontaktbögen aller Seiten | Neu gestaltete Module vollständig. Klassenlose Controls (Content-Editor, Setup, WID-Moderation, Medienpanel) erhalten Midnight-Basisstile. Drei fehlende Klassen sind vorbestehend in unberührten Dateien (`Scoreboard .ko`, `GamePage .category`, ungenutzte `GeoSetupPage`). |
| Status-/Teamfarben bei jeder Akzentwahl eindeutig? | 12-Kombinationen-Bogen, Antwort-/Urteilsansichten | **Befund B3** (siehe unten) behoben; Teamfarben stammen aus Raumdaten, unverändert. |
| Remountet ein Provider/eine Spielfläche beim Wechsel? | Vitest „remountet keine Spielfläche“ (Mount-Zähler, Eingabeelement identisch); E2E UI-2 (WebSocket-Anzahl, ausgehende Events) | Kein Remount, keine neue Verbindung, keine Spiel-/Raum-Events. |
| Verliert ein Formular Eingaben / die Partie ihre Identität? | Vitest: getippter Antwortentwurf bleibt; E2E UI-2: gleiche Route, gleiche Frage, Antwort danach genau einmal gespeichert | Erhalten. |
| disabled/pending/error/retry mobil + Tastatur? | E2E UI-3 (Menü, Fokus, Focus-Trap), G5-B1 (360 px), GeoRecovery-Test (Erneut laden) | Erreichbar; **Befund B2** (Pending-Name) behoben. |
| Reconnect/verspätetes ACK bei offenem Einstellungsdialog? | E2E UI-5: Host startet, während Spieler im Dialog ist | Route folgt dem Server, Dialog bleibt bedienbar, danach normale Antwort. Rechteentzug: Dialog liegt per Portal außerhalb von RoomPanel/Spielseite und hält keinen Raumzustand – strukturell unabhängig, nicht separat per E2E geprüft. |
| Light-Modus und kleine Displays gleichwertig geprüft? | QA-Läufe Hell 1440 + 390, Dunkel 1440/768/320 | Damals als „ja“ bewertet; **Befund B4** (320 px) behoben. *Nachträglich korrigiert:* Die Überlaufmessung war auf Handybreiten blind (siehe Nachprüfung N4). |
| Echte Funktion vs. Demo/Planned sauber getrennt? | Startseite, GameCard | Erfundene Kennzahlen entfernt; geplante Spiele bleiben als „Geplant“ mit „Details“ statt „Spielen“; keine Demo-Daten. |

## Tatsächliche Befunde und Korrekturen

| # | Befund | Schwere | Korrektur | Nachweis |
| --- | --- | --- | --- | --- |
| B1 | Navigation „Räume“ (Header) und „Öffentliche Räume anzeigen“ (Beitreten) verlinkten auf `/raeume` → 404 (vorbestehend) | hoch | Links auf `/moderator/raeume` | E2E UI-3 klickt „Räume“ und erwartet die Seite |
| B2 | `Button loading` blendete den Text per `visibility:hidden` aus → Button ohne zugänglichen Namen während Pending | mittel | Spinner neben sichtbarem Text, `aria-busy` | Lobby „Spiel starten“, Recovery-Button; G5-/Geo-E2E finden Buttons weiter per Name |
| B3 | „✓ RICHTIG“ im Jeopardy-Urteil nutzte die Akzentfarbe (bei Rosa/Orange irreführend); Rosa-Akzent ähnelt der dunklen Fehlerfarbe | mittel | Neue Variante `success` (fest grün) für Richtig-Urteile; kritische Buttons mit ⚠-Symbol; Antworten mit Textmarken | Kontaktbogen 12 Kombinationen; Screens `jp-host-judge` |
| B4 | 320 px: Antwortmarke „✗ Deine Antwort“ quetschte den Antworttext („Chi/na“) | niedrig | Marke darf in eigene Zeile umbrechen | Screen `w320-dark/wd-player-reveal` |
| B5 | Host-Lobby hatte doppelte Verwaltungsaktionen mit abweichender Logik: „✕“-Kick über Legacy-Event `room:kick`, „Raum schließen“ per REST mit ignoriertem Fehler und sofortiger Navigation (Erfolg vor Bestätigung) | mittel | Entfernt; zentrale Aktionen im RoomPanel (`room:command`, mit Bestätigung) | team-room-E2E schließt den Raum über RoomPanel; public-rooms-E2E entfernt über RoomPanel |
| B6 | Destruktive Aktionen per nativem `confirm()` bzw. ohne Bestätigung („Spiel beenden“ Wissensduell/WID) | mittel | `ConfirmDialog` (Fokus auf Abbrechen); am regulären Ende (letzte Frage aufgelöst) ohne Rückfrage | E2E UI-4 (Escape lässt Partie laufen, kein `game:end`); team-room-E2E angepasst (Dialog statt `page.on('dialog')`) |
| B7 | Logo als `<Link>` im Header-`<Link>` (verschachtelte Links), Produktname doppelt angezeigt | niedrig | Logo ist reines Bild/Text, Header stellt den Link | Screens |
| B8 | GameShell erzeugte ein zweites `<main>` und zeigte interne Phasen-IDs (`INPUT_OPEN`) | niedrig | `<div>`, deutsche Phasenbezeichnung (ID bleibt als `data-phase`) | Screens |
| B9 | Timer-Fortschritt nahm pauschal 20 s an; CSS-Klassen des Timers existierten nicht | niedrig | Dauer ab erster Anzeige; Balken + Zahl gestaltet, `role="timer"` ohne Live-Region-Spam | Screens |
| B10 | WID-Setup-Statusfarben fest auf Hell optimiert (`#1a7f37` auf Dunkel zu dunkel) | niedrig | Tokens `--ok`/`--danger` | – |
| B11 | Fehlgeschlagenes QR-Bild zeigte Alt-Text, da `display:grid` das `hidden`-Attribut überschrieb | niedrig | `[hidden]` global erzwungen | Screens mobil |
| B13 | E2E UI-5 maß ausgehende Events über den servergesteuerten Seitenwechsel hinweg; `media:join`/`media:self` stammen vom (bestehenden) Medien-Neubeitritt nach Spielstart, nicht vom Dialog. In der lokalen Vollsuite rot | Test | Messfenster auf die Dialoginteraktionen begrenzt, nach Seitenwechsel bis zur Ruhe der Events gewartet | 3× wiederholt ohne Retry grün |
| B14 | Eingecheckte QA-Hilfsskripte als `.cjs` wurden von ESLint erfasst (20 Fehler) – CI rot an `8320594`/`81db1b9`; Lint war nach dem Hinzufügen lokal nicht erneut gelaufen | Prozess | Als ESM-`.js` (Repo-Konvention, wie andere `.js` vom Lint ausgenommen); Lint-Konfiguration unverändert | `pnpm lint`: 0 Fehler, 109 Warnungen wie `main` |
| B12 | E2E UI-1 maß die Buttonfarbe während des 150-ms-Übergangs (flaky) | Test | Wiederholende Assertion `toHaveCSS` | 3× wiederholt ohne Retry grün |

## Bewusst nicht geändert / verbleibend

- **Content-Editor-Bestätigungen** (`window.confirm` in Content-Komponenten) bleiben nativ: zahlreiche Content-E2E stützen sich darauf; Gestaltung über Basisstile. Kein Spiel-/Raumkontext.
- **QR-Code in der Host-Lobby** lädt weiterhin von `api.qrserver.com` (überträgt Beitritts-URL inkl. Raumcode an Dritte). Vorbestehend, keine Designfrage – als Datenschutzpunkt zur Nutzerentscheidung gemeldet.
- **`BuzzerButton` (packages/ui)** reagiert global auf Leertaste, auch in Textfeldern. Die Komponente wird von keiner Seite verwendet; nur Farben angepasst, Logik unverändert.
- Kick über RoomPanel („Entfernen“) bleibt ohne Rückfrage (nicht endgültig, Rejoin möglich); „Sperren“ ist bestätigt.
- Lint: 109 Warnungen, identisch mit `main` (0 Fehler); keine neuen Warnungen.

## Nachprüfung nach externem Prüfbericht (PR #29, Head `11c2a56`)

Getrennter zweiter Durchgang nach Korrektur von R1–R3: Popup-Clipping, Viewportkanten, mobile Bedienung, Fokus, Hell/Dunkel, echte statt leerer Kategorie, Header mit aktivem Raum in Zwischenbreiten. Dabei wurde ein methodischer Fehler der ersten Abnahme entdeckt (N4).

| # | Befund | Herkunft | Korrektur | Nachweis |
| --- | --- | --- | --- | --- |
| R1 | Info-Popup der Spielkarten wurde vom `overflow: hidden` der neuen `GameCard` und am linken Viewportrand abgeschnitten | Prüfbericht; im Browser bestätigt | `InfoPopup` per Portal am `<body>`, `position: fixed`, an den Viewport geklemmt (oben, sonst unten, sonst eingepasst), bei Scroll/Resize neu platziert; Escape/Schließen mit Fokusrückgabe; Schließen bei Klick/Fokus außerhalb; eindeutige IDs statt mehrfachem `id="info-title"`; Trigger und Schließen 44 px | E2E UI-6 (320/390/430/1280, hell/dunkel, `elementFromPoint` für Ecken, Mitte, jede Zeile). **Gegenprobe:** gegen das alte Popup scheitert UI-6 auf allen vier Breiten (x ≈ −16 px bzw. verdeckte Punkte) |
| R2 | QA nahm `/kategorie/wissen` auf – existiert nicht, leere Ansicht | Prüfbericht | `/kategorie/quiz-wissen` und `/kategorie/buzzer-reaktion`; vor Aufnahme h1 + echte Spielkarten geprüft; Info-Popups geöffnet und vermessen | `qa-screens.js`, Läufe auf 7 Breiten |
| R3 | „(Du)“ doppelt (Text + CSS `::after`) in Jeopardy | Prüfbericht | CSS-Duplikat in allen drei Jeopardy-Modulen entfernt; Kennzeichnung bleibt im Text | Screenshot `after-mobile-light-jp-player-board.jpg` |
| – | Whitespace `InfoPopup.module.css:29` | Prüfbericht | entfernt | `git diff --check` leer |
| N1 | Eigene Messfehler im neuen Test: Eckpunkte 3 px lagen außerhalb der Rundung (Radius 20 px) und trafen das Element darunter – erster UI-6-Lauf rot | eigene Prüfung | Punkte 8 px innen; fehlschlagende Punkte werden ausgegeben | Gegenprobe danach erneut durchgeführt (siehe R1) |
| N2 | Header mit aktivem Raum lief zwischen 1101 und ca. 1250 px über (bis 114 px horizontal, Darstellungs-/Theme-Button außerhalb) | Prüfpunkt des Berichts, gemessen | Mit aktivem Raum wandert die Navigation bis 1279 px ins obere Menü | Messung 11 Breiten: keine Elemente außerhalb, keine Überlappung, kein Überlauf |
| N3 | Zuschauen-Seite: Überschrift stand neben der Formular-Karte (gemeinsames Formularseiten-CSS als Flex-Zeile), 36 px Überlauf bei 320 px | eigener Fehler aus Durchgang 1 | Formularseiten als Spalte | QA 320 px |
| N4 | **Methodischer Fehler der ersten Abnahme:** Überlauf wurde gegen `window.innerWidth` geprüft. In Chromiums Mobil-Emulation wächst `innerWidth` mit überbreitem Inhalt (gemessen 333 statt 320 px) – die Prüfung war auf Handybreiten blind. Betraf QA-Skript, eigene E2E UI-3/UI-6 und den bestehenden G5-B1-Helfer | eigene Prüfung | Messung gegen `documentElement.clientWidth` überall; G5-B1 damit verschärft, nicht abgeschwächt | Volle Suite 45/45 mit verschärfter Messung |
| N5 | Durch N4 sichtbar: lange Einzelwort-Überschriften („Spielekategorien“) bei 320 px | vorbestehend, durch Systemschrift verstärkt | Überschriften `overflow-wrap: break-word; hyphens: auto`; Kategorien-Titel per `clamp()` | QA 320 px |
| N6 | Durch N4 sichtbar: Jeopardy-Setup-Wertauswahl, Display-Link-Feld (Medienpanel), RoomPanel-Auswahlfeld „Vorbereitetes Spiel“ (bis 85 px) | teils vorbestehend | `min-width: 0` / flexible Breiten für Felder in Flex-Zeilen | QA 320/390 px |
| N7 | Durch N4 sichtbar: WID-Setup-Runden als `<fieldset>` mit Standard-`min-width: min-content` (18 px) | vorbestehend | `min-width: 0` für alle Fieldsets global | QA 320 px |

Weiterhin offen (unverändert): Kein Safari/iPhone-Hardwaretest; Content-Editor nutzt native `confirm()`; externer QR-Dienst.
