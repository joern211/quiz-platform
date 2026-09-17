# Verbindlicher Arbeitsauftrag für Hermes

**Projekt:** Quiz-Plattform  
**Repository:** https://github.com/joern211/quiz-platform  
**Audit-Grundlage:** Commit 21adb68b97c49f8b84090808a921536c1a96adc7  
**Erstellt:** 17.09.2026  
**Priorität:** Release-Blocker / Wiederherstellung und Stabilisierung  
**Ziel:** Einen reproduzierbar getesteten Geo-Quiz-MVP herstellen – nicht nur sichtbare Oberflächen oder theoretisch kompilierbaren Code.

---

## 1. Auftrag und Arbeitsregeln

Arbeite diesen Auftrag vollständig und in der angegebenen Reihenfolge ab. Überspringe keine Phase. Beginne keine neuen Spiele oder Komfortfunktionen, solange die technischen P0-Gates nicht nachweislich grün sind.

Der beigefügte „Quiz-Plattform — Gesamtplan (MVP → Phase 5)“ bleibt die fachliche Produktvorgabe. Dieses Dokument ergänzt ihn um die beim Quellcode-Audit festgestellten Fehler, die Wiederherstellungsstrategie und die verbindlichen technischen Abnahmekriterien.

### Verbindliche Regeln

1. Nicht direkt auf main arbeiten.
2. Kein Force-Push, kein Reset von main und kein Umschreiben bestehender Historie.
3. Kleine, logisch getrennte Commits erstellen.
4. Vor jeder größeren Änderung den aktuellen Zustand dokumentieren.
5. Fehler nicht durch Deaktivieren von TypeScript-, Lint- oder Testprüfungen „lösen“.
6. Keine Tests löschen, überspringen oder in Platzhalter umwandeln, nur damit CI grün erscheint.
7. Keine Funktionen als „fertig“ melden, die nicht im laufenden System getestet wurden.
8. Bei einem Blocker Ursache, betroffene Dateien und Reproduktionsschritte dokumentieren.
9. Andere Spiele außer Geo zunächst als „geplant“ oder „nicht verfügbar“ kennzeichnen.
10. Nach jeder Phase die verlangten Prüfungen ausführen und Ergebnisse im Abschlussbericht festhalten.

---

## 2. Kritischer Auditbefund

Der verlinkte Commit 21adb68 ist kein fertiger v0.3-Stand. Er ist der Merge von PR #2, der die Änderungen aus PR #1 vollständig zurückgesetzt hat.

- PR #1: https://github.com/joern211/quiz-platform/pull/1
- PR #2: https://github.com/joern211/quiz-platform/pull/2
- Audit-Commit: https://github.com/joern211/quiz-platform/commit/21adb68b97c49f8b84090808a921536c1a96adc7
- Revert-Commit: 48c1ff55813a22e27e44aaa6676a7a706c3f441c

Der Dateibaum des Audit-Commits ist bytegenau identisch mit einem älteren v0.2-Stand. Die Verbesserungen aus PR #1 waren vorhanden, wurden jedoch wieder entfernt.

Der aktuelle Stand besitzt unter anderem:

- keine GitHub-CI
- keine Prisma-Migrationen
- keinen funktionierenden vollständigen Multiplayer-Ablauf
- defekte Server-Build-Konfiguration
- ungültige Importe
- widersprüchliche API- und Socket-Verträge
- unzureichende Authentifizierung und Raumautorisierung
- keine belastbare Integrations- oder E2E-Abdeckung
- nicht releasefähiges Docker-/Deployment-Verhalten

**Folgerung:** Zuerst PR #1 kontrolliert wiederherstellen. Danach dessen verbleibende Fehler beheben. Nicht auf dem zurückgesetzten v0.2-Code weiterentwickeln.

---

## 3. Phase 0 – Sichere Wiederherstellung

### 3.1 Recovery-Branch erstellen

~~~bash
git switch main
git pull --ff-only
git status
git switch -c recovery/reapply-v0.3.1
~~~

Vor dem Revert muss git status sauber sein.

### 3.2 Den Revert rückgängig machen

