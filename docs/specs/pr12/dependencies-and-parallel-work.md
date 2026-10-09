# PR12 — Abhängigkeitsplan für parallele Arbeit

Basis: Roadmap PR13–50 (geplante Arbeitspakete, Nummern variabel).
**Aktuelle Parallelphase:** A = PR11-Code (feature/wer-ist-das-fusion-media),
B = diese PR12-Dokumentation (docs/pr12-master-spec-preparation),
C = optional: Prüfung eines festen Snapshots. **Keine** zusätzlichen
Implementierungsagenten in dieser Phase.

## 1. Dependency-Graph (gekürzt, echte Abhängigkeiten)

```
PR11 (offen, BETA)
 └─→ PR12 (dieser Draft: Matrix, Mapping, Games, Decisions)
      └─→ PR13 (Standards/Schemas/Permissions/Config)  ← alle Folgenden brauchen
           ├─→ PR14 (Team + Room Core)
           │    ├─→ PR15 (Spielaktionen/Rundensteuerung)
           │    │    ├─→ PR16 (Results/Recovery)
           │    │    │    └─→ PR17 (Content Pools + Editor)
           │    │    │         └─→ PR18 (Review/Import/Qualität/KI)
           │    │    │              └─→ PR19 (Media Audio + Voice Core)
           │    │    │                   └─→ PR20 (Kamera/Broadcast)
           │    │    │                        └─→ PR21 Song · PR31/32/33 (Voice-Spiele)
           │    │    ├─→ PR15 (ebenfalls)
           │    └─→ PR30/31/32 (Team-/Voice-Spiele)
           └─→ PR15 (direkt, Standards)
PR15+16 → PR22–29, 34–35 (Cores-Spiele, ohne Voice)
PR14–18 → PR22–30, 34–35 (ohne Voice)
PR14–20 → PR31–33 (Voice-Spiele)
PR12+PR36-Dependenz → PR36 (DDF, blockiert durch DEC-DDF-*)
PR14–20 + 21–36 → PR37 (Bestands-Spiele auf V1-Verträge)
PR16+37 → PR38 (Events)
PR13–18+38 → PR39 (Accounts)
PR16+37–39 → PR40 (Stats/XP)
PR13–40 → PR41 (Integrität)
PR18–20+38–41 → PR42 (Quotas/Cleanup/Jobs)
PR39–42 → PR43 (Admin/Moderation)
PR19–20+39–43 → PR44 (Hosting/Produktion)
PR42–44 → PR45 (Backup/Restore)
PR41–45 → PR46 (Monitoring/Last/Skalierung)
PR17–46 → PR47 (UX/PWA/Accessibility/Sprachen)
PR12–47 → PR48 (Master-Audit)
PR48 → PR49 (RC/Beta) → PR50 (V1.0)
```

## 2. Harte Voraussetzungen vs. parallele Spezifikation

