# Fortsetzung des Master-Plans — 24.10.2026

Auftrag: fünf Pakete nacheinander umsetzen, regelmäßig auf GitHub sichern,
globale Regression beachten. Kein selbstständiger Merge. Nachfolgende Pakete
auf dem jeweils geprüften Vorgänger aufbauen; PRs bei Bedarf stapeln.

Regelquelle: Master Regelwerk.rtf, 28.09.2026. Die PR12-Matrix ist ein
historischer Ausgangspunkt, keine aktuelle Prozentanzeige. Fachlich offene
Spielregeln bleiben offen; bereits festgelegte Regeln nicht erneut abfragen.

| Punkt | Paket | Stand |
|---|---|---|
| 1 | TEAM-ROOM / GitHub #15 abschließen; öffentliche Raumliste reparieren | Code/lokale Abnahme fertig; CI/E2E ausstehend |
| 2 | Gemeinsame Spielaktionen / Rundensteuerung, Planplatz PR15 | offen |
| 3 | Results / Finalisierung / Recovery, Planplatz PR16 | offen |
| 4 | Content-Pools / Editor, anschließend Review / Import / Qualität | offen |
| 5 | Audio / Voice, Kamera / Display; danach weitere Engines | offen |

## Wiederaufnahme

1. Aktuellen Branch, Remote-Head und PR-Checks lesen. Keine Arbeit verwerfen.
2. Punkt 1: API-Arrayvertrag, aktive Belegung über beide Viewer-Modelle,
   Lifecycle und Beitrittsfähigkeit der öffentlichen Liste berichtigen.
3. HTTP-/UI-/Browserregression ergänzen; Server/Web vor Commit bauen.
4. Push/CI am exakten Head, dann erst nächstes Paket beginnen.
5. Jeden neuen Paketumfang und Nachweis hier fortschreiben. Kein Paket allein
   wegen vorhandener Typen, Buttons oder Dokumentation als abgeschlossen melden.

Startbasis: main 4f665a8; GitHub #15 aaad2b9. Keine lokalen Produktänderungen
aus einer anderen Aufgabe vorhanden. Pushes vom Nutzer ausdrücklich autorisiert.

## Punkt 1 — Nacharbeit

- Gemeinsames PublicRoomSummary-Schema, API-Arrayvertrag, Fehler-/Retry-UI.
- Aktive Player statt Wartender/entfernter Teilnehmer; beide Viewer-Modelle.
- Lifecycle/Beitrittsfähigkeit inkl. Warteliste, geplanter/gesperrter Räume und
  Late Join; Entwürfe/abgelaufene/geschlossene Räume verborgen.
- Lokal 386 Server-/83 Webtests grün, Typecheck und beide Builds grün, Lint
  0 Fehler / 115 Warnungen. Dokuchecker grün.
- Neuer Browserfall R1 ist implementiert. Lokaler Chromium-Download
  fehlgeschlagen (unvollständiges ZIP); GitHub-E2E ist verbindlich.
- Nächster Schritt: Push/CI prüfen, gegebenenfalls R1 korrigieren. Erst nach
  grüner kompletter CI/E2E Punkt 2 auf eigener Folgebranch beginnen.
