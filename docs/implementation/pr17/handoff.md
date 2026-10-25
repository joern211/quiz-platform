# RESULTS / RECOVERY — 25.10.2026

## Auftrag

Fünf Pakete nacheinander; regelmäßig auf GitHub sichern; kein selbstständiger Merge.
Punkt 1 ist auf f26e8fb abgeschlossen. Punkt 2 ist auf a1b55eb abgeschlossen:
423 Server-/85 Webtests, Typecheck/Build/Lint grün, komplette CI/E2E grün,
Run 40143108619. PR16 ist Ready for Review. Merge-Reihenfolge #15 → #16.

## Punkt 3 — in Arbeit auf feature/pr17-results-recovery

Basis a1b55eb; als gestapelte Folge-PR gegen feature/pr16-game-core.

Implementiert:
- Additive Migration 20261025010000_results_history: RoundResultRecord,
  GameResultRecord, immutable GameResultVersion; Ledger mit roundKey/kind/
  referenceEventId. DB-Trigger verweigern Updates von Ergebnisversionen,
  Rundenresultaten und ScoreEvents. Historische Originale werden nicht geändert.
- Alle drei Engines schreiben RoundResults atomar mit Score/State-Event und
  GameResults atomar mit GAME_END. Jeopardy hat stabile Feldidentitäten und
  Feldreferenzen im Ledger; seine bisherigen roundIndex=Board-Werte bleiben
  kompatibel. Kein Erfundenes für fehlende Legacy-Feldidentitäten/Dauern.
- Ergebnisse pinnen Name, Slug, Engine-Version, Teilnehmer, Teamwertung,
  Content-Refs, Rundenzahl, Dauer und Endgrund. Abbruch erzeugt keinen Sieger.
- Eigener Ergebnis-Lifecycle GAME_END → RESULT_REVIEW → FINALIZED;
  Engine-Unterphase bleibt für alte Clients GAME_END. Runtime zeigt Core-Phase.
- game:result:command ist receipted, run-/revisionsgesichert und prüft aktuelle
  SCORE_ADJUST-Befugnis samt Session in der Schreibtransaktion. ADJUST vor
  Finalisierung, AMEND danach; ROLLBACK referenziert und kompensiert einmalig.
  Ledger, Materialisierung (nur aktueller Run), Ergebnisrevision und Audit sind
  atomar. Historische Amendments ändern niemals ein neueres Spiel.
- GET /rooms/:code/results?runIndex=N&revision=N liest feste Versionen.
  Privater Zugang erfordert Host-Session oder gültigen Teilnehmernachweis;
  PUBLIC_JOIN gibt nur die explizite Ergebnisprojektion frei. Keine Antworten,
  Secrets, Start-Snapshots, Tokens oder interne States. Altresultate bleiben
  ausdrücklich LEGACY; unvollständiges Ledger wird nicht als geprüft ausgegeben.
- Gemeinsame ResultScreen für Host/Player/Viewer, Rechte-abhängige Korrekturen,
  verbindliche Bestätigung, Versionswahl, Teamwertung, historische Partieauswahl
  und Rematch. Keine stale sessionStorage-Ergebnisse als stille Fehlerfallbacks.
- game:recovery:command stellt nur den aktuellen Run und die gepinnte Engine
  aus validiertem Event-Replay wieder her. Host/Session/Recht, CAS, Ledger und
  Invariants müssen stimmen. Spätere explizite Checkpoints nach Freeze werden
  erkannt; keine neuen Scores/Zufallsentscheidungen. Fehlende/ungültige Belege
  belassen ERROR_RECOVERY. Timer werden aus den gespeicherten Zeitpunkten
  restauriert. Host-Oberflächen bieten den geprüften Wiederherstellungsweg.

## Nachweise / nächste Arbeit

- Frühere gezielte Spiel-/Teamregressionen: 38/38 grün.
- Ergebnissuite + Runtime: 17/17 grün (vor drei zusätzlichen Negativfällen).
- Migration/Rejoin/echter Prozess + Ergebnissuite: 8/8 grün. Der erste volle
  Lauf fand eine veraltete Migrationsliste im Deploy-Test; neue additive
  Migration ist nun in der echten Bestandsmigration enthalten. Assertions
  wurden nicht abgeschwächt. Unvollständige Legacy-Punkte bleiben ungeprüft.
