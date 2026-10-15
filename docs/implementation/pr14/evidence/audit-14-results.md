# PR14 Audit (14-01 … 14-10) — Fix & Testbeleg

**Audit:** `Audit_PR14_dea0d92.md` (13.10.2026), geprüfter Remote-Head `dea0d92`.
**Fix-Branch:** `feature/pr14-audit-fixes` · **Ziel:** Übernahme in
`feature/pr14-foundation-standards` (PR #14, Draft).
**Datum:** 2026-10-15. **Status:** alle 10 Punkte an echten Grenzen behoben und mit
gezielten Regressionstests belegt. Lokale volle Regression + E2E am Arbeitsstand
grün (s. Abschnitt „Lokale Regression"). GitHub-Status wird nach Push + CI am
finalen Head ergänzt.

> **Prinzip:** Jeder Befund trägt (a) den **Fix** an der tatsächlichen Grenze und
> (b) eine **Gegenprobe**, die exakt die im Audit reproduzierte Fehlerbedingung
> abdeckt (nicht das alte, falsche Surrogat). `audit14.regression.test.ts`
> enthält die serverseitigen Gegenproben; `intentLifecycle.test.ts` (Web) und
> `weristdas-e2e.spec.ts` (E2E) decken den Frontend-/Browser-Pfad.

## 14-01 — Neue Benutzerabsichten werden als alte Wiederholungen behandelt (P1)

**Fix:** Zentraler `emitCommand()` in `apps/web/src/lib/socket.ts` verwaltet den
Intent-Token-Lebenszyklus an der Sendegrenze: gleiche Absicht (Doppelklick,
ACK-Verlust) → **gleiches** Token; bestätigter Erfolg (`success:true`, inkl.
`replayed:true`) → Token **verbraucht**; die nächste zulässige Absicht (erneutes
Buzzer-Öffnen derselben Runde nach WRONG-Bewertung, zweite Pause) erhält
automatisch ein frisches Token. Alle kritischen Emits laufen über `emitCommand`
(WID/Jeopardy-Events, `game:start/pause/resume/end`, `room:kick`, Geo-Aktionen) —
kein Aufrufer kann den Verwurf nach ACK vergessen (früher war `discardIntentToken`
exportiert, aber nirgends aufgerufen).

**Gegenprobe (Fehlerbedingung):**
- Server: `audit14.regression.test.ts` §14-01 — „erneutes Buzzer-Öffnen derselben
  Runde mit NEUEM Token wird ausgeführt (State → BUZZ_OPEN); mit ALTEM Token →
  Replay (State bleibt ROUND_READY)". Echte Sockets.
- Web: `intentLifecycle.test.ts` — Doppelklick ohne ACK → gleiches Token;
  bestätigter Erfolg/Replay → frisches Token; Fehler → Token bleibt (9 Tests).
- **E2E (Browser):** `weristdas-e2e.spec.ts` W1–W10 enthält
  „öffnen → buzz → falsch bewerten → erneut öffnen" — war am Audit-Head
  `dea0d92` **timeout/rot**, nach dem Fix **grün (6.3 s)**.

## 14-02 — Receipt-Wrapper nicht atomar zur Spielmutation (P1)

**Fix:** `runReceipted()` in `games/core/commands.ts`:
- Vor dem Claim wird die aktuelle Room-Revision gelesen und als
  `beforeRevision` **atomar mit dem Claim-Write** persistiert; die mitgesendete
  `stateVersion`/`expectedRevision` wird **vor** der Mutation gegen die aktuelle
  Revision geprüft.
- **Retry-Entscheidung:** ein Retry (FAILED oder abgelaufenes PENDING) ist nur
  sicher, wenn `room.revision === beforeRevision`. Fortgeschrittene Revision →
  der ursprüngliche Command hat gewirkt (verlorenes Erfolgs-Receipt) →
  `COMMAND_STATE_ADVANCED` + `resyncRequired` — **keine** zweite fachliche
  Wirkung (exakt der im Audit injizierte Fall: CAS commit → 1, COMPLETED-Write
  schlägt fehl → FAILED; identischer Retry darfr nicht 1→2 machen).
- **Recovery:** PENDING-Zeilen tragen eine `leaseExpiresAt` (3 s); abgelaufene
  Lease → abgestürzter Besitzer, `claimTakeover()` (exklusives CAS auf Status +
  exakte Lease) nimmt die Wiederaufnahme wieder auf statt `COMMAND_IN_PROGRESS`
  für immer. FAILED→PENDING ist ein exklusives CAS (parallele Retry-Claims
  konkurrieren fair, genau einer gewinnt). Neue Spalten `beforeRevision` /
  `leaseExpiresAt` via Migration `20261013120000` (additiv).

**Gegenprobe:** `audit14.regression.test.ts` §14-02 —
- „COMPLETED-Write schlägt **NACH** committierter Mutation fehl → Retry
  double-applied **NICHT** (Revision bleibt)" (frühere C5-Gegenprobe injizierte
  den Fehler *vor* der Mutation — die falsche Stelle).
- „abgestürzter PENDING-Claim (abgelaufene Lease) wird wieder aufgenommen statt
  `COMMAND_IN_PROGRESS` für immer".

## 14-03 — Konfliktierende/veraltete Command-Felder werden akzeptiert (P1)

**Fix:** `commandContext.ts` gibt **beide** Paare (commandId+requestId,
stateVersion+expectedRevision) gemeinsam an die Prüfung weiter;
`resolveCommandEnvelope` wendet das deklarierte `CommandEnvelopeSchema` an
(validierte Boundary, kein nacktes Objekt). Widersprüche (commandId≠requestId,
stateVersion≠expectedRevision) und ungültige Werte (negatives stateVersion,
ungültiges roomCode, überlange commandId) → `null` → **`INVALID_PAYLOAD` vor
jeder Mutation** (kein Legacy-Umschlag). Die serverseitige CAS-Prüfung nutzt die
tatsächliche `stateVersion` (14-02).

**Gegenprobe:** `audit14.regression.test.ts` §14-03 —
- „game:pause mit widersprüchlichen commandId/requestId → **vor** Mutation
  abgelehnt" (echtes Socket, `INVALID_PAYLOAD`, Revision unverändert).
- „negativer stateVersion + ungültiges roomCode → abgelehnt, keine Mutation".
- „Resolver: negatives stateVersion / ungültiges roomCode / überlange commandId →
  null; gültige Paare → Envelope (Shared-Boundary)".
- „resolveCommandContextForSocket an der echten Grenze: widersprüchliche
  commandId/requestId → `INVALID_PAYLOAD`".

## 14-04 — Canonical Config-Integration und Start-Snapshots fachlich falsch (P1)

**Fix:** `games/core/config.ts` — Felder liegen **nur** unter kanonischen Slugs
(`wissensduell`, `wer-ist-das`, …); Legacy-Slugs werden an der Grenze per
`resolveCanonicalSlug` aufgelöst (Adapter nur an der Grenze). Neue
`ENGINE_VERSIONS`-Map liefert die **tatsächliche** Engine-Version pro Slug
(WID = `WER_IST_DAS_ENGINE_VERSION` = 2, unterstützt `[1,2]`), nicht hartkodiert
`1`. `persistConfigSnapshot` trägt tatsächliche Setupwerte + echte Engine-Version
+ korrekte Rundendaten (Audit-Fall: 1 Runde statt 5, engineVersion 2 statt 1).
`loadGameConfig` prüft den Snapshot beim Lesen auf Spiel (`gameSlug`), Schema und
unterstützte `engineVersion` — kein stilles Deuten eines unpassenden Snapshots
durch heutige Defaults. Geo liest den Timer über den kanonischen Slug.

**Gegenprobe:** `audit14.regression.test.ts` §14-04 — „Setup-Timer 11 s + 2 Fragen
→ Snapshot trägt kanonischen Slug, **tatsächliche Werte** (11000 ms statt
Default/20000 ms) und **Version**". (Audit-Fall: kanonischer `wissensduell`-Raum
lieferte 20.000 ms statt 11.000 ms, weil Felder unter `geo` lagen und der
Snapshot leer/hart v1 war.)

