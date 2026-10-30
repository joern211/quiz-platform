# Gemeinsame Spielmechaniken vor neuen Engines

Stand: 30.10.2026. Beschlossener Ablauf: zuerst ein begrenzter Grundlagenblock,
danach neue Spiele. Ausgangspunkt ist `main @ 75013448ebf7065daad4b64a90ce568c85d11d3b`.
Die Pakete PR15–19 sind über PR20 in main enthalten. Dieser Plan führt ihre
Ergebnisse fort; er erklärt nicht sämtliche Master-Anforderungen für erfüllt.

## Ziel und Grenze

Wiederverwendbare Mechaniken werden anhand konkreter Anforderungen der geplanten
Spiele vervollständigt. Wissensduell, Jeopardy und Wer ist das? dienen als reale
Verbraucher, soweit eine Mechanik zu ihren festgelegten Regeln passt.

In diesem Block entsteht keine neue Spiel-Engine. Bestehende Spielregeln werden
nicht geändert, um künstlich einen zweiten Verbraucher vorweisen zu können.
Einzelne Brettregeln, Würfelkombinationen, Rollen-Siegbedingungen und Punktetabellen
bleiben beim jeweiligen Spiel. Es entsteht kein konfigurierbarer Universal-Editor
für beliebige Spiele und kein neuer Plugin-/Workflow-Unterbau auf Vorrat.

Quellen: [Technisches Mapping, insbesondere §3.4 und §4](../../specs/pr12/technical-mapping.md),
[Spielespezifikationen](../../specs/pr12/games/index.md),
[Entscheidungsregister](../../specs/pr12/decision-register.md), tatsächlicher Code
und die [Bestandsaufnahme](inventory.md). Die alten PR12-Ist-Spalten sind historische
Snapshots. Die ursprüngliche Master-RTF wurde für diesen Plan nicht erneut vollständig
geprüft; dies ist kein vollständiger Master-Audit.

## Nachweisstufen

| Stufe | Bedeutung |
| --- | --- |
| R | In vorhandenen Engines real verwendet; nur der belegte Teilumfang zählt. |
| H | Hilfsfunktion, Schema oder isolierter Test vorhanden; vollständige Laufzeitintegration fehlt. |
| O | Im geprüften gemeinsamen Kern nicht als vollständiger Baustein vorhanden. |
| S | Bewusst später beim passenden Spiel oder Mechanikcluster. |

Die Stufen sind keine Prozentwerte. Neue Testadapter oder Typen machen aus H/O
kein R. Die Core-DoD verlangt mindestens zwei echte Engine-Verbraucher und die
zugehörigen Rechte-, Persistenz-, Rejoin-, Recovery- und Fehlernachweise. Wo das
vor neuen Spielen nicht möglich ist, bleibt die endgültige Abnahme ausdrücklich
offen. Ein fehlender Verbraucher rechtfertigt keine fachfremde Funktion in einem
Bestandsspiel.

## Reihenfolge der Arbeitspakete

### G1 — Gemeinsamer Aktions- und Zustandsvertrag

Zuerst die tatsächlich erreichbaren Befehle der drei Engines mit Schema,
Berechtigung, Phase, verfügbarem UI-Control und persistierter Wirkung abgleichen.
Registry und bestehende Adapter bleiben der Ausgangspunkt. Eine Umstrukturierung
erfolgt nur für eine belegte Lücke, nicht allein wegen unterschiedlicher Dateinamen.

Abschlusskriterien:

- Eine nachvollziehbare Tabelle ordnet jeden vorhandenen Spielbefehl seinem Guard,
  Payload, Receipt-/Legacy-Verhalten, State-/Eventwrite und Verbraucher zu.
- Laufzeit und angebotene Aktionen stimmen überein; nicht unterstützte Aktionen
  bleiben gesperrt. Fremde Räume, wartende Teilnehmer, alte Geräte und entzogene
  Rechte führen zu keiner Mutation oder privaten Projektion.
- Neue oder geänderte kritische Mutationen verwenden die bestehende Transaktion,
  CAS-/Command-Fences und den Eventpfad. Gleiche Absicht wirkt einmal; dieselbe ID
  mit anderer Absicht wird abgewiesen. Legacy-Kompatibilität wird explizit erhalten.
- Bekannte Versionen und Konfiguration sind gepinnt. Ungültiger Zustand wird
  angehalten; Recovery benötigt vollständige Evidenz bis zur Vorversion.

