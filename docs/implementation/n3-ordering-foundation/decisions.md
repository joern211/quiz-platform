# N3 — Entscheidungen und offene Spielregeln

**Master** = verbindlich festgelegt, **PR12** = unbestätigter Entwurf (`docs/specs/pr12/…`), **N3** = Routineentscheidung dieses Pakets (technisch, begründet). Keine erneute Grundsatzfrage zu Rollenmodell, Serverautorität oder Katalog.

## 1. Master-Festlegungen, die N3 bindet

- §15.8: Timeline ist ein **eigenständiges** Spiel; mehrere Items werden chronologisch oder nach numerischem Wert in Reihenfolge gebracht; **nicht** Higher or Lower. → N3 liefert keine Engine und ordnet nichts bestehenden Spielen zu.
- §5.14/§5.15/§10.7: private Antworten bleiben bis Reveal geheim; Secrets nie vorsorglich an falsche Clients; nicht nur die UI verstecken. → Referenz nicht im Zustand, nicht in Config/Props, keine Vergleichsdaten vor Reveal.
- §5.16/§6.11: Entscheidungen persistieren, nie neu würfeln; BLIND_HOST darf Secrets nicht rekonstruierbar machen. → Startreihenfolge im Scope gepinnt; **kein Referenz-Hash** im Zustand (§3 Punkt 4).
- §2.2: Admin-/Hostrechte sind keine Informationsrechte. → Projektion gibt Host/Co-Host nichts Privates.
- §12.15: jede fachliche Änderung erhöht die Revision. → Eine Referenzrevision hat unveränderlichen Inhalt (Pflicht des Content-Snapshots).
- §13.2: Core-DONE verlangt zwei echte Engines. → N3 bleibt **H** (siehe `matrix.md`).

## 2. Wirklich offene Timeline-Regeln (DEC-TIM-01 und Umfeld) — blockieren N3 nicht

| # | Thema | Stand | Empfehlung | Folge für die Engine (N3 liefert) |
|---|---|---|---|---|
| 1 | Punkte je Position (PR12: 20), Bonus (PR12: 50), 0/100-Formel | PR12 | erst bestätigen, dann als Konfiguration | N3 schreibt nie Punkte; `matchedPositions`/`complete`/`positions` sind Fakten |
| 2 | Gleiche Jahres-/Zahlenwerte (PR12: `TOLERATED_TIES` als Standard) | PR12 / offen | Spielentscheidung vor der Engine | N3 unterstützt ausdrücklich vorgegebene Äquivalenzgruppen, **leitet sie aber nie ab** und setzt keinen Standard |
| 3 | Richtung (aufsteigend/absteigend), Default-Richtung | offen | je Aufgabe konfigurieren | Richtung = Referenzaufbereitung der Engine; keine Umkehrung im Comparator |
| 4 | Speed-Bonus / Zeitwertung | PR12 | zunächst aus | keine Zeitwertung in N3 |
| 5 | Itemzahl je Runde (PR12: 5 bzw. 4–7), Rundenzahl, Fristen | PR12 | Engine-/Content-Konfiguration | N3: 2–12 nur als Schutzgrenze |
| 6 | Team-Modus/-Gerät, Host-Preview, Reveal-Timing | PR12 | gesondertes Paket | Projektion: Team gibt keine Einsicht; Vorab-Einsicht für Judge = spätere Informationsrolle |
| 7 | Teilabgaben, `sort.update` mit Zwischenständen, frühzeitiges `sort.lock` | PR12-Vorschlag, **nicht** vereinbart | nein, solange nicht bestätigt | N3: nur vollständige, einmalige Abgabe; Rundenlock ist `closeOrderingRound` |
| 8 | Teilwertung (z. B. Anzahl richtiger Positionen zählt Punkte) | offen | Spielentscheidung | `matchedPositions` hat keine globale Bedeutung |
| 9 | Nachträgliche Änderung/Reopen | offen (nicht beschlossen) | nein | Abgabe unveränderlich; Vergleich nur idempotent, Korrektur über den zentralen Pfad |
| 10 | Referenzquelle (Datums-/BC-/Zeitzonen-/Gleitkomma-Normalisierung, Content-Editor) | offen | eigenes Content-Paket | N3 nimmt eine vorgegebene Reihenfolge entgegen |

## 3. Routineentscheidungen von N3 (mit Begründung)

1. **Eigener Subpath und eigenständige Datei.** `@quiz/shared/ordering`, additiv; `SubmissionRecord.value` bleibt string/null. Keine relativen Imports (Strip-only), daher die N2-Textpolicy dupliziert + Paritätstest.
2. **Schutzgrenzen 2–12 Items**, ID 40, Label 120, Hilfe 200 — keine Spielregel (§2 in `design.md`).
3. **Zwei Identitäten:** `orderingConfigKey` (inkl. Präsentationsreihenfolge, für den Serverscope) und `orderingItemSetKey` (sortiert, nur UI-Entwurf). So wird eine neu gemischte Startreihenfolge nach Rejoin abgewiesen, und die UI behält trotzdem einen Entwurf über Metadaten-Umordnung.
4. **Kein Referenz-Hash im Zustand.** Erwogen, um einen stillen Inhaltswechsel unter gleicher Revision zu erkennen. Verworfen: bei ≤ 12! Permutationen offline brute-force-bar; würde die Lösung für jeden rekonstruierbar machen, der einen Snapshot des serverprivaten Zustands sieht (§5.16, Auftrag §5). Stattdessen: opake Revision + Pflicht des Content-Snapshots zur Inhaltsunveränderlichkeit; Wiederholung mit abweichendem Ergebnis → `ORDERING_ALREADY_COMPARED`.
5. **Referenz nicht im Zustand, sondern bei der Übernahme geliefert und validiert.** Hält Secrets aus der persistierten Struktur; die Revision wird gepinnt.
6. **Status `COMPARED` statt `JUDGED`.** Ein Vergleich ist kein Richterurteil.
7. **Vor Reveal auch dem Besitzer kein `COMPARED`/keine Fakten** (kein Orakel); Projektion von `revealed: true` nur bei geschlossener Runde.
8. **`projectOrderingSolution` ohne Vorab-Einsicht für irgendeine Rolle.** Host-Preview ist eine spätere Engine-Entscheidung.
9. **UI: Pfeil-Buttons, kein Drag & Drop**; Rand = `aria-disabled` statt `disabled` (bleibt fokussierbar); Fokus nach dem Absenden auf die Statuszeile.
10. **Geänderte Itemmenge unter demselben `contextKey`** = kontrollierter Fehler statt stillem Zusammenführen; Aufrufer ändern `contextKey` mit der Menge.
11. **Kein Timer-/Zeitbezug im Vergleich**; `now` nur an Abgabe/Lock/Übernahme.

## 4. Bekannte Grenzen

- Domain-Funktionen authentifizieren nichts; Rechte/Phase/Scope/Zeit sind Engine-Wiring.
- `validateOrdering` prüft die Größe nach dem Parsen; die Gesamtgröße des Requests begrenzen die vorhandenen frühen Request-Gates (G4).
- Die Wiederherstellung des Fokus nach dem Verschieben ist in Chromium nicht als notwendig belegt (der Browser behält ihn); sie ist eine defensive Maßnahme für andere Engines. Kein echter iPhone-/Safari-Nachweis.
- Item-IDs sind öffentlich; der Parser kann wertcodierte IDs nicht erkennen.
