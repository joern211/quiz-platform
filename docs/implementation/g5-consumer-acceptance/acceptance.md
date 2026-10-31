# G5 — Abnahme (Ausführung und Ergebnisse)

Produktstand der Schlussabnahme: `8129a157f43b03ade20670a9a62c44b3607d3295` (Base main `bafbc61`). Danach nur: eine Testkorrektur in `g5-bedienung-e2e.spec.ts` (`console.info` → Annotation, entfernt die einzige neue Lintwarnung; Test danach einzeln erneut grün) und Doku. Produktcode (`apps/web/src`, `apps/server/src` ohne Tests) ist danach unverändert. Maßgeblich für den Head ist die GitHub-CI im PR; ältere Läufe gelten nicht.
Umgebung: Node v22.23.4, pnpm 9.12.0, frozen Lockfile, Prisma generiert, ffmpeg, Playwright-Chromium (vorinstalliert), temporäre SQLite-DBs (`/tmp/quiz-server-test.db`, `/tmp/test-e2e.db`, gemäß `.github/workflows/ci.yml`).

| Befehl | Ergebnis am Produktstand |
| --- | --- |
| `pnpm typecheck` | grün |
| `pnpm lint` | 0 Fehler, 110 Warnungen → nach der Testkorrektur **109** (wie Base) |
| `pnpm build` | grün |
| `pnpm --filter @quiz/server test` | 74 Dateien, **721** Tests grün (Base-Lauf: 708/710, 2 rot) |
| `pnpm --filter @quiz/web test` | 34 Dateien, **184** Tests grün (Base 178) |
| Playwright chromium (Seed gemäß CI) | **36** grün (Base 34; neu: M4b, G5-B1) |

Nicht gesondert ausgeführt: weitere Doku-/Schema-Skripte (über die obigen hinaus im Repo nicht gesucht).

## Fünf PR15–19-Schwerpunkte
Belege in [matrix.md](matrix.md) §2 und [review.md](review.md): 7.1 Admission (neuer Test ×3), 7.2 Viewer-Kapazität (bestehend), 7.3 Recovery-Evidenz (neuer Gegenfall), 7.4 Null Punkte (UI-Test neu, G4P bestehend), 7.5 Medien-Neustart beidseitig (M4 Empfänger, **M4b Sender**).

## Drei Verbraucher
Pflichtfälle Master §5.28 je Engine: Zuordnung in [matrix.md](matrix.md) §3 auf bestehende und neue Tests. **WID läuft jetzt auch durch die gemeinsame Contract-Suite.** Eine vollständige neue manuelle Durchspielung jeder Rollen-/Enginekombination wurde nicht durchgeführt (nicht verlangt); eine Runde Wissensduell läuft auf 360 px im Browser (G5-B1).

## Gemeinsame Bedienung (Auftrag §9)
| Punkt | Ergebnis |
| --- | --- |
| Gesperrt bei fehlendem Recht/falscher Phase, verständlich | Core-Read-Ablehnung unterscheidet jetzt RATE_LIMITED / Rechteentzug / Fehler mit sichtbarem Hinweis |
| Erreichbarer erneuter Lese-Weg | „Erneut laden“ (alle fünf Seiten) + höchstens 3 automatische Re-Reads |
| Verspäteter ACK nach Socket-/Routenwechsel | verworfen (`useGameCore.test` 3) |
| Doppelte Verwaltungsaktion Panel/Seite | `CoreReadNotice` nicht im RoomPanel; kein zweites Steuerelement |
| Kleiner Bildschirm / Namen | G5-B1 (Wissensduell, 360×640) |
| Read-Last | 4 Reads je Zustandswechsel und Client gemessen; Budget 40 Burst |
| Lobby-Warnung `GAME_NOT_IMPLEMENTED` | erwarteter Zustand (kein Spiel), vermieden durch Lesen erst ab Spielstart |

## Risiko: ACK-Timeout (PR26)
Nicht aufgetreten. Ursache weiterhin nicht belegt.
