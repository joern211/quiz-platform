# N6 — Entscheidungen

## Master-Festlegung (nicht erneut zu fragen)
- Server autoritativ; Verwaltungs- und Informationsrechte getrennt (§2.2): ein mitspielender Host/Administrator bekommt nur, was seine Spielerrolle sehen darf; VIEWER nur PUBLIC; DISPLAY keine Secrets.
- Disconnect: Identität und Team bleiben, Rejoin stellt Zustand wieder her, das Spiel pausiert nicht automatisch (§3.5); Leave/Kick: historische Stats bleiben (`LEFT`/`KICKED`), Ersatzspieler ist neue Identität (§3.5, §4.12); Kick/Ban: Historie/Punkte bleiben (§4.9); keine nachträgliche Übertragung alter Secrets (§4.12).
- Turn-Core: Modi FIXED/RANDOM/ROTATING_START/CUSTOM_HOST_ORDER, der Server verwaltet den aktiven Zug, **Disconnect ändert die Reihenfolge nicht automatisch** (§5.12).
- Rejoin/Recovery würfelt nie neu und erzeugt Reveal/Score nie doppelt (§5.16, §5.21); irreversible Secrets sind nicht zurücknehmbar (§5.30).
- Last Man Standing (§15.6): Kategorie/Begriff, feste Turn Order, einzigartige gültige Antworten, **konfigurierbare Leben**, KO, zentraler Turn-/Submission-/Judge-Core. Die konkrete Engine und ihre offenen Details sind spätere Aufträge. **N6 implementiert sie nicht.**

## Technische Entscheidungen in N6 (selbst getroffen, begründet)
| Thema | Entscheidung | Begründung |
|---|---|---|
| Status gespeichert, nicht abgeleitet | `status` ist Feld; Invarianten verknüpfen ihn nur mit den Leben (ACTIVE/0 unter ELIMINATE ungültig) | Auftrag §5/§6: Eliminierung mit Restleben oder ohne Lebensmodell muss möglich sein; `Scoreboard.tsx` (KO aus `lives === 0`) war genau das Gegenbeispiel und bleibt unangetastet |
| Zwei explizite Null-Leben-Policies | `ELIMINATE` (atomar) und `KEEP_ACTIVE`; keine Defaults | Auftrag §5; welche Policy zu einem Spiel passt, entscheidet die spätere Engine (für LMS nach den bestätigten KO-Regeln) |
| Kein Clamping | Über-/Unterlauf lehnt ab; Prüfung gegen die Restspanne vor jeder Addition | Auftrag §6: keine stille Reparatur, keine unsicheren Integer |
| Eine Versionsänderung je echter Änderung | KO = eine Änderung; `version ≥` Anzahl Eliminierter als Ladeinvariante | verhindert doppeltes Ereignis; erkennt manipulierte Zustände |
| Wiederholte Eliminierung | `changed:false`, `transition:null`; Scope/Version/Zeit/Akteur werden **vorher** geprüft | Auftrag §6: veraltete Wiederholung nie wegen „harmlos“ annehmen |
| `expectedVersion` fehlerhaft | gleicher Code wie ein Versionskonflikt (`…_VERSION_STALE`) | fail-closed, weniger Codes; ein nicht-sicherer Wert kann nie dem Zähler gleichen |
| Zähler an der Grenze | `version = MAX_SAFE_INTEGER` ist ladbar, eine weitere Änderung endet kontrolliert in `…_STATE_INVALID` ohne Teilzustand | theoretischer Rand, aber ohne Überlauf/Umbruch |
| Eliminierungsmetadaten | nur `atMs` + Ursache `EXPLICIT`/`ZERO_LIVES`, serverprivat, nie projiziert | Auftrag §5: minimal, kein Freitext, kein neuer Ereignisspeicher; Platzierung nach Ausscheidungszeitpunkt (§15.6-Skizze) ist **keine** N6-Funktion (ein späterer Verbraucher braucht bei gleichem Zeitstempel eine eigene Ordnung, z. B. aus der globalen Eventfolge) |
| Kein `roundId` im Track | Track gebunden an Run + trackId + Rosterrevision + Akteursart | Auftrag §5: überdauert Runden, wird nicht bei ROUND_TRANSITION neu erzeugt |
| Scope-Semantik | Veraltetes wird immer abgewiesen (nie „leer“); fünf getrennte Codes | konsistent mit N5; der Verbraucher mappt auf „stale/Resync“ |
| Akteursart im Scope | `PARTICIPANT` \| `TEAM` ist Teil der geprüften Bindung | Auftrag §5: gleiche ID-Texte nie verwechseln |
| Team | Keine Mitgliederliste, keine Zuordnungslogik; Projektion nur über `TEAM_PRIVATE` (teamId eines PLAYER) | Auftrag §5/§9; die Team-/Admission-Prüfung bleibt beim bestehenden Vertrag |
| Turn-Helfer-API | `activeActorsInOrder` + `findNextActiveTurn` auf bestehendem `CoreTurn` (`includeCurrent`) | schmalste API, die die CoreTurn-Konventionen (`index`, `cycle`) wiederverwendet und `advanceTurn` bei Voll-Aktivität reproduziert; `roundFlow.ts` bleibt unberührt |
| `NONE` statt Fallback | kein aktiver Akteur ⇒ `{ kind: 'NONE' }`, Turn unverändert | Auftrag §8: nie ein falscher Fallback, nie `undefined`, keine Endlosschleife |
| Freigaben | `NONE` \| `STATUS` \| `STATUS_AND_LIVES`, Pflichtparameter ohne Default; **keine** Variante „Leben öffentlich, Status geheim“; `STATUS` zeigt nicht einmal, ob ein Lebensmodell existiert | ein öffentlicher Nullwert würde das Ausscheiden verraten; Modellexistenz ist Konfiguration |
| Eigener Datensatz | `own` zeigt Status **und** Leben; Lebenssicht `HIDDEN` für den Eigentümer per Schema ausgeschlossen | Auftrag §9: eigene Teilnehmer-/Teamdaten über PLAYER_PRIVATE/TEAM_PRIVATE |
| `stateVersion` im Umschlag | vom Aufrufer gelieferte Snapshot-Version; nie der lokale Zähler | Auftrag §9: der lokale Zähler würde die Zahl verborgener Lebensverluste verraten |
| Audience-Prüfung | unbekannte Rolle (z. B. `ADMIN`)/ungültige ID ⇒ `PARTICIPATION_AUDIENCE_INVALID` | kein ADMIN-Shortcut; fail-closed statt raten |
| UI: erwarteter Mindest-Snapshot | `minStateVersion` kommt vom Aufrufer, nie aus der Projektion; zusätzlich **ein** Merker-Slot je angezeigtem Kontext | Auftrag §10; der Slot schützt gegen späte ältere Pakete, ersetzt aber nicht die Pflicht des Aufrufers, `minStateVersion` anzuheben |
| UI: Lebensanzeige | nur Zahl; keine Zeile bei verborgen/ohne Modell | 0 ist ein Wert, `null`/verborgen darf nie als 0 erscheinen |
| Browser-Harness | wie N4/N5 unter `apps/web/harness/n6-participation/` (nur künstliche Daten, nicht Teil des Builds) | wiederholbarer Browsernachweis ohne produktive Route |

