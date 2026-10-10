# PR12 — Regelwerk Mapping und V1-Spezifikation (Dokumentations-PR)

**Status:** Vorbereitung/Draft — **nicht** merge-ready. Kein Anwendungscode,
keine Schema-/Migration-/CI-Änderungen. Rein dokumentarisch.

## Was diese PR liefert

Eine vollständige, prüfbare Zuordnung
**Master-Regelwerk → Anforderungen → Module/Verträge → Roadmap-PRs →
Tests → Abnahme** für V1.0 mit **19 Spielen** (18 kanonische Slugs FEST
+ Der Dümmste Fliegt als Nutzerergänzung, Regeln noch offen).

## Dateien

| Datei | Inhalt |
|---|---|
| [requirements-matrix.md](requirements-matrix.md) | **1292 Einzelanforderungen aus 291 fachlichen Herkunftsgruppen**: jede V1-Anforderung mit Quelle, Scope-Klasse (Pflicht/Option/später/offen), Entscheidungsstatus, Ist-Status auf main (mit Referenzen), PR11-Vergleich, Core, Ziel-PR, Abnahmekriterium, Lücke/Decision-ID. Deckt §1–§20 vollständig ab. |
| [requirements-groups.md](requirements-groups.md) | Historische 292 MR-IDs einschließlich Yacht-Split-Index, Originalformulierungen und Herkunftsbefunde; keine atomare Runtime-Abnahme. |
| [technical-mapping.md](technical-mapping.md) | Technisches **Zielmodell** (kein Runtime-Code): Datenmodell, ID-/Zeit-/Revisions-Standards, Command-/Event-/Snapshot-Verträge, alle Game-Cores mit API-Skizzen, Fachbereichs-Mapping, Migration & Recovery, Monitoring, offene technische Optionen. |
| [decision-register.md](decision-register.md) | Offene **fachliche Nutzerentscheidungen** (DEC-DDF-01…06, DEC-<Spiel>-01, DEC-JEO/KAT/WID, DEC-EVT/ACC) getrennt von **Routine-Entscheidungen** (RUT-01…18) + gebündelte Nutzer-Fragenliste. |
| [dependencies-and-parallel-work.md](dependencies-and-parallel-work.md) | Abhängigkeitsgraph PR13–50, harte Voraussetzungen, zentrale Verträge, Dateizuständigkeiten, Worktree-/Branch-Plan, Integrationsreihenfolge, 3-Wochen-Startplan. |
| [games/index.md](games/index.md) | Kanonischer Katalog (19 Spiele) + gemeinsame Spiel-DoD + Konventionen. |
| [games/*.md](games/index.md) | **19 Spielespezifikationen**: feste Regeln (mit Quellenstellen), offene Regeln (mit Decision-IDs), Setup/Content/Phasen/Commands, Wertung, Projektionen/Secrets, Rejoin/Recovery, Results/Stats, Tests. DDF als klar markierter Vorschlag. |

## Quellenstand

| Quelle | Stand | Verwendung |
|---|---|---|
| `Master Regelwerk.rtf` (Stand 28.09.2026) | lokal extrahiert, kein Wrapper-Code ausgeführt (`.work/master-regelwerk-extrahiert.md`, gitignored) | maßgebliche Regelquelle |
| Nutzerergänzung 07.10.2026 | V1.0 = kompletter Master-Scope + Der Dümmste Fliegt (19 Spiele) | ADD-DDF-01 |
| `Online_Quiz_Plattform_PR_Roadmap_1_bis_50.md` (07.10.2026) | neueste grobe Reihenfolge | PR-Nummern als Planplätze |
| `main @ 411a5b7` | gemergter PR10 | **Iststatus** (alle MR-Zeilen) |
| PR11 `1470894` (offener Draft) | gepinnter Snapshot | **separat** als „PR11" markiert, **kein** main-Nachweis |
| Gesamtplan-PDF | historisch | **keine** Ersatzautorität |

## Ist-/Zieltrennung (wichtig)

- **Ist** = nur `main @ 411a5b7` (konkrete Code-/Schema-/Testbefunde).
- **PR11** = nur der gepinnte Commit `1470894`, separat gekennzeichnet;
  nichts davon zählt als main.
- **Ziel** = alles in technical-mapping.md und den Spielespezifikationen
  ist **Zielmodell/Vorschlag**, bis in den jeweiligen PRs umgesetzt.
- IMPLEMENTED nur mit Nachweis; „Typ/Button/Route vorhanden" ≠ Core-DONE;
  „Testdatei vorhanden" ≠ „Test ausgeführt".
- Vorschläge sind **nicht** als beschlossen ausgegeben; offene
  fachliche Entscheidungen bleiben im decision-register.md sichtbar
  und blockieren nur die betroffene Engine.

## Grenzen dieser Vorbereitung

- **Kein** Merge, kein Ready-for-review (erst nach Abnahme + PR11-Abgleich).
- **Keine** Implementierung von PR13+ oder neuen Engines.
- PR11 wird separat in einem eigenen Worktree geprüft; PR12 enthält keine PR11-Runtime-Änderungen.
- Die 15 neuen Spiele + DDF haben jeweils **offene Detailregeln**
  (je 1 Decision-Bündel) — das ist beabsichtigt (Master §18:
  Detailregeln bleiben Rest; keine erfundenen Freigaben).
- Nach dem PR11-Merge müssen SHAs/PR11-Vergleich/Links neu geprüft werden
  (siehe dependencies-and-parallel-work.md §7, Woche 2).
