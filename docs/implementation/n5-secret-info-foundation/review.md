# N5 — Eigenprüfung (getrennt von der Implementierung)

Methode: der fertige Diff wurde aus Sicht eines späteren Engine-Autors und eines fremden Clients gegen den Auftrag und den Master gelesen; zusätzlich **Mutationsprüfung** (gezielt eingebaute Lecks/Fehler, die die Tests fangen müssen). Der Medien-Testfix steht getrennt in Abschnitt B.

## A. Die Fragen aus Auftrag §14

| Frage | Befund |
|---|---|
| Wo könnte die zugewiesene Rolle ungewollt sichtbares Wissen werden? | Nirgends im Code: `projectSecretInfo` baut `own`/`released` aus `title`/`text` der Fragmente; `assignments`/`roleIds` werden nie gelesen. Tests prüfen die **serialisierten** Projektionen aller 12 Audiences in drei Freigabestadien auf Rollen-/Fragment-IDs, Zuordnungsbegriffe und Markertexte (nicht nur auf ein Feld „role“). Mutation M3 (Rollen-ID in `own`) wird gefangen (mindestens 6 Tests rot). Rest-Risiko (Aufruferpflicht, dokumentiert): ein Verbraucher, der ein Fragment mit dem Text der eigenen Rolle adressiert, macht sie **absichtlich** bekannt; ein Verbraucher, der IDs/Titel/Reihenfolge der Fragmente an Rollen koppelt, kann über die Ausgabereihenfolge **freigegebener** Fragmente Rückschlüsse zulassen (die Reihenfolge ist die Fragmentreihenfolge des Deals). |
| Host-/Team-/Admin-/„own data“-Shortcut? | Nein. HOST (blind/nicht, mit Teilnehmer-ID, mit `isAdmin`/`permissions`-Zusatzfeldern) → `own: null`; Team wird ignoriert (gleiche Antwort bei anderer `teamId`); ADMIN ist kein gültiges Audience-Role (→ `SECRET_INFO_AUDIENCE_INVALID`). Mutation M1 (Host mit ID bekommt privaten Teil) und M2 (Team-/Alle-Fragmente-Shortcut) werden gefangen (2 bzw. mindestens 5 Tests rot). Der Test belegt außerdem, dass `canView(HOST_PRIVATE)` den Host öffnen *würde* — die Projektion nutzt ihn bewusst nicht. |
| Clientschema mit internen IDs / aus Geheimem abgeleiteten Schlüsseln? | Nein: `.strict()` ohne ID-/Rollen-/Empfängerfelder; ein Test beweist die Ablehnung solcher Zusatzfelder auf jeder Ebene, ein weiterer, dass das Shared-Modul nur `zod` importiert und keine Deal-/Private-Namen exportiert. `dealId`/`revision` im Scope sind Labels des Verbrauchers — **Aufruferpflicht**, sie opak zu vergeben (dokumentiert). |
| Leakt ein selektives Reveal versteckte Metadaten oder die ganze Zuordnung? | Nein: `released` trägt nur Titel+Text; keine Zeiten, IDs, Empfänger, Anzahl nicht freigegebener Fragmente. Zwei Deals mit verschiedener Fragment-/Teilnehmerzahl liefern vor der Freigabe byte-identische öffentliche Projektionen (Test). |
| Teilweise Veröffentlichung bei ungültigem Batch / Zeit-/Zustandsänderung bei Wiederholung? | Nein: Batch wird vollständig validiert, bevor etwas geändert wird; Wiederholung liefert `changed:false` mit unverändertem ersten Zeitpunkt. Mutation M5 (unbekannte IDs tolerieren) wird gefangen. |
| Kann ein anderer Deal derselben Runde eine alte Projektion/einen alten offenen UI-Zustand übernehmen? | Domain: nein (`SECRET_INFO_DEAL_STALE`, beide Richtungen getestet; M4 „Scope in der Projektion nicht prüfen“ wird gefangen (3 Tests rot)). UI: der Schlüssel enthält die `dealId`; Wechsel → verborgen; Rückkehr → verborgen. |
| Alte Texte beim Entzug / PLAYER→VIEWER noch gerendert? | Nein: Entzug (`null`) und Viewer-Projektion (`own: null`) rendern nur den neutralen Text und keinen Button; getestet im DOM, bei jedem Commit und im Chromium-Harness. Mutation U1 (Bindung entfernt) und U2 (Reset entfernt) werden gefangen. U3 (Text nur per `hidden` verbergen) wird gefangen. |
| Verändert ein Rückgabewert unbemerkt den privaten Zustand? | Nein: alle Rückgaben sind frische Zod-Ausgaben bzw. Kopien; Tests mutieren Rückgaben, Projektionen und die Originaleingabe (auch tief eingefroren) und lesen danach den Zustand erneut. |
| Wird Zufall neu ausgeführt oder ein Empfänger aus Clientdaten autorisiert? | Nein: kein RNG/keine Uhr (Spies auf `Date.now`/`Math.random` in Parse, Projektion, Create, Replay). Empfänger stammen ausschließlich aus dem serverseitig erzeugten Deal; `audience` wird nie aus dem Deal oder Clientdaten abgeleitet. |
| Behaupten Doku/PR mehr Runtime-/Recovery-/Core-Reife als nachgewiesen? | Nein: durchgängig „H“, 0 Verbraucher, Core-DoD offen, SDK-Replay und Domainprojektion ausdrücklich nicht als Socket-/Rejoin-/Neustartnachweis bezeichnet. |
| Medien-Testfix: Reihenfolge abgesichert, alle Assertions erhalten? | Ja, siehe B. |