## 14-05 — Config-CAS und Datenspeicherung können teilweise committen (P1)

**Fix:** `updateRoomConfig` läuft in **einer** `$transaction`: Status-Prüfung
(LOCKED_AFTER_START), CAS (Revision via `updateMany where revision`), Merge der
Livewerte und `liveConfigJson`-Write gemeinsam — Rollback erhält Revision und
Werte. Ein Fehler nach dem CAS verbraucht die Revision nicht (früher: Revision-Bump
als eigener Write, liveConfigJson als zweiter → dazwischen Fehler = Revision
verbraucht, Werte NULL). Der Start wirft bei Snapshot-Schreibfehler **ab** (kein
erfolgreicher Start ohne den zugesagten Snapshot).

**Gegenprobe:** `audit14.regression.test.ts` §14-05 — „fehlgeschlagene Änderung
(Fehler **nach** CAS) → Revision + liveConfigJson unverändert" (Injektion
**innerhalb** der Transaktion, nach dem Revision-CAS → Tx rollt zurück; Revision
bleibt `rev0`, kein `REVISION_CONFLICT` beim Retry mit der ursprünglichen
Erwartung).

## 14-06 — PLAYER_MANAGE-Entzug wird beim Kicken umgangen (P1)

**Fix:** `sockets/room.ts` `handleKickPlayer()` nutzt jetzt den gemeinsamen
`requireGamePermission(socket, 'PLAYER_MANAGE')` statt der reinen
`identity.role === 'HOST'`-Prüfung. Ein am verbundenen Socket entzogenes Recht
wirkt sofort (Guard liest die wirksame Berechtigung live). Inventar: alle kritischen
Verwaltungs-/Engine-Mutationen (Start/Pause/Resume/End, Kick, Config-/Timer,
Geo/Jeopardy/WID-Aktionen) laufen über den Guard.