Nicht den Merge-Commit 21adb68 mit falschem Parent zurücksetzen. Stattdessen den normalen Revert-Commit aus PR #2 rückgängig machen:

~~~bash
git revert 48c1ff55813a22e27e44aaa6676a7a706c3f441c
~~~

Konflikte fachlich lösen. Keine Dateien pauschal aus einer Seite übernehmen, ohne sie zu prüfen.

### 3.3 Wiederherstellung mit PR #1 vergleichen

~~~bash
git fetch origin pull/1/head:pr-1-head
git diff --stat pr-1-head...HEAD
git diff pr-1-head HEAD -- .
~~~

Erwartung: Der Arbeitsbaum entspricht im Wesentlichen dem letzten Stand aus PR #1. Jede Abweichung muss im Abschlussbericht begründet werden.

### Gate 0

- [ ] Recovery-Branch vorhanden
- [ ] Revert des Reverts erfolgreich
- [ ] Keine unbeabsichtigten Dateiverluste
- [ ] Vergleich mit PR #1 dokumentiert
- [ ] main unverändert
- [ ] Recovery-Commit gepusht

---

## 4. Phase 1 – Reproduzierbarer Build und Datenbank-Basis

### 4.1 Workspace und TypeScript

Prüfe alle package.json- und tsconfig-Dateien als zusammenhängenden Workspace.

Zu erledigen:

- Root-, Web-, Server- und Package-Versionen vereinheitlichen.
- Für server, shared, ui und game-sdk korrekte eigene TypeScript-Konfigurationen sicherstellen.
- CommonJS/ESM-Mischbetrieb entfernen.
- Server-Build-Script auf tatsächlich vorhandene tsconfig-Dateien umstellen.
- apps/server/run.ts entweder vollständig korrigieren oder sauber entfernen/aus dem Build ausschließen.
- Alle fehlenden und falschen Importe korrigieren.
- Package-Exports nur auf tatsächlich vorhandene Dateien zeigen lassen.
- Keine implizite Kompilierung des gesamten Monorepos aus einzelnen Packages.
- ESLint und alle Testabhängigkeiten vollständig deklarieren.
- Node- und pnpm-Version festlegen, beispielsweise über .nvmrc und packageManager.

### 4.2 Prisma

Es existieren keine Migrationen. Erzeuge eine echte initiale Migration aus dem final überprüften Schema.

Anforderungen:

- Migration gegen eine vollständig leere SQLite-Datenbank testen.
- prisma generate reproduzierbar ausführen.
- Seed mehrfach ausführbar machen.
- Seed darf nicht vollständig abbrechen, nur weil bereits ein Spiel existiert.
- Passwörter ausschließlich mit demselben Verfahren erzeugen, das der Login verwendet.
- INITIAL_ADMIN_PASSWORD konsistent verwenden.
- Keine schwachen Produktions-Standardpasswörter.
- Fehlende Seeds getrennt ergänzen: Benutzer, Spiele, Kategorien, Question Packs und Geo-Fragen.
- Migration und Seed in CI testen.

### 4.3 Docker

- prisma migrate deploy aus dem Image-Build entfernen.
- Migration als Deployment-/Start- oder separaten Init-Schritt ausführen.
- Image muss ohne erreichbare Laufzeitdatenbank gebaut werden können.
- Server und Web-Build korrekt kopieren.
- WEB_DIST_PATH konsistent verwenden.
- Container als Nicht-Root-Benutzer betreiben.
- Schreibrechte nur für notwendige Storage-Verzeichnisse.
- Healthcheck darf nicht nur SELECT 1 prüfen, sondern muss mindestens den erwarteten Schema-/Anwendungszustand erkennen.
- Gemeldete Version aus package.json beziehen, nicht hart 0.2.1 ausgeben.

### 4.4 CI anlegen

Erstelle .github/workflows/ci.yml. Mindestens:

~~~bash
corepack enable
pnpm install --frozen-lockfile
pnpm prisma generate
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm exec playwright install --with-deps
pnpm exec playwright test
~~~

Für Migrationstests eine leere temporäre Datenbank verwenden. CI muss bei TypeScript-Fehlern, Lintfehlern, fehlenden Migrationen, fehlgeschlagenen Tests oder fehlgeschlagenem Build abbrechen.