## B. Medien-Testfix (getrennt, Commit `277fd34`)

**Befund (vorbestehend, in N4 dokumentiert):** `live.integration.test.ts`, „restarts a receive-only viewer on both ends…“. Das `media:restart`-ACK geht nur an den Socket des Viewers (`live.ts:127`), der neue Snapshot des Spielers wird separat an dessen Socket emittiert (`live.ts:104`). Der Test las die neuen Route-IDs unmittelbar aus der Sicht des Spielers und sah gelegentlich noch die alten.
**Korrektur (nur Test, kein Produktivcode):** `vi.waitFor` auf den tatsächlichen Zustandswechsel in der Sicht des Spielers — Audio- **und** Video-Route existieren und beide IDs unterscheiden sich von den vorherigen — erst danach werden die neuen IDs übernommen und die Gegenstelle (Viewer) beobachtet. Weitere socketübergreifende Annahmen desselben Tests geprüft: Der zweite Restart (TEAM-Policy) beobachtete nur „Video-Route vorhanden“ (war vorher auch wahr); er prüft jetzt die **neue** Video-ID. Alle übrigen Lesungen gehen vom eigenen Socket aus und sind durch die Reihenfolge ACK-nach-Snapshot am selben Socket geordnet; `f.control` wartet ohnehin auf alle Beobachter.
**Erhalten:** unveränderte andere Routen, Viewer-Policy, Receive-only-Rechte, Ablehnung veralteter Signalisierung, TEAM-Policy, Host-Mute/Kamera-Hide, Kick. Kein `sleep`, kein höheres Timeout, kein Retry, kein Skip, keine abgeschwächte Assertion.
**Nachweis:** zusätzlicher deterministischer Regressionstest hält die Snapshots des Spielers bis nach dem Viewer-ACK zurück und belegt dabei, dass genau dort noch die **alten** IDs sichtbar sind (das Fenster, in dem der alte Test las und fehlschlagen konnte); danach muss die neue Sicht per `waitFor` erscheinen. Gezielte Wiederholung: 6× die „viewer“-Tests und 8× die beiden Restart-Tests, alle grün; ganze Datei 13/13.

## C. Gefundene Fehler und Nachbesserungen

