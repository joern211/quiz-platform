# PR12 — Handoff: Regelwerk Mapping & V1-Spezifikation (19 Spiele)

**Stand dieses Dokuments:** wird nach jeder Etappe aktualisiert.
**Zuletzt aktualisiert:** **09.10.2026 — Audit-Nacharbeit 12-01..12-11 abgeschlossen** (falsche feste Regeln korrigiert, Ist-Aussagen abgeglichen, Entscheidungsregister bereinigt, Matrix atomarisiert, Engine-Vertrag + pro-Spiel-Policy, Scope/Integration, widerspruchsfreie Vorschläge, Handoff/Verifikation bereinigt). Draft-PR #12 offen, **nicht** Ready, **nicht** gemerged.

## Auftrag (Kurzform)

Eigenständige, isolierte **Vorbereitung von PR12 als Dokumentations-/Spezifikations-PR**:
vollständige Zuordnung Master-Regelwerk → Anforderungen → Module/Verträge → Roadmap-PRs →
Tests → Abnahme. Ist-Analyse auf main, getrennter Vergleich des gepinnten PR11-Snapshots,
Zielverträge (Zielmodell, keine Runtime-Änderungen), Spezifikationen aller 19 Spiele
(einschließlich **Der Dümmste Fliegt**, Slug-Vorschlag), Entscheidungsregister,
Abhängigkeitsplan. **Keine** Implementierung, **kein** Touch des PR11-Worktrees.

## Isolation (Etappe A — verifiziert)

| Wert | Status |
|---|---|
| Repository | https://github.com/joern211/quiz-platform (origin, HTTPS) |
| **Basis main (festgehalten)** | `411a5b783e5857bca5b208598fade43affc108b5` (PR10 gemerged) |
| **PR11-Head (gepinnt)** | `14708940246de105b83fdf69501ce373e2c48d21` (Etappe 3, Draft) |
| PR11-Branch | `feature/wer-ist-das-fusion-media` (remote + local, NICHT angefasst) |
| **Eigener Worktree** | separater Git-Worktree (Branch `docs/pr12-master-spec-preparation`) |
| **Eigener Branch** | `docs/pr12-master-spec-preparation` (basierend auf origin/main @ 411a5b7) |
| HEAD beim Start | `411a5b783e5857bca5b208598fade43affc108b5`, sauberer Start |

> **12-11 (Bereinigung):** Private absolute Rechnerpfade und lokaler
> Zugangskontext wurden aus diesem öffentlichen Dokument entfernt —
> Branches, SHAs und relative Projektpfade genügen. Der PR12-Worktree ist
> strikt von den anderen Arbeitsbereichen getrennt (eigener Branch, eigener
> Worktree); keine der anderen Worktrees/branches wurde angefasst.

## Freigegebene Schreibbereiche

- `docs/implementation/pr12/` (dieser Ordner)
- `docs/specs/pr12/`

Zwischendatei (lokal, nicht committen): `.work/master-regelwerk-extrahiert.md`
(Mustertext, extrahiert aus dem RTF-Wrapper; `.work/` wird vor jedem Commit geprüft
bzw. via `.git/info/exclude` lokal ignoriert — siehe Validierung).

## Quellenstatus

| Quelle | Status |
|---|---|
| `Master Regelwerk.rtf` (Desktop, Stand 28.09.2026) | VOLLSTÄNDIG GELESEN. SHA256 (Datei): `867b3519f86c427420d5de3aae5a07566371bcaff462630bf4aad9b16a6c0e15`. Enthält Python-Wrapper; Regeltext extrahiert (ohne Code-Ausführung), SHA256 (extrahierter Text): `5051ffc9ce8d8cda8b98241319d5179eea3b7928557021480ab95bd3c9a06ac0`. Alle 20 Abschnitte vorhanden (§1–§20), 3956 Zeilen. |
| Nutzerergänzung vom 07.10.2026 | V1.0 = vollständiger Master-Scope + **Der Dümmste Fliegt** (19 Spiele). |
| Roadmap 1–50 (angehängt) | Gelesen; PR-Nummern sind Planplätze. |
| main `411a5b7` | Ist-Analyse läuft (Etappe B). |
| PR11 `1470894` | Als Fix-Snapshot via `git diff/show` verglichen (keine fortlaufende Beobachtung). |
| Gesamtplan PDF | Nicht benötigt; nur historischer Kontext. |

