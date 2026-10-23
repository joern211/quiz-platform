# TEAM-ROOM — Kompatibilität

- Bestehende Räume erhalten additive Spalten, keine Umschreibung von Scores,
  Tokens oder Setup-Snapshots. `roomPolicyJson=null` liest den bisherigen PIN-
  und Viewer-Kontrakt; aktive Teilnehmer bleiben ACTIVE.
- Neue `room:command`-Commands verlangen Protokoll 1 und commandId. Payload,
  Akteur und optional stateVersion werden mit PR14-Receipts und Schreib-Fence
  geschützt. Kritische alte Spiel-Events bleiben kompatibel.
- Der bisherige `lobby:chat:lock` sperrt künftig tatsächlich den Chat, nicht den
  Raumzugang. Raumzugang hat den eigenen LOCK-Command. Player senden keinen
  Broadcast-Chat; Host/Co-Host nutzen den gemeinsamen Feed.
- Der Rate-Limiter-Test verwendet weiter echte Produktions-Requests. Seine
  synthetische Engine erlaubt nun auch die dort vorgesehenen 30 Teilnehmer;
  Room-Limit und Engine-Limit müssen beide erfüllt sein.
- Jeopardy/WID akzeptieren PAUSED-Projektionen; alte Engines mit unbekannter
  Phase dürfen weiterhin keine Spielaktion ausführen. Spielende bleibt ENDED
  mit RESULTS. Der öffentliche Raum-Lifecycle ist davon getrennt abgeleitet.
- Früherer Host und neuer Verwaltungs-Host wechseln keine Informationsrolle.
  Nach Gerätewechsel verliert das alte Socket Kanal und Aktionsidentität;
  Token-Replay erzeugt keinen zweiten Gerätewechsel.
