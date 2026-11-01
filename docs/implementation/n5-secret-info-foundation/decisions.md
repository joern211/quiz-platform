# N5 — Entscheidungen

## Master-Festlegung (nicht erneut zu fragen)
- Administrative Rechte und Informationsrechte sind getrennt (§2.2); ein mitspielender Host/Administrator bekommt nur, was seine Spielerrolle sehen darf; VIEWER nur PUBLIC; DISPLAY keine Secrets; Server autoritativ.
- Secrets nie vorsorglich an falsche Clients; Rollen sind Secret-Inhalt (§10.7); Zufallsentscheidungen einmal serverseitig, persistiert, Rejoin/Recovery würfeln nie neu (§5.16); keine nachträgliche Übertragung alter Secrets an Late-Joiner (§4.12); irreversible Secrets sind nicht zurücknehmbar (§5.30).
- Kanonische Plattformrollen bleiben ADMIN, HOST, PLAYER, VIEWER, DISPLAY. Agent/Undercover/Saboteur wären spätere **geheime Spielrollen**, keine Verwaltungsrechte und kein neuer Plattformrollentyp.
- Imposter, Undercover und Geheim Agent bleiben fachlich getrennte Spiele. **N5 implementiert keine dieser Engines.**

## Technische Entscheidungen in N5 (selbst getroffen, begründet)
| Thema | Entscheidung | Begründung |
|---|---|---|
| Rolle ≠ Wissen | Rollen-ID steht in keiner Projektion; Wissen nur über ausdrücklich adressierte Fragmente | Auftrag §1/§5: die Verwechslung „eigene Rolle = erlaubtes eigenes Wissen“ darf die API nicht festschreiben |
| Kein Host-Pfad | HOST (blind/nicht, mit ID, mit Zusatzrechten) → `own: null`; kein `canView(HOST_PRIVATE)` | Auftrag §8: keine versehentliche Übersicht; Vorschau ist eine eigene Entscheidung |
| Teams | Keine Team-Regel in der Projektion (`teamId` ignoriert) | Gleiche Teamzugehörigkeit gibt keine Rechte |
| Rollenzuordnung | Genau eine bekannte Rolle je Teilnehmer, Wiederholungen erlaubt, unbenutzte Rollen erlaubt | Begrenzte technische Zuordnung; keine Verteilungs-/Zähllogik als Default |
| Stale-Semantik | Jede veraltete Änderung **und** Projektion wird abgewiesen (nie „leer“) | Eine einzige, dokumentierte Semantik; ein Verbraucher mappt alles auf „stale/resync“ |
| Revision | Opake, vom Aufrufer vergebene Referenz; Helfer leitet nichts ab | Auftrag §7: kein Hash geheimer Begriffe (kleiner Begriffsraum wäre brute-force-bar) |
| Release-API | `{ state, changed }`; nicht leere Auswahl; Dubletten im Batch = Fehler; Log in Fragmentreihenfolge | Kein stilles Reparieren; `changed` verhindert unnötige State-Events; Ausgabe unabhängig von der Aufrufreihenfolge |
| Ausgabereihenfolge | Fragmentreihenfolge des Deals (nicht Freigabezeit) | Deterministisch und unabhängig von Wiederholungen; Zeit ist nie projiziert |
| Kanonisierung | Zuordnungen/Empfänger in Rosterreihenfolge abgelegt; beim Laden Mengensemantik (keine Reihenfolgepflicht) | Gleiche Mengen → gleicher Zustand, ohne beim Laden fremde, aber gültige Reihenfolgen abzulehnen |
| Grenzen | 100 Teilnehmer / 32 Rollen / 200 Fragmente / 2000 Verknüpfungen / Titel 80 / Text 1000, 20 Zeilen | Schutzgrenzen (Teilnehmer = Raum-`maxPlayers`-Obergrenze); keine Spielersettings |
| Fehler | Code-only, eigene Whitelist-Einträge; Zod-Meldungen werden nie durchgereicht | Auftrag §6: keine Begriffe/Rollen/Empfänger in Meldungen |
| Audience-Prüfung | Unbekannte Rolle (z. B. `ADMIN`)/ungültige ID → `SECRET_INFO_AUDIENCE_INVALID` | Kein ADMIN-Shortcut; fail-closed statt raten |
| UI-Anzeige | Nur `own`; Zustand in Kontextschlüssel; Bindung beim Rendern | Auftrag §10 |
| Browser-Harness | wie N4 unter `apps/web/harness/n5-secret-info/` (nur künstliche Daten, nicht Teil des Builds) | Wiederholbarer Browsernachweis ohne produktive Route |

## Weiterhin offen (blockiert N5 nicht; nichts davon wird hier als entschieden behandelt)
- **DEC-UND-01** (Undercover): Rollenanzahl/-verhältnis, welche Rolle welchen Begriff (oder keinen) kennt, Hinweise, Diskussion, Abstimmung, Gleichstand, Eliminierung, Sieg, Spielerlimits, Voice.
- **DEC-AGT-01** (Geheim Agent): Rollen-Satz, Siegbedingungen, Phasen; ob ein Spieler seine eigene tatsächliche Rolle erfährt.
- Automatisches vollständiges Reveal bei Runden-/Spielende: **nicht** vorgesehen und nicht entschieden. Abstimmung/Eliminierung/Spielende lösen in N5 nichts aus.
- Explizit autorisierte Host-Vorschau (nicht mitspielender Host): Freigabe und Integration offen.
- Die PR12-Spielentwürfe (Rollenverteilung „1 Undercover“, 4–10 Spieler, 3 Runden, Hinweislängen, Host blind …) sind **Vorschläge**, keine Nutzerfreigabe; nichts davon ist hartcodiert.

## Host-Fairness (dokumentiert, nicht gelöst)
Ein Autor oder Host, der Informationen schon aus Erstellung, Vorschau oder Beurteilung kennt, wird durch späteres Aktivieren von BLIND_HOST nicht unwissend. Ein späterer Engine-Verbraucher muss solche Konflikte **vor** der Mitspielberechtigung berücksichtigen. N5 behauptet nicht, dieses Fairnessproblem durch die Informationskarte zu lösen.