## Etappen-Plan

- [x] **A — Isolation und Checkpoint:** Worktree/Branch angelegt, Master extrahiert, erster Commit.
- [x] **B — Anforderungen + Iststand:** Vollständige Erfassung der Regelwerk-Unterpunkte (§1–§20);
      main-Iststand (Shared-Typen, Prisma, Cores, Registry, HTTP/Socket, Media, Tests, CI);
      PR11-Delta separat. → Detail-Befunde in `requirements-matrix.md` + unten.
- [x] **C — Zielverträge + Spieldetails:** ✅ requirements-matrix.md (275 MR-Zeilen),
      technical-mapping.md, 19 Spielespezifikationen + index.md, decision-register.md.
- [x] **D — Abhängigkeiten:** ✅ dependencies-and-parallel-work.md.
- [x] **E — Konsistenz, Draft, Handoff:** ✅ Link-/ID-Prüfung (275/275 MR, 57/57 DEC),
      README, verification.md, pr-body.md. **Push + Draft-PR #12: DONE (2026-10-07).**
- [x] **Audit-Nacharbeit 12-01..12-11 (09.10.2026):** alle Befunde geschlossen —
      falsche feste Regeln + Ist-Aussagen (12-01..05), Entscheidungsregister (12-06),
      atomare Matrix (12-07), Engine-Vertrag + pro-Spiel-Policy (12-08),
      Scope/Integration (12-09), widerspruchsfreie Vorschläge (12-10),
      Handoff/Verifikation (12-11). Details unten + Audit-Closure-Tabelle.

## Erste Befunde (Etappe A/B, vorläufig — werden in der Matrix finalisiert)

