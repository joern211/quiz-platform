# N5 — Übergabe

Stand: 01.11.2026.

- **Basis:** `main` @ `c09266b7c7c33eb911e0aa1d3151c5312d0b6cd8` (N4-Squash-Merge von PR #33), beim Start per `git fetch` geprüft und unverändert; Branch-Basis = dieser Commit, **kein Konflikt, kein Rebase nötig**. Einziger andere offene PR: #21 (historischer Plan-Draft, keine Basis).
- **Branch:** `claude/new-session-im4em9` (vom Sitzungsrahmen vorgegeben, direkt von `main`). **PR:** siehe `acceptance.md` (Draft gegen `main`).
- **Commits (Code):** `277fd34` (Medien-Test-Race, **eigener Commit**) · `cb5f0a3` (Vertrag + Domain + Tests) · `52b6173` (SecretInfoCard + Harness) · `c36e4fc` (Eigenprüfung: `safeParse`, `__proto__`-Test). Danach nur Dokumentation. Die exakten Head-/CI-Angaben stehen in `acceptance.md`.
- **Offene Jobs/Dateien:** keine. Harness-Server beendet, keine temporären Prozesse; Arbeitsbaum sauber.

## Was N5 liefert (und was nicht)
Ein serverprivater, unveränderlicher Deal (Rollen + Fragmente + Empfänger + additive öffentliche Freigabe), ein clienttauglicher Projektionsvertrag, `releaseSecretInformation`, `projectSecretInfo` und die Karte `SecretInfoCard`. **Alles H** (Helfer ohne Runtime-Integration). **0 neue echte Engine-Verbraucher.** Keine Engine, kein Command, keine Route, keine Tabelle, keine Spielregel, keine Verfügbarkeitsänderung, keine DEC-Regel als entschieden markiert. **Core-DoD (Master §13.2) bleibt offen.**

## Nächste konkrete Aktion
1. PR reviewen und selbst mergen (Claude merged nicht). Urteil für das **begrenzte Paket**: reviewbereit (siehe `acceptance.md`); unvollständig bleibt bewusst die Runtime-Integration.
2. Danach — nur nach Freigabe der jeweiligen Spielregel (DEC-UND-01 / DEC-AGT-01) — der erste echte Verbraucher. Pflichten (Auftrag §15, hier verbindlich festgehalten):
   - **Identität/Rechte:** aktuelle serverseitige Session-/Teilnehmer-/Informationsrolle am Aufrufmoment prüfen — auch nach Kick, Rechtewechsel und Host-Transfer; `audience` (Rolle, participantId) **nur** aus Admission/Session bilden, nie aus Clientpayload. Mitspielender Host/Admin → Rolle `PLAYER`.
   - **Pinnen:** Phase und Scope prüfen; Deal und Konfiguration (GameConfigSnapshot, Engine-Version) unveränderlich pinnen. `dealId`/`revision` einmal vergeben, **opak** (nie aus Rollen/Begriffen oder deren Hash), eindeutig persistieren (z. B. UNIQUE auf Raum + Run + Runde + dealId).
   - **Zufall:** Rollen-/Begriffsentscheidung genau einmal über den vorhandenen serverseitigen Zufallspfad treffen und das **konkrete** Ergebnis persistieren; Lesen, Projizieren, Rejoin, Recovery würfeln nie neu.
   - **Commands:** Zustandsänderungen (insb. `releaseSecretInformation`) mit Version, CAS, Receipt und State-Event atomar verdrahten; Doppelwirkung paralleler Befehle verhindern; kein Event, wenn `changed === false`.
   - **Auslieferung:** projektionstreue Socket-Auslieferung (eine Projektion je Empfänger), Rejoin, Resync und **echten Prozessneustart** testen; `projectSecretInfo` wirft bei veraltetem Scope — als „stale/resync“ ohne Detail melden.
   - **Late-Join/Nachrücker:** keine alten Secrets an neue Identitäten oder nachrückende Teilnehmer übertragen (Master §4.12); neue Teilnehmer = neuer Deal.
   - **Host-Fairness:** Kenntnis aus Erstellung/Vorschau/Beurteilung vor der Mitspielberechtigung berücksichtigen; BLIND_HOST allein macht einen Autor nicht unwissend.
   - **Logs:** keine Secrets in Logs, Audit-Nutzlasten für Clients oder öffentlichen Historien; Fehler nur als Code melden (`SecretInfoError.issues` darf serverseitig geloggt werden, nie Rohzustand/Deal).
   - **Core-DoD:** erst mit mindestens **zwei verschiedenen realen Engines** (Master §13.2) und Persistenz, Permissions, Rejoin/Resync/Recovery, Monitoring/Logging kann dieses Core-Modul als DONE bewertet werden.

## Ehrliche Grenze
Keine Socket-/Rejoin-/Resync-/DB-/Neustart-Nachweise (SDK-Replay und Domainprojektion sind Vorbereitung, kein Ersatz). Keine Host-Vorschau. Die Komponente zeigt nur `own`; die öffentliche Anzeige freigegebener Texte ist Sache des Verbrauchers. Layout nur im Chromium-Emulator geprüft.