### Gate 1

- [ ] Clean Clone installierbar
- [ ] Typecheck grün
- [ ] Lint grün
- [ ] Unit Tests grün
- [ ] Build grün
- [ ] Leere Datenbank migrierbar
- [ ] Seed und Login funktionieren
- [ ] Docker-Image ohne Laufzeitdatenbank baubar
- [ ] GitHub-CI sichtbar grün

---

## 5. Phase 2 – HTTP-Verträge, Authentifizierung und Sicherheit

### 5.1 Einheitliche API-Verträge

Definiere gemeinsame Zod-Schemas und TypeScript-Typen für Request und Response.

Raumerstellung muss mindestens zurückgeben:

- roomId
- code
- moderatorParticipationId
- moderatorRejoinToken

Das Frontend muss diese Werte unmittelbar und atomar in sessionStorage speichern.

setupSnapshotJson darf nicht doppelt serialisiert werden. Das Frontend sendet ein Objekt. Der Server validiert dieses Objekt und serialisiert es genau einmal für Prisma.

Alle API-Antworten verwenden ein einheitliches Schema:

~~~text
{ success: true, data: ... }
{ success: false, error: { code, message } }
~~~

Kein gemischtes Lesen von response.code, response.data.code und doppelt verschachtelten data-Feldern.

### 5.2 Eingabevalidierung

Validiere mindestens:

- Anzeigename: Länge, Whitespace, erlaubte Zeichen
- Raumcode: normalisiertes NNN-NNN-Format
- PIN: definierte Länge und Zeichensatz
- Spielerlimit
- Zuschauerlimit
- Timerdauer
- Fragenanzahl
- ausgewählte Question IDs
- Room Name
- Game Slug
- Uploadgröße und MIME-Typ

Unbekannte Felder ablehnen oder bewusst entfernen.

### 5.3 Authentifizierung und Cookies

- Session-Cookies in Produktion Secure, HttpOnly und mit geeignetem SameSite-Wert.
- Mutierende Cookie-Endpunkte gegen CSRF beziehungsweise fremde Origins schützen.
- Login, Join und PIN-Prüfung rate-limiten.
- Kurze PINs nicht als alleinigen Schutz betrachten; Rate Limit und temporäre Sperre umsetzen.
- Keine Klartext-Tokens protokollieren.
- Rejoin-Tokens ausreichend zufällig erzeugen und möglichst nur gehasht speichern.
- Authentifizierung bei Uploads prüfen, bevor Daten auf die Platte geschrieben werden.
- Setup-Änderungen nur dem Host beziehungsweise berechtigten Rollen erlauben.
- Media-Sichtbarkeit serverseitig erzwingen.

### Gate 2

- [ ] API-Contracts gemeinsam typisiert
- [ ] Setup nur einmal serialisiert
- [ ] Moderator-Token wird zurückgegeben und gespeichert
- [ ] Alle Eingaben validiert
- [ ] Rate Limits aktiv
- [ ] Cookie-/Origin-Schutz aktiv
- [ ] Uploadauthentifizierung vor Dateischreiben
- [ ] Eigentums- und Sichtbarkeitsprüfungen getestet

---

## 6. Phase 3 – Socket-Identität und Raumisolation

Dies ist ein P0-Sicherheits- und Funktionsblocker.

### 6.1 Moderatoridentität

Der Host muss beim room:subscribe zuverlässig als MODERATOR erkannt werden.

Zulässige Lösung:

- Moderator verwendet den bei Raumerstellung erhaltenen Moderator-Rejoin-Token.
- Server prüft, dass Token, Participation, Host-User und angefragter Raum zusammenpassen.
- Alternativ darf eine HTTP-Session den Host identifizieren, aber nur wenn zusätzlich die passende Moderator-Participation für genau diesen Raum geladen wird.

Ein Moderator ohne Token darf nicht stillschweigend als anonymer Zuschauer angelegt werden.

### 6.2 Einheitliche Raumkanäle

Sockets treten ausschließlich dem internen Kanal bei:

~~~text
room:<interne-room-id>
~~~

