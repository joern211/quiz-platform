# BASIS-STANDARDS — Kompatibilität & Legacy-Kontrakte (compatibility.md)

**Paket:** BASIS-STANDARDS (Roadmap-Planplatz „PR13") · **GitHub-PR:** #14. Aktueller Abschlussnachweis: verification.md (19.10.2026).
**Zweck (Audit PR14, 14-09):** Verbindliche, zentrale Übersicht ALLER
Legacy-Kontrakte, die dieses Paket bewusst beibehält, umschreibt oder ablehnt —
sodass Bestandsdaten, alte Clients und laufende Spiele nach dem Upgrade
vorhersagbar weiterlaufen. Jede Zeile trägt die konkrete Grenze (Wo wirkt der
Kontrakt?) und den Nachweis (Test/Code). „Kompatibel" heißt hier immer:
**keine stillen Schreibungen, keine Rechteausweitung, kein falscher State.**

> **Prinzip (Regelwerk §5.23):** Eine Legacy-Normalisierung gilt NUR an der
> klaren Grenze (DB-Read / Auth-Map / Socket-Envelope / Slug-Resolver). Sie
> darf Rechte NIEMALS erweitern und unbekannte Werte NIEMALS still
> „berichtigen" (→ `null` / Ablehnung).

## 1. Rollen (Account + Spielrolle)

| Legacy-Input | Kanonisch | Wo wirkt die Grenze | Verhalten bei Unbekanntem | Nachweis |
|---|---|---|---|---|
| `MODERATOR` | `HOST` | `normalizeRole`/`LEGACY_ROLE_VALUES` (shared), Auth `LEGACY_MAP`, Bestands-Migration `20261010120000` | unbekannte Rolle → `null` (kein String-Cast, keine Rechte) | `migration.roles.test.ts` (MODERATOR→HOST, ADMIN bleibt, `SUPERUSER` as-is, negativ `null`); `normalizeRole`-Gegenproben |
| `ADMIN`, `PLAYER`, `VIEWER`, `DISPLAY`, `HOST` | unverändert | `normalizeRole` | — | ebenso |
| **Prototype-Namen** (`constructor`, `__proto__`, `toString`, `hasOwnProperty`) | `null` | `normalizeRole` (shared) | **muss** `null` sein — der frühere Lookup leckte geerbte Object-Member (Audit 14-10) | `audit14.regression.test.ts` §14-10; `LEGACY_ROLE_VALUES` nutzt `Object.create(null)` + `hasOwnProperty` + finale Rollenmenge-Prüfung |

**Kanonische Rollenmenge (fest):** `ADMIN, HOST, PLAYER, VIEWER, DISPLAY`.

## 2. Spiel-Slugs (Game-Identität)

| Legacy-Slug | Kanonisch | Wo wirkt die Grenze | Verhalten bei Unbekanntem |
|---|---|---|---|
| `geo`, `allgemeinwissen` | `wissensduell` | `resolveCanonicalSlug` (shared); `migrateCanonicalSlugsOnStartup` (versioniert, idempotent, Audit-Log) | — |
| `weristdas` | `wer-ist-das` | 同上 | — |
| `wer-luegt`, `luegen` | `imposter` | 同上 | — |
| `song`, `song-erraten` | `song-quiz` | 同上 | — |
| `wer-wird-millionaer` | `millionenfrage` | 同上 | — |
| `wahrheit-oder-fake` | `wahr-oder-fake` | 同上 | — |
| unbekannter Slug | unverändert | `resolveCanonicalSlug` gibt Input zurück; Aufrufer meldet „nicht gefunden" | kein stiller Cast |

**Wichtig (Audit 14-04):** Ein Raum trägt immer seine **stabile
`gameDefinitionId`**; die Engine-Version und der Config-Snapshot werden über
den **kanonischen** Slug aufgelöst. Vorher nutzte `sockets/game.ts` den
DB-Slug direkt für `ENGINE_VERSIONS` (Legacy-Slug → Fallback `engineVersion 1`
→ WID-Snapshot behauptete v1, der State war v2). Jetzt: `resolveCanonicalSlug`
vor der Versionsauflösung. **Keine Daten werden umgeschrieben** — die Auflösung
geschieht zur Laufzeit; die optionale `migrateCanonicalSlugsOnStartup` ist
versioniert + idempotent und markiert kollidierende Legacy-Definitionen nur
`HIDDEN` (keine Löschung, keine ID-Änderung).

## 3. Command-Envelope (Client → Server)

**Kompatible Feld-Übersetzung (zentrales `resolveCommandEnvelope`, validiert
gegen `CommandEnvelopeSchema`):**

| Altes Feld | Neues Feld | Regel |
|---|---|---|
| `requestId` | `commandId` | `requestId` gilt als `commandId`, wenn kein explizites `commandId` gesetzt ist |
| `expectedRevision` | `stateVersion` | `expectedRevision` gilt als `stateVersion` |
| `roomCode` | (raumbezogen) | ersetzt **KEINE** Membership (Membership kommt serverseitig aus der Socket-Identität) |

**Widersprüchliche alte + neue Felder → Ablehnung, nicht Stillstand:**
`requestId` **und** `commandId` mit unterschiedlichem Wert, oder
`expectedRevision` **und** `stateVersion` mit unterschiedlichem Wert →
`INVALID_PAYLOAD` (oder `COMMAND_CONFLICT` auf Receipt-Ebene), **vor** jeder
Mutation. Unbekannte/ungültige Werte (negatives `stateVersion`, überlange
`commandId`, ungültiges `roomCode`) → `null`/Ablehnung. (Audit 14-03: ungültige
Commands werden **nicht** in einen Legacy-Pfad umgeleitet — sie werden vor der
Mutation abgelehnt.)

**Replay-/Idempotenz-Kontrakt (Receipts):** gleiche `commandId` mit gleicher
Akteur-/Payload-Identität → Duplicate liefert die **gespeicherte** Antwort
(`replayed: true`), exakt eine fachliche Wirkung. Gleiche `commandId` mit
**anderer** Identität → `COMMAND_CONFLICT` (keine fremden Ergebnisse, keine
neuen Rechte). `FAILED` mit unverändertem Zustand → sichere Neu-Ausführung;
`FAILED` mit fortgeschrittener Revision → `COMMAND_STATE_ADVANCED` +
`resyncRequired` (keine Doppelwirkung). (Audit 14-02.)

## 4. Engine- & Setup-Versionen

| Spiel | Kanonischer Slug | Engine-Version (aktuell) | Unterstützt | Setup-Schema-Version |
|---|---|---|---|---|
| Wissensduell | `wissensduell` | `1` | `[1]` | — |
| Jeopardy | `jeopardy` | `1` | `[1]` | — |
| Wer ist das? | `wer-ist-das` | `2` (`WER_IST_DAS_ENGINE_VERSION`) | `1, 2` | `1` **und** `2` |

**Wer-ist-das-Rejoin (Audit 14-08):** EIN version-agnostischer Reader
unterstützt sowohl `setupSchemaVersion 1` (ein fertiges `imageAssetId` pro
Runde) als auch `2` (Original-A + B → freigegebenes Composite). Beide Versionen
laden denselben `WerIstDasState`; die Version bleibt am `room_game_states`
**unverändert** (der Reader schreibt sie NICHT um). Inkompatible Engine-Version
(z. B. `3`) → kontrollierte Ablehnung `UNSUPPORTED_ENGINE_VERSION` (kein Crash,
kein falscher State, Raum bleibt ansonsten unverändert).

## 5. Fehler-Wire-Codes (Legacy → AppError-Vertrag)

Das neue AppError-Vertrag (`code` / `messageKey` / `traceId`, zentral via
`wireErrorToAppError`) **erhält die bestehenden Wire-Codes**, damit alte Clients
nicht brechen. Permission-Denials werden auf die etablierten Legacy-Wire-Codes
gemappt:

| Kontext | Interner Guard-Code | Etablierter Wire-Code (unverändert für Clients) |
|---|---|---|
| Engine-Mutation (z. B. Jeopardy/Geo) | `FORBIDDEN` / `NOT_IN_ROOM` | `UNAUTHORIZED` / `NOT_IN_ROOM` (bzw. je Engine `HOST_ONLY`/`PLAYER_ONLY`) |
| Game-Lifecycle (`room:kick`, Pause, End) | `NOT_AUTHORIZED` | `UNAUTHORIZED` (Wire-Kompatibilität) |

**Kein Detail-Leak:** Interne Stack/Message-Details landen in `internalDetail`
(logger-seitig) und werden nicht an den Client gesendet; der Client erhält nur
`code`/`messageKey`/`traceId`. (Audit 14-04/14-09: „keine Breaks" = die
bestehenden Wire-Codes bleiben lesbar.)

## 6. Was dieses Paket bewusst NICHT verändert

- **Bestandswerte** (Raum-, State-, Score-, Rejoin-Token, Engine- und
  Setup-Schema-Versionen) bleiben erhalten; die neue Migration
  (`20261010120000` Rollen+Config, `20261013120000` Receipt-Recovery) ist
  **additiv** (neue Spalten nullable / `NOT NULL DEFAULT 0`), kein Umbauen
  vorhandener Zeilen. (Nachweis: `migration.deploy.test.ts` — echtes
  `migrate deploy` auf repräsentativer Bestands-DB, IDs/Referenzen/Versionen/
  Punkte unverändert, WID-v1/v2-Rejoin überlebt.)
- **Kollidierende Legacy-Slug-Definitionen** werden nicht gelöscht, sondern
  `HIDDEN` + markiert (Kinder auf die kanonische Definition umgebunden).
- **Keine neue Engine, kein volles Team-/Room-Lifecycle, kein Co-Host-UI, kein
  Storage-GC** (→ Folgebereich, in `handoff.md` gekennzeichneter Folgebereich,
  nicht als erledigt).

## 7. Nachweise (Verifikation)

| Kontrakt | Test / Beleg |
|---|---|
| Rollen MODERATOR→HOST, UNKNOWN→null, Prototype→null | `migration.roles.test.ts` (8/8), `audit14.regression.test.ts` §14-10 |
| Slug-Auflösung + keine Umlegung | `persistence/canonicalSlugMigration.test.ts`, `config.integration.test.ts` |
| Command-Envelope-Konflikte vor Mutation, Rejoin/Receipt | `audit14.regression.test.ts` §14-01/14-02/14-03, `commandContract.integration.test.ts` |
| Config-Snapshot kanonisch + Version, atomares Update | `config.integration.test.ts`, `audit14.regression.test.ts` §14-04/14-05 |
| WID v1/v2 Rejoin über Migration | `migration.deploy.test.ts` (2/2), `weristdas/recovery.integration.test.ts` |
| Bestands-Migration (Rollen + Receipt-Spalten) additiv | `migration.deploy.test.ts` (echtes `migrate deploy` ×2, Idempotenz) |
| Permission-Guard + Revocation wirkt sofort | `permissions.integration.test.ts`, `audit14.regression.test.ts` §14-06 |


## Abschlusspräzisierungen vom 19.10.2026

- Runtime-Wrapper runReceipted nutzt **keine** gemeinsame Transaktion um
  Receipt und Engine. Die Engines behalten ihre CAS-Transaktionen. Ein
  verlorener Abschluss wird anhand beider persistierten Revisionsbeobachtungen
  konservativ behandelt: Resync statt möglicher Doppelwirkung. Kommentare zu
  separat angebotenen transaktionalen Hilfsfunktionen sind kein Beleg für die
  Transaktionsgrenze der tatsächlich gerouteten Socket-Aktionen.
- Migration `20261016130000_receipt_before_state_revision` ergänzt die
  GameState-Beobachtung. Sie ist zusätzlich zu den beiden älteren PR14-
  Migrationen im echten migrate-deploy-Bestandsnachweis enthalten.
- Intent-Verwaltung liegt in shared, Frontend-Schnittstelle bleibt gleich.
  Definitives success/Fachfehler-ACK beendet eine Benutzerabsicht; verlorene, ungültige
  und COMMAND_IN_PROGRESS-ACKs behalten deren ID. Späte ACKs konsumieren nur
  die tatsächlich gesendete ID. Neue Absicht nach Ablehnung wird neu geprüft.
- Ein defekter Geo-Snapshot wird niemals als aktuelle Defaults interpretiert.
  ERROR_RECOVERY ist gespeichert und wird rollenabhängig resynchronisiert;
  öffentlich ist nur der konstante Fehlercode, kein Snapshotinhalt. Der Host
  kann das Spiel beenden. Bereits gespeicherte Punkte bleiben erhalten.
- game:end mit commandId speichert success:true und replayt dasselbe Resultat.
- Permission-Rollennormalisierung verwendet ausschließlich shared normalizeRole.


## Ergänzung vom 20.10.2026

Die [acht Review-Korrekturen](review-fixes-2026-10-20.md) präzisieren die Runtime:
executionToken und mutationStartedAt sichern jeden Engine-CAS gegen übernommene
Besitzer. Die vierte PR14-Migration ist additiv; alte abgeschlossene Receipts
bleiben erhalten. Neu getrennte Aktionsklassen liefern bei mehrdeutigen alten
Receipts einen Konflikt, niemals eine geratene Aktion oder zweite Wirkung.
Vorhandene fehlerhafte Envelope-Felder werden auch ohne gültige ID abgelehnt.
Die Alias-Auflösung bleibt erhalten; Versionsfelder ohne ID werden nicht still
ignoriert. Legacy ohne IDs und ohne Versionserwartung bleibt unterstützt.
Timer 0 bedeutet in der bestehenden Geo-Engine keine unbegrenzte Zeit; der Writer
lehnt ihn ab. Der generische Resolver bewahrt 0/false dennoch unverändert.
Counts beeinflussen nun die echten Initializer aller drei Spiele.

Receipted Exceptions können nach einem Commit entstehen. outcomeUnknown:true
kennzeichnet diesen unklaren Abschluss; der gemeinsame Client behält die ID
bis zu einem Replay oder einer definitiven Recovery-Antwort. Fachliche
Ablehnungen verbrauchen weiterhin die ID, damit eine neue gültige Absicht
nicht durch eine alte Ablehnung blockiert wird.

Die fünfte PR14-Migration ergänzt den nullable Presence-Besitzer connectionId.
Bestehende Identitäten/Ready/Punkte bleiben erhalten. Jede echte Anmeldung setzt
den Besitzer; ein später alter Disconnect kann einen neuen Socket nicht offline
setzen. Der Wert ist Verbindungsmetadatum, kein Rejoin- oder Zugriffstoken.
