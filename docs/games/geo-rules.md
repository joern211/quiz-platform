# Geo-Quiz - Spielregeln

## Übersicht

Das **Geo-Quiz** ist ein klassisches Multiple-Choice-Quiz mit vier Antwortoptionen. Es unterstützt Text-, Bild- und Audio-Fragen sowie drei Joker.

## Spielablauf

### 1. Vorbereitung (Moderator)

1. Wähle ein Inhaltspaket oder einzelne Fragen
2. Filtere nach Kategorien (optional)
3. Konfiguriere Timer (Standard: 20s, min: 5s)
4. Setze Punkte pro Frage (Standard: 100)
5. Aktiviere/Deaktiviere Joker
6. Erstelle den Raum

### 2. Lobby

- Spieler treten bei und werden in der Spielerliste angezeigt
- Jeder Spieler klickt "Bereit" (gelber Rahmen bei bereit)
- Moderator sieht alle Spieler und deren Status
- Moderator kann Spieler kicken
- Chat ist verfügbar (Moderator kann sperren)

### 3. Spielrunde

#### Frage zeigen
Moderator klickt "Nächste Frage" → Alle Clients sehen:
- Fragetext/Bild/Audio
- Vier Antwortoptionen (A, B, C, D)
- Timer läuft

#### Antworten
- Spieler wählen eine Antwort
- Antwort wird serverseitig gespeichert
- Nach Auswahl: Kein Wechsel möglich (Lock)

#### Timer läuft ab
- Offene Spieler werden automatisch gelockt
- Niemand erhält Punkte für diese Frage

#### Reveal
Moderator klickt "Auflösen" → Alle sehen:
- Richtige Antwort (grün hervorgehoben)
- Erklärung (falls vorhanden)
- Punkteverteilung
- Neuer Punktestand

## Joker

### 50/50

- **Wann:** Jederzeit vor eigener Antwort
- **Effekt:** Zwei falsche Optionen verschwinden
- **Limit:** Einmal pro Spiel (konfigurierbar)
- **Sichtbarkeit:** Nur für den Spieler, der ihn nutzt

### Spy

- **Wann:** Nach Eingabezeit oder Ablauf, wenn mindestens ein anderer Spieler geantwortet hat
- **Effekt:** Zeigt prozentuale Verteilung A/B/C/D
- **Limit:** Einmal pro Spiel
- **Anschließend:** Spieler kann innerhalb kurzer Zeit antworten

### Risk (x2)

- **Wann:** Vor eigener Antwort aktivierbar
- **Effekt:**
  - Richtig: 2 × Fragepunkte
  - Falsch: 2 × Minuspunkte
- **Limit:** Einmal pro Spiel
- **Hinweis:** Minuspunkte werden ebenfalls verdoppelt

## Punkte

| Ergebnis | Punkte |
|----------|--------|
| Richtig | +100 (konfigurierbar) |
| Falsch | 0 (oder Minuspunkte) |
| Nicht geantwortet | 0 |
| 50/50 genutzt | unverändert |
| Spy genutzt | unverändert |
| Risk richtig | +200 |
| Risk falsch | -X (verdoppelt) |

## Speed-Bonus (Optional)

Falls im Setup aktiviert: Linearer Bonus bis 25% der Fragepunkte basierend auf verbleibender Zeit.

## Kategorien

Das Geo-Quiz unterstützt folgende Kategorien:

- Hauptstädte
- Flaggen
- Allgemeinwissen
- Sprachen/Amtssprachen
- Flüsse und Berge
- Länderumrisse

## Technische Details

- **Context:** 1M Token Fenster
- **Buzzer:** Nicht verwendet (Time-based)
- **Teams:** Optional
- **Late Join:** Standardmäßig aus
