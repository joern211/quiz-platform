# N5 — Geheime Rollen und gezielt freigegebene Informationen, technische Grundlage: Design

Base: `main` @ `c09266b7c7c33eb911e0aa1d3151c5312d0b6cd8` (N1–N4 gemergt, N4 = PR #33; main-CI-Lauf 41340969657 grün). Arbeitsbranch `claude/new-session-im4em9` (vom Sitzungsrahmen vorgegeben, direkt von `main`; kein gestapelter Feature-Zweig). Einziger weitere offene PR beim Start: #21 (historischer Plan-Draft, keine Basis).
Status: **N5-Grundlagenpaket umgesetzt und reviewbereit; kein produktiver Verbraucher, vollständige Core-DoD offen** (Master §13.2 verlangt zwei echte Game Engines; N5 hat **0** neue echte Verbraucher, Tests/Harness zählen nicht).

## 1. Scope und ausdrückliche Grenze

Geliefert: ein serverprivater, unveränderlicher **Deal** (Rollen-Zuordnung + Informationsfragmente + additive öffentliche Freigabe), ein clienttauglicher **Projektionsvertrag**, eine reine **selektive Release-Funktion**, eine rollenbezogene **Projektion** und die Midnight-Komponente `SecretInfoCard`; Tests; Integrationsanleitung; kleine Medien-Testkorrektur (eigener Commit `277fd34`, siehe `review.md`).

Nicht geliefert (absichtlich): keine Undercover-/Geheim-Agent-/Imposter-Engine, keine Katalogfreischaltung, keine Spiel-/Testroute, kein Reveal-Command, kein Socket-/HTTP-Endpunkt, keine neue DB-Tabelle/Migration, keine Rollenpresets, keine automatische Rollenauslosung, keine Spieler-/Rollenzahlen als Defaults, keine Hinweis-/Abstimmungs-/Eliminierungs-/Punkte-/Siegregel, kein automatisches Reveal bei Runden-/Spielende oder Abstimmung, keine vollständige Host-Vorschau, keine Team-Wissensvererbung, keine Knowledge-History. Bestandsengines unberührt.

Quellen: Arbeitsauftrag N5 (01.11.2026); Master §§2, 4.10–4.12, 5.15–5.24, 5.28–5.30, 6.3, 6.10, 10.7, 13.2, 15.15, 15.17; `docs/specs/pr12/{technical-mapping.md,games/undercover.md,games/secret-agent.md}` nur als Vorschlagsquelle (siehe `decisions.md`); N4-Dokumente und -Code als Muster.

## 2. Drei strikt getrennte Dinge

1. **Tatsächlich zugewiesene Rolle** (serverprivat): `assignments[]`. Sie erscheint in **keiner** Projektion. Wer eine Rolle hat, kennt sie dadurch nicht.
2. **Gezielt an einzelne Teilnehmer freigegebenes Wissen**: Fragmente mit explizitem Empfängerkreis → Feld `own`. Eine eigene Rolle wird nur bekannt, wenn ein späterer Verbraucher dafür ausdrücklich ein Fragment an den Teilnehmer adressiert.
3. **Ausdrücklich öffentlich freigegebene Informationen** → Feld `released`. Nur Titel + Text; weder die ursprünglichen Empfänger noch eine Rollenkarte werden dadurch öffentlich.

Rolle und Wissen sind unabhängig: dieselbe Rolle für mehrere Teilnehmer mit verschiedenem Wissen; ein Teilnehmer mit Rolle und null Fragmenten; ein Fragment für mehrere Empfänger; ein Teilnehmer mit mehreren Fragmenten; ein Fragment ohne Empfänger (existiert nur serverseitig, bis es öffentlich freigegeben wird). „Kein Begriff“ ist kein ungültiger Zustand und keine fehlende Zuweisung — ein Verbraucher gibt der Rolle einfach kein Fragment. Wann ein Spiel das tut, entscheidet N5 nicht. Es gibt keine Vererbung über Rolle, Team oder Host-Rechte.

## 3. Vertrag `@quiz/shared/secretInfo` (clienttauglich)

Subpath-Export, eigenständige Strip-only-Datei (nur `import { z } from 'zod'`; getestet). Sie enthält **nur**: Konstanten/Grenzen, Feldschemas (IDs, Labels, Textpolicy), `SecretInfoProjectionSchema` samt `parseSecretInfoProjection`, `secretInfoProjectionMatches`, `secretInfoContextKey`, code-only `SecretInfoError`. **Kein** serverprivater Zustand, kein Deal-Schema, keine Rollenmap; ein Test stellt sicher, dass der Export keinen entsprechenden Namen trägt.

`SecretInfoProjection` = `{ contract: 'SECRET_INFO_V1', scope: { runIndex, roundId, dealId, revision }, own: { participantId, fragments: [{ title, text }] } | null, released: [{ title, text }] }`, `.strict()` auf jeder Ebene: kein Platz für Rolle, Fragment-ID, Empfänger, Zuordnung, Seed, Team, Zeit. `scope` sind nicht-geheime Labels zum Binden an den erwarteten Kontext. **`dealId` und `revision` müssen opake Serverlabels sein** (nie aus Rolle/Begriff oder einem Hash geheimer Inhalte abgeleitet); der Vertrag kann ein unglückliches Label nicht erkennen — Aufruferpflicht.

**Textpolicy.** Titel: dieselbe Einzeilenregel wie N2/N3/N4 (Paritätstest gegen das N4-Label). Fragmenttext zusätzlich mit einfachen Zeilenumbrüchen (U+000A), sonst keine Steuerzeichen, kein CR, keine Bidi-/Lone-Surrogate-Zeichen, nicht leer/blank, ohne Rand-Leerraum. Gerendert wird ausschließlich Plaintext.

**Grenzen (benannte Konstanten, technischer Schutz — keine Spielersettings, keine PR12-Defaults):** 1–100 Teilnehmer (= obere Grenze `maxPlayers` der Raumerstellung), 1–32 Rollen, 0–200 Fragmente, ≤ 2000 Empfängerverknüpfungen insgesamt (Zustand ≤ ≈ 0,4 MB), ID ≤ 40 (`^[a-z][a-z0-9_-]*$`, reservierte Namen abgelehnt), Referenz ≤ 80, Teilnehmer-/Runden-ID ≤ 200, Titel ≤ 80, Text ≤ 1000 (UTF-16-Einheiten wie in N4) und ≤ 20 Zeilen. Bounds werden **vor** jedem Quervergleich geprüft (Refinements laufen in Zod auch für „dirty“ Arrays; deshalb ein ausdrücklicher Frühausstieg `LIMIT_EXCEEDED`, getestet).

**Fehler.** `SECRET_INFO_*`-Codes in der zentralen Whitelist `PUBLIC_CODES` (`core/errors.ts`), `SecretInfoError.message === code`, zusätzlich code-only `issues` (nur Art des Verstoßes, nie ein Wert/eine ID/ein Pfad). Nur eigene Custom-Codes überleben; jede strukturelle Zod-Meldung (kann Eingaben zitieren, z. B. unbekannte Schlüssel) wird zu `SHAPE_INVALID`.

## 4. Domain `apps/server/src/games/core/secretRoleDeal.ts` (serverprivat)

Reine Funktionen über serialisierbaren Zustand. Keine Uhr, kein Zufall, kein Socket/DB, keine Punkte, keine Authentifizierung. `audience`, erwarteter Scope und `now` kommen von der Admission-/Command-Grenze des späteren Verbrauchers, nie aus einem Clientpayload.

`SecretRoleDealState` (`kind: 'SECRET_ROLE_DEAL'`, `schemaVersion: 1`): `runIndex`, `roundId`, `dealId`, `revision`, `participantIds[]`, `roleIds[]`, `assignments[{participantId, roleId}]`, `fragments[{fragmentId, title, text, recipientIds[]}]`, `released[{fragmentId, releasedAtMs}]`. Arrays + `Set`/`Map` statt freier Objektschlüssel. Beim Laden werden Struktur **und** Invarianten geprüft: eindeutige Teilnehmer/Rollen/Fragmente, jede Zuordnung zu bekanntem Teilnehmer und bekannter Rolle, **exakte Abdeckung** (keine Lücke, kein Zusatzteilnehmer, genau eine Rolle je Teilnehmer), Empfänger bekannt und eindeutig, jedes Release verweist auf ein vorhandenes Fragment, keine Dubletten. Beschädigtes/manipuliertes → `SECRET_INFO_STATE_INVALID`; nichts wird repariert, ergänzt, gekürzt oder still verworfen.

- `createSecretRoleDeal(input)`: nimmt **konkrete serverseitig entschiedene** Zuweisungen (kein „AUTO“, kein stilles n−1, keine Clientzufallswerte, keine Presets). Exakte Eingabeschlüssel (kein `kind`/`schemaVersion`/`released` von außen). Zuordnungen und Empfänger werden in Rosterreihenfolge abgelegt (Mengensemantik; ihre Eingabereihenfolge trägt keine Bedeutung), Fragmente behalten die gegebene Reihenfolge (sie legt die Ausgabereihenfolge fest). Die Eingabe wird nicht behalten; die Rückgabe teilt keine Referenz mit ihr.
- `secretRoleDealScopeOf(state)`.
- **Scope.** Jede Funktion, die einen Deal ändert oder daraus für diesen Aufruf projiziert, erhält den erwarteten Scope (strikt typgeprüft). Feste Fehlersemantik für **jeden** veralteten Zugriff (Änderung und Projektion gleich; eine veraltete Projektion wird abgewiesen, nie „leer“ geliefert): ungültiger Scope → `SECRET_INFO_SCOPE_INVALID`; anderer Run/andere Runde → `STALE_ROUND` (bestehender Code); anderer Deal derselben Runde → `SECRET_INFO_DEAL_STALE`; andere Revision → `SECRET_INFO_REVISION_STALE`. Ein zweiter Deal derselben Runde übernimmt weder Rollen, Wissen noch Releases des ersten (getestet in beide Richtungen).
- **Revision** ist opak und an den eingefrorenen Deal gebunden. Der Helfer kann nicht verhindern, dass unter derselben `dealId`/`revision` ein fachlich anderer Deal erzeugt wird (Test dokumentiert das ausdrücklich) — **Erzeugung und eindeutige Persistenz der Labels ist Aufgabe des späteren echten Verbrauchers** (einmal vergeben, z. B. UNIQUE auf Raum + Run + Runde + dealId; nie aus Rollen/Begriffen oder deren Hash ableiten).
- **Unveränderlichkeit.** Zuweisungen, Empfänger und Fragmentinhalte sind nach der Erstellung fixiert; keine Reassign-/Edit-/Transfer-/Unreveal-Funktion (ein Test prüft die Exportliste). Änderungen brauchen später einen bewusst neuen Deal und eine eigene Engine-Entscheidung. Bereits gesehenes Wissen lässt sich durch kein Verbergen zurücknehmen.

### 4.1 `releaseSecretInformation(state, { scope, fragmentIds, now }) → { state, changed }`

Reihenfolge der Prüfungen: gespeicherte Daten → Argumentform → Scope → Zeit → Batch. Der Helfer authentifiziert keinen Host und entscheidet keine Phase.

- Ohne Aufruf ist nichts öffentlich. Kein `revealAll`, kein Wildcard; die Auswahl ist eine ausdrückliche, **nicht leere** Liste bekannter Fragment-IDs.
- **Alles oder nichts**: unbekannte, falsch typisierte oder doppelte ID im Batch (konsistent als Fehler, nicht still vereinigt), leerer oder überlanger Batch → `SECRET_INFO_RELEASE_INVALID` ohne Teilfreigabe; der Eingabezustand bleibt unverändert.
- **Idempotent**: bereits Freigegebenes erneut freigeben ist wirkungslos (`changed: false`, erster Zeitpunkt bleibt); ein gemischter Batch ergänzt nur die neuen IDs mit `now`.
- Nur der Veröffentlichungsstatus der gewählten Fragmente ändert sich; Rollen, Empfänger, andere Fragmente, Inhalte bleiben. Kein Zurücknehmen.
- `now` = vom Aufrufer gelieferte Serverzeit (sichere nichtnegative Ganzzahl, sonst `SECRET_INFO_TIME_INVALID`); serverprivat, nie projiziert, nie entscheidend. Das Log wird in **Fragmentreihenfolge** geführt: verschiedene zulässige Release-Reihenfolgen (innerhalb eines Batches, über mehrere Aufrufe) ergeben dieselben IDs und dieselben Projektionen.

### 4.2 `projectSecretInfo(audience, state, expectedScope) → SecretInfoProjection`

Neue Ausgabeobjekte über eine kleine Allowlist (kein Spread des privaten Zustands); das Ergebnis wird zusätzlich gegen das strikte Clientschema geprüft (`safeParse`, nie eine `ZodError`).

- `audience` ist das bestehende `ProjectionAudience`. **Es gibt keinen ADMIN-Eintrag und N5 fügt keinen Shortcut hinzu.** Die Informationsrolle ist die **aktuelle Spielrolle** aus dem bestehenden Rollen-/Admission-Mapping: ein mitspielender Host oder Administrator wird mit `PLAYER` projiziert und bekommt genau das Wissen eines Spielers; ein nicht mitspielender Administrator wird `VIEWER` (oder `HOST`, falls ihn das bestehende Mapping dazu macht). Verwaltungsrechte öffnen kein fremdes Secret. Eine Rolle außerhalb der vier (z. B. `ADMIN`) oder eine ungültige `participantId` → `SECRET_INFO_AUDIENCE_INVALID` (kein Raten).
- `own`: nur für `PLAYER` mit participantId aus dem Deal; genau die an diesen Teilnehmer adressierten Fragmente über die bestehende Regel `canView(PLAYER_PRIVATE)` je Empfänger (keine Team-Regel, kein `blindHost`-Pfad), nur `{ title, text }`, in Fragmentreihenfolge. Ein Teilnehmer ohne Fragment erhält eine leere Liste. **Nie**: Rollen-ID, Verteilung, Rollenanzahl, fremde Teilnehmer/Empfänger, andere Fragmente, interne IDs, Seeds.
- `released`: für alle vier Informationsrollen, nur Titel + Text freigegebener Fragmente. Vor jeder Freigabe ist das für alle `[]`; zwei Deals mit unterschiedlicher Fragment-/Teilnehmeranzahl und gleichen Scope-Labels liefern vor der Freigabe **byte-identische** öffentliche Projektionen (Test) — kein „5 Geheimnisse, 1 sichtbar“. Ein Fragment, das zugleich adressiert und freigegeben ist, erscheint in beiden Listen (das eigene Wissen wird nicht entzogen).
- **HOST** (blind oder nicht, auch mit Teilnehmer-ID oder Zusatzrechten) bekommt in diesem begrenzten Vertrag **keinen** privaten Teil und keine Rollen-/Begriffsübersicht. Eine ausdrücklich autorisierte Vorschau für einen nicht mitspielenden Host ist offen; **nicht** über `canView(HOST_PRIVATE)` öffnen (ein Test belegt, dass dieser Helfer sie öffnen *würde*, die Projektion es aber nicht tut).

## 5. Komponente `SecretInfoCard` (`apps/web/src/components/SecretInfoCard.tsx`)

Keine Socket-/Sessionverwaltung, kein Submit, keine SUBMITTED/LOCKED/ACK-Maschine, keine serverseitige Lesebestätigung, keine neuen Intents. Props: `expected` (Run, Runde, Deal, Revision, Empfänger aus dem **eigenen** authentifizierten Kontext des Aufrufers), `projection | null | undefined`, `title?`. Nie der Deal, nie eine Rollenmap.

- **Bindung vor dem Rendern.** Die Projektion wird beim Rendern mit dem strikten Schema geprüft und mit `expected` verglichen; fremde/veraltete/ungültige/private-teil-lose Projektionen rendern nie Inhalt — auch nicht einen Frame lang (Test mit `renderToStaticMarkup` ohne Effekte, plus Aufzeichnung des DOM bei **jedem** Commit). Kein nachträglicher Reset-Effekt.
- **Anfangs eingeklappt.** Neutrale Beschriftung, nativer `<button>` („Anzeigen“/„Verbergen“, `aria-expanded`, `aria-controls` auf ein stets vorhandenes, im Zustand „verborgen“ leeres Panel). Texte stehen verborgen **nicht** im DOM, in keinem `aria-label`, `title` oder `data-*`. Der eingeklappte Zustand ist für 0, 1 und viele Fragmente identisch (Test), auch „keine Informationen“ erscheint erst nach dem Öffnen.
- **Verbergen ist nur Schutz vor beiläufigem Mitlesen.** Die Daten wurden dem berechtigten Browser bereits zugestellt; es ist keine serverseitige Zugriffskontrolle und macht Gesehenes nicht rückgängig.
- **Kontextwechsel.** Der Offen-Zustand hängt an einem Schlüssel aus erwartetem Kontext (+ Inhalts-Fingerabdruck, der nie ins DOM gelangt). Run-/Runden-/Deal-/Revisions-/Empfängerwechsel, Entzug oder geänderter Inhalt → wieder verborgen; Rückkehr zu einem früheren Schlüssel „weckt“ keinen alten Offen-Zustand. Parent-Rerender, neue gleiche Props und Theme-/Akzentwechsel behalten ihn (Test inkl. DOM-Knotenidentität).
- Nur Plaintext (React-Textknoten, `white-space: pre-wrap`, `overflow-wrap: anywhere`), kein Timer, keine Animation, kein Audio, keine Live-Region, Fokus bleibt auf dem Button. Touchfläche ≥ 44 px (≥ 48 px Höhe), nur Midnight-Tokens, sichtbarer 3-px-Fokusring.
- Die Komponente zeigt nur `own`. Die öffentliche Anzeige freigegebener Texte (`released`) für Viewer/Display ist Sache eines späteren Verbrauchers.
