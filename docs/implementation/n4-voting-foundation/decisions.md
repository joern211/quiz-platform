# N4 — Entscheidungen

## Master-Festlegung (nicht erneut zu fragen)
- Imposter ist von Undercover getrennt; Imposter-Wertung (Master §15.4): +1 an den Spieler, der die echte Antwort wählt, +1 an den Lügenautor je getäuschtem Vote; die echte Antwort hat keinen Spieler-Autor; auch ein Gesamtgleichstand hebt die feste je-Stimme-Wertung nicht auf. **N4 implementiert keine Punktvergabe.**
- Undercover: geheime Rollen/Begriffe, Hinweise, Diskussion, Voting, ggf. Eliminierung, Secret-/Visibility-Core zwingend. Geheim Agent: eigene Social-Deduction-Engine.
- Administrative Rechte sind keine Informationsrechte (§2.2) — auch nicht für mitspielende Hosts; Viewer sehen nur PUBLIC; Server ist autoritativ; kein Fingerprinting.

## Technische Entscheidungen in N4 (selbst getroffen, begründet)
| Thema | Entscheidung | Begründung |
|---|---|---|
| Enthaltung | Eigener Discriminator `ABSTAIN` ohne `optionId`; Nichtabgabe = kein Record | Kein reservierter String kann mit einer Option kollidieren; drei Zustände bleiben unterscheidbar |
| Allowlist statt Selbstwahl-Regel | Pro Wähler explizite erlaubte Option-IDs | Technische Fähigkeit ohne Spielregel; „Selbstwahl immer verboten/erlaubt“ wird nicht eingeführt |
| Enthaltungsrecht | Pflichtfeld je Wähler, kein Default; leere Allowlist nur mit Enthaltungsrecht | Kein stiller fachlicher Default; Widerspruch wird beim Anlegen abgelehnt |
| Ein verbindlicher Cast | Zweiter gewöhnlicher Cast abgewiesen, auch identisch | Echte Wiederholung gehört zum späteren Receipt-/Intentpfad; kein „last write wins“ |
| Ergebnisfreigabe | Aggregat ≠ Stimmzettel; `publiclyRevealed` nicht auf Stimmzettel | Auftrag §8; N2/N3-Reveal-Verhalten bewusst nicht kopiert |
| Freigabe-API | Pflicht-`release` mit zwei Listen (`options`, `result`) je Zielgruppe | Sicherer geschlossener Default; kein neues Permission-DSL |
| Eigene Auswahlliste stabil | Bleibt über Stimme/Schluss gleich | Sonst ändert sich der UI-Kontext nach dem Abgeben (Fehlerzustand der UI) |
| Enter auf Radio | sendet nicht | Verbindliche Stimme nie versehentlich senden |
| Grenzen | 2–32 Optionen, 1–100 Wähler | Technischer Schutz; Wähler = Raum-`maxPlayers`-Obergrenze; keine PR12-Defaults |
| Branch | `claude/new-session-t4thly` statt `feature/n4-voting-foundation` | Vorgabe der Sitzung; startet direkt von `main` |

## Weiterhin offen (blockiert N4 nicht; keine still bestätigten Regeln)
- **DEC-SPI-01** (Imposter): Selbstwahl, Anonymisierungs-/Freigabephasen, Duplikat-/Autorenregel, Nichtabgabe, Teilnehmerlimits, Rundengewinner-Tie. Folge: Allowlist/Enthaltungsrecht/Freigabe werden erst vom echten Verbraucher gesetzt.
- **DEC-UND-01** (Undercover): Rollenanzahl, Gleichstand/Eliminierung/Max-Runden/Sieg, Hinweisregeln. Folge: `top.kind: TIED` bleibt neutral; N4 löst nichts auf.
- **DEC-AGT-01** (Geheim Agent): Rollen-Satz, Siegbedingungen, Phasen.
- DDF-Voting nur möglicher späterer Verbraucher; DEC-DDF-02/04 sind keine Freigabe.
- Nicht eingeführt: „Tie = 0 Punkte“, „Tie = keine Elimination“, „Selbstwahl immer verboten“, „Timeout = Enthalten“, „Host sieht alle Stimmen“.
