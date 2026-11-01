# Midnight-UI — Inventarmatrix (vor Umsetzung erstellt)

Base: main `975165e` (G5 / PR #28 gemergt). Quelle der Routen: `apps/web/src/App.tsx`.
Erfasst sind nur tatsächlich erreichbare Oberflächen. Prüfweg: **S** = Screenshot-Lauf mit echten Räumen (`docs/implementation/ui-midnight/qa-screens.js`), **U** = Vitest, **E** = Playwright-E2E.

| Route / Ansicht | Rollen | Gemeinsame Bausteine | Notwendige Gestaltung | Kritische Zustände | Prüfweg |
| --- | --- | --- | --- | --- | --- |
| App-Rahmen: Header, Mobilmenü, Footer | alle | `Header`, `Logo`, `useTheme` | Midnight-Topbar, doppelter Logotext entfernen, Einstellungsdialog, Menü oben | Menü offen/zu, Escape, aktiver Raum, schmale Breiten | S, U, E |
| `/` Startseite | anonym | `Button`, `Card`, Katalog | Bühne mit Lichtkegeln (akzentabhängig), horizontale Spielkarten, erfundene Kennzahlen (`2+`, `∞`) entfernen | reduzierte Bewegung, 320 px | S |
| `/kategorien`, `/kategorie/:slug`, `/spiel/:slug` | anonym | `GameCard`, `Badge` | Programmkarten, Statusbadges mit Text | geplante/Beta-Spiele | S |
| `/beitreten`, `/zuschauen`, `/moderator/anmelden` | anonym/Host | `Input`, `Button` | Formulare, Fehlerzustand dauerhaft | Pending, Ablehnung, Tastatur | S, U |
| `/moderator/vorbereitung/*`, `/moderator/schnellstart/:slug` | HOST | Setup-Seiten, `SetupBlueprints`, `SetupRoomRules`, `ContentPoolPicker` | Formularflächen, Sektionen, Hauptaktion | Upload/Erzeugen pending, Fehler | S, E |
| `/moderator/raeume` | HOST | `RoomsPage` | Liste/Karten | leer, Fehler | S, U |
| Lobbys Host/Player/Viewer | HOST/PLAYER/VIEWER | `RoomPanel`, `LiveMediaPanel`, `MediaDeviceCheck`, `Badge` | Raumcode-Banner, Spielerkarten, Ready-Status mit Text | Ready pending, Startblocker, Warteliste | S, U, E |
| RoomPanel (Raum & Teams) | alle außer DISPLAY | `RoomPanel` | Panel-Struktur, Aktionsgruppen, destruktive Aktionen rot + bestätigt | Rechteentzug, Pending, Fehler | S, U, E |
| LiveMediaPanel / DISPLAY `/raum/:code/broadcast` | alle / DISPLAY | `LiveMediaPanel`, `BroadcastPage` | Medienpanel gruppiert, DISPLAY groß und read-only | Host-Mute, entzogene Rechte, keine Host-Aktionen | S, E |
| GameShell | alle Spielansichten | `GameShell`, `Timer` | Statusleiste mit deutscher Phase, Verbindungsstatus mit Text | Getrennt, Fehler (`role=alert`) | S, U |
| Wissensduell Host/Player/Viewer + Ergebnis | HOST/PLAYER/VIEWER | `useGameCore`, `RecoveryControl`, `ResultScreen`, `Scoreboard` | Bühne für Frage, Antwortpillen, Joker, Feedback richtig/falsch mit Text | Abgabe pending, Reveal, Pause, Recovery-Read-Fehler | S, U, E |
| Jeopardy Host/Player/Spectator | HOST/PLAYER/VIEWER | `JeopardyBoard`, `JeopardyQuestion`, `BuzzerButton` | Board bleibt Board, Kategorien lesbar, beschrifteter Scrollbereich | Buzz offen/gesperrt, Steal, Urteil | S, E |
| Wer ist das? Host/Player/Viewer | HOST/PLAYER/VIEWER | `WerIstDasGamePage`, `BuzzerButton` | Bildbühne, Buzzer groß, Hinweis/Reveal | Buzzer gesperrt, Hinweis aktiv, Reveal | S, E |
| Ergebnisseiten (Moderator/Player/Viewer) | alle | `ResultScreen`, `RecoveryControl` | Podium/Rangliste, 0/negativ/Gleichstand | Revision, Lesefehler + erneut laden | S, U |
| `/inhalte`, `/inhalte/playtest/:code` | HOST/ADMIN | Content-Komponenten | Konsistente Formulare/Buttons via Basisstile | Konflikt, Sperre, Bestätigungen | S, E |
| `/spieler/profil`, `/admin/*`, 404 | Spieler/ADMIN | — | Konsistente Flächen | leer/Fehler | S |

Bewusst nicht als neue Seite gebaut: im Regelwerk nur geplante Oberflächen (Event/Olympia, Statistiken, weitere Spiele).