**Rollennomenklatur (wichtig):** main nutzt noch `MODERATOR` als Host-Rolle
(`User.role: ADMIN|MODERATOR`, `Participation.role: MODERATOR|PLAYER|VIEWER`,
`GameManifest.roles` enthält `'MODERATOR'`). Master §2.1 schreibt vor, dass
„Moderator" vollständig durch **HOST** ersetzt wird; **DISPLAY** existiert in main
überhaupt nicht (kein Role-Value, keine Session-Art, keine Route).
→ Migration/Compatibility-Punkt für PR13 (§12.1 „alte Begriffe nur Migration/Compatibility").

**Room-Lifecycle:** main: `CREATED|LOBBY|RUNNING|ENDED|ARCHIVED` + `runPhase`;
Master §4.3 verlangt u. a. `DRAFT_ROOM|SCHEDULED|LOBBY_OPEN|LOBBY_LOCKED|GAME_ACTIVE|
PAUSED|IDLE|EXPIRED|CLOSED`. Teilweise über `runPhase` abgedeckt (z. B. PAUSED,
STARTING_COUNTDOWN), aber `DRAFT_ROOM`/`SCHEDULED`/`EXPIRED`/`IDLE` fehlen als Zustände.

**Team-Core:** kein Team-Modell in Prisma (nur `Participation.teamId String?` ohne Team-Row,
keine Team-Entität, keine Team-Limits, keine Teamhistorie, kein TEAM_SCORE-Scoring).
→ PR14 Kernthema; `hasTeams`-Manifeste (partner-challenge, same-thought) nicht bedienbar.

**Content-System:** nur `QuestionPack` + `GeoQuestion` (4-Optionen-Multiple-Choice,
`enabled` statt DRAFT/READY/DISABLED/ARCHIVED-Status, kein Visibility/Ownership-Modell,
keine Tags, keine Revisionen, kein Import, kein Editor-Backend). → PR17/18.

**Game Core (main):** vorhanden: `games/core/{buzzer,score,state,access,errors}.ts`
(Buzzer-Primitiven, ScoreEvent-Transaktion, CAS via `saveGameStateIfRevision`,
Rollen-Authorization, Fehlercodes). Fehlt als Core: Timer als Core-Modul (Geo hat
eigene In-Memory-Timer), Judge, Turn, Tie, Answer-Matching, Submission, Reveal/Visibility,
Random/Seed, Command-Idempotency (nur `requestId` + `expectedRevision` im ClientCommand),
Metrics, Invariants, Leaderboard, Round-Transition, Next-Action, Notification.
GameEngineContract (§5.2) nicht formal als Interface umgesetzt — Registry hat eine
`GameHandle` (initialize/afterStart/pause/resume/end/cleanup/registerEvents), die dem
Contract nicht vollständig entspricht (keine `validateSetup/preflightCheck/createProjection/
buildRoundResult/buildGameResult` als Contract-Methode).

**Rejoin:** vorhanden (rejoinToken + Version, `room-reconnect`-Integrationstest,
geo/jeopardy/weristdas resync). **Keine** Geräteübernahme-Logik nach §4.11
(keine Übernahme-Meldung, keine Viewer-Begrenzung pro participantId), kein Late Join
(`allowLateJoin` fehlt), keine Waitlist, kein Ban (nur `kickedAt`), kein Host-Transfer.

**Media (main):** `MediaAsset` (PRIVATE|PUBLIC|ROOM), Local Storage, kein Signed-URL-Flow,
keine Derived Assets, kein Processing-Status, kein Audit/Block. PR11 (gepinnt) fügt hinzu:
`derivedFromAssetIds`, `processStatus` (READY|PROCESSING|FAILED|REJECTED),
Visibility-Kommentar SHARED/SYSTEM/ROOM_TEMP, `http/media.ts` massiv erweitert (protected
delivery), `media/signedUrl.ts` neu, Migration `..._add_media_derivation_status.sql`,
Composite-Fusion (`weristdas/composite.ts` + Tests), Setup-Schema v2 für wer-ist-das,
`HOST_CANNOT_PLAY_OWN_ROUND`-Gate beim Join (Host-Konto kann eigene wer-ist-das-Runde
nicht mitraten — Informationsvorteil).

**Events/Olympia:** nur leeres `EventSeries`-Modell (PLANNING|ACTIVE|ENDED, settings-JSON,
keine Relationen, keine Eventpunkte, keine Intermission). Room.eventSeriesId als String ohne
Relation. → PR38.

**Profile/Stats/XP:** fehlt komplett (kein PlayerProfile-Modell, keine History/Stats/
Achievements/XP). → PR39/40. (Web `ProfilePage.tsx` = lokale Client-Daten.)

**Integrität:** nur `AuditLog` (einfach, nicht tamper-evident, nur User-Aktionen),
Rate-Limiter (Login/Join, nach Projekt-Historie nur production — zu prüfen),
kein IntegrityIncident, kein Replay/Dedup über commandId (commandId-Äquivalent: `requestId`
im ClientCommand, Server-Dedup-Verhalten zu verifizieren), kein Secret-Leak-Test-Rahmen.

**Betrieb:** keine Backups (außer `apps/server/storage/backups` gitignore-Verweis),
keine Background Jobs, kein Health-Endpoint nach §11.4 zu prüfen, keine Feature Flags,
keine Platform Modes. CI: typecheck+lint+build+server tests+web tests+E2E (Playwright).

**19. Spiel:** `der-duemmste-fliegt` ist in main NICHT im Katalog (18 Manifests) —
konsistent mit „Nutzerergänzung, Slug-Vorschlag, separat zu spezifizieren".

## Offene Decision-IDs (während der Arbeit fortgeschrieben)

- `DDF-01` … (Der Dümmste Fliegt: Mechanik-Details, Slug, Ausscheidung/Voting/Finale)
- `SNG-01` (Song-Quiz-Punktwerte/Phasen, §15.5 offen)
- weitere folgen (Undercover/Geheim Agent/Raus damit/Higher-Lower/Timeline/
  Schätz mal/Millionenfrage/Wahr-oder-Fake/SLF/Gleicher-Gedanke-Details)

## Blocker / Annahmen

- Keine Blocker bisher. PR11-Worktree bleibt strikt unangetastet.
- Annahme: `docs/pr12-master-spec-preparation` darf auf origin gepusht werden
  (Push erfolgt erst in Etappe E).

## Ausgeführte Checks (Etappe A)

- `git worktree add` + `git rev-parse`-Verifikation (Pfad/Branch/HEAD oben).
- RTF-Extraktion mit strukturiertem Parser, keine Code-Ausführung; 0 verbleibende
  RTF-Escape-Sequenzen; Abschnittsüberschriften vollständig (§1–§20).
- `git status --porcelain` im eigenen Worktree: sauber (außer neuen Dokumenten).
- PR11-Delta: `git diff --stat 411a5b7..1470894` (18 Dateien, +1946/−125) —
  bestätigt PR11-Scope (Media, weristdas, schema, seed, shared, docs/pr11-handoff).

## Etappe B abgeschlossen (Anforderungsmatrix)

`docs/specs/pr12/requirements-matrix.md` geschrieben: **275 MR-Zeilen** +
5 ADD-DDF-Zeilen,
deckend alle Unterabschnitte §1–§20 + DDF-Nutzerergänzung. Jede Zeile: ID,
Quelle, Scope-Klasse (P/O/L/X), Entscheidungsstatus (F/N/V/O), Ist-Status
(I/P/M/NV) mit konkreten Referenzen, PR11-Vergleich, Core/Rollen, Ziel-PR,
Abnahmekriterium, Lücke/Decision-ID.

**Ist-Verteilung (Kurzform):** I ≈ 18 · P ≈ 60 · M ≈ ~190 · NV = 0.
Größte MISSING-Blöcke: zentrale Game-Cores (Timer/Judge/Turn/Tie/Matching/
Submission/Visibility/Random/Event/Invariants/Undo/Finalisierung/Next-Action/
Round-Transition/Progress/Leaderboard/Result-Screen/Notification), Team-Core,
§6 Content-System, §7 Media-Vollsystem + Voice/Camera/Broadcast, §8 Event (voll),
§9 Profile/Stats/XP (voll), §10 Integrity, §11 Plattformbetrieb.

## Nächster Schritt (10.10.2026, nach Nachbefunden D–F)

**Audit-Nacharbeit 12-01..12-11:** ✅ DONE (Tabelle unten).
**Nachbefunde D–F (10.10., Wiederaufnahme-Auftrag):** ✅ DONE (Tabelle unten) —
Viewer-Audio-Standard (§7.23) verbindlich in allen 19 Specs + Vertrag;
Imposter: feste je-Stimme-Wertung auch bei Gleichstand + keine geheimen
Antworten für mitspielenden Host; Jeopardy: „Host mitbuzzer, Vorteil
akzeptiert" als Alternative entfernt (FEST-Trennung Verwaltung ≠
Gameplay-Information).

