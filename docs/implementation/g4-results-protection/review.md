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

Lifecycle-/Room-/Recovery-Sockets nicht im neuen Limiter · Receipt-Retention · HTTP-Resultate ohne Rate-Limit ·
neue Identität = neues Budget · Core-DoD „zwei Verbraucher“ der Auswahlabgabe (G3) · G5-Gesamtabnahme.
