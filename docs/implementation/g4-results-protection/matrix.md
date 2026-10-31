# G4 — Gemeinsame Ergebnisse, Korrekturen und Mechanikschutz

Basis: main `1f8fdce` (G1–G3 gemergt). Quellen: Auftrag G4, Plan G1–G5 (gepinnt `e2ca3e25`, nur
lesend), G1/G2/G3-Matrizen, tatsächlicher Code. Kein neuer vollständiger Master-Audit.
**R** real belegt · **H** Hilfsbaustein · **O** nicht vorhanden · **S** später.
Verbraucher: Wissensduell (W), Jeopardy (J), Wer ist das? (WID). Nachweise: `g4Protection.integration.test.ts`
(G4P), `g4Restart.integration.test.ts` (G4R), bestehende `results.integration.test.ts` (RES).

## A — Atomare Score-/State-/Event-/Ergebniswirkung

| Aussage | Pfad | Verbraucher | Nachweis | Stufe |
| --- | --- | --- | --- | --- |
| Ledger, Score-Map, Teilnehmer-/Team-Cache und Ergebnis stimmen überein | `recordScoreMutation` → `persistGameResult` (`context()` baut aus Ledger) | W, J, WID | G4P „one evidence“ (je Spiel, regulär beendet, Socket **und** HTTP identisch) | R |
| Fehler beim Ergebnisschreiben beendet nichts | `finishRunningGame` + `persistGameResult` in einer TX | W, J, WID | G4P „failing result write ends nothing“ (kein GAME_END, keine Ergebniszeile, kein Teileffekt, Retry beendet genau einmal) | R |
| Fehler nach Score-/Cache-Writes, vor Ergebnisversion | `mutateResult` (eine TX) | W (Team) | G4P „failing write after score and cache writes“ | R |
| 0 ist ein Wert; Gleichstand teilt Platz 1, alle sind Sieger, kein Zufall | `rankScores`, `buildEngineGameResult` | W, WID | G4P „nobody scored“ (regulär beendet) | R (J: siehe Grenzen) |
| Host-Abbruch behält Endgrund und Punkte, kein Sieger | `base()` `aborted` → `winnerIds: []` | W, J, WID | G4P „host abort“ | R |
| Wiederholter/konkurrierender Command wirkt einmal, gleiche ID mit anderer Absicht abgewiesen | `runReceipted` | alle | G4R (nach echtem Neustart), G4P Korrekturen | R |
| Absturz zwischen Persistenz und Bestätigung | Receipt `PENDING` + `mutationStartedAt` | WID (Ergebnis-Command) | G4P „process dies after the correction committed“ → `resyncRequired`, nie doppelt (DB-seitig simuliert) + G4R echter Neustart | R |
| Buzzer-Korrektur betrifft nur offenen Versuch, keine Ergebnisänderung | `buzzerOverride` (G2/G3) | J, WID | G3-Tests unverändert | R |

## B — Ergebnisse, Rang, Teamwertung

| Aussage | Nachweis | Stufe |
| --- | --- | --- |
| Werte/Rang/Gewinner aus demselben gespeicherten Nachweis, Socket = HTTP | G4P „one evidence“ (W, J, WID) | R |
| Teamwertung: Teamsumme, Rang, Teamsieger, Team-Cache gleich; `TEAM_SCORE` getrennt von Einzelwertung | G4P „TEAM_SCORE“ (W, J, WID; J: anderes Team stiehlt, da das falsche Team gesperrt ist) | R |
| Nachträglicher Teamwechsel hängt keine Ledger-Zeilen um; Korrekturen folgen dem historischen Team | G4P „TEAM_SCORE“ (Alice wechselt nach dem Spiel; ADJUST/ROLLBACK bleiben bei Team A) | R |
| Verlassen/Kick behält Punkte und Platz; Ersatzspieler ist neue Identität, nicht korrigierbar | G4P „left or was removed“ (W, J, WID) | R |
| Revision eindeutig: aktueller Status ≠ Status der gelesenen Revision | `latestRevision`, `isLatestRevision`, `revisionKind`, `statusAtRevision` im View (Socket/HTTP) + UI-Label | R (neu) |
| Ergebnisansichten ohne Lösungen/Secrets | G4P prüft Antworten auf Lösungs-/Antwortstrings (W, J, WID) | R |
| Zugriffspolitik privat/öffentlich, Forged-Score abgewiesen | RES (bestehend) + G4P „forged absolute values“ | R |
| Tie-Strategien außer ALLOW_TIE | unverändert offen, keine Strategie aktiviert | S/DEC |

