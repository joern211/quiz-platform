# PR12: Regelwerk Mapping und V1-Spezifikation für 19 Spiele vorbereiten

## Problem und Ziel

V1.0 umfasst das vollständige Master-Regelwerk (Stand 28.09.2026) plus
**Der Dümmste Fliegt** als 19. Spiel (Nutzerergänzung 07.10.2026).
Bislang gibt es keine zentrale, prüfbare Zuordnung
**Regelwerk → Anforderungen → Module/Verträge → Roadmap-PRs → Tests →
Abnahme**. Ohne diese Matrix drohen unbemerkte Regelwidersprüche,
doppelte Verantwortung über PR-Grenzen und ein Audit (PR48) ohne
Vollständigkeitsnachweis.

**Ziel dieser PR:** Die vollständige Vorbereitung als
Dokumentations-/Spezifikations-PR — eine Anforderungsmatrix mit
stabilen IDs, ein technisches Zielmodell, Spezifikationen für alle
19 Spiele, ein Entscheidungsregister und ein Abhängigkeitsplan für
parallele Arbeit.

## Umfang: reine Dokumentation

- **Nur** neue Dateien unter `docs/implementation/pr12/` und
  `docs/specs/pr12/`.
- **Kein** Anwendungscode, keine Shared-Types, keine Registry-Änderung,
  kein Prisma-Schema, keine Migrationen, keine package-/Lockfile-/
  CI-Änderungen, keine gemeinsamen Handoff-Dateien.
- Kein Merge-Kandidat: Draft bis zur Abnahme.

## Quellen und verwendete Stände

| Quelle | SHA/Stand |
|---|---|
| Basis (Iststatus) | `main @ 411a5b7` (gemergter PR10) |
| PR11-Vergleich | gepinnter Snapshot `1470894` (offener Draft, **kein** main-Nachweis) |
| Master Regelwerk | RTF Stand 28.09.2026 (vollständig extrahiert, kein Wrapper-Code ausgeführt) |
| Roadmap | `Online_Quiz_Plattform_PR_Roadmap_1_bis_50.md` (07.10.2026) |
| Nutzerergänzung | 07.10.2026: V1.0 = Master + DDF (19 Spiele) |

Ist-/Zieltrennung: „Ist" = nur main; „PR11" = nur der gepinnte
Commit (separat markiert); „Ziel" = Zielmodell/Vorschlag bis Umsetzung.
Vorschläge sind **nicht** als beschlossen ausgegeben.

## Fertige Inhalte

- **requirements-matrix.md**: 275 MR-IDs (+ ADD-DDF-Zeilen) über §1–§20,
  jede mit Quelle, Scope-Klasse, Entscheidungsstatus, Ist-Status mit
  Referenzen, PR11-Vergleich, Core, Ziel-PR, Abnahmekriterium.
- **technical-mapping.md**: Datenmodell (bestehend + Ziel), Standards
  (IDs/Zeit/Units/Revisions/Error-Codes/protocolVersion),
  Command-/Event-/Snapshot-Verträge, 22+ Game-Cores mit API-Skizzen,
  Fachbereichs-Mapping, Migration & Recovery, Datenfluss
  FINALIZED → Events/Stats/Usage/XP/Achievements (eine Ledger-Quelle,
  Amendment-korrekturfähig — keine fünf Punktesysteme).
- **decision-register.md**: 6 DDF-Entscheidungen + 15
  Spiel-Bündel + Bestands-Spiele + Event/Accounts; 18
  Routine-Entscheidungen (aus Regeln abgeleitet); gebündelte
  Nutzer-Fragenliste.
- **dependencies-and-parallel-work.md**: Dependency-Graph PR13–50,
  zentrale Verträge, exklusive Dateizuständigkeiten, Worktree-/
  Branch-/Port-Plan, Integrationsreihenfolge, 3-Wochen-Startplan.
- **games/**: Index + 19 Spielespezifikationen (18 FEST-Slugs,
  DDF als klar markierter Vorschlag mit DEC-DDF-01…06).

## Offene fachliche Entscheidungen (blockieren nur die betroffene Engine)

1. **Der Dümmste Fliegt** (DEC-DDF-01…06): Slug, Mechanik,
   Fragenmodell, Ties/Nichtabgabe, Punkte, Ausschluss-Verhalten.
2. **15 neue Engines** (je 1 Bündel, DEC-<Spiel>-01): Detailwertung,
   Edge-Cases, min/max Spieler — Vorschläge mit Defaults stehen in
   den Spieledokumenten.
3. **Bestands-Spiele** (DEC-JEO-01…03, DEC-KAT-01/02, DEC-WID-01…03):
   Host-Mitspiel-Details, Auto-Reveal, Reveal-Sichtbarkeit.
4. **Event/Accounts** (DEC-EVT-01, DEC-ACC-01): Bonus-Spiele/Joker,
   Account-Pflicht.

## Ausgeführte Validierung (Details: `docs/implementation/pr12/verification.md`)

- `git diff --check` sauber; nur freigegebene Doku-Pfade geändert.
- Alle relativen Doku-Links vorhanden.
- 19 Games eindeutig; 18 kanonische Slugs konsistent; DDF-Slug als
  Vorschlag; keine Geo/Allgemeinwissen-Doppelzählung.
- 275/275 MR-IDs und 57/57 Decision-/Routine-/ADD-DDF-IDs konsistent
  (referenziert = definiert).
- Alle Master-Abschnitte §1–§20 abgedeckt; jede V1-Anforderung hat
  Zielpaket + Abnahmekriterium + Testplanung.
- Keine App-/E2E-Tests ausgeführt (Doku-PR, keine Code-Änderung);
  bestehende CI-Ergebnisse nur gelesen, nicht neu ausgeführt.

## Parallelität zu PR11 und späterer Abgleich

Diese PR läuft parallel zum PR11-Code in einem eigenen, dauerhaft
isolierten Worktree/Branch. PR11 wurde ausschließlich als gepinnter
Commit-Snapshot gelesen — keine Änderung, kein Merge, kein
Ready-for-review. **Nach dem PR11-Merge** müssen diese Dokumente
abgeglichen werden: Quellen-SHAs aktualisieren, PR11-Vergleichspunkte
neu klassifizieren (B → main/Ist), neue Lücken prüfen, Links erneut
validieren. Der Auditstand bleibt historisch nachvollziehbar.
