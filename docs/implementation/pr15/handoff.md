# PR15 — TEAM-ROOM

Basis: main `4f665a8` (PR14 gemerged, CI grün). Branch: feature/pr15-team-room.
Roadmap: ursprünglicher Planplatz PR14; GitHub PR15.

## Auftrag
Master §2.4, §3, §4 und §12.9 über gemeinsame Room-/Team-Verträge vervollständigen; bestehende Engines integrieren. Regelmäßig Build + Commit + Push. Kein Merge durch Agent.

## Abnahmeplan
- Persistente Teams, manuell/random/self/rotation, Grenzen, unveränderliche Zuordnungshistorie, Teamwertung.
- Zugang für Player/Viewer, Sperre, geplante Räume, Warteliste, Genehmigungen und Late Join.
- Stabile Identität, eindeutige Namen, Gerätewechsel, Tokenrotation, Kick/Ban/Unban.
- Preflight/Ready, Co-Host ohne Secret-Aufwertung, freiwilliger und zeitgesteuerter Host-Transfer.
- Feed/Presence, vorhandene Pause/Recovery, engineabhängige Notfallaktionen, Rematch/Spielwechsel mit Historie, endgültiger Close.
- Reale HTTP-/Socket-/DB-Gegenproben für Rechte, Konkurrenz, Replay, Secrets und zwei Engines; vollständige Server/Web/Build/CI/E2E.

Voice-/Kameratests folgen wie geplant in deren Arbeitspaketen. Vollständige FINALIZED-/Statistik-Verträge und Retention-Jobs bleiben Folgescope; RoomRun sichert hier die bisherigen Spiele vor Rematch.

## Aktueller Stand
In Arbeit: Verträge/Persistenz, noch keine Freigabe.
