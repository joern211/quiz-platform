# Gate 3 — Geo-E2E-Tests

**Branch:** `gate-1-build-db`
**HEAD:** `30b4d84` (`P0-12/P0-16: Atomare Antwort-Speicherung + Timer-Restoration für Geo-Engine`)
**Status CI:** ✅ **CI #22 PASSED**

---

## Gate 3 — Vollständiger Geo-Vertical-Slice

### Was noch zu tun ist

| Phase | Beschreibung | Status |
|---|---|---|
| 3a | P0-12 Atomare Antworten (Prisma-Tx mit revision) | ✅ CI #22 |
| 3b | P0-16 Timer-Rekonstruktion nach Server-Restart | ✅ CI #22 |
| 3c | P0-20 Pause/Resume UI in ModeratorGamePage | ✅ geo engine implementiert, UI button vorhanden |
| 3d | Geo-E2E-Integrationstests (Vitest) | 🔜 Gate 5 |
| 3e | Geo Playwright E2E | 🔜 Gate 5 |
| 3f | Spielende + Ergebnisrouten | Prüfen |

### Gate 4 — Manual Walkthrough

Gate 4 ist eine manuelle Abnahme durch den Prüfer:

- [ ] Moderator startet mit zwei echten Spielern
- [ ] Zuschauer kann passiv folgen
- [ ] Frage und Optionen identisch
- [ ] Antworten und Timer korrekt
- [ ] Pause/Fortsetzen korrekt
- [ ] Reveal exakt einmal
- [ ] Scores bei allen Rollen identisch
- [ ] Nächste Runde korrekt
- [ ] Spielende und Ergebnisrouten korrekt
- [ ] Reload/Rejoin funktioniert

### Gate 5 — Verpflichtende Tests (Integration + Socket + Playwright)

| Test | Status |
|---|---|
| Integrationstests (Vitest rooms.integration.test.ts) | 🔜 |
| Socket-Negativtests | 🔜 |
| Playwright E2E (15-Schritte-Volltest) | 🔜 |
| Playwright Kick-Test | 🔜 |

---

## Gate 2 — Zusammenfassung

Alle Security-Features vollständig implementiert und CI-passiert:

1. ✅ Argon2id PIN-Hashing  
2. ✅ Cookie SameSite=Strict + Secure in Produktion  
3. ✅ 7-Punkt requireRoomRole + Raumkanal-Isolation  
4. ✅ Moderator-Token-Validierung  
5. ✅ room:kicked targeted Emit  
6. ✅ Viewer-Isolation  
7. ✅ Rate-Limiting  
8. ✅ geo:reveal OHNE correctOptionId für Spieler  
9. ✅ geo:question OHNE correctOptionId  
10. ✅ Zod-Validierung  
11. ✅ API-Contract-Typen in @quiz/shared  
12. ✅ Moderator-Token in Raumerstellung  
13. ✅ Setup-Ownership-Prüfungen  

**Commit:** `30b4d84`  
**CI:** ✅ CI #22 PASSED
