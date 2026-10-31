# G4 — Eigenprüfung (Block 5)

Durchgeführt nach dem ersten grünen integrierten Stand (Head `8621ac4`: Server 674, Web 168), vor jeder
Fertigmeldung. Vorgehen: vollständigen Diff gegen `main` `1f8fdce` neu gelesen, jede Abnahmeaussage der
Matrix auf einen **negativen/konkurrierenden** Gegenfall geprüft, die Gegenbeispiele des Auftrags (Abschnitt 13 B)
einzeln durchgegangen. Unabhängig davon bleibt die externe Prüfung des Nutzers.

## Tatsächliche Befunde und Behebung

| # | Befund | Schwere | Auslöser / Beleg | Behebung | Nachweis |
| --- | --- | --- | --- | --- | --- |
| 1 | Diagnosezeile zur traceId ohne Kontext: Ergebnis-Command/-Read/Recovery/`core:read` loggten Unerwartetes ohne die traceId der Antwort; Ergebnis-Read meldete jeden Fehler als „nicht gefunden“ | mittel | rote Probe: Zeile mit der traceId der Antwort enthielt kein `internalDetail` | `wireErrorToAppError` mit bereinigter Beschreibung in allen vier Pfaden; Level `error` für `INTERNAL_ERROR` | G4P „Errors“, `appError.test.ts` |
| 2 | `messageKey` konnte Freitext sein (z. B. Zod-Meldung `VALIDATION_ERROR: … received '<Clientwert>'` aus Jeopardy, als Code `INTERNAL_ERROR`) | niedrig–mittel | Code-Lesung `buildAppError`/`validateOrReject` | `messageKey` nur stabiler Bezeichner, `VALIDATION_ERROR…` → `INVALID_PAYLOAD`; Jeopardy liefert `INVALID_PAYLOAD` | `appError.test.ts`; G4P „values a client sends“ (Regressionsschutz, **kein** roter Vorstand: die geprüften Eingaben echoten schon vorher keinen Wert) |
| 3 | Kein Limit auf Spiel-Sockets (Lücke D aus der G1-Matrix) | hoch (Abnahmekriterium) | Ist-Analyse | Token-Bucket je Raum + Teilnehmer + Gruppe, siehe [limits.md](limits.md) | `actionLimits.test.ts`, G4P „Limits“, G4R |
| 4 | Replays eigener bekannter Commands waren in der ersten Fassung vollständig vom Limit **ausgenommen** → unbegrenzter Replay-Flood (DB-Reads) | mittel | Gegenbeispiel „Rate-Limit … ungebremster Retry“, Code-Lesung | eigenes `REPLAY`-Budget (60/10 s) | G4P „replays … own bounded budget“ (Test nach der Korrektur, kein roter Vorstand) |
| 5 | Befehle ohne Rolle/Recht (Viewer sendet `judge`) verursachten unbegrenzt DB-Reads und je eine Logzeile | mittel | Gegenbeispiel „Spammer“, Code-Lesung `requireGamePermission`-Zweig | `DENIED`-Budget je Identität; Sockets ohne Raum werden nicht verfolgt | G4P „refused commands are bounded“ (Test nach Korrektur) |
| 6 | Ergebnis-View vermischte aktuellen Status und Status der gelesenen Revision (`resultStatus` der Revision 2 meldete `FINALIZED`) | niedrig–mittel | Code-Lesung + Test mit Revisionslesung | `latestRevision`, `isLatestRevision`, `revisionKind`, `statusAtRevision`; UI trennt Historie vom Live-Status | G4P „what each revision was“, `ResultScreen.test.tsx` |
| 7 | Nutzerhinweis fehlte: `RATE_LIMITED` hätte als „Aktion nicht bestätigt“/Roh-Code erschienen | niedrig | UI-Durchsicht | `failureText` in Spieler-, Jeopardy-, WID- und Ergebnis-UI | Web-Tests (3) |
| 8 | Dokumentationsfehler in der eigenen ersten Fassung: Gruppe `LIFECYCLE` wirkte real nirgends (`game:start/pause/resume/end` laufen nicht durch den Guard) | niedrig | Aufrufer-Prüfung | Gruppe entfernt, Lücke in limits.md als Grenze benannt | `actionLimits.test.ts` |

## Selbst verursachte Fehler (offen ausgewiesen)

- Die erste CI am PR war rot: zwei Lintfehler in meiner G4-Testdatei (lokal nur die Warnzeile gelesen). Behoben (`8621ac4`).
- Eine Änderung in `http/middleware/auth.ts` (Log ohne Zod-Texte) betraf `checkPayload`, das **keinen** Aufrufer hat;
  keine echte Verbesserung, deshalb zurückgenommen und nicht als Befund gezählt.

## Geprüft ohne Änderungsbedarf (belegt durch neue Negativ-/Konkurrenztests)

Fehler nach Score-/Team-Writes vor Ergebnisversion (rollt alles zurück) · zwei Korrekturen/Finalisierungen auf
einer Revision · doppelte Rücknahme · Fremdraum-/Fremdpartie-Referenz · Amendment Partie 1 bei laufender und beendeter
Partie 2 · nach Host-Transfer (alter Host: weder Neu-Command noch Replay) · Absturzfenster zwischen Persistenz und Receipt ·
echter Prozessneustart mit Replay · Kick/Verlassen nach Spielende · nachträglicher Teamwechsel · Ersatzspieler nicht korrigierbar ·
manipulierte absolute Scores/unbekannte Felder/Delta 0 · überholte Ergebnis-Reads (neueres gewinnt) ·
geschützte Lese-/Resync-Pfade bleiben bei G3-Regeln (Tests unverändert grün) · Limits: Spammer vs. Mitspieler/Host/anderer Raum,
Tabs/Reconnect/frische IDs, Replay mit leerem Budget, abgelehnte Absicht ohne Receipt.
Hinweis: Diese Tests sind **Regressionsschutz**; sie schlugen gegen den Bestand nicht fehl, weil die Mechanik schon korrekt war.