- 89 Webtests grün; Typecheck/Build/Lint grün vor letztem UI-/Testnachtrag
  (113 Warnungen, keine Fehler).
- Aktuell erneut kompletter Serverlauf, danach neu hinzugefügte Negativfälle,
  Typecheck/Web/Build/Lint, Dokuchecker. Neue Browserstrecke erweitert T1:
  Ergebnisprüfung → Korrektur → FINALIZED → Reload → AMEND → Originalversion
  ansehen → Rematch. GitHub-E2E am exakten Folge-Head noch ausstehend.
- Punkt 3 NICHT als abgeschlossen melden, bevor alle Änderungen und die
  vollständige CI/E2E am aktuellen Head grün sind. Sicherheit/Legacy prüfen.
- Danach Punkt 4 Content-Pools/Editor/Review/Import, dann Punkt 5 Medien/Display.

## Technische Wiederaufnahme

Arbeitsrepo: /workspace/scratch/74c8834207ac/quiz-platform. pnpm 9.12.0 über
Corepack; temporärer Wrapper /tmp/quiz-tools/pnpm setzt auch verschachtelte
pnpm-Aufrufe korrekt. Nie zwei Serversuiten gegen /tmp/quiz-server-test.db
parallel starten. Lokale Chromium-Installation fehlt; Browsernachweis via CI.
Git lokal ohne Login: Änderungen über GitHub-API übertragen, Dateibaum-SHA
exakt prüfen, branch per Fast-Forward + expected_sha bewegen. Originalcommit
auf checkpoint-Branch behalten, danach anonym fetchen und Arbeitsbranch auf
Remote-Commit fortsetzen. Push ist autorisiert; keine erneute Rückfrage nötig.

## Gesicherter lokaler Abnahmestand

Voller Serverlauf 431/431 (51 Dateien, 111,31 s), 89/89 Webtests (13 Dateien),
Typecheck und beide Builds grün. Lint 0 Fehler / 113 Warnungen, PR12-Dokuchecker
und diff --check grün. Die acht neuen echten Socket-/HTTP-/DB-Fälle einschließlich
zweifacher Replay-Reparatur und Negativfällen sind im vollständigen Lauf enthalten.
Nächster Schritt: exakten Baum pushen, Draft-Folge-PR anlegen, CI/E2E abnehmen;
insbesondere die erweiterte Browserstrecke T1 beobachten.

## Gesicherter Remote-Zwischenstand 1a56644

Draft-PR17 erstellt; Baum ac41e54 ist identisch zum lokalen ac1382b.
Voller lokaler Stand 431 Server-/89 Webtests grün. GitHub-CI/E2E Run
40144726278 läuft. Folgeprüfung ergänzt den rollenabhängigen Socket-Leseweg
für bereits zugelassene Viewer privater Räume ohne Player-Rejoin-Token,
korrekte Player-/Viewer-Ergebnisrouten und Refresh nach Reconnect. Gezielte
Ergebnissuite 8/8, Typecheck und Web89 grün. Geo-Browserassertion verwendet
die jetzt einheitliche deutsche Einheit Punkte statt pts; die Prüfung eines
numerischen Ergebnisses bleibt erhalten. Folgeänderung pushen/CI abnehmen.

## Nachprüfung aktiver Geräte / verspäteter Rematch

Nächste Folgeänderung prüft connectionId zusätzlich innerhalb von Result-/
Recovery-Transaktionen. Finale Team-Caches müssen mit der gespeicherten
Ledger-Auswertung übereinstimmen. Neue Rematch-UI sendet die erwartete
runIndex; eine verspätete Absicht kann keine neuere beendete Partie resetten.
RoomOperation bleibt für alte Clients additiv kompatibel. 34/34 gezielte
Result-/Room-Sockettests, Web89, Typecheck/Build/Lint grün (113 Warnungen).
Ein erster gezielter Lauf hatte ausschließlich im afterAll den Standard-
1s-Wait überschritten: alle 34 Testfälle bestanden, aber sechs echte
Disconnect-Handler waren noch in Arbeit. Der Cleanup wartet nun wie die
bestehende Runtime-Suite bis 10s auf den tatsächlichen leeren Identity-Bestand;
keine fachliche Assertion/kein Pflichtfall ist entfernt. Folgeprüfung grün.

