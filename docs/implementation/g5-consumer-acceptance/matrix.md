# G5 — Mechanik-, Verbraucher- und Nachweismatrix

Base: main `bafbc61` (PR26/PR27 im Code bestätigt). Stufen: **R** im Teilumfang in einer echten Engine verwendet · **H** Helper/Schema ohne volle Integration · **O** im Kern nicht als vollständiger Baustein vorhanden · **S** bewusst später.
Verbraucher: W = Wissensduell, J = Jeopardy, WID = Wer ist das?. Keine Prozentwerte. R für einen Teilumfang ist nicht automatisch volle Core-DoD.

**Ehrlicher Prüfumfang:** Die Zeilen stützen sich auf Codeprüfung der genannten Pfade und auf Ausführung der genannten Tests am Head. Die G1–G4-Matrizen wurden nicht neu aufgerollt; wo ich nur auf deren Nachweise verweise, steht „bestehend“.

| Baustein / Teilumfang | Verbraucher | Pfad / Rechte-Grenze | Nachweis (Test) | Stufe | Grenze |
| --- | --- | --- | --- | --- | --- |
| Admission-Isolation PENDING_JOIN/WAITLIST (Lesen, Handeln, Broadcast) | W, J, WID | Spielevents verlangen `roomChannel`-Mitgliedschaft (`access.ts`), Medien `admission: ACTIVE` (`media/live.ts`) | **neu** `g4Protection` „a PENDING_JOIN and a WAITLIST player…“ (3 Spiele, Positivkontrolle); bestehend `team-room.integration` „keeps pending viewers outside gameplay broadcasts…“ | R | Genehmigungs-Nachlieferung alter Secrets: bestehend geprüft (`team-room`), hier nicht neu |
| Gemeinsame Viewer-Kapazität (Token-Rejoin, anonyme Sitzung, letzter Slot) | alle (Raumebene) | `activeViewerCount` unter Raum-Schreibsperre (`rooms/core.ts`) | bestehend `team-room.integration` „rechecks shared viewer capacity on token rejoin…“, „admits at most one competing viewer…“ | R | Anonyme Viewer haben keinen Wiederaufnahmepfad (neuer Join) |
| DISPLAY getrennt von Limits, read-only trotz Hostcookie | alle | `DisplaySession`, `media/live.ts` | bestehend `media/live.integration` „multiple true DISPLAY sessions…“, E2E M5 | R | — |
| Recovery-Evidenz bis exakte Vorversion, Ledger, Version, Run | W, J, WID | `recoveryCommands.ts` | bestehend „stale event tail“, „missing evidence“, „late player“; **neu** `results.integration` G5 (Ledger-Abweichung, fremder Run, danach Erfolg) | R | Echter Prozessneustart: G2/G3/G4-Restarttests (bestehend); Recovery-Befehl selbst läuft im Testprozess |
| 0 Punkte als Wert (State, Ledger, Rang, UI) | W, WID (0:0 regulär); J (0 als Rang-3-Wert im Teamspiel) | `rankScores`, `ResultScreen` | bestehend G4P „nobody scored“ (W, WID), G4P TEAM_SCORE (J, Dan 0); **neu** `ResultScreen.test` (0, 0-Gleichstand, negativ, Team) | R | **J 0:0 ist kein regulärer Pfad**: ein Feld endet nur über Buzz+Urteil; keine Regel erfunden. `ResultPage.tsx` (Legacy-Seite) nutzt `p.score \|\| 0` und `any`, nicht geändert |
| Beidseitiger Medien-Neustart | Raum-Medien (Host/Player/Viewer) | `media:restart` rotiert Routen beider Enden | E2E M4 (Empfänger startet), **neu** M4b (Sender startet, inbound-rtp-Bytes wachsen auf neu gebautem Peer, Host-Mute/Kamera verbergen danach wirksam); bestehend `media/live.integration` „restarts a receive-only viewer on both ends…“ | R | Lokal, kein Nachweis für externe NATs; Teamwechsel-Entzug alter Peers bestehend |
| Aktionslimits, Intentclient-ID-Lebenszyklus | alle | G4 | bestehend G4P; **repariert**: Limiter-Uhr in `exhaust()` | R | siehe review.md |
| Recovery/Neustart, Receipts | alle | G2–G4 | bestehend `g2/g3/g4Restart` | R | — |
| Auswahlabgabe (Eingabeformat) | nur W | — | — | R (nur 1 Verbraucher) | **Core-DoD „zwei Engines“ offen** |
| Antwortbesitzer nach Buzz | J, WID | — | G3/G4-Tests | R | kein allgemeiner Mehrspieler-Turnzyklus |
| EXACT/MANUAL_ONLY | J, WID | — | G3 | R | NORMALIZED/SYNONYM/FUZZY nur H |
| Count-up/Zeitänderung, weitere Tie-Strategien | — | — | — | H/S | nicht in zwei Engines bedienbar |
| Live-Voice vs. Song-Clip-Zeitplan, Rollen-Core | — | — | — | O/S | späterer Mechanikcluster |

## Abschlussliste
- **G1–G5 im vereinbarten Umfang abgeschlossen:** siehe review.md (Abschlussurteil dort, abhängig von finaler CI).
- **Volle Core-DoD mit zwei echten Verbrauchern:** nicht erreicht (Auswahlabgabe nur W; Antwortbesitzer J/WID ohne allgemeinen Turnzyklus).
- **Nur R-Teilumfang / H / O / S:** Normalisierung/Synonyme/Fuzzy (H), Count-up und Tie-Strategien (H/S), Rollen-/Voting-Core (O), Song-Clip-Sync (O/S).
- **Offene DEC-Punkte:** keine neuen gefunden; bestehende Tie-Strategien-Entscheidung bleibt offen.
- **Spätere Cluster:** Turn-Zyklus, numerische/Mehrfeld-Abgaben, Rollen/Voting, Event/Olympia — jeweils eigenes Paket.