### G2 — Zeit, Zug, Buzzer und Rundenübergang

Die vorhandenen Primitive aus `runtimePrimitives.ts`, `roundFlow.ts`, `buzzer.ts`
und `roundTransition.ts` weiterverwenden. Countdown in Wissensduell, unbegrenzte
Antwortzeit in Jeopardy sowie Buzzer/Antwortzug in Jeopardy und WID sind bereits R.
Count-up, allgemeine Mehrspieler-Zugzyklen und zusätzliche Timeraktionen sind
nicht automatisch als vollständig eingebaut anzusehen.

Abschlusskriterien:

- Für jede tatsächlich unterstützte Aktion sind Rechte, erlaubte Phase,
  Persistenz, Anzeige und Verhalten bei Pause/Expiry dokumentiert und verbunden.
- Die Deadline selbst nimmt keine Antwort mehr an. Pause, Änderung, Resume und
  Neustart erzeugen keine unbeabsichtigte Zeit und reaktivieren keinen abgelaufenen Timer.
- Wiederbeitritt verändert weder Buzzer-Gewinner noch gespeicherte Reihenfolge,
  Team-Roster oder Zufallsentscheidung. Rundenwechsel setzt die passenden
  Laufzeitwerte atomar zurück und erhält Punkte.
- Nicht benötigte Modi bleiben H/S, statt das Verhalten eines Bestandsspiels zu
  verändern. Weitergehende Gleichstandsregeln erhalten keinen erfundenen Default.

### G3 — Abgaben, Matching, Bewertung und Sichtbarkeit

Die vorhandene Auswahlantwort und manuelle verbale Bewertung bilden den ersten
Vertrag. Freitext, Zahlen, mehrere Felder und Reihenfolgen werden als getrennte
Bedarfe erfasst; ein String-Feld allein gilt nicht als fertiger Vertrag dafür.

Abschlusskriterien:

- Eigentümer, Partie, Runde, Abgabezustand und Frist werden serverseitig geprüft.
  Abgabe, Lock und Bewertung haben definierte Wiederholungs-/Korrekturregeln.
- EXACT und MANUAL_ONLY sind mit ihren realen Verbrauchern belegt; Normalisierung,
  Synonyme und Fuzzy bleiben nach tatsächlichem Integrationsstand gekennzeichnet.
  Eine Fuzzy-Ähnlichkeit ersetzt keine bestätigte Bewertung.
- Eine angebotene Bewertung hat eine definierte Punktewirkung einschließlich 0
  und Teilpunkten. Andere Entscheidungen werden kontrolliert zurückgewiesen.
- Private Abgaben und Lösungen bleiben über Projektion, Resync, Pause, Recovery
  und Fehlerausgaben geschützt. Verwaltungsrechte ändern keine Informationsrolle.
- Für künftig benötigte Eingabeformen sind Verbraucher und Entscheidungslücken
  benannt. Es werden keine ungenutzten UI-/Datenbankmodelle pauschal angelegt.

### G4 — Gemeinsame Ergebnisse, Korrekturen und Mechanikschutz

Ledger, versionierte Round-/GameResults, Finalisierung, Amendments und Recovery
existieren bereits. Hier werden ihre Anschlüsse an geänderte Mechaniken geprüft;
sie werden nicht nochmals parallel implementiert.

Abschlusskriterien:

- State, Score und Ereignis werden atomar geschrieben; ein Fehler rollt alle
  fachlichen Wirkungen zurück. Historische Korrekturen verändern keine neuere Partie.
- Ergebnis, Rang und Teamwertung verwenden denselben gespeicherten Nachweis.
  Geteilte Plätze sind belegt; weitere Strategien bleiben ohne Spielentscheidung offen.
- Erlaubte Korrekturen erzeugen Gegen-/Änderungsnachweise. Bereits veröffentlichte
  Informationen werden nicht als rückgängig gemacht ausgegeben.
- Der Aktionsabgleich aus G1 erfasst vorhandene HTTP-/Medien-Limits und mögliche
  Lücken bei Spiel-Sockets. Notwendige Limits werden pro Aktion begründet; kein
  globales Limit bestraft einen gemeinsamen NAT-Anschluss oder einen anderen Raum.
- Fehlerdiagnosen enthalten Kontext/traceId, aber keine Lösungen oder Tokens.
  Zusätzliche Messwerte werden nur für einen konkreten Prüffall eingeführt.
  Ein plattformweites Monitoring-/Analytics-System gehört nicht in dieses Paket.