Branch `docs/pr12-master-spec-preparation` gepusht, **Draft-PR #12 offen**
(https://github.com/joern211/quiz-platform/pull/12). **Nicht** auf
Ready-for-review umstellen, **nicht** mergen.

> **12-11 (Bereinigung):** Lokaler Zugangskontext (Auth-Methode/Credential)
> wurde aus diesem öffentlichen Dokument entfernt — er gehört nicht in die
> Repo-Dokumentation. Branch/SHA/PR-Link genügen.

- **Nach PR11-Merge (noch offen, NICHT vorweg behauptet):** erneuter
  main-Abgleich (SHAs, PR11-Spalte, Links) gemäß
  `dependencies-and-parallel-work.md` §7. Der gepinnte ältere
  PR11-Snapshot (`1470894`) bleibt für die parallele Vorbereitung zulässig,
  muss vor der endgültigen PR12-Abnahme aber gegen den neuen main-Stand
  aktualisiert werden.

## Audit-Closure-Tabelle (12-01..12-11)

| ID | Befund | Datei(en) | Konkrete Änderung | Nachweis |
|---|---|---|---|---|
| 12-01 | Yacht falsche feste Regeln | `games/yacht.md` | Dreier-/Viererpasch = Würfelsumme (Master §16.6), Beispiel 3/3/4/3/6 = 19; SHARED_SCORECARD = 1 aktiver Spieler pro Teamzug; AVERAGE ausdrücklich später | Master-Abgleich, Beispielrechnung |
| 12-02 | Partner-Challenge Teams ≠ Rollen | `games/partner-challenge.md` | Bidder + Performer IN JEDEM Team; +1 an zuletzt gegen Gewinner ausgeschiedenes Team; Secrets pro Rolle; Host-Performer ohne Wissensvorteil; Beispiele 2 und ≥3 Teams | Master §15.9, Beispiele |
| 12-03 | Imposter falsch gewertet | `games/imposter.md` | +1 an korrekt votierenden Spieler; +1 an Lügenautor je getäuschtem Vote; kein erfundener Spieler-Autor; Tie-Null hebt feste Stimme-Wertung nicht auf; Host ohne Vorsprung | ScoreEvent-Zuordnung, Beispiel |
| 12-04 | WID-Iststand falsch | `games/wer-ist-das.md` | `HOST_CANNOT_PLAY_OWN_ROUND`-Iststand korrekt; falscher Buzz sperrt dieselbe Runde; +1 erst nach Hint; Limits 10 MB/4096 (kein 512-Minimum); Master-Contentmodell Packs/Runden erhalten | PR11-Quellen (Code/Config) |
| 12-05 | Jeopardy-Ist + Rechenbeispiel | `games/jeopardy.md` | Frage an alle, Lösung nur Host; korrekte Wertung (± halber Wert); Ist/Ziel getrennt; Host-Vorteil keine Alternative | PR11 `engine.ts`/`contracts.ts` |
| 12-06 | Entscheidungsregister öffnet Feste | `decision-register.md` | KICK≠BAN (RUT-17); Host-Account/Player-ohne-Account = FEST; Event-Bonus/Joker = konfigurierbarer V1; Morph+AVERAGE = später; kein globales Minusverbot (RUT-15); Blind/Judge fair | zeilenweise FEST/NUTZERERGÄNZUNG/VORSCHLAG/OFFEN |
| 12-07 | Matrix nicht atomar | `requirements-matrix.md` | 1 prüfbare Verpflichtung pro Zeile (MR-16-00-01 aufgelöst); 11 Attribute je Zeile; MR-01-00-04/05-06-01/05-08-01 = PARTIAL; NOT_VERIFIED; Split-Mapping | Rückverfolgbarkeit |
| 12-08 | Verträge nicht implementierungsreif | `technical-mapping.md` + 19 `games/*.md` + `index.md` | gemeinsamer Engine-Vertrag §3.4 (Zustände, Command-Guards, Projektionen, Persistenz/Version/Recovery, Medien/Voice/Camera/Mic/Display, RESULT_REVIEW); pro Spiel §13 (Late-Join, Ausscheiden, Teamrollen, RESULT_REVIEW) | 19/19 §13 vorhanden, §3.4 referenziert |
| 12-09 | Scope/Integration falsch | `dependencies-and-parallel-work.md` | DDF-Katalog/Manifest = kein PR12-Runtime-Auftrag (PR36), PR12 docs-only; Core-DoD ≥2 Consumer früh je Core-PR (PR15/PR16), kein zirkuläres DONE-Kriterium | Dateibesitz + Integrationsreihenfolge |
| 12-10 | Widersprüchliche Vorschläge | 6 `games/*.md` + Ausscheidungsspiele | Higher/Lower (B geheim), Timeline (1 Formel), Schätz mal (80/40/40 + trueValue=0/neg), Millionenfrage (Bank [3,6,9,10] → 100), Geheim Agent (Rollen exakt n), Same Thought (+100=je +50); INSUFFICIENT_PLAYERS nur Start-/Pause-Gate | Beispiele aus eigener Regel abgeleitet |
| 12-11 | Handoff/Verifikation bereinigen | `handoff.md`, `verification.md` | private absolute Pfade/Zugangskontext entfernt; „Rest: Push/Draft-PR" korrigiert; ID-/Linkchecks als solche benannt; PR11-Snapshot getrennt von main; nach PR11-Merge = erneuter Abgleich (nicht vorweg behauptet) | grep: keine `/Users/`-Pfade |

## Nachbefund-Closure (D–F, 10.10.2026)

| ID | Befund | Datei(en) | Konkrete Änderung | Nachweis |
|---|---|---|---|---|
| D | Viewer-Audio-Standard nicht durchgängig verbindlich (Master §7.23) | `technical-mapping.md` §3.4 (Medien-Default-Tabelle), alle 19 `games/*.md` §13, `games/index.md` (DoD 12) | Gemeinsame Vertragstabelle: neue **Viewer-Audio-Zeile** (kein Mic/Send, hört `MAIN`, nie `TEAM`, Host-Deaktivierung) als verbindlicher V1-Standard; in JEDEM §13-Block eine FEST-Viewer-Zeile (kein Spiel darf abweichen); index-DoD-Punkt 12 | Master §7.23 (RTF-Zeile 1993ff); 19/19 Specs + Vertrag + Index; bestehende korrekte Stellen (Matrix MR-07-18-01/MR-07-23-01, technical-mapping §5.6) unverändert konsistent |
| E | Imposter: Gleichstand/Tie + Host-Sichtbarkeit vor Reveal | `games/imposter.md` §2/§7/§8, `decision-register.md` DEC-SPI-01 | §2: `HOST_PREVIEW=false` = **verbindliche V1-Konfiguration** für mitspielende Hosts (KEINE Vor-REVEAL-Preview-Option); §8 Projektion entsprechend; DEC-SPI-01: „2-Wege-Tie = keine Punkte" ersetzt durch Präzisierung „Tie betrifft nur die Rundengewinnerfrage; feste je-Stimme-Wertung gilt auch bei Gleichstand (FEST, Master §15.4)" | Master §15.4 (Scoring pro Stimme, keine globale Tie-Null); §7-Tie-Grenze (12-03) bleibt gültig und wird vom Register nicht mehr widersprochen |
| F | Jeopardy: „Host mitbuzzer, Vorteil akzeptiert" als Alternative | `decision-register.md` DEC-JEO-01 | Alternative-Spalte: „Host darf mitbuzzen (Vorteil akzeptiert)" **entfernt** und ausdrücklich als nicht zulässige Option gekennzeichnet (Verwaltung ≠ Gameplay-Information, FEST Master §2/§10); empfohlener Vorschlag (Buzzer-Ausschluss in eigenen Runden) bleibt der einzig offenstehende faire Vorschlag | Master-Trennung (FEST); `games/jeopardy.md` §2 war bereits korrekt („keine freigabefähige Alternative") — Register stand im Widerspruch, ist jetzt konsistent |

**Gesamt-Abgleich (Auftrag):** `viewer + audio/mic/kanal/hört/send` über
sämtliche PR12-Dateien durchsucht — die einzigen Abweichungen von §7.23
waren (a) das Fehlen einer verbindlichen Viewer-Default-Aussage in den
Spielspecs (→ D behoben) und (b) keine widersprechenden Stellen in
Matrix/Mapping (MR-07-18-01, MR-07-23-01, §3.4-E, §5.6 stimmten bereits).
`HOST_PREVIEW/Content-Preview/Host sieht` durchsucht: widersprechend nur
`imposter.md` §2/§8 (→ E) und `DEC-SPI-01` (→ E); alle anderen Spiele
(wissensduell, jeopardy, undercover, DDF, higher-lower, timeline,
song-quiz) formulieren bereits korrekt (Host ohne Vor-REVEAL-Content oder
fester `HOST_PREVIEW=false`-Default ohne mitspielenden Host-Vorsprung).
`mitbuzzer/Vorteil akzeptiert` durchsucht: widersprechend nur
`DEC-JEO-01` (→ F). Bereits festgelegte Master-Regeln sind keine erneut
offenen Nutzerentscheidungen.

## Commit-Log (eigener Branch)

| SHA | Etappe | Inhalt |
|---|---|---|
| 604cab1 | A | Worktree/Isolation, Handoff, Master-Extraktion nachweisen |
| 4d231e7 | B | requirements-matrix.md (275 MR-Zeilen + 5 ADD-DDF) |
| 7760b6e | C | technical-mapping.md (Zielmodell) |
| 00d0b66 | C | 19 Spielespezifikationen + games/index.md |
| fcfc48e | D | dependencies-and-parallel-work.md, decision-register.md (RUT-16..18) |
| f9421fc | E | README, verification.md, pr-body.md, Handoff-Finalisierung |
| 6268d6e | E | Push + Draft-PR #12 (https://github.com/joern211/quiz-platform/pull/12) |
| 523c134 | Audit | 12-01/02/03 — Yacht-Wertung (Würfelsumme), Partner-Challenge-Rollen (pro Team), Imposter-Scoring (korrekt votierend) |
| 4189787 | Audit | 12-04/05 — Wer-ist-das-Iststand + Jeopardy-Projektion/Wertung korrigiert |
| 1f94a76 | Audit | 12-06/07 — Entscheidungsregister bereinigt, Matrix atomarisiert |
| a7ff815 | Audit | 12-08/09/10 — Engine-Vertrag + pro-Spiel-Policy, Scope/Integration, widerspruchsfreie Vorschläge |
| (dieser) | Audit | 12-11 — Handoff/Verifikation bereinigt (SHA s. `git log`) |
