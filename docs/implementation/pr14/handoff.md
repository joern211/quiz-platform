# BASIS-STANDARDS (Planplatz „PR13") — Handoff

Arbeitspaketname **BASIS-STANDARDS** = Roadmap-Planplatz „PR13: Globale Schemas Rechte und Konfiguration".
Tatsächlicher GitHub-PR: **#14** (Nummer wird von GitHub vergeben; dieser Planplatz war nie umgesetzt —
GitHub-PR #13 war nur der kleine fs.rm-Retry-Fix in `fusion.integration.test.ts`).
Nächster Planplatz **PR14 = TEAM-ROOM** bleibt offen und darf nicht als erledigt erscheinen.

| Feld | Wert |
|---|---|
| Paketname | BASIS-STANDARDS |
| Repo | github.com/joern211/quiz-platform |
| Branch | `feature/pr14-foundation-standards` |
| Worktree | `~/quiz-platform-pr14` |
| Basis (main) | `3dba9ff5cc19e53c0f6d764b5f41f5880ff92e52` (PR #13 Merge) |
| Gemergt vorab | PR11 `d52fa52`, PR12 `afef936`, PR13 `3dba9ff` |
| Node / Paketmanager | Node 22 (`.nvmrc`), pnpm 9.12.0 |
| Letzte Sicherung | (wird nach jedem Teilziel aktualisiert — s. unten) |

## Wiederaufnahme-Aktion

1. `cd ~/quiz-platform-pr14 && git status && git log --oneline origin/feature/pr14-foundation-standards..HEAD` — ungesicherte Arbeit erkennen.
2. Letzten Abschnitt „Checkpoint" unten lesen; dort steht **genau die nächste Aktion**.
3. Keine erneute Komplett-Bestandsaufnahme: Istabgleich steht in `acceptance.md` (Abschnitt „Istabgleich") und in `docs/specs/pr12/` (Abgleich-Notizen).

## Stand der Etappen

| Etappe | Inhalt | Status |
|---|---|---|
| 0 | Bestandsaufnahme (main, CI, Code-Pfade, Baseline-Tests) | IN_PROGRESS |
| 0b | PR12-Doku-Abgleich nach PR11/12/13-Merge + Arbeitspaket-Zuordnung | PENDING |
| A | Rollen/Begriffe (HOST), Schemas, Bestandsmigration | PENDING |
| D | Fehler-/Result-Vertrag (vor B/C, da von beiden genutzt) | PENDING |
| B | Permission-Vertrag + Grants + Guard-Integration | PENDING |
| C | Command-Envelope + Receipts + Replay-Sicherheit (3 Engines) | PENDING |
| E | Config-Resolver + Start-Snapshot + Revision/CAS | PENDING |
| F | Manifest-Vollständigung + Contract-Testgerüst (≥2 Engines) | PENDING |
| G | Abschlussprüfung (Migration frisch+Bestand, alle Skripte, E2E, Gegenproben) | PENDING |
| H | Push, Draft-PR, pr-body.md, CI/E2E am finalen Head, Abschlussbericht | PENDING |

> Interne Reihenfolge A→D→B→C→E→F: D (Fehlervertrag) wird vor B/C gebaut, weil beide
> auf `code/messageKey/traceId` aufbauen; B vor C, weil Command-Guards den Permission-Core brauchen.

## Checkpoint

- **Letzter gesicherter Commit:** (noch keiner — Basis `3dba9ff`, Arbeitsbaum sauber, `pnpm install` erledigt)
- **Ungesicherte Änderungen:** —
- **Tests:** Baseline läuft noch (Ergebnis wird hier eingetragen).
- **Offene Punkte:** —
- **Genau die nächste Aktion:** Baseline-Testlauf (`pnpm --filter @quiz/server test`, `pnpm --filter @quiz/web test`, typecheck/lint/build) auf frisch gefetchtem main ausführen und Zahlen in `verification.md` eintragen; dann Etappe 0b (PR12-Abgleich).