Autorisierungshelfer müssen denselben Kanal prüfen. Niemals den öffentlichen Code direkt gegen socket.rooms prüfen, wenn tatsächlich room:<id> beigetreten wurde.

### 6.3 Autorisierungsreihenfolge

Jede mutierende Socket-Aktion prüft:

1. Socket besitzt validierte Identität.
2. Identität gehört zum angefragten Raum.
3. Socket ist im internen Raumkanal.
4. Rolle genügt der Aktion.
5. Raumstatus erlaubt die Aktion.
6. Spielphase erlaubt die Aktion.
7. Payload wurde validiert.

Dies gilt insbesondere für:

- game:start
- game:pause
- game:resume
- game:end
- geo:reveal
- geo:next
- Chat sperren
- room:kick
- Ready-Status
- Profiländerungen
- Joker
- Buzz
- Resync

### 6.4 Kick und Rejoin

- room:kicked nur an Socket-Verbindungen des betroffenen Spielers senden.
- Andere Spieler dürfen das Event nicht als eigenen Kick interpretieren.
- Token des gekickten Spielers tatsächlich ungültig machen.
- Falls rejoinTokenVersion verwendet wird, muss die Version Bestandteil der Prüfung sein.
- kickedAt muss bei jedem Rejoin geprüft werden.
- Mehrere offene Sockets desselben Spielers kontrolliert behandeln.
- session:replaced muss nur das alte Gerät betreffen.

### 6.5 Zuschauer

- allowViewers serverseitig erzwingen.
- viewerRequiresPin korrekt prüfen.
- viewerLimit vor Erstellung einer ViewerSession prüfen.
- Disconnect zuverlässig speichern.
- Alte ViewerSessions bereinigen.
- Zuschauer dürfen niemals mutierende Spieler- oder Moderatoraktionen ausführen.

### Gate 3

- [ ] Moderator verbindet sich als Moderator
- [ ] Interner Room Channel überall einheitlich
- [ ] Cross-Room-Zugriffe blockiert
- [ ] Kick nur für Zielspieler
- [ ] Alter Kick-Token unbrauchbar
- [ ] Viewer-Verbot, PIN und Limit funktionieren
- [ ] Resync nur für Raumteilnehmer
- [ ] Disconnectstatus korrekt

---

## 7. Phase 4 – Vollständiger Geo-Vertical-Slice

Ziel ist genau ein vollständig funktionierendes Spiel. Andere Spiele nicht gleichzeitig ausbauen.

### 7.1 Start und Setup

- Geo-Setup korrekt laden.
- Ausgewählte Fragen und Question Pack validieren.
- Spielstart ohne Fragen ablehnen.
- Mindestzahl echter PLAYER prüfen; Moderator und Zuschauer nicht mitzählen.
- Alle erforderlichen Spieler müssen bereit sein, außer bei ausdrücklich autorisiertem Force Start.
- Intro und erste Runde exakt einmal starten.
- Parallel ausgelöste Start-Events müssen idempotent sein.

### 7.2 Rundenzustand

Für jede Runde:

- playerStates für alle aktiven Spieler initialisieren.
- Jokerstatus korrekt übernehmen.
- Frage ohne correctOptionId an Spieler und Zuschauer senden.
- Serverautoritativen timerStartMs und timerEndMs speichern.
- Eingaben nach Ablauf zuverlässig blockieren.
- Antworten nur für aktuelle Frage und aktuellen Raum akzeptieren.
- Doppelte Antworten ablehnen.
- Option-ID gegen die aktuelle Frage prüfen.

### 7.3 Pause und Fortsetzen

Beim Pausieren:

- verbleibende Zeit atomar berechnen
- aktiven Timer stoppen
- Zustand als pausiert speichern
- verbleibende Zeit an alle Rollen senden

Beim Fortsetzen:

- neuen timerStartMs und timerEndMs speichern
- Zustand als aktiv speichern
- neuen Servertimer starten
- Resume-Event an alle Rollen senden

Nach Serverneustart aktive Timer aus persistentem Zustand rekonstruieren oder das Spiel kontrolliert pausieren. Keine still verlorenen Timer.

### 7.4 Reveal und Scoring

Die vorhandene Prüfung „bereits aufgedeckt“ außerhalb einer Transaktion reicht nicht.

