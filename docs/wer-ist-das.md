# Wer ist das? (BETA: Fusion + geschütztes Medienzugriff)

## Einrichtung (Setup v2)

Der Host wählt das Spiel im Katalog (Slug `wer-ist-das`, Anzeigename „Wer ist das?“) und legt pro Runde **zwei Originalbilder (Bild A, Bild B)** sowie **zwei Namen (Name A, Name B)** an. Über `POST /api/v1/media/composite` erzeugt die Website aus den beiden Originalen ein **einfaches, reproduzierbares Fusion-Spielbild** (serverseitig, `sharp`: center-crop 1024×1024 + 50%-Alpha-Crossfade, Algorithmus `crossfade-v1`). Das Ergebnis wird **einmal** als unveränderliches Asset persistiert (`visibility ROOM_TEMP`, `processStatus READY`, `derivedFromAssetIds = [A, B]`); wiederholte Aufrufe mit denselben Quellen liefern dasselbe Asset (idempotent über den ordnungssensitiven logischen Schlüssel (Algorithmus + A + B); die Byte-Datei wird über sha256 geteilt). In der Setup-UI ist Upload-/Verarbeitungsstatus, Fehlermeldung und eine **Vorschau des Spielbilds** sichtbar, bevor der Raum erstellt wird.

Der Raum speichert `setupSnapshotJson` mit `setupSchemaVersion: 2` und pro Runde `personAImageAssetId`, `personBImageAssetId`, `gameImageAssetId`, `personAName`, `personBName` sowie `setupVersion: 2`. `Room.setupSchemaVersion` wird beim Erstellen ehrlich aus dem Snapshot abgeleitet (2, wenn top-level `setupSchemaVersion: 2` oder eine v2-Form-Runde; sonst 1) — bestehende Räume werden nie umgeschrieben. Beim Spielstart validiert die Engine serverseitig: beide Originale und das Spielbild müssen existieren, Bilder sein, `READY` sein und dem Raum-Host gehören; das Spielbild muss sich von **genau** diesen beiden Quellen ableiten. Ein fehlerhaftes Setup setzt den Raum in die Lobby zurück (kein halb gestartetes Spiel).

> **Rückwärtskompatibilität:** Ältere Runden in der v1-Form (ein `imageAssetId` + `person1`/`person2`) bleiben lesbar und lauffähig (`setupVersion 1|2`, `isV2Round()`). Es werden keine historischen Runden still umgeschrieben.
>
> **Engine-Version & Recovery (Nacharbeit D):** `engineVersion` wird beim Start gepinnt (`WER_IST_DAS_ENGINE_VERSION = 2`). v1- und v2-Räume erzeugen die **gleiche** State-Form (`WerIstDasState`); die Versions-Differenz liegt im Setup-Rundenformat, das `normalizeRound` version-agnostisch liest. Deshalb unterstützt **ein** Reader beide Versionen exakt — nachgewiesen durch einen **echten Prozess-Restart-Test** (`recovery.integration.test.ts`): ein vor dem Start persistierter v1-Raum (`engineVersion=1`) und ein v2-Raum (`engineVersion=2`) werden nach dem (echten) Neustart wiederbetrieben (Phase, Bild-ID, Punkte, Buzz-Rechte, Geheimhaltung) und normal beendet. Persistierter State einer **unbekannten/höheren** Engine-Version wird nicht gedeutet → kontrollierter `UNSUPPORTED_ENGINE_VERSION` statt falschem State.
>
> **Host-als-Player-Sperre:** Wer die Originale und Namen selbst eingegeben hat, hat Wissensvorteil (Regelwerk §2: administrierende Rolle ≠ Informationsrecht). Ein als Player eingeloggtes Host-Konto wird beim Beitritt der eigenen wer-ist-das-Runde serverseitig abgelehnt (`HOST_CANNOT_PLAY_OWN_ROUND`). Anonyme Spieler (ohne Login) sind der faire Modus und nicht betroffen.
>
> **Späteres Morphing:** Die Erzeugung ist hinter `createGameImage()` gekapselt (gleiche Signatur, gleiches Asset-Modell); ein echter Morph ersetzt nur diese Funktion und ist Teil dieses PRs nicht.

