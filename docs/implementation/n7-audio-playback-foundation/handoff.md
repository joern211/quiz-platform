# N7 — Übergabe an einen späteren echten Engine-Verbraucher

Stand: Grundlage/Helfer vorhanden, **0 neue echte Engine-Verbraucher**. Das Song-Spiel und der vollständige Core-DoD (Master §13.2) sind **nicht** fertig und werden hier nicht als fertig bezeichnet.

## Was geliefert ist

* `@quiz/shared/audioPlayback` — clienttauglicher Vertrag, Zeitformel, Projektionsschema.
* `apps/server/src/games/core/audioPlaybackPlan.ts` — serverprivater Plan (`create/start/pause/resume/stop/settle/read`) und `projectAudioPlayback`.
* `apps/web/src/audioPlayback/` — `serverClock`, `playbackIntake`, `AudioPlaybackController`.
* `apps/web/src/components/ServerAudioPlayer.tsx` — Komponente.
* Test-/Entwicklungswerkzeug: `apps/web/harness/n7-audio` (nicht Teil eines Builds).

## Was der Verbraucher liefern muss

1. **Befehle und Auth.** Start/Pause/Fortsetzen/Stop/Settle sind reine Funktionen. Der Verbraucher definiert Command, Rechte (`TIMER_CONTROL`/`GAME_PAUSE` o. Ä. nach Master §2.3), Phase und Rate-Limits und übergibt `expectedVersion`, Scope und die **Serverzeit** `now`. Ein Befehl mit `commandId` läuft über den vorhandenen Receipt-Pfad (`runReceipted`); die Planversion ersetzt weder Receipt noch globale CAS.
2. **Freigabe je Empfänger.** `release` (NONE/LOAD_ONLY/PLAY) und `sourceVisibility` je Rolle und Phase serverseitig aus Auth-/Content-Kontext. Ist der Klang vor einer Phase selbst geheim: kein Vorladen, `NONE`; BLIND_HOST erhält ihn nicht über Verwaltungsrechte. Ein längeres, geheimes Original darf nicht vollständig ausgeliefert werden — N7 liefert nur ganze, vorbereitete Clips ab Position 0.
3. **URL-Auflösung.** `resolveUrl(assetId)` muss den vorhandenen geschützten Medienpfad bedienen (`roomContentMediaUrl`/`buildSignedMediaUrl`) **und** die Auslieferungsgrenze `canDeliverContentMedia` unverändert behalten: ein Asset gehört zu Item, Run und Phase. Eine gültige Signatur allein genügt nicht. Die Quelle darf nur für `LOAD_ONLY`/`PLAY` aufgelöst werden.
4. **Uhr-/Transportanbindung.** Ein Round-Trip (z. B. Ping mit ACK) liefert `ClockSample { sentMonoMs, receivedMonoMs, serverMs }` an `ServerClock.addSample`, regelmäßig und nach Reconnect (`reset()`). N7 enthält keinen Endpunkt dafür. Ohne Basis startet nichts.
5. **Persistenz und Receipts.** Der Plan (`AudioPlaybackState`) wird in den State des Verbrauchers geschrieben (JSON-stabil, nie eine signierte URL), zusammen mit dem globalen Snapshot in **einem** CAS. Beim Neustart wird der Plan geladen; Anker bleiben erhalten. Wer den abgelaufenen RUNNING-Zustand festschreiben will, ruft `settle`.
6. **Snapshot-Kopplung.** `stateVersion` der Projektion ist die globale Snapshotversion des Aufrufers; der Browser bekommt seinen Mindeststand (`minStateVersion`) aus dem **eigenen** Snapshotkanal, nie aus der Projektion.
7. **Fachliche Fehlerreaktion.** Der Browser meldet nur lokalen Status (`ERROR`, `AUTOPLAY_BLOCKED`). Ob ein Medienfehler zu Skip, Ersatzclip, Wiederholung oder Rundenneustart führt, Anzahl automatischer Wiederholungen, Punkte, Buzzer, Bewertung und Wiederöffnung sind **offene Spielentscheidungen** (z. B. DEC-SNG-01) und gehören dem Verbraucher. `ServerAudioPlayer.onRenewUrl` ist nur die Aufforderung, eine frische URL derselben Ressource zu liefern.
8. **Neue Wiedergabeidentität.** Ein neuer Clip oder ein bewusster neuer Durchlauf braucht eine neue `playbackId`; ein STOPPED/ENDED-Plan wird nie wiederbelebt.
9. **Refs sind opake Labels.** `roundId`, `playbackId`, `contentRevision`, `assetId` dürfen keine Titel, Interpreten, Dateinamen oder Pfade kodieren; N7 erzwingt die Zeichenform, nicht die Bedeutung.

## Bekannte Grenzen

* Gemessen ist nur Chromium (Headless, Linux); Safari/iOS (Geste je Element), mobile Hardware und Produktionsnetze nicht.
* Die Uhr nimmt symmetrische Laufzeit an (Fehler ≤ RTT/2).
* Autoplay: der Aktivierungspfad ruft `play()` synchron in der Geste auf; in Browsern, die die Entsperrung je Element verlangen, ist ein Aktivierungsklick **vor** dem geplanten Start nötig (ein Geste-Priming ist nicht Teil von N7).
* Eine kurzlebige URL ist kein DRM. Bereits ausgelieferte Bytes bleiben beim Empfänger.
* URLs laufen nach `MEDIA_URL_TTL_SECONDS` (5 min) ab; ein bereits geladenes Element spielt weiter, ein späterer Seek/Neuladen kann scheitern → `ERROR` → `onRenewUrl`.