**Gegenprobe:** `audit14.regression.test.ts` §14-06 — „eingeloggter Host mit
`REVOKE(PLAYER_MANAGE)` kann **NICHT** mehr kicken (echtes Socket)" (früher:
`success:true` + `kickedAt` trotz Entzug).

## 14-07 — PR12-main-Abgleich und Arbeitspaketzuordnung fehlen (P2)

**Fix:** Datierter Nachtrag `docs/specs/pr12/main-abgleich-1407.md`:
- Tatsächlicher Merge-/Iststand (PR11 `d52fa52`, PR12 `afef936`, PR13 `3dba9ff`
  **gemerged**; main-Head `3dba9ff`), nachgeführt.
- Zentrale **Arbeitspaket-ID ↔ GitHub-Nummer**-Verknüpfung (Planplatz „PR13" =
  BASIS-STANDARDS = **GitHub-PR #14**; Planplatz PR14 = TEAM-ROOM, offen, strikt
  getrennt).
- Historische Basis-Referenzen (`411a5b7` als „Ist", PR11-Snapshot `1470894` als
  „offener Draft") **datiert** — bewusst **ohne** Umbruch der 1292 atomaren
  Matrixzeilen (Regel: atomare Matrixstatus nur mit Einzelbelegen aktualisieren);
  der Nachtrag datiert die Lesart.
- Handoff `0b` vom überzogenen „DONE" auf „PARTIAL → erledigt" korrigiert;
  PR12-README-Dateitabelle verlinkt den Nachtrag.

**Beleg:** Abgleichsbefehle im Nachtrag (`git merge-base --is-ancestor` ×3,
`git diff --stat 1470894 d52fa52` = 33 Dateien). Doc-Checker bleibt grün.

## 14-08 — Bestandsmigration nur teilweise nachgewiesen (P2)

**Fix/Beleg:** Neue `persistence/migration.deploy.test.ts` — **echtes**
`prisma migrate deploy` auf einer repräsentativen **Bestands-DB** (gebaucht aus
Basis-Migrationsstand + Bestandsdaten: ADMIN/MODERATOR/PLAYER/VIEWER/UNKNOWN-
Rollen, Host-Teilnahme, aktive+beendete Räume, WID-`room_game_states` v1 **und**
v2, Sessions, Rejoin-Tokens), dann deploy ×2 (Idempotenz) und Vergleich von
IDs/Referenzen/Engine-Versionen/Punkten. Echter **WID-v1/v2-Rejoin** wird per
Socket geprüft (nicht nur ein gespeichertes Token/State-Datensatz).

**Gegenprobe:** `migration.deploy.test.ts` — frische + Bestandskopie jeweils
`migrate deploy` ×2; Rollen MODERATOR→HOST, ADMIN bleibt, UNKNOWN ohne Rechte;
IDs/Sessions/Räume/Rejoin-Tokens/Engine- und Setup-Schema-Versionen unverändert;
WID v1 (ein Bild) + v2 (Fusion) bleiben per echtem Rejoin lauffähig.

## 14-09 — Abschlussdokumentation und Veröffentlichung nicht vollständig (P2)

**Fix:**
- **`compatibility.md`** (verpflichtend, fehlte) →
  `docs/implementation/pr14/compatibility.md`: verbindlicher Legacy-Kontrakt-
  Überblick (Rollen, Slugs, Command-Envelope-Felder, Engine-/Setup-Versionen,
  Wire-Fehlercodes) mit Grenze + Nachweis je Zeile.
- **`pr-body.md`** aus dem Repo-Root entfernt → audit-korrigierte, ehrliche
  PR14-Beschreibung in `docs/implementation/pr14/pr14-body.md` (Draft, DoD,
  Folgebereich, kein Merge); der **tatsächliche** GitHub-PR-Text wird nach dem
  finalen Push aktualisiert.
- **`acceptance.md`**: überzogene Stage-2-„final/VERIFIED"-Kopfkarte durch
  Audit-Korrektur ersetzt (historischer Befund bleibt, aktueller Status gilt erst
  nach dem Audit-Fix-Commit + echten Fehlergrenzen-Tests).
- **`handoff.md`** + diese `evidence/audit-14-results.md`: nur den tatsächlich
  geprüften Head und dessen Checks als Abschluss.

## 14-10 — Unbekannte Rollen werden nicht für alle Strings sauber verworfen (P2)

**Fix:** `packages/shared/src/index.ts` — `LEGACY_ROLE_VALUES` nutzt
`Object.create(null)` (kein geerbtes Object-Prototype); `normalizeRole` prüft
`Object.prototype.hasOwnProperty` **und** das Ergebnis gegen die kanonische
Rollenmenge. Prototype-Namen (`constructor`, `__proto__`, `toString`,
`hasOwnProperty`) → **`null`** (früher: geerbte Object-Konstruktorfunktion).

**Gegenprobe:** `audit14.regression.test.ts` §14-10 — „constructor/__proto__/
toString/hasOwnProperty → null; gültige + Legacy-Rolle korrekt".

## Lokale Regression (Arbeitsstand, nach `pnpm build` — CI-Parität)

| Stufe | Ergebnis |
|---|---|
| Typecheck (alle Pakete) | ✓ grün |
| Lint | ✓ 0 Fehler (108 vorbestehende Warnings) |
| Build (server + web) | ✓ |
| **Server-Tests** | **325/325 (37 Dateien)** — inkl. 374-Zeilen-`migration.deploy.test.ts` und 408-Zeilen-`audit14.regression.test.ts` |
| **Web-Tests** | **61/61 (7 Dateien)** — inkl. neuem `intentLifecycle.test.ts` (9) |
| **E2E (Playwright, 3 Spiele)** | **17/17** — Geo, Jeopardy, **WID W1–W10 grün (6.3 s)**; WID-Timeout am Audit-Head `dea0d92` behoben (Ursache 14-01) |

> Hinweis Node-Version: lokal Node 26.7.0 (Audit-Bezug Node 22/24.19.0). Die
> Ergebnisse sind getrennt von den GitHub-Nachweisen ausgewiesen (Audit-Regel
> „lokale Gegenproben getrennt von GitHub").

## GitHub (am finalen Head `ec8ef51` — geprüft, nicht erwartet)

Fixes in `feature/pr14-foundation-standards` (PR #14) per Fast-Forward übernommen
(Basis `dea0d92` → Head `ec8ef51`, kein Überschreiben), PR-Beschreibung auf
`docs/implementation/pr14/pr14-body.md` aktualisiert (REST `PATCH /pulls/14`, HTTP 200).

| GitHub-Check am exakten Head `ec8ef51ee3753c5408ed6e53147a73ea98b72a08` | Status |
|---|---|
| **CI** (typecheck, lint, build, Server-Tests, Web-Tests) | ✅ `completed / success` |
| **E2E** (Playwright, Geo + Jeopardy + **WID W1–W10**) | ✅ `completed / success` |
| PR #14 Zustand | `OPEN`, **Draft = true** (nicht gemerged, nicht Ready) |

**WID-Timeout (14-01) am GitHub-Head behoben:** Der E2E-Check, der am Audit-Head
`dea0d92` wegen WID W1–W10 rot war, ist am finalen Head `ec8ef51` **grün**. Die
lokal reproduzierte Ursache (nie verbrauchtes Intent-Token → erneutes Buzzer-Öffnen
wird als Replay behandelt) ist mit dem `emitCommand`-Verbrauch behoben; lokal
**17/17** (WID 6,3 s), GitHub **E2E success** — beide Ebenen getrennt belegt.
