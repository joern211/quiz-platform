# PR12 — Main-Abgleich & Arbeitspaket-Zuordnung (datierter Nachtrag)

**Nachtrags-Datum:** 2026-10-15 · **Auslöser:** Audit PR14, Punkt 14-07 (P2).
**Gültigkeit:** Dieser Nachtrag aktualisiert den *Iststand* der hier zitierten
Basis-SHAs. Er ist **kein** Umbruch der atomaren Matrixzeilen — diese bleiben
beim historischen Befundstand (main `@ 411a5b7` = PR10), weil eine
Zeilen-für-Zeilen-Neuabnahme nur mit Einzelbeleg je Zeile erfolgen darf
(Regel: „atomare Matrixstatus nur mit Einzelbelegen aktualisieren"). Der
Nachtrag dient dazu, dass keine veraltete Basis-Referenz mehr als
*tatsächlicher* Iststand gelesen wird.

## 1. Tatsächlicher Merge-/Iststand (abgeprüft am 2026-10-15)

| Arbeitspaket (stabiles ID) | Roadmap-Planplatz | Tatsächlicher GitHub-PR | Merge auf `main` | Merge-SHA |
|---|---|---|---|---|
| PR10 — Kanonischer Spielekatalog & Slug-Migration | PR10 | #10 | ja | `411a5b783e5857bca5b208598fade43affc108b5` |
| PR11 — „Wer ist das?" Composite + Medien-Geheimhaltung (BETA) | PR11 | #11 | **ja** (früher „offener Draft") | `d52fa52` |
| PR12 — Regelwerk Mapping + V1-Spezifikation (dieses Paket) | PR12 | #12 | **ja** (früher „Vorbereitung/Draft") | `afef936` |
| PR13 — Standards/Schemas/Permissions/Config (kleiner fs.rm-Retry-Fix) | PR13 | #13 | **ja** (aktueller main-Head) | `3dba9ff5cc19e53c0f6d764b5f41f5880ff92e52` |
| BASIS-STANDARDS — Schemas/Rechte/Config (dieses Handoff) | Planplatz „PR13" (nie umgesetzt) | **#14** | **offen, DRAFT** | — |
| TEAM-ROOM — Room/Team-Core | Planplatz PR14 | (noch offen) | offen | — |

> **Klärung Planplatz vs. GitHub-Nummer (Audit 14-07):** Die Roadmap-Nummern
> sind *Planplätze*; GitHub vergibt die echte PR-Nummer unabhängig davon.
> Konsequent getrennt: **Planplatz „PR13"** (BASIS-STANDARDS) = **GitHub-PR #14**;
> **Planplatz PR14** (TEAM-ROOM) ist ein *anderes*, offenes Paket und darf nicht
> mit PR #14 verwechselt oder als erledigt gelesen werden.

## 2. Historische Basis-Referenzen (datiert, bewusst nicht umgebrochen)

| Referenz im PR12-Körper | Ursprüngliche Bedeutung | Tatsächlicher Iststand (2026-10-15) |
|---|---|---|
| `main @ 411a5b7` („Iststatus", alle MR-Zeilen) | gemergter PR10, 2026-10-04 | **veraltet als „aktueller main"**: main steht jetzt bei `3dba9ff` (PR13). Die MR-Zeilen-Spalten „Ist"/„Referenzen" gelten weiterhin *für den Snapshot `411a5b7`* und sind damit ein **historischer, datierter Befund**, kein Live-Ist. |
| PR11 `1470894` („offener Draft", Spalte „PR11") | gepinnter PR11-Snapshot | PR11 ist **gemerged** (Merge-SHA `d52fa52`). `1470894` bleibt der *gepinnte Vergleichs-Snapshot*; der gemergte PR11-Code (`d52fa52`) weicht um 33 Dateien ab (u. a. `schema.prisma`, `weristdas/composite.ts`). |

**Konsequenz für die Lesart:** Bis ein zeilenweiser Neubeleg durchgeführt ist,
beschreibt die Matrix den *Befund auf dem Snapshot `411a5b7`/`1470894`* — das
bleibt korrekt und nachvollziehbar. Es darf aber **nicht** als „Ist auf aktuellem
main (`3dba9ff`)" verstanden werden. Ein solcher Live-Abgleich (PR11 gemergt +
PR12/PR13 gemergt) ist ein **benannter Folgeauftrag** (siehe README §„Grenzen",
Punkt „Nach dem PR11-Merge … neu prüfen") und in diesem PR **nicht** ausgeführt.

## 3. Was hier bewusst NICHT geändert wurde

- Keine der 1292 atomaren `-Axx`-Zeilen in `requirements-matrix.md` wurde
  ohne Einzelbeleg umgeschrieben (Regel: atomare Status nur mit Einzelbelegen).
- Keine Spielespezifikation (`games/*.md`) wurde an den PR11-Merge
  „nachgezogen", weil das eine je-Engine-Neuabnahme wäre.
- Die Ziel-PR-Zuordnungen (PR13+ als *Planplätze*) bleiben unverändert; sie sind
  Zielmodell, kein Ist.

## 4. Beleg (Abgleichsbefehl)

```
git log --oneline origin/main            # 3dba9ff … (#13) … afef936 (#12) … d52fa52 (#11) … 411a5b7 (#10)
git merge-base --is-ancestor d52fa52 origin/main   # PR11 ON main
git merge-base --is-ancestor afef936 origin/main   # PR12 ON main
git merge-base --is-ancestor 3dba9ff origin/main   # PR13 ON main (Head)
git diff --stat 1470894 d52fa52           # 33 Dateien (gepinnter Snapshot vs. gemergter PR11)
```