Implementiere atomare Idempotenz:

- Reveal darf pro Raum und Runde nur einmal gewinnen.
- Verwende Revision/optimistic locking, eine eindeutige Datenbankkennung oder einen atomaren Zustandswechsel.
- ScoreEvents benötigen eine eindeutige Idempotenzkennung pro Runde, Spieler und Wertungstyp.
- Punkte, Participation Score, Round State und ScoreEvents in einer konsistenten Transaktion aktualisieren.
- Gleichzeitige Reveal-Aufrufe dürfen niemals doppelte Punkte erzeugen.
- Moderatorstatistik muss optionId und Spielerzahl korrekt enthalten.
- Spielerresultat darf Participation-ID nicht mit Rejoin-Token verwechseln.
- Score-Datenstruktur zwischen Server und allen Clients vereinheitlichen.

### 7.5 Spielende und Ergebnisse

- Letzte Runde führt genau einmal zu ENDED/RESULTS.
- Alle Timer werden beendet.
- Ergebnisrouten für Moderator, Spieler und Zuschauer funktionieren.
- Ergebnis-API gibt erst im zulässigen Ergebniszustand Daten aus.
- Private Räume und sensible Daten nicht anonym veröffentlichen.
- Rollen sehen nur die für sie vorgesehenen Daten.
- Reload und Rejoin auf Ergebnisrouten funktionieren.

### Gate 4

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

---

## 8. Phase 5 – Verpflichtende Tests

### 8.1 Integrationstests

Ersetze die vorhandenen rooms.integration.test.ts-Platzhalter durch echte Tests. Kein it.todo.

Mindestens prüfen:

- Raum erstellen mit gültiger Moderator-Session
- Unauthentifizierte Raumerstellung ablehnen
- fehlenden oder ungültigen Game Slug ablehnen
- private Räume schützen
- Join mit gültiger Eingabe
- falsche PIN
- Rate Limit
- voller Raum
- doppelte Namen gemäß definierter Regel
- Moderator-Token in Create Response
- Schließen nur durch Host
- Ergebnisse erst im zulässigen Zustand

### 8.2 Socket-Negativtests

- Token aus Raum A mit Code aus Raum B
- Zuschauer ruft Moderatoraktionen auf
- Spieler ruft Reveal/Next/End auf
- ungültiger Rejoin-Token
- gekickter Token
- Viewer bei allowViewers=false
- falsche Viewer-PIN
- Viewer-Limit erreicht
- Resync ohne Mitgliedschaft
- doppelte Antwort
- Antwort nach Timerablauf
- gleichzeitiges doppeltes Reveal
- gleichzeitiger Spielstart

### 8.3 Playwright-E2E

Playwright muss den benötigten Server automatisch starten.

Ein vollständiger Test mit getrennten Browserkontexten:

1. Moderator meldet sich an.
2. Moderator erstellt Geo-Raum.
3. Spieler A tritt bei.
4. Spieler B tritt bei.
5. Zuschauer tritt bei.
6. Spieler werden bereit.
7. Moderator startet.
8. Beide Spieler beantworten Frage.
9. Timer beziehungsweise Reveal funktioniert.
10. Punkte stimmen auf allen Ansichten überein.
11. Pause/Fortsetzen funktioniert.
12. Nächste Runde startet.
13. Spiel endet.
14. Alle Ergebnisrouten laden.
15. Ein Spieler lädt neu und tritt wieder bei.

Zusätzlicher Test:

- Moderator kickt Spieler A.
- Nur Spieler A wird entfernt.
- Spieler B und Zuschauer bleiben verbunden.
- Spieler A kann mit altem Token nicht erneut beitreten.

### Gate 5

- [ ] Keine Test-Platzhalter
- [ ] Keine übersprungenen kritischen Tests
- [ ] Integrationstests grün
- [ ] Socket-Negativtests grün
- [ ] Mehrrollen-E2E grün
- [ ] Docker-Smoke-Test grün
- [ ] Tests laufen in GitHub-CI

---

## 9. Phase 6 – UI, Accessibility, Profil und PWA

Diese Phase erst nach Gate 5.

### 9.1 Katalog und Inhalte

