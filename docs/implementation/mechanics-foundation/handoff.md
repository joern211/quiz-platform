# Wiederaufnahme — Grundlagenblock Spielmechaniken

Stand 30.10.2026. Auftrag: gemeinsame Mechaniken vor neuen Spielen vervollständigen,
mit begrenztem Umfang, echten Verbrauchern und prüfbaren Abschlusskriterien.

- Produktbasis: main `75013448ebf7065daad4b64a90ce568c85d11d3b`.
- Planung: [Plan](plan.md), [Bestandsaufnahme und 19 Spielzuordnungen](inventory.md).
- G0 / Planung: erstellt; Quellen, Codepfade, Teilintegration und spätere Cluster
  sind dokumentiert. Dieser Stand verändert keinen Produktcode.
- G1–G5: geplant, noch nicht als umgesetzt oder laufzeitgeprüft kennzeichnen.
- Keine neue Engine, keine vorgezogenen unbestätigten Spielregeln, kein Merge
  durch den Agenten. Regelmäßige Commits/Pushes bleiben autorisiert.

## Nächste ausführbare Aufgabe: G1

1. Remote-main und offene PRs abgleichen, vorhandene Arbeit erhalten. Produktänderungen
   erhalten einen neuen Branch direkt von main. Unabhängige G1-Untersuchungen können
   bereits gegen main erfolgen; dieser Plan ist auch auf dem Planungsbranch referenzierbar.
2. Tatsächlich registrierte Eingänge in `sockets/game.ts`, `sockets/index.ts`,
   `games/jeopardy/events.ts` und den WID-Events gegen `core/engineContract.ts`,
   `actionRules.ts`, `receiptedAction.ts` und UI-Controls abgleichen.
3. Die G1-Befehlsmatrix mit konkreten Payload-/Rechte-/Phasen-/Receipt-/State-/
   Eventpfaden ausfüllen. Bestehende Receipt-/Legacy-Semantik kenntlich machen.
4. Nur belegte Vertragslücken beheben und für die geänderten Grenzen echte
   Regressionen ergänzen. Kein generischer Dispatcher-Refactor ohne Bedarf.
5. Zwischenstand sichern, gezielt prüfen und den eigenen finalen Code-Head in CI
   abnehmen. Danach G1-Ergebnis und verbleibende Punkte hier eintragen.

Die Statuswerte alter Handoffs sind historische Zwischenstände. Den Produktabschluss
PR15–19 belegt die Integration durch PR20 samt main-CI, nicht die dort verbliebenen
Draft-/Push-/Browser-Zwischenmeldungen. Eine vollständige Master-Abnahme und spätere
Plattformpakete sind weiterhin getrennt.