## Browser-Abnahme c3e7142 — Korrektur erforderlich

Run 40145355091: komplette CI grün (Server431/Web89), E2E 18/20 grün.
G4-4 fand die erwartete Abschlussüberschrift nicht; T1 fand die Teilnehmer-
Auswahl nicht über den exakten zugänglichen Namen. Retry änderte daran nichts.
Browsertrace und Screenshots wurden heruntergeladen und tatsächlich geprüft.
Die Team-Korrekturform war vorhanden. Explizite aria-labels beheben die
Auswahlbeschriftung. Ergebnisansicht und globales RoomPanel hatten beide
room:subscribe ausgeführt; jetzt ist die Ergebnisseite alleiniger Besitzer
und das Panel liest nach deren Snapshot. Player/Viewer erhalten wieder die
Überschrift Spiel beendet; keine Siegerbehauptung für abgebrochene Partien.
Die neue Ergebnis-CSS macht Ranglisten, Formfelder und Abstände lesbar.
Zwei zusätzliche Webtests prüfen genau eine Raumaufnahme neben dem Panel
und die Abnahme nach StrictMode-Effektwiederholung. Web91, Typecheck, Build,
Lint0 Fehler/113 Warnungen und diff-check grün. Neuen Head pushen und die
vollständige CI/E2E erneut prüfen. Punkt 3 bleibt bis dahin in Abnahme.

## Gemeinsame Ergebnis-/Raumansicht — letzter UI-Abgleich

Die Revancheaktion bleibt ausschließlich im globalen RoomPanel, das nun
auch runIndex mitsendet; die Ergebnisseite erzeugt keinen zweiten gleich
benannten Button und übernimmt keine zweite Lobby-Navigation. Der neue
Integrationstest montiert beide echten Komponenten mit vollständigem
Raum-View, prüft genau einen Revanchebutton und die gepinnte Partie.
Web92, Web-Typecheck/-Build, Lint0 Fehler/113 Warnungen und diff-check grün.
Die vorherige Browserkorrektur liegt auf 83a14ced (Baum 173b74bd), CI Run
40146259561. Nächsten UI-Head pushen und dessen komplette CI/E2E abnehmen.

## Browserlauf 6dd37ad — präziser Locator und echter Socket-Lifetime-Fix

Run 40146546740: CI Server431/Web92 grün. G4-4 fand den Teilnehmernamen
zweimal (Ranking und Raumfeed); die Ergebnisprüfung ist nun auf die neue
Region Spielergebnis und deren Ranglisteneintrag begrenzt, statt die
fachliche Assertion zu entfernen. T1 schaffte den kompletten neuen
Ergebnisworkflow, verlor im ersten Versuch nach Rematch aber das Panel;
der Retry war grün. Diese Flake ist nicht als abgeschlossen gewertet.

Ursache: Das permanente RoomPanel hielt einen Socket, den eine Seite beim
Routen-/StrictMode-Wechsel entsorgt hatte. Der gemeinsame Socket-Store
stellt nun observeSocket bereit. Das Panel bindet seine Listener bei
Client-Neuanlage neu und verwirft alte ACKs per Client-/Generationsprüfung.
Seiten bleiben allein für Admission zuständig. Automatische Rejoin- oder
Spielaktionen wurden nicht hinzugefügt. Tests prüfen Store-Neuanlage/
Unsubscribe und Panel-Refresh auf Partie 2 nach Clientersatz.

Web94/94 (14 Dateien), Web-Typecheck/Build, Lint0 Fehler/113 Warnungen und
diff-check grün. Neuen Head pushen und vollständige CI/E2E erneut abnehmen.
Punkt 3 bleibt in Abnahme; Punkte 4–5 nicht begonnen. Alle Änderungen sind
weiterhin auf feature/pr17-results-recovery, PR17 Draft, kein Merge.