| # | Befund | Ursache | Behebung / Beleg |
|---|---|---|---|
| R1 | Ein fehlerhaft typisierter erwarteter Scope (z. B. `{…, runIndex: undefined}`) wäre als „veraltet“ (`STALE_ROUND`) statt als ungültig gemeldet worden | `assertScope` prüfte nur die Schlüsselmenge, nicht die Typen | Beim Schreiben der Scope-Tests aufgefallen, **vor** dem Domain-Commit behoben: strikte Prüfung mit `SecretInfoScopeSchema` → `SECRET_INFO_SCOPE_INVALID`; Test mit acht fehlerhaften Scopes |
| R2 | Am Ende von `projectSecretInfo` hätte ein (theoretisch unerreichbarer) Schemafehler eine `ZodError` geworfen, deren Meldung Inhalte zitieren kann | `Schema.parse` statt `safeParse` | In der Eigenprüfung behoben: `safeParse` → `SECRET_INFO_STATE_INVALID` (code-only) |
| R3 | Test-Lücke: ein eigener `__proto__`-Schlüssel (wie ihn `JSON.parse` erzeugt) in der Create-Eingabe war nicht getestet | — | Test ergänzt (wird durch die exakte Schlüsselprüfung abgelehnt) |
| R4 | Werkzeugfalle: das Schreibwerkzeug löste ` `-Escapes in der Regex-Policy in echte Zeichen auf (Parse-Fehler beim Typecheck) | — | Regexe auf ASCII-Escapes zurückgesetzt und per `diff` als **identisch** mit `voting.ts` belegt; Tests nutzen `String.fromCodePoint` |
| — | Testfehler (nicht Produktcode) bei der Entwicklung: Rollenset ohne zugewiesene Rolle in einem Grenztest, falsch-positiver Marker-Regex mit `/i` (traf `RELEASE_UNKNOWN_FRAGMENT`), Testing-Library-Normalisierung von Zeilenumbrüchen | — | jeweils im Test korrigiert; keine Erwartung wurde „auf das aktuelle Verhalten umgeschrieben“ |

## D. Mutationsprüfung (Ergebnis)

Domain (38 Tests): M1 Host mit ID bekommt `own` → 2 rot · M2 Team-/Alle-Fragmente-Shortcut → 5 rot · M3 Rollen-ID in `own` → ≥ 6 rot · M4 Scope in Projektion nicht geprüft → 3 rot · M5 unbekannte IDs im Batch toleriert → 3 rot.
UI (22 Tests): U1 Bindung an erwarteten Kontext entfernt → 3 rot · U2 Reset bei Schlüsselwechsel entfernt → 4 rot · U3 Texte immer im DOM, nur `hidden` → ≥ 8 rot · U4 `key !== null &&` entfernt → grün: **äquivalente Mutante** (bei `key === null` ist `open` durch den Reset ohnehin `false`; die Bedingung ist reine Absicherung).

## E. Verbleibende, ehrlich benannte Grenzen
- Alles ist **H**: kein Socket-, Rejoin-, Resync-, DB- oder Neustartnachweis. SDK-Replay und Domainprojektion sind Vorbereitung, kein Ersatz.
- Die Helfer authentifizieren niemanden; der Verbraucher muss `audience`, Scope und `now` an seiner Servergrenze bilden.
- Der Helfer kann nicht verhindern, dass ein Verbraucher unter derselben `dealId`/`revision` einen anderen Deal erzeugt (Test dokumentiert es).
- Zeitwerte sind nicht monoton erzwungen (`now` kleiner als ein früherer Freigabezeitpunkt wird nicht abgelehnt); sie sind serverprivat und nie entscheidend.
- `SecretInfoCard`: Verbergen ist kein Zugriffsschutz; die Karte zeigt nur `own`; Layout wurde im Chromium-Emulator geprüft, **nicht** auf einem echten iPhone/Safari.
- `appError.ts` bildet die `SECRET_INFO_*`-Codes (wie N4 die `VOTING_*`-Codes) nicht ab; ein Verbraucher, der AppErrors braucht, ergänzt das.
