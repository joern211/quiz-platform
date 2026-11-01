# Midnight-UI — Design, Tokens und persönliche Darstellung

## Quelle und Umfang

Referenz ist ausschließlich das Konzept **„Midnight“** aus `Quiz-Plattform_UI-Entwuerfe.html` (dunkle Bühne und helle Variante). Atelier-Tabs, Favoriten, Geräte-Simulator, Demo-Reset und die vier anderen Konzepte sind nicht übernommen, ebenso keine Demo-Namen, Demo-Timer, Musterergebnisse oder erfundenen Kennzahlen (die bisherigen Startseitenwerte „2+“ und „∞ Spielspaß“ wurden entfernt; angezeigt wird nur die echte Zahl startbarer Spiele aus dem Katalog).

Übernommene Gestaltungsmerkmale (nicht nur Farben):

| Merkmal im Entwurf | Umsetzung in der Anwendung |
| --- | --- |
| Bühne mit Lichtkegeln und Show-Titel | Startseite `HomePage` (`.stage`, zwei schräge Lichtkegel, radiales Licht) – Licht folgt dem Akzent (`--stage-glow`, `--stage-beam`) |
| Horizontale Programmkarten (Symbolfläche links) | Startseite und `GameCard` (Kategorieseiten); neue `GameArt` mit festen Kennfarben je Spiel |
| Zentrierte Frage im Licht, runde Antworten | Wissensduell Host/Spieler/Zuschauer, Jeopardy-Frage, DISPLAY |
| Code-Banner mit Verlauf, Spielerkarten mit runder Oberkante | Host-Lobby (`ModeratorLobbyPage`) |
| Ergebnis mit Pokal im Lichtkreis | `ResultScreen` |
| Runde Buttons, dezente Konturen, 17 px Flächenradius | `Button` (Pill), `Card`, Formular-Controls, Basisstile für klassenlose Controls in `index.css` |
| Systemnahe Schrift, kräftige Überschriften | Google-Fonts (Inter/Space Grotesk) entfernt; System-Stack, Überschriften 750–850 |

Spielflächen bleiben funktional verschieden: Jeopardy behält das Board (6 Spalten, auf schmalen Geräten in einem beschrifteten, fokussierbaren Bereich seitlich scrollbar), Wissensduell die Antwortauswahl, Wer ist das? Bild/Buzzer/Hinweis.

## Tokens

Datei: `packages/ui/src/styles/tokens.css`. Bestehende Tokennamen (`--bg`, `--surface`, `--surface-2/3`, `--fg`, `--muted`, `--border`, `--accent`, `--accent-strong`, `--accent-rgb`, `--ok`, `--warn`, `--danger`) bleiben erhalten, damit alle CSS-Module ohne Umbenennung folgen. Neu: `--on-accent`, `--accent-tint`, `--accent-soft`, `--focus-ring`, `--stage-*`, `--border-strong`, `--ok-bg`, `--warn-bg`, `--danger-bg`, `--on-danger`, `--on-ok`, `--scrim`, `--radius-pill`, `--tap`.

| Token | Dunkel | Hell | Begründete Abweichung vom Entwurf |
| --- | --- | --- | --- |
| bg | `#11101b` | `#faf5fc` | – |
| surface | `#1c1a2a` | `#ffffff` | – |
| surface-2 (soft) | `#282437` | `#f0e8f4` | – |
| fg (ink) | `#f8f4ff` | `#281c37` | – |
| muted | `#bbb3cf` | `#695674` | – |
| border (dekorativ) | `#3d354f` | `#e1d4e8` | – |
| border-strong (Controls) | `#7a6d93` | `#8d7b99` | **neu:** Entwurfs-Kontur liegt < 3:1; Eingabefelder/Optionsflächen brauchen ≥ 3:1 |
| ok / ok-bg | `#9fdfc0` / `#213a34` | `#236944` / `#e1f1e8` | – |
| danger | `#ffa3b6` | `#b52c46` | – |
| warn / warn-bg | `#ffc979` / `#3b2d17` | `#8a4b00` / `#fcecd5` | **neu** (Entwurf hatte keine Warnfarbe; Vorgabe „Warnungen orange“) |

## Akzentpalette (vordefiniert, keine freie Hex-Eingabe)

| Familie | Dunkel: accent / on-accent / tint | Hell: accent / on-accent / tint |
| --- | --- | --- |
| **Lila (Standard)** | `#e1b0f4` / `#2a0b36` / `#392346` | `#763a91` / `#fff` / `#efdef6` |
| Blau | `#a7c8ff` / `#0b1f3f` / `#1f2d4a` | `#2456b5` / `#fff` / `#dfe8fa` |
| Türkis | `#7fdad3` / `#04302c` / `#173a3a` | `#0b6b69` / `#fff` / `#d5efed` |
| Grün | `#addf9c` / `#11340a` / `#213a22` | `#2f6a27` / `#fff` / `#dfefd9` |
| Orange | `#ffbf87` / `#3d1c02` / `#3f2a1b` | `#9a4708` / `#fff` / `#fbe5d2` |
| Rosa | `#ffadd2` / `#3d0a25` / `#432238` | `#a5306a` / `#fff` / `#f9dfeb` |

