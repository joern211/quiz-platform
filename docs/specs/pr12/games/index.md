# PR12 — Spielespezifikationen (19 Spiele)

Kanonischer Katalog gemäß MASTER-REGELWERK §14 + Nutzerergänzung 07.10.2026
(Der Dümmste Fliegt). **Diese Spezifikationen ändern den Runtime-Katalog
nicht** — sie sind Zielmodell für PR21–36 (neue Engines) und PR37
(Bestands-Engines auf vollständige V1-Verträge).

| # | Spiel | Slug | Status main (411a5b7) | Datei |
|---|---|---|---|---|
| 1 | Wissensduell | `wissensduell` | AVAILABLE (MVP) | [wissensduell.md](wissensduell.md) |
| 2 | Jeopardy | `jeopardy` | AVAILABLE (MVP) | [jeopardy.md](jeopardy.md) |
| 3 | Wer ist das? | `wer-ist-das` | BETA (PR11 offen) | [wer-ist-das.md](wer-ist-das.md) |
| 4 | Imposter | `imposter` | PLANNED | [imposter.md](imposter.md) |
| 5 | Erkenne den Song | `song-quiz` | PLANNED | [song-quiz.md](song-quiz.md) |
| 6 | Last Man Standing | `last-man-standing` | PLANNED | [last-man-standing.md](last-man-standing.md) |
| 7 | Higher or Lower | `higher-lower` | PLANNED | [higher-lower.md](higher-lower.md) |
| 8 | Timeline | `timeline` | PLANNED | [timeline.md](timeline.md) |
| 9 | Wie weit gehst du? | `partner-challenge` | PLANNED | [partner-challenge.md](partner-challenge.md) |
| 10 | Stadt, Land, Fluss | `stadt-land-fluss` | PLANNED | [stadt-land-fluss.md](stadt-land-fluss.md) |
| 11 | Gleicher Gedanke | `same-thought` | PLANNED | [same-thought.md](same-thought.md) |
| 12 | Schätz mal | `schaetz-mal` | PLANNED | [schaetz-mal.md](schaetz-mal.md) |
| 13 | Millionenfrage | `millionenfrage` | PLANNED | [millionenfrage.md](millionenfrage.md) |
| 14 | Wahr oder Fake? | `wahr-oder-fake` | PLANNED | [wahr-oder-fake.md](wahr-oder-fake.md) |
| 15 | Undercover | `undercover` | PLANNED | [undercover.md](undercover.md) |
| 16 | Raus damit! | `board-race` | PLANNED | [board-race.md](board-race.md) |
| 17 | Geheim Agent | `secret-agent` | PLANNED | [secret-agent.md](secret-agent.md) |
| 18 | Yacht | `yacht` | PLANNED (Regeln vollständig fest) | [yacht.md](yacht.md) |
| 19 | Der Dümmste Fliegt | `der-duemmste-fliegt` **(Slug-Vorschlag, zu bestätigen: DEC-DDF-01)** | Nutzerergänzung, Regeln offen | [der-duemmste-fliegt-vorschlag.md](der-duemmste-fliegt-vorschlag.md) |

## Gemeinsame Spiel-DoD (Master §13.1, §5.28)

Jede Spezifikation endet mit demselben verbindlichen DoD-Block:

1. GameManifest (vollständig, §5.3) + GameEngineContract (vollständig, §5.2)
2. Content-/Editor-Schema (game-spezifisch, über Shared Editor Framework)
3. Quick Setup (≥1 SYSTEM-Quick-Template, §6.50/6.51)
4. Projektionen: HOST / PLAYER / (TEAM) / VIEWER / DISPLAY
5. Rejoin/Resync/Recovery (inkl. Geräteübernahme, Host-Ausfall)
6. Secret-/Visibility-Schutz (automatisierte Leak-Prüfung, PR41)
7. Result-/Stats-Integration (RoundResult/GameResult, FINALIZED)
8. Error/Fallback-Vertrag (§5.25)
9. Contract-Tests: 10 Pflichttests (Start, komplette Runde, GAME_END,
   Rejoin, Resync, Pause/Resume, ungültige Commands, Duplicate Commands,
   Recovery, Secrets/Visibility)
10. CI vollständig grün, keine übersprungenen Pflicht-Tests
11. **Gemeinsamer Engine-Vertrag (12-08):** `games/<slug>.md` referenziert
    `technical-mapping.md §3.4` (Zustandsmaschine inkl. geerbtem
    `RESULT_REVIEW`, Command-Guards, Projektionen/`availableActions`,
    Persistenz/Version/Recovery, Medien-/Voice-/Camera-/Mic-/Display-
    Defaults) und ergänzt **nur** die engine-spezifischen Abweichungen im
    §13-Block der eigenen Spec.

`AVAILABLE` erst nach 1–11; `BETA` nur mit dokumentierten nichtkritischen
Einschränkungen. Jede Engine nutzt mindestens die Cores, die in ihrer
Spezifikation „verwendet" sind — diese Cores erfüllen damit (mit je einer
zweiten Engine) die 2-Engine-DoD aus §13.2.

## Konventionen in den Spieldokumenten

- **FEST** = im Master festgelegt (Quellenstelle angegeben) — nicht änderbar
  ohne Nutzerentscheidung.
- **VORSCHLAG** = PR12-Entwurf mit Decision-ID (DEC-…); blockiert nur die
  betroffene Engine-Implementierung, nicht die übrige Roadmap.
- **OFFEN** = echte Nutzerentscheidung fehlt.
- **§13 (Pflicht, 12-08):** jede Spec endet mit dem Block
  „Engine-Vertrag, Late Join & Rollen-Policy" — engine-spezifische
  Guards, Late-Join-/Ausscheidungs-/Teamrollen-Policy,
  Voice-/Camera-/Mic-/Display-Abweichungen und die
  `RESULT_REVIEW`-Kennzeichnung (ausgewiesen oder geerbt).
- Setup-/State-Beispiele sind Zielmodell-Schemata (kein Runtime-Code).
- „Host" = Host-Rolle nach G1-Migration (begrifflich: MODERATOR in main).