| Paket | Harte Voraussetzungen | Parallel möglich (Spec/Code) |
|---|---|---|
| PR13 | PR12 (Matrix als Quelle) | — (Basispaket, muss zuerst) |
| PR14 | PR13 | — (Room/Team ist kritisch) |
| PR15 | PR13, PR14 | Cores-Skizzen (dieses Dokument, Abschnitt 4) |
| PR16 | PR13–15 | — |
| PR17 | PR13–16 | Content-Schema-Skizzen je Spiel (games/*.md §5) |
| PR18 | PR17 | Import/Review-Flows (Spec fertig) |
| PR19 | PR14–18, PR11 | Audio-/Voice-Flows (Spec fertig) |
| PR20 | PR19 | Kamera/Broadcast (Spec fertig) |
| PR21 (Song) | PR19–20, DEC-SNG-01 | Spec fertig, Engine blockiert bis Media-Voice + Decision |
| PR22 (Imposter) | PR15–18, DEC-SPI-01 | Spec fertig, Engine blockiert bis Cores + Decision |
| PR23–30, 34, 35 | PR14–18, je DEC-* | Spec fertig, Engines blockiert bis Cores + Decision |
| PR31–33 | PR14–20, je DEC-* | Spec fertig, blockiert bis Voice |
| PR36 (DDF) | PR12–20, **DEC-DDF-01…06** | **Vorschlags-Spec fertig, Engine hart blockiert durch Decisions** |
| PR37 | PR14–20 + 21–36 | — (Integration aller Bestands-Engines) |
| PR38 | PR16, 37 | Event-Schema (Spec fertig) |
| PR39–47 | siehe Graph | Betriebs-Specs fertig |
| PR48 | PR12–47 | Audit-Matrix = diese Matrix (nachgeführt) |

## 3. Gemeinsame Verträge, die vorher stabil sein müssen

Diese Verträge müssen **vor** den jeweiligen Spiele-PRs **einfach und
stabil** existieren (sonst 15× Anpassung):

1. **PR13:** Command-Envelope (`commandId`), Error-Codes,
   protocolVersion, Glossar/Enums, State-Machine-Basis,
   Config-Inheritance, Revisions, Ownership/Scope.
2. **PR14:** Team-Modell + Room-Lifecycle (Zustände, Zugang,
   Ready, Transfer, Ban, Feed, Pause, Abschluss).
3. **PR15:** alle 22 Game-Cores (Timer, Buzzer, Judge, Turn, Tie,
   Matching, Submission, Reveal, Random, Command, Event, State,
   Resync, Recovery, Versioning, Migration, ConfigSnapshot,
   Error/Fallback, Rate-Limit, Metrics, Test-Contract, Invariants,
   Undo, Finalisierung, Next-Action, Round-Transition, Progress,
   Leaderboard, Result-Screen, Notification).
4. **PR16:** ScoreEvent-Ledger, RoundResult, GameResult,
   FINALIZED, Amendment, Recovery-Vollständigkeit.
5. **PR17:** ContentPool/ContentItem (gemeinsames Editor-Framework,
   Scope, Revision, Ready-Standard, Multi-Pool, Snapshot).
6. **PR19:** Media-Visibility (ROOM_TEMP, signed URLs), Audio-Sync,
   Voice Channels.
7. **PR13+16+38+40:** FINALIZED-Results → Events/Stats (einmaliger
   Datenfluss, Amendment-korrekturfähig — Abschnitt 1.2 in
   technical-mapping.md).

**Regel (12-09, kein zirkuläres DONE-Kriterium):** Ein Core gilt erst als
stabil, wenn er die 2-Engine-DoD (§13.2) erfüllt. Der Nachweis wird **früh,
mit dem jeweiligen Core-PR** erbracht — nicht erst bei PR37:
- **PR15:** frühe vertikale Integration von **jeopardy + wissensduell**
  (die Cores nutzen sie bereits teilweise; volle Übernahme ist Teil von
  PR15).
- **PR16:** frühe Migration von **wer-ist-das + jeopardy**.
- **PR37:** konsolidiert dann **alle** Bestands-Engines auf den
  vollständigen Vertrag (technical-mapping §3.4) + V1-Verträge.
Damit ist „≥2 Consumer je Core-PR" ein tatsächlicher, zeitlich **vor PR37**
liegender Nachweis — nicht auf PR37 verwiesen (kein zirkuläres
DONE-Kriterium).

## 4. Genau ein zuständiger Arbeitsbereich je zentraler Datei

| Zentrale Datei/Bereich | Zuständig (exklusiv) |
|---|---|
| Prisma-Schema + Migrationen | PR13 (Basis), danach je PR mit explizitem Schema-Commit (ein PR = eine Migration-Datei, keine parallelen Schema-Edits) |
| Game Registry (`games/registry.ts`) | PR10-Katalog bleibt Referenz; jeder neue Engine-PR registriert sich (1 Datei, Konfliktrisiko hoch → kleine Commits, sofort rebase) |
| Shared-Typen/Enums/Schemas | PR13 (zentr.), danach additive Änderungen nur im zugeordneten Core-PR |
| Manifest/Katalog-Datei | **PR36 (DDF-Engine-PR)** — die DDF-Katalog-/Manifest-Änderung ist **kein** PR12-Runtime-Auftrag, auch nicht nach Slug-Bestätigung (DEC-DDF-01); PR12 ist **docs-only** und hält den DDF-Slug als getrennten Vorschlag (12-09); sonst nur PR37 |
| CI-Konfiguration | PR4 (Basis), additive Changes je PR (kein Refactor in Feature-PRs) |
| `docs/` (gemeinsame Doku) | je PR seinen Bereich (docs/<paket>/) |
| Medien-Verarbeitung | PR11 (Grundlage) → PR19 (Ausbau) |

## 5. Worktree-/Branch-Plan (getrennte Umgebungen)

| Arbeitsbereich | Branch (Beispiel) | Worktree | DB/Medien/Ports |
|---|---|---|---|
| PR11 (Code, anderer Chat) | `feature/wer-ist-das-fusion-media` | `quiz-platform-pr11` | dev-Default (3001/5173) |
| **PR12 (dieser Chat, Doku)** | `docs/pr12-master-spec-preparation` | `quiz-platform-pr12-spec` | **keine** (kein Code, keine Tests außer lesen) |
| PR13 (später) | `feature/pr13-standards` | `quiz-platform-pr13` | eigene SQLite-Datei, Port 3101 |
| PR14 (später) | `feature/pr14-team-room` | `quiz-platform-pr14` | eigene DB, Port 3102 |
| PR15 (später) | `feature/pr15-game-actions` | `quiz-platform-pr15` | eigene DB, Port 3103 |
| … | je PR | je PR | je PR eigene DB/Ports |

**Regeln:**
- Jeder schreibende Arbeitsbereich = eigener Worktree + Branch
  (geschwistert, nie im fremden Ordner).
- Jede ausführbare Testumgebung: **eigene** DB-Datei + Medienordner +
  Ports (kein geteilter Dev-Server).
- Kein ständiger Merge von main in Feature-Branches — nur vor
  Abschluss/PR (Rebase auf aktuellen main).
- PR12 (dieser Chat) hat **keine** Laufzeit-Tests (Doku-PR); wenn
  eine konkrete Ist-Annahme geklärt werden muss: eigener,
  temporärer Checkout + eigene DB/Ports (nicht die PR11-Instanz).

## 6. Integrationsreihenfolge + Regression

1. **PR13** → main (Basis-Standards).
2. **PR14** → main (Team/Room).
3. **PR15** → main (Cores). **Frühe Consumer-Migration (2-Engine-DoD):
   jeopardy + wissensduell** (12-09). Regression: bestehende 3 Engines
   (wissensduell/jeopardy/wer-ist-das) müssen grünes CI behalten.
4. **PR16** → main (Results/Recovery). **Frühe Consumer-Migration
   (2-Engine-DoD): wer-ist-das + jeopardy** (12-09). Regression: E2E-Suite.
5. **PR17/18** → main (Content). Regression: Content-Integration.
6. **PR19/20** → main (Media/Voice/Broadcast).
7. **Spiele-PRs (21–36)** — können **parallel** auf den stabilen
   Cores laufen (jeder eigener Worktree), Integration in
   kleineren Schüben (2–3 Spiele gleichzeitig, je 1 PR).
   Regression nach jedem Merge: Core-Tests + betroffene Engine +
   Catalog-Consistency.
8. **PR37** → main (Bestands-Spiele auf V1-Verträge).
9. **PR38** → main (Events).
10. **PR39–47** je Graph.
11. **PR48** (Audit) → **PR49** (RC) → **PR50** (Release).

**Konfliktrisiko (höchste Dichte):** `games/registry.ts`,
Prisma-Schema, `shared/`-Typen, CI-Dateien. Gegenmaßnahmen:
kleine, fokussierte Commits; Schema-Änderungen nur im
zuständigen PR; Rebase vor PR-Submission; Catalog-Guard-Test
(prüft 18 Manifests — bei DDF-Zusatz: 19, erst nach DEC-DDF-01).

## 7. Aktueller 3-Wochen-Startplan (Konkret, max. 2 schreibend + 1 Prüfer)

| Woche | A (PR11-Code) | B (PR12-Doku) | C (Prüfer, optional) |
|---|---|---|---|
| 1 | PR11 fertigstellen (UI v2 + Abschlussprüfung) | Etappe E: Validierung, README, verification.md, pr-body.md, Draft-PR | PR11-Snapshot prüfen (1470894): Media-Visibility, Composite, Setup v2, Secrets — Abgleich gegen requirements-matrix PR11-Spalte |
| 2 | PR11 → merge-ready (nach Abnahme) | Nach PR11-Merge: SHAs aktualisieren, PR11-Vergleich neu klassifizieren, Doku-Links validieren | — |
| 3 | PR13 vorbereiten (Standards) | PR12 → Ready (nach Abnahme + Abgleich) | — |

**Kein Merge** von PR11 oder PR12 durch diesen Chat. PR12 bleibt
Draft bis Abnahme. PR13 startet erst nach PR12-Ready.

## 8. Handoff-Anforderungen (pro PR)

Jeder PR-Chat führt `docs/implementation/<pr>/handoff.md`:
Ziel, Basis-/Head-SHA, erfüllte Regelpunkte (MR-IDs), offene
Aufgaben, Teststand, nächster Schritt. Vor jedem neuen PR:
aktuelle Matrix prüfen (welche MR-IDs schon abgedeckt sind).
Globale Regression hat Vorrang vor lokalen Sonderlösungen.