> Hinweis: Der interne Modul- und Socket-Eventname bleibt `weristdas`
> (Modulpfad `games/weristdas/`, Events `weristdas:*`). Das ist bewusst
> getrennt vom **Spiel-Slug** `wer-ist-das` (sichtbare Identität in DB/API/URL).

## Phasen und Regeln

Unverändert: `ROUND_READY` → Host öffnet den Buzzer → `BUZZ_OPEN` → erster gültiger Spieler buzzert → `ANSWERING`. Der Host bewertet:

| Bewertung | Punkte | Folge |
| --- | ---: | --- |
| Beide richtig | +3 | `REVEAL` |
| Eine richtig, Hinweis aktiv | +1 | `REVEAL` |
| Falsch | −1 | `ROUND_READY`; Spieler für diese Runde ausgeschlossen |

Eine richtige Person ohne Hinweis kann nicht als solche gewertet werden. Auch nach aktiviertem Hinweis bleiben beide richtigen Personen +3 Punkte wert. Der Host kann den Hinweis während `ROUND_READY`, `BUZZ_OPEN` oder `ANSWERING` aktivieren; er verrät noch keinen Namen. Bei falscher Antwort öffnet er den Buzzer erneut. Sind alle Spieler ausgeschlossen, kann er die Runde ohne Gewinner auflösen.

`REVEAL` veröffentlicht beide Namen und die Punkte. Nur der Host startet die nächste Runde. Die neue Runde setzt Hinweis, Buzzer, Gewinner und Ausschlüsse zurück. Nach der letzten Auflösung führt „Ergebnis anzeigen“ zum gemeinsamen Spielabschluss: Raum `ENDED`, `runPhase` `RESULTS`, Spielphase `GAME_END`. `game:end` bietet auch den manuellen Abschluss; dieser gibt eine noch verborgene Lösung nicht frei.

## Architektur und Sicherheit

Die Registry ruft die Engine über den generischen `game:start`- und `game:end`-Lifecycle auf. Socket-Aktionen werden anhand der serverseitigen Socket-Identität und Raumzugehörigkeit autorisiert. Der gemeinsame Buzzer entscheidet den ersten gültigen Buzz; Revision/CAS verhindert einen zweiten Sieger. Der gemeinsame Score-Core schreibt `Participation.score`, `ScoreEvent` und `RoomGameState` transaktional. `engineVersion` wird beim Start gepinnt (`WER_IST_DAS_ENGINE_VERSION = 2`) und beim Laden (act/resync) gegen `SUPPORTED_ENGINE_VERSIONS` geprüft; Rejoin/Recovery stellt Phase, Punktestand, Ausschluss und Antwortrecht aus dem gespeicherten State wieder her, das Spielbild wird dabei **nicht** neu erzeugt.

### Bild-Lebenszyklus (Nacharbeit E)

Das Fusion-Spielbild wird **vor** der Raumerstellung erzeugt und trägt bis dahin `roomId = tmp-<Host>` (eigenes, owner-geschütztes Asset, ohne echte Raum-ID). Nach erfolgreicher `POST /rooms` werden die im neuen Raumsnapshot referenzierten tmp-Assets **kontrolliert** an die echte Raum-ID gebunden — nur `ROOM_TEMP` + Host-eigene + im Snapshot referenzierte; bereits an einen echten Raum gebundene oder fremde Assets werden nicht gestohlen, Originale (PRIVATE) bleiben unangetastet. Die Bindung ist idempotent (doppelter Klick / Retry) und fehlertolerant: ein Fehlschlag macht den Raum nicht unbrauchbar (die Startvalidierung prüft Eigentum + Provenienz, nicht `roomId`); ein Prozessabbruch zwischen Raumerstellung und Bindung wird beim Spielstart geheilt. Verwaiste tmp-Assets (abgebrochenes Setup, gelöschte Runde, Quellaustausch, fehlgeschlagene Raumerstellung, Prozessunterbrechung) werden befristet bereinigt: nur unreferenzierte `tmp-`-Assets, die in keinem Raumsnapshot (auch nicht in ENDED-Räumen) vorkommen und älter als 24 h sind. Ein Rate-Limiter begrenzt Raum-Erstellungen (Doppelklick), wie schon die Beitritts-Route.