## Offener Rest (nicht G4-blockierend, dokumentiert)

(Stand der ersten Eigenprüfung; Lifecycle/Room/Recovery inzwischen in der frühen Zulassung, siehe unten) Lobby-Events nicht in der frühen Zulassung · Receipt-Retention · HTTP-Resultate ohne Rate-Limit ·
neue Identität = neues Budget · Core-DoD „zwei Verbraucher“ der Auswahlabgabe (G3) · G5-Gesamtabnahme.

---

# Unabhängige Prüfung des PR (Head `ea22c51`) und Nachbesserung

Die externe Prüfung bestätigte A–C und fand drei offene Punkte in D/E sowie einen UI-Hinweis. Alle vier waren
**von meiner Eigenprüfung nicht gefunden worden**; die Ursachen, soweit erkennbar: Ich hatte nur geprüft, dass die
*Antwort* `RATE_LIMITED` lautet, nicht die Arbeit *vor* der Entscheidung (DB-Reads), und nur Fehler ohne
aufzählbare Zusatzfelder injiziert.

| # | Befund (Bericht) | Ursache | Reparatur | rot → grün |
| --- | --- | --- | --- | --- |
| R1 | Ausgeschöpftes Limit stoppt DB-Last nicht: je abgewiesenem Paket 2 (DENIED) bzw. 4 (neue Absicht) Reads (Raum, Teilnehmer, Raum, Receipt) vor der Entscheidung | Das Budget wurde erst im Handler nach `requireGamePermission`/Receipt-Lookup geprüft | Datenbankfreie Stufe 1 als Socket-Middleware (`requestAdmission.ts`), identitätsbasiert, **ohne Recht**; Stufe 2 bleibt nach der Autorisierung. `DENIED` wird beim Antworten belastet und führt danach zu früher Abweisung | 2 Reproduktionen des Berichts rot (Reads `[…]`) → grün (`[]`); eigene Tests für alle Einstiegspunkte |
| R2 | Recovery-Ablehnungen ungedrosselt: 80 Pakete → 0 limitiert, 80 Logzeilen | `game:recovery:command` hing an keinem Limiter; „rechtegebunden“ war als Schutz gewertet worden | Recovery, Lifecycle (`game:*`) und `room:command` laufen durch Stufe 1; Zuschauer-Flood erzeugt höchstens `REQUEST`-Burst (40) + 1 Logzeilen, danach keine | Reproduktion rot (`limited 0`, 80 Zeilen) → grün (`limited 40`, 41 Zeilen); Host/Spieler/Raum bleiben handlungsfähig (eigener Test) |
| R3 | Rohe Fehlerobjekte mit aufzählbaren Feldern (`meta.args` mit Token/Lösung) im Log (`Game end (receipted) error`, `Geo reveal error`) | `describeInternal` schützte nur `buildAppError`; 61 Aufrufer geben `{ error }` direkt an den Logger | Zentral im `logger` (`serializeLogMeta`): Errors überall in den Metadaten → sichere Beschreibung; Nicht-Error-Objekte unter `error`/`err`/`cause` ebenfalls | 2 Reproduktionen rot (Secret im Log) → grün; `logger.test.ts`; weitere Pfade (Ergebnis-Command, Jeopardy-/WID-Urteil) |
| – | UI: `RATE_LIMITED` nicht in allen limitierten Host-Aktionen verständlich (Feld öffnen, Weiter, Boardwechsel) | `failureText` nur in einem Teil der Hooks | auf alle von den Stufen betroffenen Oberflächen angewendet (Jeopardy, WID, Geo-Host, Raumpanel) | `limitMessages.test.tsx` rot für Feld öffnen/Weiter/Boardwechsel → grün |

**Eigenprüfung nach der letzten Korrektur** (eigener Schritt, ausdrücklich auf Ressourcenaufwand *vor* der
Limitentscheidung und *alle* Logzeilen des Fehlerablaufs):
- Reads gezählt für 9 Einstiegspunkte bei ausgeschöpfter Identität (`weristdas:buzz`, Resync, `game:core:read`,
  Ergebnis lesen/ändern, Recovery, Pause, Ende, `room:command`): jeweils `[]`; keine zusätzliche Logzeile.
- Verbleibende Last bewusst benannt: pro Identität höchstens `REQUEST`-Burst plus 12 Pakete/s mit je einigen Lookups.
- Nebenwirkung der Middleware geprüft: Pakete ohne serverseitige Identität werden nicht verfolgt; Reconnect/Tab teilt
  das Budget; ein gespeicherter Erfolg bleibt nach `retryAfterMs` abrufbar; der Server-Gesamtlauf (inkl. aller
  G1–G3-Rennen/Bursts) bleibt grün.
- Zweite Logzeile neben APP_ERROR (`Game end (receipted) error …`) bleibt, ist aber jetzt auf Klassenname/Kurzcode
  beschränkt; sie trägt keine traceId (die APP_ERROR-Zeile desselben Fehlers trägt sie). Nicht weiter verknüpft.
