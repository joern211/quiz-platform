# BASIS-STANDARDS — Abnahme (acceptance.md)

Jede Pflicht aus Arbeitsauftrag §5 (A–F) mit **echter MR-Zuordnung** (Planplatz „PR13" = BASIS-STANDARDS),
geplante Verhalten, Gegenprobe, Code-/Testreferenz, Ergebnis und Status.
Status: `OPEN` · `IN_PROGRESS` · `VERIFIED` · `BLOCKED`. `VERIFIED` nur mit positiv **und** negativ belegtem Flow — nie aus einer Datei/Typecheck/Mock allein.
Nebenpflichten, die in **späteren** Paketen anfallen, stehen getrennt als „Folge" und werden hier nicht als erledigt ausgegeben.

## Istabgleich (Basis `3dba9ff`, vor jeder Codeänderung)

| Beobachtung | Beleg |
|---|---|
| Rollen heute: `UserRole='ADMIN'\|'MODERATOR'`, `PlayerRole='MODERATOR'\|'PLAYER'\|'VIEWER'` | `packages/shared/src/index.ts` |
| `Participation.role` String (`MODERATOR\|PLAYER\|VIEWER`), `User.role` String (`ADMIN\|MODERATOR`, Default `MODERATOR`) | `prisma/schema.prisma` |
| Authorization: 7-Punkt-Sequenz (`requireRoomRole`), `authorizeGameAction/Context` — **nur Rollen + Membership, keine feingranularen Rechte, kein Grant/Revoke** | `http/middleware/auth.ts`, `games/core/access.ts` |
| Kommandos: `ClientCommand{requestId, roomCode, expectedRevision?, clientTime?, payload}` — **kein commandId, kein protocolVersion** | `packages/shared/src/index.ts` |
| Fehler: `ApiResponse.error{code,message,details?}` — **kein messageKey, kein traceId, kein retryable** | `packages/shared/src/index.ts` |
| Config: `config/index.ts` = env-Schema + Normalisierung; **keine 7-Ebenen-Priorität, kein Start-Snapshot pro Engine, kein LOCKED_AFTER_START** | `config/index.ts` |
| Manifest: `GameManifestSchema` ohne Capabilities/engineVersion/lateJoin/viewer/broadcast/content-type | `packages/shared/src/index.ts` |
| Room.revision + RoomGameState.revision + CAS via `updateMany where revision` vorhanden (Basis für C/E) | `schema.prisma`, `sockets/game.ts` |
| 3 Engines: `games/geo` (wissensduell), `games/jeopardy`, `games/weristdas`; mutierende Socket-Events in `*/events.ts` | `games/registry.ts` |
| `shared/src/index.ts` ist **eine einzige Datei** (Node type-stripping bricht relative `.js→.ts`-Imports) → neue shared-Verträge inline in `index.ts` | Skill + Code-Kommentar |
| `prisma/seed.ts` läuft vom **Repo-Root** → kein `@quiz/shared`-Import; Konsistenz via `catalog-consistency.test.ts` | `prisma/seed.ts`, Skill |

> Baseline-Testzahlen (auf `3dba9ff`) werden in `verification.md` nach dem ersten Lauf eingetragen.

---

## A — Rollen, Begriffe, Schemas, Bestandsmigration

| ID | Pflicht (Quelle/MR) | Verhalten | Gegenprobe (Fehlerbedingung) | Code-/Test-Ref | Ergebnis | Status |
|---|---|---|---|---|---|---|
| A1 | Kanonische Rollen `ADMIN,HOST,PLAYER,VIEWER,DISPLAY` zentral in shared (MR-02-01-02-A01..A03, MR-12-01-01-A01) | Runtime/UI nutzen `HOST` statt `MODERATOR`; `ADMIN,PLAYER,VIEWER,DISPLAY` ergänzt | unbekannte Rolle wird **abgelehnt**, kein String-Cast | shared (Roles), `test:` | | OPEN |
| A2 | `MODERATOR`→`HOST` in Runtime/UI (MR-02-01-02-A03, MR-01-00-02-A01) | Auth, Guards, HTTP, Socket, Registry, Seeds, Fixtures, sichtbare UI-Bezeichnungen, **geroutete** Seiten (v.a. generische `ModeratorSetupPage` für Wissensduell) auf `HOST`; `MODERATOR` nur noch Migration/Compatibility/Legacy-Routen | grep: kein `MODERATOR` in Runtime-Pfaden außer abgegrenzter Compatibility; UI zeigt „Host" | | | OPEN |
| A3 | Trennung Accountrolle / Verwaltungsrecht / Teilnahme / Projektionskontext (MR-01-00-02-A01, MR-02-01-03-A01..A02) | `HOST`-Rolle ≠ pauschaler Anspruch auf Player-Geheimnisse/fremde Lösungen | Admin/Host im Spielbetrieb erhält **keine** allwissende Projektion; WID `HOST_CANNOT_PLAY_OWN_ROUND` bleibt | | | OPEN |
| A4 | Sichere versionierte Migration `User.role`/`Participation.role` (MR-05-23-01-A01..A06) | Neue Migration (keine bestehende umschreiben); `MODERATOR`→`HOST`; IDs, Sessions, Räume, Rejoin-Tokens, Referenzen, Ergebnisse, Engine-Versionen bleiben | frische DB + Bestandskopie (ADMIN/MODERATOR, Host-Teilnahme, aktive+beendete Räume, WID v1/v2, Sessions/Rejoin); wiederholtes `migrate deploy`; ADMIN bleibt ADMIN; Rejoin funktioniert; unbekannte Rolle → keine Rechte | `prisma/migrations/…` | | OPEN |
| A5 | Legacy-Normalisierung an klaren Grenzen (MR-05-23-01-A03, MR-12-01-01-A05) | alte Client-/DB-Werte nur an der vorgesehenen Grenze normalisiert; gecachte Socketrolle wird nicht für immer gültig angenommen | alter Client mit `MODERATOR` wird an der Grenze zu `HOST` normalisiert, nicht im ganzen Code | | | OPEN |
| A6 | `DISPLAY` Read-only/Public-Vertrag (MR-02-01-06-A01..A05) | `DISPLAY`-Rolle + Enum + Vertrag: keine Secrets, keine Eingaben, kein Player/Viewer-Slot; **nur Vertrag + Enum jetzt**, voller Bedienflow später (→ PR20/TEAM-ROOM) | Display-Client erhält keine Gameplay-Eingabe/Secrets; belegt keinen Slot | | OPEN |

**Folge (nicht in diesem PR):** volles Team-Modell, Room-Lifecycle-Zustände `DRAFT_ROOM/SCHEDULED/EXPIRED/IDLE` (MR-04-03-01 → TEAM-ROOM); Display-Bedienflow (→ PR20).

---

## B — Berechtigungen und Informationsschutz

| ID | Pflicht (Quelle/MR) | Verhalten | Gegenprobe | Code-/Test-Ref | Ergebnis | Status |
|---|---|---|---|---|---|---|
| B1 | Permission-Vertrag mit den 11 Rechten (MR-02-03-01-A01..A03, §2.3) | `GAME_START, GAME_PAUSE, ROUND_ADVANCE, JUDGE_ANSWER, SCORE_ADJUST, BUZZER_CONTROL, TIMER_CONTROL, REVEAL_CONTENT, TEAM_MANAGE, PLAYER_MANAGE, GAME_ABORT` zentral definiert; Rollen liefern Defaultpakete | — | `games/core/permissions.ts` | | OPEN |
| B2 | Wirksame Rechte = Default ± Grants/Entzüge (MR-02-03-01-A03) | Grant/Revoke pro Recht; **vollständig autorisierte, validierte, getestete** API, falls eingeführt | Grant für genau ein Recht wirkt; entzogenes Recht wird auch bei **bereits verbundenem** Socket verweigert (Revoke/Reconnect) | | | OPEN |
| B3 | Guard in kritischen Aktionen integriert (MR-02-03-01-A01, MR-05-17-01-A01) | Guard serverseitig in existierenden kritischen Mutations (Start/Pause/Reveal/Weiter/Judge/Points/Kick), **nicht** nur exportiert | Player/Viewer fälscht Hostrolle → verweigert; falscher Raum → verweigert; Cross-Room verweigert | | | OPEN |
| B4 | Verwaltungs- vs Secret-Rechte getrennt (MR-02-02-01-A01..A02, MR-01-00-02-A01) | delegiertes Pause-Recht verleiht **keine** Judge/Reveal/Lösungsansicht; eingeloggter ADMIN erhält im Spielbetrieb keine allwissende Projektion | Host mit Pause-Grant sieht keine fremden Lösungen; ADMIN-Login ≠ Secret-Zugriff | | | OPEN |
| B5 | Co-Host-Grundlage (MR-02-04-01-A01..A08) | kein neuer Hauptrollentyp, Default OFF, nur eingeloggte Nutzer, keine zusätzlichen Secrets; **Grundlage jetzt, volles Room-Setting/UI → TEAM-ROOM** | kein Co-Host durch Gastidentität; Gast kann nicht delegiert werden | | | OPEN |
| B6 | VIEWER/DISPLAY read-only, nur freigegebene PUBLIC (MR-02-01-04-A02, §2.1) | Viewer/Display sehen vor Reveal keine Lösungen; WID-Eigentümerprüfung + Signed-URL-Audience + `HOST_CANNOT_PLAY_OWN_ROUND` intakt | Player/Viewer-Snapshot vor Reveal enthält keine Antworten (negativ via direktem HTTP/Socket-Request, nicht nur UI) | | | OPEN |
| B7 | Kein generischer Host-as-Player-Modus (MR-02-01-03, §1) | bestehende Engines behalten ehrliche Mitspiel-Grenzen; Guard muss Konflikt „Admin sieht Lösungen" vs. „als benachteiligter Player" abbilden | Host mit bekannten Lösungen wird nicht als normaler wissensbenachteiligter Player freigeschaltet | | | OPEN |

**Folge:** volles Co-Host-Bedienablauf + Room-Settings-UI (→ TEAM-ROOM); vollständige Finalisierungs-/Event-Architektur (→ später).

---

## C — Commands, Protokoll, Wiederholungssicherheit

| ID | Pflicht (Quelle/MR) | Verhalten | Gegenprobe | Code-/Test-Ref | Ergebnis | Status |
|---|---|---|---|---|---|---|
| C1 | Command-Envelope: `commandId, protocolVersion, autoritativer Raumbezug, Versionserwartung, Payload-Schema` (MR-05-17-01-A01..A06) | zentrale validierte Envelope; bestehende `requestId/roomCode/expectedRevision` kompatibel abgebildet; widersprüchliche alte/neue Felder abgelehnt; Client-Raum ≠ Membership | fehlende/ungültige Felder abgelehnt; Widerspruch `commandId` vs `requestId` → Ablehnung | shared (Command), `test:` | | OPEN |
| C2 | `protocolVersion=1` im Handshake + bei Commands (MR-12-04-01-A02..A06, MR-10-11-01-A03..A04) | unbekannte inkompatible Version → `CLIENT_VERSION_UNSUPPORTED` **vor** Mutation; fehlende Legacy-Version nur über dokumentierten, getesteten Pfad; Rejoin behält Version | Client mit Version 2 → `CLIENT_VERSION_UNSUPPORTED` vor jeglicher Mutation; Rejoin einer laufenden Session behält Vertrag | | | OPEN |
| C3 | Ein Token pro Benutzerabsicht (Frontend) | Frontend erzeugt ein Token pro Absicht, nutzt es bei Wiederholung erneut, neue Absicht → neues Token; gleiche Payload ≠ gleiche Absicht; kein Zeit-/Payload-Fingerprint | neue Absicht mit identischer Payload → neues Token → neue zulässige Wirkung | web (geroutete Komponenten) | | OPEN |
| C4 | Command-Receipts in kritischen Mutationen (MR-10-06-01-A01..A04, MR-05-17-01-A04) | Receipts für Antworten/Joker, Buzz/Judge/Points, Reveal/Weiter, Start/Pause/Abort (soweit vorhanden); vollständige Handler-Abdeckung dokumentiert | identischer Command seriell **und** parallel → genau eine fachliche Wirkung; Commit ok + Antwort verloren + Retry → keine zweite Wirkung | `games/core/receipts.*` + Engines | | OPEN |
| C5 | Duplicate-Nachweis + Mutation + Receipt in einer DB-Transaktion/CAS (MR-10-06-01-A02, MR-05-19-01-A04) | kein Check-then-create bei parallelen Requests; kein Erfolgseintrag ohne abgeschlossene Aktion; keine doppelte Wirkung nach Commit vor ACK-Verlust | parallele identische Commands; Fehler-Injektion **innerhalb** der Transaktion → Rollback → keine Erfolgsquittung | | | OPEN |
| C6 | Receipt bindet Raum + Akteur + Aktion + Payload (MR-10-06-01) | gleiche commandId mit anderem Akteur/Payload → kontrollierte Ablehnung, keine fremden Ergebnisse/Rechte | Replay mit anderem Akteur/Payload → Ablehnung; Wiederholung nach aktueller Autorisierung | | | OPEN |
| C7 | Duplicate liefert gespeicherte Antwort ODER `ALREADY_PROCESSED` (MR-10-06-01-A02) | eindeutig definiert + Fehler/Retry-Verhalten; DB-Fehler vor Commit erlaubt sicheren Retry; Retention/Restart ehrlich dokumentiert; kein stilles Löschen relevanter Receipts in laufender Session | Retry nach DB-Fehler heilt ohne Doppelwirkung | | | OPEN |

**Folge:** vollständige Event-/RoundTransition-/Finalisierungs-Architektur (→ spätere Pakete); aber die hier umgestellten Aktionen haben echte Replay-Sicherheit.

---

## D — Einheitliche Fehler und Validierung

| ID | Pflicht (Quelle/MR) | Verhalten | Gegenprobe | Code-/Test-Ref | Ergebnis | Status |
|---|---|---|---|---|---|---|
| D1 | Zentrale Fehler-/Result-Struktur (MR-12-02-01-A01) | `code, messageKey, traceId` + optional `details`, `retryable` (Master §12.2/12.13) | fehlende/ungültige Felder → strukturierter Fehler | shared (errors) | | OPEN |
| D2 | Bekannte Codes + Namespaces (MR-12-02-01-A02..A03) | `NOT_AUTHORIZED, INVALID_PHASE, STALE_STATE, ALREADY_PROCESSED, ROOM_LOCKED, PLAYER_NOT_FOUND, CONTENT_NOT_READY, CLIENT_VERSION_UNSUPPORTED, RATE_LIMITED, RECOVERY_REQUIRED` + Game-Namespace | Konflikt-, Rechte-, interner DB-Fehler → korrekter Code | | | OPEN |
| D3 | In geänderten HTTP-/Socket-Flows + Frontend-Verbrauchern genutzt (MR-12-02-01) | alte lesbare `message` im Kompatibilitätsfenster erhalten; Wire-Codes nicht unkontrolliert gebrochen; Abbildung/Deprecation dokumentiert | Legacy-Antwortformat weiterhin benutzbar; UI behandelt Fehler sichtbar und beendet Loading-/Klicksperren | | | OPEN |
| D4 | Validierte Schemas, keine kritischen neuen `any` (MR-12-03-01-A01..A03) | API/Socket/Command/Event/Snapshot/Manifest/Config-Schemas; Server validiert immer | verschachtelt falsche Payload, unbekannter Command → kontrollierte Validierungsfehler | | | OPEN |
| D5 | Keine Sensitivlecks in Antworten/Logs (MR-12-13-01-A02, §10.7) | Auth/Ownership/Scope-Denials ohne unnötige Infos über fremde private Ressourcen; keine Stacktraces/SQL/Pfade/Tokens/Secrets in Antworten/sensiblen Logs | Denial auf fremde private Ressource enthält keine Details; Trace-ID verbindet Antwort+Log, verleiht keine Rechte | | | OPEN |

---

## E — Konfiguration, Revisionsschutz, Start-Snapshots

| ID | Pflicht (Quelle/MR) | Verhalten | Gegenprobe | Code-/Test-Ref | Ergebnis | Status |
|---|---|---|---|---|---|---|
| E1 | Zentrale validierte Defaults, Einheiten/Nullability (MR-11-14-01-A01..A03, MR-12-07-01, MR-12-08-01) | `durationMs`, Bytes, Prozent 0–100 (Nachkommastellen erlaubt), Punkte Integer; klare Herkunft; „nicht gesetzt" ≠ `null` ≠ Vererbung ≠ Reset; kein `value \|\| default` | `false`, `0`, optionales/nullbares Feld bleiben erhalten; ungültige Werte abgelehnt | `config/` (Resolver) | | OPEN |
| E2 | 7-Ebenen-Priorität (MR-12-14-01-A01..A02) | `SYSTEM_DEFAULT → HOST_DEFAULT → ROOM_TEMPLATE → GAME_PRESET → ROOM_CONFIG → GAME_CONFIG → LIVE_OVERRIDE`, spezifischer gewinnt | jede Prioritätsstufe mit unterschiedlichen Werten → korrekte Auflösung | | | OPEN |
| E3 | Änderungsklassen / LOCKED_AFTER_START (MR-12-14-01-A03) | nach Start nicht live überschreibbar; erlaubte Live-Änderungen serverseitig geprüft + nachvollziehbar erfasst | ungültige Live-Änderung nach Start → abgelehnt, Snapshot unverändert | | | OPEN |
| E4 | Resolver in Setup-/Start-Flows + unveränderlicher Start-Snapshot (MR-05-22-01-A01, MR-05-24, MR-11-14-01-A04) | endgültige Werte mit `gameSlug, engineVersion` + vorhandenem Setup-/Referenzdaten beim Start unveränderlich gespeichert; keine Platzhalter für Teams/Content/Events als fertig | Snapshot bleibt nach Default-/Live-Änderung unverändert; Rejoin + DB-Reopen liefern dieselben Regeln; WID v1/v2 bleiben spielbar | | | OPEN |
| E5 | Revision + Optimistic Locking (MR-12-15-01-A01..A04, A08) | fachliche Änderung erhöht Revision; bloßes Lesen/Rejoin/No-op nicht; Konflikt → `REVISION_CONFLICT` ohne Überschreiben | zwei Updates auf derselben Revision → einer bekommt `REVISION_CONFLICT`; No-op/Read ohne Revisionserhöhung | | | OPEN |
| E6 | Setup-v1/v2 + Engine-Versionen weiter lesen; explizite Legacy-Strategie (MR-05-23-01) | keine erfundenen historischen Snapshots aus heutigen Defaults; fehlende sichere Migration → laufender Raum **nicht** still umgedeutet | WID-v1-Raum (ein Bild) und v2 (Fusion) bleiben lauffähig nach Migration | | | OPEN |
| E7 | HOST_DEFAULT/ROOM_TEMPLATE/GAME_PRESET als Auflösungsvertrag (MR-12-14-01) | als Vertrag unterstützt; volles Editor-/Persistenz-UI → späteres Paket (gekennzeichnet) | — | | | OPEN |

---

## F — Manifeste und wiederverwendbare Contract-Tests

| ID | Pflicht (Quelle/MR) | Verhalten | Gegenprobe | Code-/Test-Ref | Ergebnis | Status |
|---|---|---|---|---|---|---|
| F1 | Manifest-Vergleicher (MR-01-00-04-A01, §5.3) | `GameManifest` um Capabilities, engineVersion, Content-/Setup-Typ, Late-Join, Viewer, Broadcast ergänzt (volle Feldliste aus Master) | absichtlich ungültiges Manifest wird abgelehnt | shared (Manifest) | | OPEN |
| F2 | Single Source of Truth (MR-01-00-04-A01) | shared-Manifest für Katalog, API, Registry, Oberfläche; keine doppelten Listen/driftenden Defaults | API/UI/Seed/Registry nutzen dieselbe Quelle (Konsistenztest) | | | OPEN |
| F3 | Ehrliche Capabilities/Status (MR-05-28-01-A11..A12, §5.4) | Capability/Status beschreiben realen Stand; neues optionales Feld aktiviert kein Team-/Voice-/Display-Feature; **WID bleibt BETA**; kein AVAILABLE-Durch-Typen | Capability stimmt mit registriertem Verhalten überein; Statuswechsel durch Typen nicht möglich | | | OPEN |
| F4 | Keine DDF-Manifestregistrierung (Scope) | DDF-Regeln/Slug/Engine bleiben getrennt | — | | | OPEN |
| F5 | Wiederverwendbares Contract-Testgerüst (MR-05-28-01-A01..A12, §13.2) | Schema/Manifest, Autorisierung, Informationsgrenzen, Protokollfehler, Replay/CAS, Config-Snapshot | **mindestens 2 unterschiedliche echte Engines** laufen dieselbe Prüfung; 3. bekommt Regression; bewusst falsche Rollen-/Secret-/Replay-Bedingung lässt die Prüfung **fehlgeschlagen** | `games/contract/*` + 2 Engines | | OPEN |
| F6 | Geroutete Frontend-Seiten + Konsistenz | bestehende Katalog-/Seed-/Registry-Prüfungen weiter; **geroutete** Seiten getestet (v.a. generische `ModeratorSetupPage`) | — | web e2e/tests | | OPEN |

---

## Abschlusskriterien (Arbeitsauftrag §8)

1. Alle Pflichten A–F im definierten Umfang implementiert **und** mit positiv + negativ belegten Gegenproben abgenommen.
2. Verträge von echten existierenden Flows genutzt; Core-DoD in ≥2 Engines nachgewiesen (F5).
3. Bestandsmigration, Rejoin, WID v1/v2 und die 3 Engines funktionieren; keine neuen Secret-Leaks / doppelten Wirkungen.
4. Alle Checks (Migration frisch+Bestand, typecheck, lint, build, Server-Tests mit Migration+Seed, Web-Tests, check-docs, E2E, Gegenproben) auf dem **finalen** Stand ausgeführt und bewertet.
5. Code + Doku gepusht, PR-Beschreibung aktuell, CI **und** E2E am exakt gleichen Head geprüft.
6. Handoff/Acceptance/Wiederaufnahme vollständig; keine stille „nur lokal"-Restarbeit.

> Ein Typ/Stub/delegierter Folgeauftrag/grüner Normalpfad erfüllt **keine** Runtime-Pflicht.
> Matrix-`VERIFIED` nur für wirklich einzeln belegte Pflichten; dieses Paket markiert nicht alle V1-Anforderungen als erledigt.
