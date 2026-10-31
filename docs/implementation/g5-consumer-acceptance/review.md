# G5 — Eigenprüfung, Befunde, Rest

Angekündigter, eigener Arbeitsschritt nach dem ersten grünen Teilstand. Gegenfälle nach Auftrag §7/8/10/13.

## Tatsächliche Befunde

| # | Quelle / Trigger | Soll / Ist | Ursache | Korrektur | Nachweis |
| --- | --- | --- | --- | --- | --- |
| 1 | Voller Serverlauf auf unverändertem main (708/710), `g4Protection` „lost acknowledgement of a result correction…“ (zusätzlich „Admission: more tabs…“ anfällig) | Soll `RATE_LIMITED`, Ist Erfolg | `exhaust()` ließ die Limiter-Uhr laufen; REQUEST füllt 12 Token/s nach, auf langsamer Maschine kam ein Token zurück. PR27 hatte nur Teile eingefroren | `exhaust()` friert die Uhr; `afterHint` spult die eingefrorene Uhr um den Hinweis vor; rohe Wartezeiten ersetzt | **Rot:** Originaldatei + 300 ms Verzögerung → 2 Tests rot. **Grün:** derselbe Eingriff gegen den neuen Stand grün; Datei 53/53 |
| 2 | Voller Serverlauf, `jeopardy/socket-flow` „restores only active Geo timers…“ (2 statt 1 Aufruf) | nur eigene Räume zählen | `restoreActiveTimers` scannt alle RUNNING-Räume der gemeinsamen Test-DB | Assertion auf die im Test angelegten Räume beschränkt | **Rot:** fremder RUNNING-Raum mit abgelaufenem Timer in der DB, Originaltest → identische Meldung. **Grün:** nach Änderung |

Welcher fremde Raum im Volllauf tatsächlich auftrat, wurde nicht ermittelt; der Mechanismus ist reproduziert, die Zuordnung zum Volllauf nicht bewiesen.
Beide Befunde sind Testfehler, kein Produktfehler.

## Geprüft ohne Änderungsbedarf
Admission-Isolation (neuer Gegenfall grün auf Anhieb, Positivkontrolle ergänzt), Viewer-Kapazität, DISPLAY, Recovery-Evidenz (neuer Gegenfall grün), 0 Punkte in `ResultScreen` (rendert Werte korrekt), sendeseitiger Medien-Neustart (M4b grün; erste Fassung scheiterte an meinem falschen Kriterium „neue Stream-ID“, ersetzt durch inbound-rtp-Bytes).

## Eigene Fehlgriffe (behoben)
Jeopardy-0:0 angenommen: `field:lock` ist Legacy-Alias von `field:open`, Felder enden nur per Buzz+Urteil; Zusatz verworfen. Ein fehlerhaftes Zurücknehmen beschädigte kurz eine Testdatei; aus dem Commit wiederhergestellt, 53/53.

## Nicht geprüft / verbleibend
Nicht neu aufgerollt wurden: vollständige Bedienungsprüfung aller UI-Panels (kleiner Bildschirm, Zugänglichkeit), Rate-Limit-Kaskaden unter Mehrspielerlast, Medienrechte nach Teamwechsel im Browser (nur Server-Test bestehend), Legacy-Seite `ResultPage.tsx`, Logger-/traceId-Gegenfälle über G4 hinaus. Diese sind **nicht** als abgenommen zu lesen, sondern als Rest für eine unabhängige Prüfung.
Auffällig, ungeprüft: Warnungen `GAME_NOT_IMPLEMENTED … core:read` beim Lobbyaufruf im E2E-Serverlog.