### Medien-Geheimhaltung (PR11)

- **Vor Reveal** erhalten Player, Viewer und Display **ausschließlich das freigegebene Spielbild** — als `imageAssetId` (Identität) plus `gameImageUrl`, einer **kurzlebigen HMAC-Signed-URL** (audience `game`, TTL 5 Min). Spieler/Viewer haben keine HTTP-Session, die `game`-URL funktioniert ohne Login. **Namen, Alias, Original-IDs und Original-URLs erscheinen in keiner Projektion, in keinem Socket-Event und in keinem HTTP-Header** (auch nicht in `storagePath`/`originalName`, die nie nach außen gehen).
- **`GET /api/v1/media/:id`** liefert `PRIVATE`/`ROOM_TEMP`-Assets nur noch gegen gültige Signed-URLs; private Inhalte werden mit `Cache-Control: no-store` ausgeliefert (vorher: offen + `public, max-age=1y`). `PUBLIC`/`SYSTEM`-Medien (z. B. Wissensduell/Geo) bleiben wie gehabt zugänglich — mit normalem Cache.
- **Host-Kontext** erhält zusätzlich `hostImageUrls` (Signed-URLs audience `host`, TTL 60 Min), die **nur mit gültiger Host-Session** laden (uploader == Session-User oder Session-User == Raum-Host). Damit bleiben die Originale für Setup-Korrektur/Reveal-Vorschau sichtbar, ohne dass eine rohe Asset-ID sie freigibt.
- **Nach Reveal** werden Namen/Beschreibung an alle Rollen projiziert (das ausdrücklich Freigegebene); `game:end` ohne Reveal veröffentlicht nichts.
- Eine direkte Medien-URL mit manipulierter Asset-ID, fremde Session, abgelaufene Room-Session oder alter Browser-Cache umgeht die Politik nicht: Signatur wird serverseitig verifiziert (timing-safe), `exp` wird geprüft, `no-store` verhindert Caching.
- **Upload:** echter Content-Check über das Decodieren der Bytes (nicht Client-MIME), EXIF-/Metadaten-Strip, WebP-Normalisierung, Größen- und Abmessungs-Limits (`MAX_IMAGE_SIZE_MB`, `MAX_IMAGE_DIMENSION`), Dedupe über sha256, Datei-Cleanup bei Fehlern.

Socket-Aktionen: `weristdas:buzzer:open`, `weristdas:buzz`, `weristdas:judge`, `weristdas:hint`, `weristdas:reveal`, `weristdas:next`, `weristdas:resync`. Der Server sendet `weristdas:update` mit einer Projektion für die jeweilige Rolle.

## Prüfung

