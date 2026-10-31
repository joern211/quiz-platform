# G5 — Eigenprüfung, Befunde, Rest

Zwei Durchgänge: (1) Eigenprüfung nach dem ersten grünen Stand, (2) Nachbesserung nach dem unabhängigen Prüfbericht zu PR #28 (R1–R3).

Angekündigter, eigener Arbeitsschritt nach dem ersten grünen Teilstand. Gegenfälle nach Auftrag §7/8/10/13.

## Tatsächliche Befunde

| # | Quelle / Trigger | Soll / Ist | Ursache | Korrektur | Nachweis |
| --- | --- | --- | --- | --- | --- |
| 1 | Voller Serverlauf auf unverändertem main (708/710), `g4Protection` „lost acknowledgement of a result correction…“ (zusätzlich „Admission: more tabs…“ anfällig) | Soll `RATE_LIMITED`, Ist Erfolg | `exhaust()` ließ die Limiter-Uhr laufen; REQUEST füllt 12 Token/s nach, auf langsamer Maschine kam ein Token zurück. PR27 hatte nur Teile eingefroren | `exhaust()` friert die Uhr; `afterHint` spult die eingefrorene Uhr um den Hinweis vor; rohe Wartezeiten ersetzt | **Rot:** Originaldatei + 300 ms Verzögerung → 2 Tests rot. **Grün:** derselbe Eingriff gegen den neuen Stand grün; Datei 53/53 |
| 2 | Voller Serverlauf, `jeopardy/socket-flow` „restores only active Geo timers…“ (2 statt 1 Aufruf) | nur eigene Räume zählen | `restoreActiveTimers` scannt alle RUNNING-Räume der gemeinsamen Test-DB | Assertion auf die im Test angelegten Räume beschränkt | **Rot:** fremder RUNNING-Raum mit abgelaufenem Timer in der DB, Originaltest → identische Meldung. **Grün:** nach Änderung |
| 3 (R1) | Unabhängiger Prüfbericht; reproduziert mit realem Hook und realer Host-Seite | Nach vorläufig abgewiesenem `game:core:read` (RATE_LIMITED) soll die Bedienung wiederkehren; Ist: `projection = null`, alle Aktionen gesperrt, kein Hinweis, kein Wiederholungsweg | `useGameCore` behandelte jede Fehlantwort gleich und gab weder Status noch `refresh` zurück | Hook liefert `status` (loading/ready/throttled/denied/error), `retryAfterMs`, `refresh`; bei `RATE_LIMITED` höchstens 3 automatische Re-Reads nach dem Server-Hinweis (Timer wird bei Ereignis, Socketwechsel, Disconnect, Unmount gelöscht, alte ACKs verworfen); `denied` (z. B. `NOT_IN_ROOM`) nie automatisch; Autorität bleibt bis zur frischen gültigen Projektion entzogen. Gemeinsame `CoreReadNotice` (Alert + „Erneut laden“) in allen fünf Verbraucher-Seiten; RoomPanel ohne zweite Steuerung | **Rot:** drei neue Hook-Tests + Host-Seiten-Test gegen den alten Hook rot. **Grün:** `useGameCore.test` (6), `GeoRecovery.test` (15), Web gesamt grün. Server: `g4Protection` „exhausted core read“ ×3 (echte ausgeschöpfte REQUEST-Zulassung → `RATE_LIMITED` + `retryAfterMs`, kein Receipt, andere Teilnehmer unberührt, Read nach Hinweis liefert Projektion) |
| 4 (R2) | E2E-Serverlog `GAME_NOT_IMPLEMENTED … core:read` in der Lobby | Ist: `RoomPanel` las den Core, obwohl vor dem Start kein Spielzustand existiert (`GAME_NOT_FOUND` → WARN je Read) | erwarteter Zustand, aber vermeidbarer Lärm und Last | `RoomPanel` liest erst, wenn das Spiel existiert | `RoomPanel.test` „reads the game core only once a game exists“ |

Befunde 1–2: Welcher fremde Raum im Volllauf tatsächlich auftrat, wurde nicht ermittelt (Mechanismus reproduziert, Zuordnung nicht bewiesen); beides Testfehler. Befund 3 ist ein Produktfehler (bestand vor G5), Befund 4 vermeidbare Last/Warnung.

## Geprüft ohne Änderungsbedarf (mit Beleg)
- Admission-Isolation (neuer Gegenfall, Positivkontrolle), Viewer-Kapazität, DISPLAY, Recovery-Evidenz (neuer Gegenfall), 0 Punkte in `ResultScreen`.
- **Sendeseitiger Medien-Neustart** (M4b): erste Fassung scheiterte an meinem falschen Kriterium „neue Stream-ID“ (stammt aus der Sender-SDP), ersetzt durch wachsende inbound-rtp-Bytes auf neu gebautem Peer.
- **Kleiner Bildschirm** (E2E G5-B1, 360×640, Touch, Wissensduell): Host- und Spielerseite ohne horizontales Scrollen, „Auflösen“, „Spiel beenden“ und Antwortoption als benannte Buttons vollständig im Viewport.
- **Read-Last:** gemessen **4 `game:core:read` pro Zustandswechsel (Auflösen) je Client** (Host und Spieler), weil mehrere Ereignisse desselben Wechsels je einen Read auslösen. Grenzen: REQUEST 40 Burst/12 pro s, READ 40/8 pro s je Identität; ein Wechsel verbraucht also ~4 von 40 Token, ordinäres Spieltempo erschöpft das Budget nicht. Eine Zusammenfassung der Reads wurde **nicht** eingebaut, weil bestehende Hook-Tests sofortige Reads je Ereignis voraussetzen und kein Fehler vorliegt; bei künftig schnellen Mehrfachwechseln ist das der Ansatzpunkt. Nicht gemessen: Mehrspieler-Last mit vielen echten Browsern.
- **Wartelisten-/Rate-Limit-Zusammenspiel:** ein ausgeschöpfter Teilnehmer sperrt andere nicht (G4P, neuer Core-Read-Test).

## Eigene Fehlgriffe (behoben)
Jeopardy-0:0 angenommen (`field:lock` ist Legacy-Alias, Felder enden nur per Buzz+Urteil); zweimal beim Scripten eine Testdatei beschädigt (aus Git wiederhergestellt, danach vollständig grün); in der Matrix hatte ich WID fälschlich als Matching-Verbraucher geführt und die Core-DoD pauschal verneint — korrigiert (siehe matrix.md).

## Nicht geprüft / verbleibend (ehrlich)
- Kleiner Bildschirm und Namen im Browser nur für Wissensduell; Jeopardy- und WID-Seiten nur über den gemeinsamen Hook-/Komponententest (`CoreReadNotice` ist dort identisch eingebunden).
- Medienrechte nach Teamwechsel im Browser: nur Server-Test (`media/live.integration` „revalidates team changes and old routes“) und E2E M4 (Team-Kanal entzieht Audio).
- Echte Mehrspieler-Last mit vielen Browsern, externe Netze/NAT, Legacy-`ResultPage.tsx`.
- Der ACK-Timeout-Hinweis aus PR26 trat in keinem Lauf wieder auf; Ursache weiterhin unbelegt.
