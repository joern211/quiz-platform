# Fortsetzung des Master-Plans — 24.10.2026

Auftrag: fünf Pakete nacheinander umsetzen, regelmäßig auf GitHub sichern,
globale Regression beachten. Kein selbstständiger Merge. Nachfolgende Pakete
auf dem jeweils geprüften Vorgänger aufbauen; PRs bei Bedarf stapeln.

Regelquelle: Master Regelwerk.rtf, 28.09.2026. Die PR12-Matrix ist ein
historischer Ausgangspunkt, keine aktuelle Prozentanzeige. Fachlich offene
Spielregeln bleiben offen; bereits festgelegte Regeln nicht erneut abfragen.

| Punkt | Paket | Stand |
|---|---|---|
| 1 | TEAM-ROOM / GitHub #15 abschließen; öffentliche Raumliste reparieren | abgeschlossen, f26e8fb; CI + 20/20 E2E grün |
| 2 | Gemeinsame Spielaktionen / Rundensteuerung, Planplatz PR15 | abgeschlossen, a1b55eb; CI/E2E grün |
| 3 | Results / Finalisierung / Recovery, Planplatz PR16 | abgeschlossen, 7316415; vollständige CI/E2E grün |
| 4 | Content-Pools / Editor, anschließend Review / Import / Qualität | in Arbeit, feature/pr18-content-editor |
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