### G5 — Verbraucher-Abnahme und gemeinsame Bedienung

Die drei vorhandenen Spiele werden am fertigen Grundlagenstand als echte
Verbraucher geprüft. Bestehende Result-, Recovery-, Buzzer- und Medienoberflächen
werden weitergenutzt. Gemeinsame UI wird nur bei tatsächlich gleichem Verhalten
zusammengeführt; kein vorgezogener Designwechsel.

Abschlusskriterien:

- Eine abschließende Matrix benennt pro Baustein den belegten Umfang, echte
  Verbraucher, passende HTTP-/Socket-/DB-/Browsernachweise und verbliebene H/S-Punkte.
- Für Änderungen bestehen aussagekräftige Regressionen für Berechtigungen,
  konkurrierende/duplizierte Befehle, Fristgrenzen, Neustart und Secrets.
- Typecheck, Lint, Build und die vorgesehene CI/E2E-Abnahme sind am endgültigen
  Code-Head erfolgreich. Alte Läufe werden nicht auf neuen Code übertragen.
- Der Review prüft speziell die Nacharbeiten aus PR15–19: Wartelisten-Isolation,
  gemeinsame Viewer-Kapazität, vollständige Recovery-Evidenz, 0 Punkte und
  beidseitigen Medien-Neustart. Es gibt keine zusätzliche lokale Vollwiederholung
  ohne Änderung, Fehler oder begründeten offenen Befund.
- Offene Spiele bleiben im Katalog PLANNED. Keine simulierte Engine zählt als
  reales Spiel oder als zweiter Core-Verbraucher.

## Nach diesem Block: gezielte Mechanikcluster

| Cluster | Konkrete Verbraucher | Was bis dahin offen bleibt |
| --- | --- | --- |
| Abstimmung/anonyme Optionen | Imposter, Undercover, Geheim Agent | Selbstwahl, Nichtabgabe, Tie und Ergebniswirkung je freigegebener Spielregel. |
| Geheime Rollen | Undercover, Geheim Agent | Rollenverteilung, Kenntnisse eines mitspielenden Hosts und Siegbedingungen. |
| Leben/Teilnahmestatus | Last Man Standing, Undercover; DDF als Vorschlag | Timeout, Ausscheiden, weitere Leserechte und Endbedingungen. |
| Zahlen/Mehrfeld/Reihenfolge | Schätz mal, Stadt Land Fluss, Timeline, Gleicher Gedanke | Eingabeform und Wertungsfunktion nicht zu einem universellen String-Scorer vermischen. |
| Audio-Zeitplan | Erkenne den Song | Live-Voice ist nicht dieselbe Mechanik wie synchroner Clip-Start, Seek und Pauseposition. |
| Würfel/Brett/Bieten | Yacht, Raus damit!, Wie weit gehst du? | Gespeicherter Serverzufall wird geteilt; Scorecard, Kollisionen und Bietende bleiben spielbezogen. |

Diese Cluster sind keine unbemerkte Erweiterung von G1–G5. Gemeinsam benötigte
Verträge können danach vor den jeweiligen neuen Engines entstehen; finale
Verbraucher-Abnahme folgt mit den passenden Spielen. Unbestätigte DEC-Vorschläge
werden nicht durch einen technischen Standardwert fachlich freigegeben.

## Abschluss und Git-Arbeitsweise

Der Grundlagenblock endet mit einer nachvollziehbaren Matrix und nutzbaren,
abgenommenen Verbesserungen an den bestehenden Verbrauchern. Er endet nicht mit
der Behauptung, alle Mechaniken sämtlicher künftiger Spiele seien fertig.
Accounts/Profile, Events über mehrere Spiele, XP/Statistiken, Admin-Ops,
Quotas/Retention, Hosting/TURN, PWA/i18n und ein UI-Neudesign bleiben eigene Pakete.

Je Umsetzungspaket ein kleiner Branch direkt vom aktuellen main. Keine gestapelte
Feature-Kette. Zwischenstände committen und pushen, den konkreten Prüfstand im
Handoff festhalten, keine fremde Arbeit überschreiben. Ein PR wird nur gegen die
richtige Base abgenommen. Merges führt weiterhin der Nutzer aus. Falls der
Vorgänger noch nicht in main liegt, bleiben unabhängige Arbeiten auf main; eine
abhängige Umsetzung wartet auf dessen Integration.

Aktueller Fortschritt und nächste ausführbare Aufgabe: [Handoff](handoff.md).
