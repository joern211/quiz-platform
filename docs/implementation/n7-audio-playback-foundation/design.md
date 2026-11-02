# N7 — Servergesteuerte, synchronisierte Audio-Wiedergabe, technische Grundlage: Design

Base: `main` @ `1ac064f4933df90067bccd8dfb2c20115501c44e` (N1–N6 gemergt; PR #36 mit dem Restart-/ACK-Fix gemergt; main-CI-Lauf 41411675476 grün). Arbeitsbranch `claude/n7-audio-playback-foundation` (neu von diesem main, kein Merge-Commit, kein alter Branch).
Status: **N7-Grundlagenpaket umgesetzt und reviewbereit; kein produktiver Verbraucher, vollständiges Core-DoD offen.** Der Entwurf wurde vor der Implementierung geschrieben; Abweichungen/Verfeinerungen stehen in §10 und in `review.md`. Weitere Dokumente: `matrix.md`, `review.md`, `acceptance.md`, `handoff.md`.

## 1. Scope und ausdrückliche Grenze

Geliefert: ein serverprivater **Wiedergabeplan** für genau einen vorbereiteten Clip (Zustände, Zeitformel, Übergänge, Serialisierung), eine **explizite Freigabepolitik** mit clienttauglicher Projektion, eine kleine **Uhrabstraktion** im Browser, ein **Browsercontroller** für ein echtes `HTMLAudioElement` (Generationen, Autoplay, Laden, Drift, Cleanup) und eine **Komponente** `ServerAudioPlayer` mit Midnight-Gestaltung.

Nicht geliefert: keine Engine, keine Seite, kein Socket-/HTTP-Endpunkt, kein Command-Bus, keine DB-Tabelle/Migration, keine neue Audio-Pipeline, keine Punkte-/Buzz-/Reopen-/Ersatzclipregeln, keine Zeitdienst-Infrastruktur. Aus `docs/specs/pr12/games/song-quiz.md` wird **nichts** als beschlossen übernommen (12 s, 3/1/0 Punkte, Reopen und automatische Wiederholungen bleiben offene Entscheidungen DEC-SNG-01).

**0 neue echte Engine-Verbraucher.** Das vollständige Core-DoD nach Master §13.2 bleibt offen.

Kleinster vollständiger Fall: **ein** normalisierter, vorbereiteter Clip je Wiedergabeinstanz; die erste Wiedergabe beginnt bei Position 0, Fortsetzen bei der gespeicherten Position. Arbiträre Ausschnitte einer geheim zu haltenden längeren Datei sind nicht Teil von N7 (ein Browser-Seek schützt den Rest einer ausgelieferten Datei nicht).

## 2. Bestand (am Code bestätigt)

| Fakt | Fundstelle | Folge für N7 |
|---|---|---|
| Die Ereignishülle trägt `serverTime`, mehr nicht | `packages/shared/src/index.ts:101` | keine Uhrkorrektur vorhanden → N7 bringt eine kleine, injizierbare Uhr mit Round-Trip-Sample |
| Im Web-Code gibt es keinerlei Serveruhr-Abgleich (`serverTime`, Offset, `performance.now` kommen nicht vor) | `apps/web/src` | Browser-`Date.now()` darf nie der Serverzeit gleichgesetzt werden |
| Server-Timer rechnen `Date.now()` direkt gegen `endsAtMs` | `core/runtimePrimitives.ts` | als Browser-Synchronisation unzureichend; das Zeitformel-Muster (RUNNING/PAUSED, halboffene Grenze `now < endsAt`) wird übernommen |
| `ContentMedia` ist ein `<audio controls>` | `apps/web/src/components/ContentMedia.tsx` | keine servergesteuerte Wiedergabe; bleibt unverändert |
| Vertrauenswürdige Dauer: `normalizeAudio` bestimmt `duration` (ganze ms) aus dem dekodierten PCM, Metadaten werden entfernt | `media/audio.ts`; Prisma `MediaAsset.duration` (ms) | der Plan übernimmt **diese** Dauer; Browser-Metadaten ersetzen sie nie |
| Obergrenze: `MAX_AUDIO_DURATION_SECONDS` ≤ 1800 s (Konfig-Schema) | `config/index.ts:21` | Dauergrenze `1_800_000` ms als Schutzgrenze, keine Spielregel |
| Signatur + Inhaltsfreigabe: `canDeliverContentMedia` bindet Asset an Item, Run, Phase | `content/media.ts`, `http/media.ts:607` | bleibt unverändert die Auslieferungsgrenze; eine gültige Signatur allein genügt nicht |
| Gleiche normalisierte Bytes werden je Owner dedupliziert (HTTP 200 kann korrekt sein) | `http/media.ts` | Fixtures: deterministisch verschiedene Töne; Deduplizierung separat |
| Sichtbarkeit: `canView`/`ProjectionAudience`, BLIND_HOST sieht kein HOST_PRIVATE | `core/visibility.ts` | die Freigabe nutzt dieselbe Regel; Verwaltungsrechte öffnen nichts |

## 3. Identität, Quellenbindung (Anforderung 5.1)

`AudioPlaybackScope = { runIndex, roundId, playbackId, contentRevision }`. `playbackId` ist eine undurchsichtige Referenz (`^[A-Za-z0-9][A-Za-z0-9._:@-]*$`, ≤ 80), `contentRevision` pinnt die Inhalts-/Quellenrevision (Master §6.3). Weder URL-Token noch Titel noch Pfad sind Identität. Ein neuer Clip oder ein bewusster neuer Durchlauf braucht eine **neue `playbackId`**; eine erneuerte Zugriffs-URL desselben Clips ändert die Identität nicht. Der fachliche Zustand speichert `assetId` (autorisierte Referenz), `durationMs` und die Zeitanker; **nie** eine signierte URL.

## 4. Drei verschiedene Versionen / Generationen (Anforderung 7.3)

| Name | Wem gehört sie | Aufgabe | Vergleich |
|---|---|---|---|
| `stateVersion` | globaler Spiel-Snapshot (Master §5.19), vom Aufrufer der Projektion übergeben | ordnet **Projektionen** zeitlich; N7 erfindet sie nicht und ersetzt sie nicht | Projektion mit kleinerer `stateVersion` als die bereits beobachtete wird nie angewendet |
| `playbackVersion` | serverprivater Plan, steigt bei **jeder** echten Planänderung um 1 | Optimistische Prüfung der Übergänge (`expectedVersion`) und Monotonie innerhalb einer Instanz | Übergang mit `expectedVersion ≠ version` → `AUDIO_PLAYBACK_VERSION_STALE`; Projektion mit kleinerer `playbackVersion` als beobachtet wird nie angewendet |
| lokale **Generation** | nur Browser, nie übertragen | bindet Timer, Listener, URL-Antworten, `play()`-Versuche an die aktuelle Ressource (Element) und Operation | Rückmeldung wirkt nur, wenn ihre Generation **und** ihr Element noch die aktuellen sind |

Der Browser pflegt je Kontext eine **Versionskenntnis** (`seen = { stateVersion, playbackVersion }`) getrennt von allem Abspielbaren (Muster N6 `seen`/`shown`). Sie überlebt Entzug, `null`, ungültige und quelllose Zwischenansichten. Fremde/ungültige Kontexte und Projektionen unter dem unabhängig übergebenen `minStateVersion` bewegen sie nie.

## 5. Zustände und Zeitformel (Anforderung 5.2)

Gespeichert: `READY | RUNNING | PAUSED | STOPPED | ENDED`. Einheiten **durchgehend ganze Millisekunden** (`*Ms`); die Umrechnung nach `HTMLMediaElement.currentTime` (Sekunden) geschieht an genau einer Stelle (`msToMediaSeconds` / `mediaSecondsToMs`). Alle Werte sind endliche sichere Ganzzahlen (kein Sekunden/Millisekunden-Raten; Gleitkommawerte werden abgewiesen).

```
Zustand  = { schema, scope, assetId, durationMs, version, status, positionMs, anchorServerMs | null, changedAtMs }
RUNNING:   anchorServerMs gesetzt; positionMs = Position AM Anker (bei Start 0, bei Fortsetzen der gespeicherte Offset)
sonst:     anchorServerMs = null; positionMs eingefroren

ZielpositionMs(now)   = clamp(positionMs + max(0, now − anchorServerMs), 0, durationMs)      (RUNNING)
endsAtMs              = anchorServerMs + (durationMs − positionMs)
aktiv (wird gespielt) ⇔ anchorServerMs ≤ now < endsAtMs        (halboffen [Start, Ende))
vor dem Anker (now < anchorServerMs): Ziel = positionMs, noch nicht hörbar → Anzeige SCHEDULED
now ≥ endsAtMs: wirksam ENDED, Position = durationMs, nie wieder anlaufen
```

Abgeleitete Anzeige (nie gespeichert): `READY, SCHEDULED, PLAYING, PAUSED, STOPPED, ENDED`.

| Übergang | von | nach | Bedingungen / Duplikat |
|---|---|---|---|
| `start(startAtMs)` | READY | RUNNING (Anker `startAtMs`, Position 0) | `startAtMs ≥ now`; sonst `AUDIO_PLAYBACK_TIME_INVALID`. RUNNING mit passender Version → **kein-Op** (Anker bleibt) |
| `pause` | RUNNING | PAUSED, Position = Ziel(now) (vor dem Anker: die Ankerposition, beim ersten Start 0) | wirksam ENDED → `AUDIO_PLAYBACK_ENDED`. PAUSED mit passender Version → kein-Op |
| `resume(startAtMs)` | PAUSED | RUNNING, neuer Anker `startAtMs` an gespeicherter Position | `startAtMs ≥ now`. Nicht von 0 zurück. RUNNING mit passender Version → kein-Op |
| `stop` | READY, RUNNING, PAUSED | STOPPED (terminal), Position eingefroren | wirksam ENDED → `AUDIO_PLAYBACK_ENDED`. STOPPED mit passender Version → kein-Op |
| `settle` | RUNNING mit `now ≥ endsAtMs` | ENDED (terminal), Position = Dauer | persistiert das abgeleitete Ende; sonst kein-Op |

Stets: `expectedVersion` muss der aktuellen `version` entsprechen (sonst `…VERSION_STALE`, **auch** bei Wiederholung mit altem Bezug); jede Änderung erhöht `version` um 1 und setzt `changedAtMs = now`; `now < changedAtMs` (rückläufige Uhr) → `AUDIO_PLAYBACK_TIME_INVALID`. Ein Übergang aus STOPPED/ENDED in einen anderen Zustand ist verboten (`AUDIO_PLAYBACK_TERMINAL`); ein neuer Durchlauf braucht eine neue Instanz.
**Entscheidung ENDED:** Ein zeitlich abgelaufenes RUNNING wird durch `pause`/`resume`/`stop` **nicht** wiederbelebt und **nicht** stillschweigend umgeschrieben, sondern mit `AUDIO_PLAYBACK_ENDED` abgelehnt; `settle` ist der ausdrückliche Weg, das Ende zu persistieren. Die Projektion zeigt das Ende in jedem Fall korrekt (`plan.status = ENDED`), auch ohne Hintergrundjob.

Determinismus: alle reinen Funktionen erhalten `now` ausdrücklich; sie lesen weder `Date.now()` noch `performance.now()`, Zufall oder Netzwerk. Gleiche Eingabe → gleiches Ergebnis (Test mit gleichem Zustand/Aktion/Zeit, JSON-Roundtrip).

## 6. Freigabe, Projektion, Informationsschutz (Anforderung 7)

Interner Zustand ≠ auslieferbare Sicht. `release ∈ { NONE, LOAD_ONLY, PLAY }`, vom Verbraucher serverseitig pro Empfänger entschieden (Auth-/Content-Kontext, Rolle, Phase). Zusätzlich verlangt die Projektion eine `VisibilityRule` für die **Quelle**: nur wenn `canView(audience, rule)` gilt, wird überhaupt etwas freigegeben; sonst wird zu `NONE` herabgestuft (BLIND_HOST und HOST_PRIVATE; Host-/Admin-Rechte öffnen weder PLAYER_PRIVATE noch TEAM_PRIVATE). Ein vom Client wählbares „allowed" oder Assetwissen ist keine Berechtigung.

| `release` | `source` (URL) | `durationMs` | `plan` | Bedeutung |
|---|---|---|---|---|
| NONE | `null` | `null` | `null` | nichts außer Scope + Versionen: der versionierbare **Entzug** |
| LOAD_ONLY | `{ url }` | ja | `null` | Vorladen erlaubt, **kein** Abspielplan; ein Download ist eine Informationsfreigabe |
| PLAY | `{ url }` | ja | ja | aktuell autorisierte Wiedergabe nach dem Serverplan |

Die Quellenauflösung (`resolveSource(assetId) => { url, renewal }`, injiziert; im Betrieb der vorhandene geschützte Medienpfad / `roomContentMediaUrl`; Ordnungszahl siehe §11) geschieht **lazy**, ausschließlich für `LOAD_ONLY`/`PLAY`; für `NONE` wird der Resolver nachweislich nicht aufgerufen. Keine Metadaten: die Projektion kennt weder Titel noch Interpret noch Dateiname noch Pfad (allowlist-Schema `strict`). Keine Browser-`MediaSession`-Befüllung. **Grenze:** eine kurzlebige URL ist kein DRM; ausgelieferte Bytes bleiben beim Empfänger. Ein längeres, geheimes Original darf nicht vollständig ausgeliefert werden, nur weil die UI einen Ausschnitt zeigt — N7 liefert nur ganze, vorbereitete Clips.

Anschluss, den die spätere Engine liefern muss: Rollen-/Phasenentscheidung `release` je Empfänger, `canDeliverContentMedia`-konforme Signatur (bleibt unverändert die Auslieferungsgrenze), Aufruf von `projectAudioPlayback` je Snapshot, Persistenz des Plans in ihrem State.

## 7. Uhr (Anforderung 6.1)

`ServerClock` im Browser: injizierbare **monotone** Uhr (`performance.now`), ein Round-Trip-Sample `{ sentMonoMs, receivedMonoMs, serverMs }`. Schätzung `serverNow(m) = serverMs + (received − sent)/2 + (m − received)`; Unsicherheit `± rtt/2`; es wird das Sample mit der kleinsten RTT behalten (nur eine Aussage über die Verbindung, kein Beweis). Ungültige Samples (negative/verkehrte/nicht ganzzahlige/zu große RTT) werden verworfen. **Ohne gültiges Sample liefert die Uhr `null`**; die Komponente startet dann nicht und meldet „Zeit wird abgeglichen" — ein geratener Start wird nie als synchron ausgegeben. Die Fortschreibung beruht ausschließlich auf der monotonen Uhr; Änderungen der Wanduhr (auch Minuten) sind wirkungslos (Test mit verstelltem `Date.now`). Ein Serverstempel allein (Push ohne Sendezeitpunkt) wird bewusst **nicht** als Offset akzeptiert, weil er die Laufzeit nicht enthält. Eine spätere Engine muss einen Round-Trip (z. B. Ping-ACK) liefern; ein produktiver Zeitdienst ist nicht Teil von N7.

Toleranzen (begründet, am Browser gemessen; siehe `acceptance.md`): Driftkorrektur erst ab `DRIFT_TOLERANCE_MS = 250`, höchstens ein Seek je 1000 ms, höchstens 5 automatische Seeks je Ressource und Planstand, danach Lauf ohne weitere Korrektur (kein Seek-Dauerlauf). Keine samplegenaue oder geräteübergreifend garantierte Synchronität.

## 8. Browser: Controller, Generationen, Fehler (Anforderungen 6.2–6.4)

* Serverabsicht (Plan) und lokaler Medienzustand sind getrennt: lokal `IDLE, AWAITING_CLOCK, LOADING, WAITING_FOR_START, PLAYING, BUFFERING, PAUSED, AUTOPLAY_BLOCKED, ENDED, STOPPED, WITHDRAWN, ERROR`. Ein erfülltes `play()` beweist nichts über andere Browser; die Anzeige „läuft" gilt nur für lokal tatsächlich spielende Wiedergabe (`!paused`, `readyState`, Zeitfortschritt gemessen im Harness).
* Je Ressourcengeneration ein **eigenes** `Audio`-Objekt (nicht im DOM, keine URL im Markup). Teardown: `pause()`, `removeAttribute('src')`, `load()`, Listener ab, Timer ab. Jeder Callback prüft Generation **und** Elementidentität; ein spät erfülltes `play()` einer überholten Operation pausiert genau sein **eigenes** altes Element, nie das neue.
* Kein erneutes `play()`/`load()` bei gleichwertigem Plan: der Controller bildet einen stabilen Schlüssel (`scope`, Versionen, `release`, `url`, Plan) und wendet nur Änderungen an; Uhrticks, Theme, Rerender und neue Wrapperobjekte ändern den Schlüssel nicht.
* Position setzen erst bei `readyState ≥ HAVE_METADATA` (sonst nach `loadedmetadata`); `NaN/Infinity` der Elementdauer werden ignoriert, die Dauer kommt aus dem Plan. Beim tatsächlichen Start gilt die inzwischen gültige Zielposition, nie 0 — und der erste hörbare Start erfolgt erst, wenn die Positionierung **verifiziert** ist (§11, N7-03).
* Autoplay: `NotAllowedError` → `AUTOPLAY_BLOCKED` (lokaler Zustand). „Audio aktivieren" ruft `play()` **synchron** in der Geste auf der aktuellen Ressource auf, mit der **jetzigen** Zielposition; nach Ende/Entzug/Stop startet die Geste nichts.
* Fehler/Retry: `error` der aktuellen Ressource → `ERROR` (neutraler Text). „Erneut laden" lädt dieselbe autorisierte Ressource neu oder fordert über `onRenewUrl` eine neue URL an; Plan, Position und Identität bleiben, keine neue Runde, kein neuer Clip, kein globales Skip/Ersatz. Eine erneuerte URL (gleicher Scope, Versionen ≥, **höhere Ordnungszahl**, §11) tauscht nur die Ressource, nie den Anker; eine ältere Erneuerung ersetzt die gehaltene Quelle nie. Ein altes Erneuerungsergebnis nach Kontext-/Clipwechsel wird verworfen.
* Native Controls werden nicht verwendet (kein freies Play/Seek). Lautstärke/Stumm ist lokal und keine Spielpause (nicht Teil von N7-UI).

## 9. Tests (Auszug; vollständige Matrix in `matrix.md`)

Server rein (Zeitgrenzen, Pause vor Start, Fortsetzen mit Offset, Terminalität, Duplikate/Versionen, Einheiten, JSON-Roundtrip), Freigabe/Projektion (alle Rollen, NONE ohne Resolver, Marker), Web-Intake (PLAY→Entzug→altes PLAY, PLAY→null→altes PLAY, fremder hoher Kontext, Mindeststand), Controller mit kontrollierbarem Audio-Fake (Rennen aller Art), Komponente (StrictMode/Unmount/Rerender/Theme), echter Chromium mit zwei Kontexten und deterministischen Tönen (normalisiert durch die vorhandene Pipeline). Offen für die spätere Engine: Befehle/Auth, Freigabeprojektion je Phase, Uhr-/Transportanbindung (Round-Trip), Persistenz/Receipts, fachliche Fehlerreaktion.

## 10. Verfeinerungen nach dem Entwurf (aus der Eigenprüfung, siehe review.md §7)

* **Terminaler Plan ohne Quelle (R1).** Ein STOPPED/ENDED-Plan wird als `release: PLAY` mit Plan und Dauer, aber **ohne** `source` projiziert (das Schema erzwingt dies in beide Richtungen). Es wird keine URL aufgelöst und kein Clip geladen; der Controller hält dafür kein Element. Das präzisiert §6: die lazy Auflösung gilt nur, wenn noch etwas abzuspielen ist.
* **Autoplay-Sperre pro Plan (R2).** Ein neuer Plan ist eine neue Entscheidung; eine frühere Ablehnung wird nicht festgeschrieben (`blocked` wird beim Planwechsel gelöscht, `play()` erneut versucht).
* **Entscheidung Intake bei gleichem Stand.** Bei identischem (Snapshot-, Plan-)Versionspaar wird eine Wiederzustellung mit gleicher oder engerer Freigabe angenommen (erneuerte URL), eine **weitere** Freigabe nicht (ein Entzug an genau diesem Snapshot wird nicht durch dessen früheres Paket zurückgenommen).
* **Entscheidung Abgrenzung ENDED.** `AUDIO_PLAYBACK_ENDED` (Ablehnung) statt stillem Umschreiben; `settle` persistiert das Ende ausdrücklich.

## 11. Nachbesserung nach der unabhängigen Prüfung (PR #37, Befunde N7-01 bis N7-03)

Der Bericht `N7_PR37_Pruefbericht_und_Nachbesserungsauftrag_2026-11-02` fand drei P2-Befunde am Head `1cc8cb3`; die fünf Gegenproben liegen als `apps/web/src/audioPlayback/n7IndependentReview.test.ts` im Repository (Probe 1 um die nun verlangte Ordnungszahl ergänzt). Alle drei Befunde waren am Code reproduzierbar (5 von 5 rot) und sind behoben.

### N7-01 — Reihenfolge von URL-Erneuerungen

* **Ursache.** Der Intake ordnete nach Snapshotversion, Planversion und Freigaberang. Bei gleichem Paar und gleicher Freigabe nahm er jede eintreffende Quelle an; die Generation im Controller entsteht erst **nach** der Annahme und schützt nur vor Ereignissen ersetzter Elemente.
* **Vertrag (präzisiert).** `source = { url, renewal }`. `renewal` ist die Ordnungszahl der **Ausstellung**: streng wachsend je ausgestellter Zugriffs-URL für diese Wiedergabe, unabhängig von Plan, Snapshotversion und Ankunft. Sie wird **nie** aus URL-Text, Signatur, Zeitstempel (`serverNowMs`) oder Ankunftsreihenfolge abgeleitet. Eine Erneuerung ändert weder Zeitanker noch Planversion und erzwingt weder neue Snapshotversion noch neue `playbackId`.
* **Server-Anschluss (bis zum zuständigen Adapter).** `projectAudioPlayback(…, { resolveSource })` mit `resolveSource(assetId) => { url, renewal }` (lazy wie zuvor, Ergebnis wird gegen `AudioPlaybackSourceSchema` geprüft); `createRenewalIssuer(lastIssued?)` liefert `max(vorherige + 1, jetzt)`: streng wachsend **innerhalb einer Instanz**; über einen Neustart nur, wenn der Adapter `issuer.last()` mit seinem Plan-Zustand persistiert und die Instanz mit `createRenewalIssuer(last)` wiederherstellt (oder die Uhr zwischen letzter Ausstellung und Neustart nicht rückwärts lief). Ohne Wiederherstellung und mit rückwärts korrigierter Uhr kann eine niedrigere Nummer entstehen — das ist dokumentierte Grenze (N7-04), kein Zeitdienst und keine Persistenz in N7. Pflicht des Adapters: nur dann eine neue Nummer ausgeben, wenn wirklich eine neue URL ausgestellt wird; solange die frühere URL gültig ist, sie samt Nummer wiederverwenden (sonst lädt jeder Browser den Clip bei jeder Projektion neu).
* **Intake.** Die höchste bekannte Nummer wird als **Zahl** getrennt von `held` geführt (`seenRenewal`, wie die beiden Versionen) und überlebt Entzug, `null`, `undefined`, ungültige und fremde Sichten (keine URL im Gedächtnis; neuer Playback-Kontext beginnt leer). Eine Quelle mit niedrigerer **oder gleicher** Nummer (bei anderer URL) ersetzt die gehaltene nie; ist keine gehalten (leere Zwischenansicht), wird die Projektion für Plan und Versionen angenommen, **ohne** die ältere Quelle: der Controller hält dann kein Element, lädt nichts Altes und zeigt neutral die Wiederbeschaffung (RUNNING/Vorladen) bzw. den Plan (PAUSED); eine aktuelle (gleiche) oder neuere Nummer wird normal angenommen. Zuvor: eine Quelle mit niedrigerer **oder gleicher** Nummer ersetzt die gehaltene nie (gleiche Nummer mit anderer URL widerspricht dem Aussteller: die zuerst angenommene bleibt, kein Flackern). Die Projektion wird für alles andere (Plan, Versionen) trotzdem angenommen: eine späte Antwort verdrängt weder die Quelle noch lässt sie einen neueren Plan (z. B. Pause) verloren gehen. Entzug, Clipwechsel und terminale Pläne sind unabhängig davon wirksam (Version/Kontext).
* **Grenze.** Fehlschläge einer Erneuerungs**anfrage** gehören dem Adapter und werden der Komponente nicht gemeldet; sie können deshalb weder Quelle noch Status überschreiben. Ein überholter **Medienfehler** eines ersetzten Elements ist durch Generation und Elementidentität wirkungslos.

### N7-02 — Lokales `ended` und neue Pläne

* **Ursache.** `res.localEnded` blieb für die ganze Ressource gesetzt; `reconcile()` brach den PLAYING-Zweig davor ab, auch bei einem späteren gültigen Fortsetzungsplan.
* **Korrektur (zwei unabhängige Schichten).** (1) Ein `ended` zählt nur, wenn der Plan **in Kraft** gerade Wiedergabe erwartet (abgeleitet aus Plan und Uhr, nie aus dem Ereignis) **und** das Element `ended !== false` meldet (ein früher eingereihtes, nachlaufendes Ereignis eines inzwischen bewegten Elements zählt nicht). (2) Das gemerkte Ende ist an den Schlüssel der Plan-Entscheidung gebunden (`endedForPlan`): ein neuer Plan überwindet es, Ticks, Rerender, neue Wrapperobjekte und gleiche Pläne behalten es — kein Wiederholungslauf an einem echten Ende, kein Neustart bei 0. Terminale Server-Pläne bleiben terminal.
* **Grenze.** Setzt der Browser ein Ende **vor** dem autoritativen Ende und der Server pausiert/fortsetzt danach hinter dem Medienende, kann die Position nicht mehr abgespielt werden (kein Seek hinter das Medienende); Schicht (2) wird deshalb nur auf Unit-Ebene belegt (siehe matrix.md G).

### N7-03 — Der erste hörbare Start steht verifiziert an der Zielposition

* **Ursache.** `startPlay` rief `seek()` und danach unbedingt `play()`; `seek()` verschluckte eine Ausnahme und prüfte nichts.
* **Protokoll `position()`** (HTML: ein erfolgreicher Setter ist kein beendeter Seek; die Position wird auf `seekable` begrenzt; `currentTime` meldet während des Seeks die **angeforderte** Position): (a) kein Seek in Flug (`seeking`), (b) Ziel in `seekable`, sofern das Element Bereiche meldet, (c) Setter akzeptiert (Ausnahme → nicht bereit), (d) danach nichts in Flug, (e) Rücklesewert innerhalb von 250 ms. Erst dann `play()` — weiterhin synchron in der Nutzergeste, wenn schon alles bereit ist.
* **Warten.** Bis dahin bleibt das Element still, Status `LOADING`. `seeked`, `loadeddata`, `progress`, `durationchange` und der Tick treten erneut in `reconcile()` ein und rechnen das **aktuelle** Ziel neu; Setter-Versuche höchstens alle 500 ms. Nach 10 s (konfigurierbar) ohne Erfolg: neutraler `ERROR` mit „Erneut laden“ statt hörbarem Fehlstart. Endet der Clip währenddessen, wird nie gestartet; Entzug/Pause/Clipwechsel verwerfen alles (Generation).
* **Driftkorrektur** einer bereits laufenden Ressource bleibt davon getrennt (unveränderte Grenzen: 250 ms, ≤ 1 Seek/s, ≤ 5 je Ressource und Plan).
* **Real gemessene Browsertatsache (Chromium 153).** Für einen Stream ohne Range-Unterstützung meldet das Element `seekable = [[0,0]]`, auch wenn `buffered` bis 8 s reicht: ein später Einstieg ist dort **nicht möglich**. Der Controller bleibt still und endet im neutralen Fehlerzustand; der produktive Medienpfad nutzt `res.sendFile` (Express, unterstützt Range), das ist hier aber nur gelesen, nicht durch N7 getestet.

### Nachprüfung 2 (Head 84821b2): N7-01-Rest und N7-04

* **N7-01-Rest [P2].** Die Ordnungskenntnis stand nur in `memo.held.source` und ging mit dem Löschen von `held` verloren (U20 → null/undefined/ungültig → U10 lud die ältere URL wieder). Korrektur: `seenRenewal` im Memo (siehe oben). Der Controller kennt jetzt den Zustand „Quelle als älter verworfen“ (`source = null` bei nicht terminalem Plan) und lädt nichts.
* **N7-04 [P3].** Die Behauptung „neustartfest“ war zu stark: eine neue Issuer-Instanz kennt die früheren Nummern nicht. Der Issuer hat jetzt einen Wiederherstellungsanschluss (`last()` / `createRenewalIssuer(last)`); die Garantie ist oben ehrlich beschrieben und die Grenze als Test dokumentiert.