- Nur eine Quelle für Kategorien und Spiele.
- Keine getrennten Mock-Kataloge in HomePage, CategoryPage und Shared Package.
- Nicht funktionierende Spiele klar als geplant markieren.
- Keine erfundenen Spieler- oder Spielzahlen.
- Fremdsprachigen Resttext „无需 Account“ entfernen.
- Texte, Statusbezeichnungen und Fehlerzustände konsistent auf Deutsch.

### 9.2 Responsive Design

- Mobile Navigation bereitstellen; Navigation nicht nur ausblenden.
- Moderator-, Spieler- und Zuschaueransichten auf kleinen Displays testen.
- Buttons und Eingaben mit ausreichender Touch-Fläche.
- Keine abgeschnittenen Raumcodes, Timer, Tabellen oder Ergebnislisten.
- Landscape- und Portrait-Ansicht prüfen.

### 9.3 Accessibility

- Modale Dialoge mit role=dialog und aria-modal.
- Fokus beim Öffnen setzen und beim Schließen wiederherstellen.
- Fokus innerhalb eines offenen Modals halten.
- Escape schließt zulässige Dialoge.
- Eindeutige IDs statt mehrfach verwendeter info-title-ID.
- Buttons mit zugänglichen Namen.
- Status nicht nur über Farbe vermitteln.
- prefers-reduced-motion respektieren.
- Kontrast in Light und Dark Theme prüfen.

### 9.4 Visuelles System

Der gewünschte Stil ist ruhig, hochwertig und modern – kein starkes Neon-/Cyberpunk-Design.

- Gradients, Text-Shadows, starke Glows und permanente Animationen reduzieren.
- Schatten und Transforms vereinheitlichen.
- Header nicht hart auf ein dunkles Theme festlegen.
- Design Tokens für beide Themes verwenden.
- Animationen gezielt und sparsam einsetzen.

### 9.5 Profil, Audio und Kamera

- Kameraauswahl mit Geräteberechtigung und Preview.
- Mikrofon-/Audioauswahl mit verständlichen Fehlerzuständen.
- AV-Einstellungen speichern und beim Raumbeitritt anwenden.
- Keine Kameraoption im Typmodell ohne funktionierende UI.
- Maximal vier aktive Kameras serverseitig erzwingen.
- Datenschutz und Freigabestatus sichtbar machen.

### 9.6 PWA

- Manifest im HTML korrekt verlinken.
- Service Worker über reproduzierbare Build-Konfiguration einbinden.
- Echte PNG-Dateien für 192x192 und 512x512 erzeugen.
- Offline-/Updateverhalten definieren.
- Installation mindestens in aktuellem Chrome/Edge testen.

### Gate 6

- [ ] Einheitlicher Katalog
- [ ] Mobile Navigation
- [ ] Light/Dark vollständig
- [ ] Accessibility-Grundlagen erfüllt
- [ ] Ruhiges konsistentes Design
- [ ] Kamera/Audio funktional oder ehrlich deaktiviert
- [ ] Echte PWA-Icons und Manifest
- [ ] Keine sichtbaren Platzhalter oder erfundenen Daten

---

## 10. Dateien und Bereiche mit besonderem Prüfbedarf

Mindestens diese Bereiche gezielt untersuchen:

- package.json
- pnpm-lock.yaml
- apps/server/package.json
- apps/server/tsconfig.json
- apps/server/run.ts
- apps/server/src/server.ts
- apps/server/src/http/rooms.ts
- apps/server/src/http/middleware/auth.ts
- apps/server/src/sockets/index.ts
- apps/server/src/sockets/auth.ts
- apps/server/src/sockets/room.ts
- apps/server/src/sockets/game.ts
- apps/server/src/sockets/lobby.ts
- apps/server/src/games/geo/index.ts
- apps/server/src/games/registry.ts
- apps/web/src/App.tsx
- apps/web/src/lib/api.ts
- apps/web/src/lib/socket.ts
- apps/web/src/lib/sessionStore.ts
- apps/web/src/pages/ModeratorSetupPage.tsx
- apps/web/src/pages/ModeratorLobbyPage.tsx
- apps/web/src/pages/ModeratorGamePage.tsx
- apps/web/src/pages/PlayerLobbyPage.tsx
- apps/web/src/pages/PlayerGamePage.tsx
- apps/web/src/pages/ViewerGamePage.tsx
- alle drei Result Pages
- prisma/schema.prisma
- prisma/seed.ts
- Dockerfile
- docker-compose.yml
- PWA-Manifest, Service Worker und Icons
- alle Tests und Playwright-Konfigurationen

