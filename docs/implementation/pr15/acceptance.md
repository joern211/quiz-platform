# PR15 — TEAM-ROOM: Umfang und Abnahme

Basis: `main` nach GitHub-PR14 (`4f665a8`). Roadmap-Planplatz PR14 ist
GitHub-PR15. Regelquelle: Master Regelwerk vom 28.09.2026, §2.4, §3, §4;
PR-Roadmap 1–50 vom 07.10.2026. Der alte MVP-Phasenplan ist ergänzender Kontext.

## Implementierter Vertrag

| Master | Implementierung / Gegenprobe |
|---|---|
| §2.4 Co-Host | Default aus; eingeloggte Nutzer; einzelne Rechte; sofortiger Entzug; unabhängige Informationsrolle. Socket-Test „delegates management…“. |
| §3.1–4 Teams | MANUAL/RANDOM/SELF_SELECT/ROTATION, serverseitige Engine-Grenzen, Farben/Namen/Symbole, Größen/Gleichheit, Preflight, vor Start editierbar; Override nur bei freigegebener Runden-Grenze. Test „persists balanced teams…“. |
| §3.5–6 Historie/Wertung | Persistente Zuordnungen, Team bleibt bei Disconnect; historische Scores bleiben nach Leave/Kick. Gemeinsame Score-Transaktion schreibt Teambeitrag und Run-Zuordnung. Echte Wertung in Jeopardy und Wer ist das?. |
| §4.1–4 Zugang/Lifecycle | Öffentlicher Code getrennt von interner ID; Player/Viewer separat; PUBLIC/PIN/APPROVAL/INVITE; Sperre, Entwurf, geplanter Raum, explizites Öffnen, kein automatischer Spielstart. |
| §4.5–6 Ready/Preflight | Drei Ready-Regeln; Warnungen explizit bestätigbar, Blocker bleiben verbindlich. Mindest-/Maximalspieler, Namen, Teams, Content/Medien, Engine. Start und Ready konkurrieren über die Room-Revision. |
| §4.7–8 Transfer | Host-Ausfall sichtbar; freiwilliger Transfer oder berechtigter Co-Host nach Ausfallfrist; gültiger Account/Session und Raumteilnahme nötig; Audit. Alter Host verliert Kontrolle, neue Verwaltung bekommt keine höherwertige Spielrolle — auch beim nächsten Reconnect ohne Player-Token. |
| §4.9–11 Identität | Kick erlaubt neuen Join; Raum-Ban sperrt Teilnehmer, Account und die serverseitig gesetzte Gastkennung. Unban; Tokenrotation mit ungültigem Alttoken; ein aktiver Socket pro Teilnehmer; Historie/Punkte erhalten. |
| §4.12–14 Admission | WAITLIST/PENDING_JOIN können weder Ready noch Spielaktionen ausführen. Zulassung prüft Kapazität erneut; Late Join nur bei Engine-Freigabe an Runden-Grenze, Score 0. Eindeutige normalisierte Namen; Umbenennung erhält Identität. |
| §4.15 Pause | Geo-Timerpause bleibt erhalten; Jeopardy/WID frieren Zustand persistent ein und stellen ihn exakt wieder her. Während Pause keine Buzz-/Bewertungswirkung. Browser bekommt aktualisierte Rollenprojektion. |
| §4.16 Notfall | Gemeinsamer Command-Vertrag für alle vier Aktionsarten und beide Punktebehandlungen. Die vorhandenen Engine-Adapter geben ABORT_GAME/KEEP_POINTS frei. Andere Kombinationen liefern ENGINE_ACTION_UNSUPPORTED und werden nicht als verfügbare Aktion angeboten. |
| §4.17–19 Feed/Status/Änderungen | Persistenter öffentlicher Feed ohne Setup/Token, Host-/Co-Host-Nachrichten, getrennte Admission/Ready/Presence/Team-Sicht, unmittelbare Rechteprüfung. Team-/Policy-Änderungen beachten Start-/Runden-Grenzen. |
| §4.20–21 Raumabschluss | Nach Ende IDLE; Rematch/Lobby/Spielwechsel archivieren alten State, Config, Scores und Teams vor Reset. Sichtbare frühere Ergebnisse ohne Secrets. CLOSE invalidiert Raumzugang und aktive Sockets; zeitliche Ablaufgrenze sperrt Join/Rejoin. |

Nachweise: `apps/server/src/rooms/team-room.integration.test.ts`,
`apps/web/src/components/RoomPanel.test.tsx`,
`apps/web/e2e/team-room-e2e.spec.ts` und bestehende Regression.
Ein Eintrag in dieser Tabelle ersetzt keinen grünen Lauf am finalen Head.

## Abgrenzungen zu Folgepaketen

- Rotation minimiert bereits beobachtete Paarungen innerhalb der persistenten
  Raumhistorie. Stabile Event-übergreifende Gastidentitäten und Olympia-Rotation
  werden mit dem Event-Core (Planplatz PR38) integriert.
- Kamera-/Mikrofontest, Hardwarestatus und deren Qualitätsdiagnostik gehören
  wie in der Roadmap zu Voice/Kamera (Planplätze PR19/20). Socket-Presence und serverseitig gemessene Round-Trip-Zeiten mit
  GUT/INSTABIL/SCHLECHT gibt es bereits hier; nicht gemessene Verbindungen
  werden ausdrücklich als unbekannt angezeigt.
- Vollständige FINALIZED-/Amendment-/Statistik-Ergebnisse bleiben Planplatz
  PR16. RoomRun schützt hier bereits abgeschlossene Spiele vor dem Reset.
- Archivverdichtung/Retention-Jobs bleiben Planplatz PR42. Die hier vorhandene
  Ablaufprüfung ist kein laufender Cleanup-Job.
- Raum-Bans verwenden Account/Gastkennung/Teilnehmer-Token; kein aggressives
  Fingerprinting. Das Löschen der anonymen Browserkennung kann eine neue
  Gastidentität ermöglichen.

Die atomare PR12-Matrix bleibt ein historischer Ausgangspunkt. Dieser datierte
Abgleich ergänzt sie; nicht einzeln geprüfte V1-Anforderungen werden nicht
pauschal auf IMPLEMENTED gesetzt.
