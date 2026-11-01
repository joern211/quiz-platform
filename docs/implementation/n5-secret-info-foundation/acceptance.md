# N5 — Abnahme (Anforderungen → Nachweis)

Stand: 01.11.2026. Basis `main` @ `c09266b7c7c33eb911e0aa1d3151c5312d0b6cd8`. **N5-Grundlagenpaket umgesetzt / reviewbereit** — nicht „Secret Core für alle Spiele fertig“. 0 neue echte Engine-Verbraucher; Master §13.2 (Core-DoD) offen.

## Prüfläufe (exakter Stand, Befehl, Ergebnis)

Code-Stand der Läufe: Inhalt von `c36e4fc` (danach nur Dokumentation: `c82a839`, `1945b27` und diese Datei). Die Server-/Web-/Build-Läufe liefen auf dem Arbeitsbaum mit dem Inhalt von `c36e4fc`; E2E am Commit `c82a839` (Code identisch).

| Prüfung | Befehl | Ergebnis |
|---|---|---|
| Typecheck | `pnpm typecheck` | Exit 0 |
| Lint | `pnpm lint` | Exit 0 — 0 Fehler, 109 Warnungen (bestehende `no-explicit-any` u. a. in unberührten Dateien; keine neue Warnung in N5-Dateien, `eslint` auf den N5-Dateien ohne Ausgabe) |
| Build | `pnpm build` | Exit 0 (bekannte Chunk-Größen-Warnung der Web-App) |
| Server | `pnpm --filter @quiz/server test` | Exit 0 — **84 Dateien, 1011 Tests** (Ausgangswert N4: 958; +52 N5 [Domain 38 + Vertrag 14] +1 Medien-Regressionstest). Geloggte `ERROR`-Zeilen stammen aus bestehenden, absichtlich fehlerauslösenden Tests. |
| Web | `pnpm --filter @quiz/web test` | Exit 0 — **41 Dateien, 408 Tests** (Ausgangswert 386; +22 `SecretInfoCard`), inkl. `VoteForm.review.test.tsx` |
| E2E (Chromium) | `CI=true pnpm exec playwright test --config=playwright.config.ts --project=chromium` mit frischer SQLite-DB (`prisma migrate deploy` + `db:seed`, `/tmp/test-e2e.db`) | Exit 0 — **45 bestanden** (Ausgangswert 45) |
| Medien-Test gezielt | `vitest run src/media/live.integration.test.ts` | 13/13; die beiden Restart-Tests 8× wiederholt, die „viewer“-Tests 6×: alle grün |
| Browser-Harness `apps/web/harness/n5-secret-info/check.cjs` | Vite-Harness (Port 5199) + `node …/check.cjs` | Exit 0 — 48 Kombinationen (320/390/430/1280 px × hell/dunkel × 6 Akzente) ohne Überlauf, ohne abgeschnittene Elemente, Toggle ≥ 44 px, keine Konsolenfehler; Tastatur, Kontextwechsel, Entzug, Viewer-Sicht, Markup-Text **assertiert**; Screenshots (320 dunkel, 390 hell) angesehen. Danach Harness-Server beendet. **Chromium-Emulation, kein echtes iPhone/Safari.** |
| Mutationsprüfung | gezielt eingebaute Lecks | 5/5 Domain-, 3/4 UI-Mutanten gefangen, 1 äquivalent (`review.md` D) |
| Strip-only | Kindprozess `node --experimental-strip-types` lädt `shared/secretInfo.ts` | im `secretInfo.test.ts` grün |
| GitHub-CI am letzten Head | siehe PR | **nach dem Push zu prüfen** (steht im PR/Abschlussbericht; ein früherer Lauf beweist den letzten Head nicht) |

Nicht ausgeführt: keine. (Die Chromium-E2E-Suite enthält keine N5-Route — es gibt bewusst keine; der N5-Browsernachweis ist der temporäre Harness.)

## Anforderungen → Nachweis