---

## 11. Definition of Done

„Fertig“ ist ausschließlich zulässig, wenn alle Punkte erfüllt und nachgewiesen sind:

- [ ] Neue Installation aus Clean Clone funktioniert.
- [ ] pnpm install --frozen-lockfile funktioniert.
- [ ] prisma generate funktioniert.
- [ ] Migration gegen leere Datenbank funktioniert.
- [ ] Seed ist idempotent.
- [ ] Moderator kann sich mit Seed-Daten anmelden.
- [ ] Typecheck ohne Fehler.
- [ ] Lint ohne Fehler.
- [ ] Unit- und Integrationstests ohne Fehler.
- [ ] Web- und Server-Build ohne Fehler.
- [ ] Docker-Image baut ohne Laufzeitdatenbank.
- [ ] Container startet mit leerem Storage-Volume.
- [ ] Readiness prüft mehr als nur SELECT 1.
- [ ] Vollständiger Geo-E2E-Test mit Moderator, zwei Spielern und Zuschauer.
- [ ] Reconnect funktioniert.
- [ ] Kick funktioniert ausschließlich für Zielspieler.
- [ ] Cross-Room-Angriffe werden abgewiesen.
- [ ] Doppeltes Reveal erzeugt keine doppelten Punkte.
- [ ] Ergebnisrouten funktionieren für alle Rollen.
- [ ] GitHub-CI ist auf dem Pull Request grün.
- [ ] Keine kritischen todo-/skip-Tests.
- [ ] Dokumentation nennt ehrlich, welche Spiele funktionieren.
- [ ] Abschlussbericht enthält ausgeführte Befehle und Testergebnisse.

---

## 12. Verlangter Abschlussbericht

Am Ende eine Datei HERMES_COMPLETION_REPORT.md erstellen mit:

1. Branch und Commit-SHAs
2. Zusammenfassung der Änderungen
3. Liste aller behobenen Auditpunkte
4. Noch offene Fehler nach P0/P1/P2
5. Datenbank- und Migrationsstatus
6. Auth-/Security-Änderungen
7. Socket- und Raumautorisierungsänderungen
8. Geo-Spielstatus
9. UI-/PWA-Status
10. Exakte Testbefehle
11. Testergebnisse mit Anzahl bestandener/fehlgeschlagener/übersprungener Tests
12. CI-Link
13. Docker-Smoke-Test
14. Bekannte Einschränkungen
15. Screenshots der vier Rollen: Moderator, Spieler, Zuschauer, Ergebnis

Wenn ein Gate nicht erfüllt ist, darf der Bericht nicht „alles fertig“ behaupten. Stattdessen den konkreten Blocker, die Ursache und den nächsten Reparaturschritt nennen.

---

## 13. Empfohlene Commit-Struktur

1. chore: restore reverted v0.3 work
2. build: repair workspace and TypeScript configuration
3. db: add initial migration and idempotent seed
4. ci: add required GitHub checks
5. fix: align room HTTP contracts
6. security: enforce socket identity and room isolation
7. fix: complete moderator session and kick handling
8. fix: make geo timer and scoring authoritative
9. test: replace placeholder integration tests
10. test: add multiplayer Playwright flow
11. ui: consolidate catalog and responsive navigation
12. a11y: repair dialogs, focus and reduced motion
13. pwa: add valid manifest, service worker and icons
14. docs: add truthful completion and known-issues report

---

## 14. Startpunkt

Beginne jetzt mit Phase 0. Melde erst nach Abschluss von Gate 0:

- verwendeten Branch
- erzeugten Recovery-Commit
- Ergebnis des Vergleichs mit PR #1
- aufgetretene Konflikte
- nächste konkrete Phase

Nicht vorzeitig an UI-Details oder weiteren Spielen arbeiten.