Hover/Active (`--accent-strong`) und Fokus (`--focus-ring` = Akzent) sind je Familie definiert. Gemessene Mindestwerte (automatisiert in `apps/web/src/lib/__tests__/appearance.test.tsx`, je Familie × Theme):

- Akzent als Text/Link/Fokus auf bg, surface, surface-2: **≥ 5,29:1** (schwächster Fall: Türkis hell auf surface-2)
- Text auf Hauptaktion (on-accent/accent) und Hover: **≥ 6,32:1**
- Haupttext auf ausgewählter Fläche (fg/tint): **≥ 11,38:1**
- Auswahlrahmen auf Tint: **≥ 5,19:1**
- Grund/Status: muted/surface-2 ≥ 5,51:1, Control-Kontur ≥ 3,60:1, ok/warn/danger auf ihren Flächen ≥ 5,05:1

Der Test schlägt nachweislich an (Mutationsprobe: abgeschwächtes `--on-accent` → rot).

## Semantik bleibt getrennt vom Akzent

Erfolg grün, Warnung orange, Fehler rot – unabhängig von der Akzentwahl. Zusätzliche Nicht-Farb-Signale, weil Grün- bzw. Rosa-Akzent den Statusfarben ähneln:

- Antworten: „Ausgewählt“, „✓ Richtig“, „✗ Deine Antwort“ als Text; falsch zusätzlich gestrichelter Rahmen.
- Jeopardy-/WID-Urteile: „✓ RICHTIG“ in fester Erfolgsfarbe (`Button variant="success"`), „✗ FALSCH“/„Falsch · −1“ in Fehlerfarbe.
- Kritische Buttons (`variant="danger"`): Warnsymbol ⚠ (für Screenreader stumm) plus eindeutiger Text.
- Hinweise/Ausschluss bei Wer ist das?: Symbol + Text; Fehler mit ⚠ und dauerhaft am Ort.
- Teamfarben kommen unverändert aus den Raumdaten (`team.color`) und werden nicht umgefärbt.
- Spielkennfarben in `GameArt` sind fest je Spiel, nicht akzentabhängig.

## Theme- und Präferenzverhalten

Zentral in `packages/ui/src/providers/appearance.ts` + `ThemeProvider.tsx`:

- Zwei unabhängige Einstellungen: `data-theme` (dark/light) und `data-accent` am `<html>`.
- Speicherung: `localStorage['quiz-appearance'] = {"v":1,"theme":…,"accent":…}`. Der bisherige Schlüssel `quiz-theme` wird gelesen (Migration) und weiter mitgeschrieben (Rückwärtskompatibilität).
- Ohne Präferenz: Midnight dunkel + Lila. Ein Systemmodus war vorher faktisch nicht implementiert (Fallback war immer dunkel) und wird nicht neu eingeführt.
- Validierung je Achse: defekter JSON-Wert, unbekannte Version, unbekanntes Theme oder freie Hex-Werte fallen kontrolliert auf den Standard zurück, ohne die andere Achse zu verwerfen.
- Speicherfehler (blockiertes Storage, Quota) werfen nicht; die Wahl wirkt dann bis zum Neuladen, der Dialog sagt das offen.
- Frühanwendung: kleines Inline-Skript in `apps/web/index.html` setzt Theme/Akzent vor dem App-Bundle (per Test mit Schlüsseln/Familien abgeglichen; E2E UI-1 prüft es bei blockiertem App-Skript).
- Tabs: `storage`-Ereignis übernimmt Änderungen; geschrieben wird nur bei echter Änderung (kein Echo).
- Wechsel ändert nur Attribute; kein `key`, kein Remount von App/GameShell/Socket-/Medienzustand. `App` hängt nicht mehr vom Theme ab.

**Reichweite:** nur dieser Browser auf diesem Gerät. Es gibt keine Account-Synchronisierung; Spielende haben ohnehin kein Konto. Ein anderer Browser oder ein anderes Gerät startet mit dem Standard. Die Wahl wirkt nie raumweit und wird nicht an den Server gesendet.

## Bedienung

- „Darstellung“ in der oberen Navigation (Desktop als Symbolbutton, mobil im oberen Menü); Hell/Dunkel-Umschalter bleibt zusätzlich erhalten.
- Dialog: echte Radiogruppen mit Farbnamen, Vorschau (Hauptaktion/Ausgewählt/Link), „Ausgewählt“-Text, Zurücksetzen auf Lila, Focus-Trap, Escape, Fokusrückgabe. Schließen navigiert nicht und sendet nichts.
- Bestätigungsdialog (`ConfirmDialog`) für Spiel vorzeitig beenden (Wissensduell, Wer ist das?), Spiel abbrechen, Raum endgültig schließen, Teilnehmer sperren, Host übertragen. Fokus startet auf „Abbrechen“. Normale Auswahl, Buzzer und Antworten bleiben ohne Bestätigung.
- Pending: `Button loading` zeigt Spinner bei sichtbarem Text (`aria-busy`), damit der zugängliche Name erhalten bleibt.