| Auftrag | Nachweis |
|---|---|
| §4 Medien-Test-Race, eigener Commit, nur Test | `277fd34`; `review.md` B; deterministischer Regressionstest „observes a viewer restart in the player view even when the player snapshot arrives after the viewer ACK“ |
| §5 Deal: Discriminator/Version, Scope (Run, Runde, dealId, Revision), begrenzter Teilnehmerkreis, Rollen-IDs, genau eine Rolle je Teilnehmer, Fragmente mit Empfängerkreis, additive öffentliche Freigabe | `secretRoleDeal.test.ts` (Deal-Block); `design.md` §4 |
| §5 Wiederholte Rollen, Wissen unabhängig von Rolle, null/mehrere Fragmente, geteilte Fragmente, Fragment ohne Empfänger, kein Vererben | Test „allows the same role for several participants …“; Projektionsblock („same role / same team“) |
| §6 Strikte Validierung inkl. Laufzeitgrenzen; kein AUTO; nichts repariert; Bounds vor Quervergleich; Eingabe unverändert; Fehlercodes ohne Inhalte | Tests „does not deal …“, „rejects unknown role …“, „enforces the named bounds …“, „rejects a loaded, manipulated state …“ (26 Manipulationen × 3 Pfade), „does not retain …“, „keeps errors free of …“ (12 Fehlerpfade) |
| §7 Scope an jeder Funktion; zweiter Deal unabhängig; opake Revision; Unveränderlichkeit; JSON-Roundtrip/SDK-Replay ohne Uhr/Zufall | Lifecycle-Block: Scope-Test, „keeps a second deal … independent“, „does not let a changed deal keep the same identity“, Roundtrip/Replay-Test mit Spies auf `Date.now`/`Math.random`; Exportlisten-Test (kein Reassign/Unreveal) |
| §8 Projektionen: nur ausdrücklich erlaubtes Wissen; Host/Admin/Team öffnen nichts; Viewer/Display nur Freigegebenes; keine Hinweise vor Freigabe; getrennte Felder; serialisierte Payloads mit Markern | Projektionsblock: 12 Audiences × 3 Stadien (serialisiert auf Marker/IDs/Feldnamen), Host-/Team-/Admin-Test, VIEWER/DISPLAY-Test, „reveals nothing about the amount …“ |
| §9 Selektive Freigabe: explizit, alles-oder-nichts, idempotent, deterministische Ausgabe, kein Unreveal, keine Auto-Reveals | Lifecycle-Block: „releases exactly the selected fragments“, „idempotent“, „rejects an invalid batch as a whole“, „deterministic output order“, „never changes roles … no way to un-release“ |
| §10 UI: eingeklappt, nicht im DOM, Bindung vor Rendern, Kontextwechsel/Entzug/Wiedererhalt, Rerender/Theme stabil, Plaintext, A11y, kein Timer | `SecretInfoCard.test.tsx` (22) + Harness; Mutationen U1–U3 |
| §12 E Kompatibilität: N1–N4-Tests grün; neue private Typen nie Legacy-Antwort/VotingBallot/Spielzustand; Shared-Exports/Strip-only; drei Engines unverändert | Kompatibilitätsblock in `secretRoleDeal.test.ts`; `secretInfo.test.ts` (Strip-only, Import nur `zod`, Exportnamen, Subpath); Gesamtläufe oben (Server 1011, Web 408, E2E 45) |
| §14 Eigenprüfung | `review.md` (Befunde R1–R4, Mutationsprüfung) |
| §15 Dokumentation, ehrliche Abnahme | dieser Ordner; Core-DoD offen; keine Engine-Verfügbarkeit geändert; keine DEC-Regel als entschieden markiert |

## Kein Verbraucher, keine Nachweise, die hier nicht geführt werden
Kein Socket-, Rejoin-, Resync-, Persistenz- oder Prozessneustart-Nachweis (kein Verbraucher, keine Tabelle). Die Medien-Integrationstests und die Chromium-E2E-Suite sind Bestandsprüfungen und beweisen nichts über N5-Geheimhaltung außerhalb der Domain/UI.
