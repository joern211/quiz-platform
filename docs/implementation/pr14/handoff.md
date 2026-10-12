# BASIS-STANDARDS (Planplatz „PR13\") — Handoff

Arbeitspaketname **BASIS-STANDARDS** = Roadmap-Planplatz „PR13: Globale Schemas Rechte und Konfiguration\".
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
| Node / Paketmanager | Node 26.7.0 (Hermes-Session; Projekt-`.nvmrc` sagt 22), pnpm 9.12.0 |
| **PR-Zustand** | **Draft — nicht mergen, nicht Ready-for-review** (Nutzer prüft und merge selbst) |
| Letzte Sicherung | Stage-2-Commit (Code+Doku) auf `feature/pr14-foundation-standards`, gepusht |

## Wiederaufnahme-Aktion

1. `cd ~/quiz-platform-pr14 && git status && git log --oneline -3` — Stand prüfen (Soll: `git status` sauber, letzter Commit = Stage-2 „…Abnahme A–F + volle Regression + Doku").
2. `docs/implementation/pr14/{acceptance,verification,handoff}.md` lesen — dort stehen Ist, Belege und die (wenigen) offenen Punkte.
3. **PR ist DRAFT.** Nicht mergen, nicht Ready-for-review. Nutzer prüft + merge selbst.

## Stand der Etappen (final)

| Etappe | Inhalt | Status |
|---|---|---|
| 0 | Bestandsaufnahme (main, CI, Code-Pfade, Baseline-Tests) | DONE (Baseline 283/283) |
| 0b | PR12-Doku-Abgleich + Arbeitspaket-Zuordnung | DONE (acceptance.md „Istabgleich\") |
| A | Rollen/Begriffe (HOST), Schemas, Bestandsmigration | VERIFIED (8/8) |
| D | Fehler-/Result-Vertrag (AppError, Wire-Code-Mapping) | VERIFIED |
| B | Permission-Vertrag + Grants + Guard-Integration | VERIFIED (4/4) |
| C | Command-Envelope + Receipts + Replay-Sicherheit | VERIFIED (6/6) |
| E | Config-Resolver + Start-Snapshot + Revision/CAS | VERIFIED (3/3) |
| F | Manifest-Vollständigung + Contract-Testgerüst (≥2 Engines) | VERIFIED (8/8, Geo+Jeopardy) |
| G | Abschlussprüfung (Migration, alle Skripte, E2E, Gegenproben) | DONE (Regression final, s. verification.md) |
| H | Push, Draft-PR, pr-body.md, CI/E2E am finalen Head, Abschlussbericht | Code+Doku gepusht, Draft-PR + pr-body.md erstellt; **CI am finalen Head = nach Push zu lesen** (Draft, kein Merge) |

> Interne Reihenfolge A→D→B→C→E→F wurde eingehalten (D vor B/C, B vor C).

## Checkpoint (final)

- **Letzter gesicherter Commit:** Stage-2 auf `feature/pr14-foundation-standards` (gepusht). Stage-1 = `1097cb8` (Doku + Schemas + Migration + Manifest).
- **Ungesicherte Änderungen:** keine (Arbeitsbaum nach Stage-2-Commit sauber).
- **Tests (finaler Stand):** typecheck ✓ · lint 0 Fehler ✓ · build ✓ · **Server 312/312** (35 Dateien) ✓ · **Web 52/52** ✓ · **E2E 17/18** (1 rot = WID W1–W10).
- **E2E-Befund (offen, aber nicht PR-Regression):** WID `W1-W10` (`weristdas-e2e.spec.ts`) schlägt isoliert **auf beiden Heads** (`3dba9ff` Basis **und** PR-Head) fehl — 30 s-Timeout / Browser-Context-Abbruch in der Cleanup-Zeile (144:15), keine Game-Logik-Assertion. Vorbestehend/umgebungsbedingt (4 Kontexte + 2 Sharp-Composites + Vite-Cold-Compile; Test dokumentiert selbst die >30 s-Kaltlauf-Grenze). → **kein PR14-Regression**; alle 17 übrigen E2E (Geo G4-* + Jeopardy J1–J10, über die neuen Guard/Receipt/Envelope-Flows) grün. Details + Kontroll-Experiment in `verification.md`.
- **Offene Punkte:** (1) CI-Ergebnis am exakt gleichen finalen Head steht nach Push noch aus (Draft-PR, kein Merge) — nach Push in der PR zu lesen. (2) Gekennzeichneter Folgebereich (nicht in diesem PR, nicht als erledigt): volles Co-Host-UI/Room-Settings, TEAM-ROOM (Planplatz PR14), Display-Bedienflow, Config-Editor-UI, Event-/RoundTransition-/Finalisierungs-Architektur, Receipt-GC (Storage-GC).
- **Genau die nächste Aktion:** PR ist fertig als **Draft** gepusht (pr-body.md + Doku aktuell). Nutzer prüft + merge selbst. Bei Wiederaufnahme: CI am finalen Head in der PR lesen; falls grün, PR-Status bleibt Draft, bis der Nutzer entscheidet.