Abgeschlossen auf f26e8fb: [Run 40104459714](https://github.com/joern211/quiz-platform/actions/runs/40104459714),
386 Server-/83 Webtests und 20/20 E2E ohne Retry/Skip/Flake. PR #15 bleibt
offen und wird nur durch den Nutzer gemergt. R1 wartet auf den echten
Kick-Commit statt mit dem noch laufenden Socket-Command zu konkurrieren.

## Punkt 2 — GAME-CORE

Branch feature/pr16-game-core, Basis f26e8fb. Folge-PR gegen
feature/pr15-team-room; CI akzeptiert deshalb auch gestapelte Feature-Basen.
Die Merge-Reihenfolge bleibt PR15 vor PR16.

1. Gemeinsame Timer-/Submission-/Judge-Primitiven in echten Wissensduell-
   und Jeopardy-Aktionen nutzen, Legacy-State explizit kompatibel lesen.
2. Gemeinsame Aktionsregeln für serverseitige verfügbare Aktionen und Guards,
   Projektion, Fortschritt, Invariants und Rundenübergänge integrieren.
3. Engine-Vertrag und weitere Master-Cores vervollständigen. Keine bloßen
   Typen oder ungenutzten Helfer als DONE melden; je Core mindestens zwei
   echte Consumer nachweisen. Results/Finalisierung gehören zu Punkt 3.
4. Regression und finale CI/E2E am eigenen Head. Erst danach Punkt 3.

## Fortsetzung — lokaler Stand nach 4d637b7

Punkt 2 wurde um gemeinsame Runden-/Matching-/Zufallsregeln (d98e2bc),
Visibility und vor Speicherung sowie bei Recovery geprüfte Invariants
fortgesetzt. 405 Server-/85 Webtests, Typecheck, Builds, Lint ohne Fehler und
Dokuchecker sind lokal grün. Einzelheiten/Abgrenzungen in pr16/handoff.md.
Noch kein Abschluss von Punkt 2 und kein Beginn von Punkt 3–5.

Push ist durch die automatische Freigabeprüfung blockiert (zwei Ablehnungen
wegen vermeintlich fehlender ausdrücklicher Freigabe für Remote/Branch).
Keine Ausweichpublikation. Vor dem nächsten normalen Push konkrete Freigabe
für feature/pr16-game-core → https://github.com/joern211/quiz-platform.git
anfordern. Danach GitHub-CI/E2E am eigenen neuen Head abnehmen und PR16-Body
aktualisieren; der Remote-Nachweis auf 4d637b7 deckt lokale Folgecommits nicht.

## Aktuell — Push-Freigabe erteilt, Event-Core in echten Engines

Der Nutzer hat den Push ausdrücklich bestätigt und Fortsetzung beauftragt.
Die alten Push-Blocker sind damit historisch. 298e97f ist auf GitHub und
vollständig CI/E2E-grün; seine Bäume entsprechen den freigegebenen lokalen
Commits. Neue Folgeänderungen werden über die GitHub-Verbindung per
Fast-Forward gesichert (lokale Git-Anmeldung fehlt).

Neu in Punkt 2: transaktional persistierte, unveränderliche State-Events,
deterministischer SDK-Replay, explizite Legacy-Checkpoints und strukturierte
Buzzer-Zustände in Jeopardy + Wer ist das?. 408 Server-/85 Webtests und
Builds/Typecheck lokal grün. Details und restlicher Umfang im PR16-Handoff.

## Engine-Vertrag — nächster gesicherter Teil von Punkt 2

cc66952: grüne CI und E2E (Run 40117073536), Event-/Buzzer-Zwischenstand.
Folgeänderung: realer SDK-GameEngineContract in Start/Preflight/Spielbefehlen/
Resync aller drei bestehenden Spiele, gemeinsame WID-Aktionen und korrigierte
Buzzer-Verwaltungsgrenze. Ergebnis-Builder vorbereitet, aber noch keine
persistente Ergebnisfinalisierung (Punkt 3). 411 Server-/85 Webtests lokal
grün, Typecheck/Build grün; genaue Abnahme im PR16-Handoff. Punkt 2 noch offen.

## Tie-Regel und reproduzierbare CI — Punkt 2 bleibt in Arbeit

Tie-Core ergänzt; bestehende Engines pinnen ALLOW_TIE vor dem Start.
Wissensduell und Jeopardy verwenden ihn beim Ende mit gemeinsamen Gewinnern.
Andere Strategien bleiben bei offenen Entscheidungen PENDING und sind in
diesen Engines nicht auswählbar. Serversuiten laufen seriell gegen die
gemeinsame SQLite-Datei; fünf Suiten wählen ihre eigene Host-Sitzung, damit
abgelaufene fremde Test-Sitzungen keinen UNAUTHORIZED-Fehler erzeugen.
416/416 Servertests, 85/85 Webtests, Typecheck/Build/Lint lokal grün.
GitHub-CI/E2E am Folge-Head noch zu prüfen.

## Host-Korrektur des Buzzer-Gewinners — nächster Teil von Punkt 2

53896ad hat vollständige grüne CI/E2E (Run 40119533680). Lokal folgen echte
Host-Korrekturen für Jeopardy (auch Steal) und WID: eigene Moderations-UI,
commandId/Run-/Engine-Versionsschutz, wirksame Verwaltungsrechte und
gemeinsame Transaktion für Buzzer/Turn/Submission, Domain-Event, Audit/Feed.
Eine Korrektur vergibt keine Punkte; die anschließende Bewertung punktet
exakt einmal für den neuen Gewinner. 419 Server-/85 Webtests grün;
Browsertests um beide UI-Flows erweitert. Team-Anbindung noch offen.

## Team-Buzzer — weiterer Teil von Punkt 2

b052a44: Host-Korrektur mit CI/E2E grün (Run 40120123179). Folge: echte
Team-Roster beim ersten Öffnen für Jeopardy/WID, Sperre des falschen Teams,
stabile Karte über Reopen/Rejoin/Recovery und neue Karte erst zur nächsten
Runde. WID ROUND_READY nach falscher Antwort bleibt für Teamwechsel gesperrt.
Legacy-Ausschlüsse werden beim ersten Upgrade-Öffnen ausdrücklich erhalten.
421/421 Server- und 85/85 Webtests, Typecheck/Build/Lint0 Fehler lokal grün.
Punkt 2: Lifecycle-Normalisierung und gemeinsame Round-Transition noch offen.

## Lifecycle und Round-Transition — Runtime-Abnahme für Punkt 2

b53c972: Team-Buzzer mit CI/E2E grün (Run 40121033591). Folge: gemeinsame
kanonische Phase im Engine-Vertrag und in Runtime-Projektionen; derselbe
Rundenübergangsguard in Wissensduell, Jeopardy und WID. Er verlangt abgeschlossene
Runde, zulässige Folgephase und unveränderte Scores; Runtime-Reset und
Übergangsfolge werden im Zustand/Domain-Event atomar gespeichert. 423 Server-/
85 Webtests, Typecheck/Build/Lint lokal grün. Noch CI/E2E am Folge-Head abnehmen,
dann Punkt 2 abschließen und Punkt 3 starten. Vollständige Runtime-Abgrenzung
und Nachweise: ../pr16/acceptance.md. Keine Ergebnisfinalisierung vorgetäuscht.

## Punkt 2 abgeschlossen / Punkt 3 begonnen — 25.10.2026

a1b55eb: 423 Server-/85 Webtests, Typecheck/Build/Lint und komplette CI/E2E
in Run 40143108619 grün. PR16 Ready for Review, nicht gemergt. Punkt 3 auf
eigener Folgebranch: persistente Round-/GameResults, Review/Finalisierung,
kompensierende Ledger-Korrekturen/Amendments, Historie und Replay-Recovery.
Stand und exakte Fortsetzung: ../pr17/handoff.md. Punkte 4–5 weiterhin offen.

## Wiederaufnahme 25.10.2026 — Punkt 3 fertig / Punkt 4 begonnen

7316415: Run 40147789297 vollständig grün, 20/20 E2E ohne Retry/Flake.
PR17 Ready for Review, kein Merge. Punkt 4 folgt auf eigener gestapelter
Branch; Einzelstand und offene Master-Anforderungen: ../pr18/handoff.md.
Punkt 5 bleibt offen.


## Punkt4 — Wiederaufnahme gesichert / Zusammenarbeit ergänzt

9a03c4f: vollständige CI/E2E grün (Run40220311085). Lokaler Folgeteil:
Sammelbearbeitung mit Impact/Bestätigung/Teilresultaten, Concurrent-Editor-
Anzeige, interne Kommentare/Locks/Usage-UI, PUBLIC-Privacy-Fix und echte
konkurrierende Editorwrites. Details/Nachweise in ../pr18/handoff.md.
Weiterhin kein Abschluss von Punkt4, kein Beginn von Punkt5, kein Merge.

## Punkt4 — Content-Medien weitergeführt

c125c13 ist gesichert; CI grün,22/23 E2E grün. C3-Trace hat einen konkreten
Beschriftungsfehler geladener Textareas gezeigt; explizite Labels korrigiert.
Lokaler Folgeteil bindet Medienrefs/Rechte an Editor/Import/READY/Preflight
und reale Wissensduell-/Jeopardy-Delivery, mit Kontextsignaturen, geschützter
Historie und additiver Legacy-Migration.463/463 Server,112/112 Web lokal grün.
Details und ehrliche Restgrenzen stehen im PR18-Handoff. Punkt4 bleibt offen.

## Punkt4 — Vorlagen und Review-Arbeitsschritte

Medienstand cdadb97 vollständig CI/E2E-grün (Run40222792665,23/23 E2E).
Folgeteil ergänzt private/System-Fragenvorlagen, getrennte versionsgebundene
Prüfaufgaben, Einzelreview mit Tastatur/Wiederaufnahme und weitere Public-
Privacy-/Receipt-Fixes. Lokal467 Server/116 Web grün, C4 zusätzlich aktiv.
Nächste Schritte und verbleibende Grenzen in ../pr18/handoff.md.
Punkt4 offen, Punkt5 unbegonnen, kein Merge.

## Punkt4 — PLAYTEST und Teststabilität lokal gesichert

Ältere P14-Regressionen erhalten eine eigene Testdatenbank und vollständigen
Disconnect-Abbau; verspätete room:probe-Antworten schreiben nach Identitäts-
wechsel nicht mehr. C3 synchronisiert die echte Anwesenheitsregistrierung.
470 Servertests für diesen Teil grün; lokaler Commit6693b5b.

Danach PLAYTEST aus Editor mit temporärem Gerätecode, vier Perspektiven,
Auflösung, Testantworten und gesammelten Hinweisen; immutable Snapshot und
aktive Mediengrenzen. Keine normalen Räume, Stats oder ScoreEvents.
476 Server-/120 Webtests, beide Builds und Typecheck grün; neue echte
HTTP-/DB-Abnahmen. Lint0 Fehler/113 bestehende Warnungen. Einzelstand, Browsergrenzen
und Restumfang in ../pr18/handoff.md. GitHub-Sicherung durch automatische
Freigabeprüfung blockiert; kein Workaround. Punkt4 offen, Punkt5 unbegonnen.

## Punkt4 — Difficulty-Verläufe weitergeführt

5ac3566 auf GitHub vollständig grün (476 Server/120 Web/25 E2E, Run40226692379).
Folgeteil: genaue Prozentverteilungen, Rundenbereiche, System-/private Host-
Schwierigkeitsvorlagen und gemeinsame Difficulty-/Pool-Quoten mit bevorzugten
ungesehenen Fragen. Echter Engine-/Snapshot-Nachweis,38 gezielte Servertests
und123 Webtests grün. Vollständig482 Servertests, beide Builds/Typecheck
grün; Lint0 Fehler/113 bestehende Warnungen. C6 ergänzt Browserweg. Vollständige Spiel-/Room-Vorlagen
und BLIND_HOST bleiben offen; Einzelabnahme siehe ../pr18/handoff.md.