## C — Korrekturen, Finalisierung, historische Isolation

Ablauf `GAME_END → RESULT_REVIEW → FINALIZED`; danach nur `AMEND` (Nachweis `RESULT_AMENDMENT`).

| Aussage | Nachweis | Stufe |
| --- | --- | --- |
| Zwei Korrekturen auf derselben Revision: genau eine gewinnt, Ledger/Versionen zeigen eine | G4P „two corrections on one revision“ | R |
| Doppelte Rücknahme desselben Ursprungs, fremde Partie/Raum/Spieler abgewiesen | G4P „same origin cannot be reversed twice“ | R |
| Amendment von Partie 1 während Partie 2 läuft und nach deren Ende ändert nichts von Partie 2; alte Revisionen lesbar | G4P „amending run one while run two is playing“ | R |
| Gleiches nach Host-Transfer; alter Host kann weder handeln noch replayen | G4P „after a host transfer“ | R |
| Neustart: Replay ohne zweite Version/Ledger-Zeile, alte Revision lesbar | G4R | R |
| Rechteentzug beim Replay, Fremdraum-Referenzen, Ledger-Manipulation blockiert Finalisierung | RES (bestehend) | R |
| Reveal nicht „ungesehen“ machbar; kein globales Undo | kein solcher Befehl vorhanden | – |

## D — Aktionslimits · E — Fehlerdiagnosen

D: siehe [limits.md](limits.md) — Stufe 1 (frühe, datenbankfreie Zulassung als Socket-Middleware, `REQUEST` +
`DENIED`) und Stufe 2 (Budgets je Aktion). Der Intentclient behält die Befehls-ID bei `RATE_LIMITED` (vorläufige Ablehnung): ein gespeicherter Erfolg mit verlorener Bestätigung wird beim Retry aus dem Receipt beantwortet, nie verdoppelt (G4P „Retry:“, `commandIntentClient.test.ts`). Nachweis mit **gezählten DB-Reads**: ausgeschöpfte Identität → keine
Reads, keine Logzeile, für Spiel-, Ergebnis-, Recovery-, Lifecycle-, Lese- und Room-Einstiege (G4P „Admission“,
Reproduktionen des unabhängigen Prüfberichts).
E: Unerwartetes im Ergebnis-/Recovery-/Core-Read-Pfad → `INTERNAL_ERROR` + traceId; dieselbe traceId steht in der
Diagnosezeile (Level `error`) mit bereinigter Beschreibung (`observability/safeError.ts`: nur Klassenname/Kurzcode,
Meldungen nur bei getypten Fehlern); der **HTTP-Fehlerhandler** loggt dieselbe Beschreibung unter der traceId der Antwort (kein `message`/`stack`). **Der `logger` selbst ersetzt Error-Objekte an jeder Stelle der Metadaten
(und alles unter `error`/`err`/`cause`) durch diese Beschreibung** — damit kann kein Aufrufer (61 Stellen mit
`{ error }`) verschachtelte Felder wie `meta.args`, `response`, `cause` ins Log geben. `messageKey` ist immer ein
stabiler Bezeichner. Nachweise: `logger.test.ts`, `appError.test.ts`, G4P „Errors“ (Probe mit verschachtelten
synthetischen Secrets über Spielende, Reveal, Ergebnis-Command, Jeopardy- und WID-Urteil).

## Grenzen

- Verbraucher-Abnahme bleibt G5. Count-up/Mehrspieler-Zug/H-Modi und die Auswahl-DoD (nur Wissensduell) unverändert (G3).
- Gleichstand: 0:0 regulär beendet bei W/WID (G4P); Jeopardy-Gleichstand ist durch das bestehende RES („with ties“, J und W) belegt, nicht durch einen eigenen G4-Fall.
- Legacy-Befehle ohne Kontextfeld bleiben zulässig (G3-Grenze); keine neuen Events/XP/Statistik.