- `state.test.ts`: Phasen, Punkte, Hinweis, Ausschluss, Reset.
- `socket-flow.integration.test.ts`: v1-Zwei-Runden-Ablauf (Regression), parallele Buzzes, Rollenrechte, Geheimhaltung, Score-Transaktionen, Rejoin, zwei Räume, Initialisierungs-Rollback, manueller Abschluss.
- `composite.test.ts` (neu): echtes gespeichertes 1024²-Fusion-Bild mit nachvollziehbarer Quelle (nicht bloße Kopie), Idempotenz, Fremd-Asset-/Ownership-Verweigerung, identische A/B-Quellen, Insert-Fehler ohne neue finale Datei; Schutz gemeinsamer Dateien bei Parallelität.
- `fusion.integration.test.ts` (neu): v2-Rollenprojektion (vor Reveal nur Spielbild, keine Namen/Originale; Host bekommt `hostImageUrls`), Full-Round, Reconnect/Recovery mit gepinnter `engineVersion` und **nicht** neu erzeugtem Composite, Rollback bei fremder ID/falscher Composite-Zuordnung/identischen Quellen, Host-als-Player-Block (HTTP).
- `media.integration.test.ts`: Upload-Content-Check, MIME-Spoofing, Signed-URL-Zugriffe (game/host, abgelaufen, fremde Asset), Cache-Header, PUBLIC-vs-private.
- `recovery.integration.test.ts` (neu, D): **echter Prozess-Restart** (Subprocess-Server, eigene DB): v1-Raum (`engineVersion=1`) + v2-Raum (`engineVersion=2`) werden nach dem Neustart wiederbetrieben (Rejoin, Phase, Bild-ID, Punkte, Buzz-Rechte, Geheimhaltung) und normal beendet; inkompatible `engineVersion` → kontrolliertes `UNSUPPORTED_ENGINE_VERSION`.
- `media-lifecycle.integration.test.ts` (neu, E): tmp→Raum-Bindung nach `POST /rooms`, Idempotenz (doppelter Klick), fremde/ebenso-referenzierte Assets werden nicht gestohlen, Originale unangetastet, Orphan-Cleanup (24 h, aktive/historische geschont), Heilung nach Prozessunterbrechung beim Spielstart.
- `catalog-consistency.test.ts` / `seed-partial-db.integration.test.ts`: Seed ↔ Manifest deckungsgleich, `setupSchemaVersion` 2, Konvergenz bestehender DBs.
- `apps/web/e2e/weristdas-e2e.spec.ts`: Browserablauf mit v2-Setup (zwei Bilder, Fusion-Vorschau), Buzzer, Reload und Ergebnis. CI führt diesen zusammen mit Geo und Jeopardy aus.

## Bekannte Einschränkungen (BETA)

- Die Fusion ist eine **einfache Composite** (50%-Crossfade), kein echtes Morphing; der Algorithmus ist austauschbar (`createGameImage()`).
- Status bleibt `BETA`; die Umstellung auf `AVAILABLE` ist **nicht** Teil dieses PRs und setzt die vollständige Definition of Done mit Core-Contract-Tests voraus.
- **Bild-Lebenszyklus (BETA-Grenze, ehrlich):** Verwaiste tmp-Assets werden **beim Serverstart** befristet bereinigt (>24 h, unreferenziert). Ein laufender Server räumt während des Betriebs NICHT proaktiv auf — verwaiste Assets eines unterbrochenen Setups bleiben bis zum nächsten Start bzw. bis zur 24-h-Schwelle im Storage (keine Datenkorruption, nur Storage-Bestand). Ein allgemeiner Storage-GC (auch für `PRIVATE`/alte Räume) ist ein bewusst separater Folgeauftrag.

## Ergänzung: parallele Publikation und Cleanup (10.10.2026)

Composite-Zuordnung und Dateiveröffentlichung verwenden denselben SQLite-Writer-Lock wie Startup-Cleanup. Der Insert erfolgt vor Veröffentlichung der kompletten Datei; Insert-Fehler löschen keinen gemeinsamen finalen Blob. GC commitet die Zeilenlöschung vor Dateilöschung und prüft unter erneuter Sperre auf neue Referenzen. Referenzabfragefehler vor Zeilenlöschung erhalten Datei und Zeile für Retry.

Ein Commit-/Prozessfehler nach Veröffentlichung oder ein Fehler der separaten Datei-Cleanup-Phase kann eine Datei ohne DB-Zeile erhalten. Startup-Cleanup erfasst solche reinen Datei-Orphans nicht; allgemeiner Storage-GC bleibt ein separater Folgeauftrag. Kein pauschaler „keine Orphans auf allen Fehlerpfaden“-Vertrag. Explizite Raum-Tokens schützen Retry über Minutengrenzen; tokenlose Fingerprints sind nur ein Schutz innerhalb derselben festen Uhrminute und unterscheiden identische neue Absichten nicht.