## Weiterhin offen (blockiert N6 nicht; nichts davon wird hier als entschieden behandelt)
- **DEC-LMS-01** (Last Man Standing): Startleben, Lebensverlust bei falscher Antwort/Duplikat/Timeout/Pass, Disconnect im Zug (Gnadenfrist), Platzierung bei gleichzeitigem KO, Endgründe. Die PR12-Skizze nennt dazu **Vorschläge** („Timeout = Pass (−1 Leben)“, „30 s Gnadenfrist“); sie sind keine Nutzerfreigabe und **nicht** implementiert.
- **DEC-UND-01 / DEC-AGT-01**: Eliminierung per Abstimmung, Gleichstand, Sieg, Rollensatz — offen; ein Voting-Ergebnis löst in N6 nichts aus.
- Wer ein Team-Handeln auslöst, wie Teamleben bei Teamwechsel behandelt werden und wann eine Team-`rosterRevision` neu vergeben wird: Sache des Team-/Admission-Vertrags und des Verbrauchers.
- Ob eine Engine Wiederbelebung, Rückkehr nach Rundenwechsel oder Ersatzspieler vorsieht: **nicht** vorgesehen und nicht entschieden; ein Ersatzspieler ist laut Master eine neue Identität.
- Eine ausdrücklich autorisierte Host-Vorschau (auch für nicht mitspielende Hosts) und Freigabezeitpunkte der öffentlichen Sicht: offen.
- Die vorhandene `Participation.lives`-Spalte und `Scoreboard.tsx` bleiben unverändert; ob und wie sie später an den Track angebunden oder abgelöst werden, ist eine Integrationsentscheidung des ersten echten Verbrauchers.
