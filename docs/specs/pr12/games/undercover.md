# Undercover (`undercover`) — Spezifikation

**Status main:** PLANNED, keine Engine. **Ziel-PR:** PR32 (nach PR14–20).
**Slug FEST** (§14/§15.15). **Getrennt von Imposter** (FEST).

## 1. Kurzbeschreibung & Regelquellen

Social-Deduction: eine (oder mehrere) Spieler haben einen **anderen
oder keinen** Begriff, die anderen den gemeinsamen. Alle geben
der Reihe nach kurze Hinweise zum eigenen Begriff; nach jeder Runde
wird abgestimmt — wer rausgt, verliert. Siegesbedingungen je nach
Rollenverteilung.

- FEST §15.15: getrennt von Imposter; geheime Rollen/Begriffe, eine/
  mehrere Personen mit anderem/keinem Begriff, Hinweise, Diskussion,
  Voting, ggf. Eliminierung; Secret Role/Visibility Core zwingend.
- OFFEN: exakte Rollenverteilung (1 Undercover vs. n? mehr?),
  Tie-Regeln, Win Conditions, Rundenanzahl → DEC-UND-01.

## 2. Feste Regeln (Prinzip)

- Rollen: n−1 haben Begriff A (Agenten), 1 (+ optional mehr) hat
  Begriff B oder **keinen** (Undercover/Marionette) — Vorschlag:
  1 Undercover mit eigenem (ähnlichem, nicht identischem) Begriff.
- Hinweis-Runde: reihum (Turn-Core), jeder ein kurzes Wort/Zeichen
  zum eigenen Begriff (nicht den Begriff selbst, keine Zahlen,
  keine eigenen Namen — Vorschlag: Server-Filter + Host-Override).
- Voting: nach jeder Hinweisrunde, meisten Stimmen → raus (Eliminiert);
  Tie → keine Elimination (Vorschlag, DEC-UND-01).
- **Win Conditions (Vorschlag):**
  - Untercover bleibt bis alle Agenten raus → Undercover gewinnt.
  - Untercover wird eliminiert → Agenten gewinnen.
  - Optional: 3 Runden ohne Elimination → Agenten gewinnen (Vorschlag).
- **Secrets:** eigener Begriff `PLAYER_PRIVATE`; Rollen-Verteilung
  `HOST_PRIVATE`; Hinweise werden PUBLIC nach Aussprechen
  (das ist Spielinhalt).

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 4 / 10 | V (DEC-UND-01) |
| Teams | nein (individuell, Rollen-basiert) | V |
| Host-Mitspiel | erlaubt; Host sieht Rollen (Secret Core) — Info-Vorteil: Host kennt die Begriffe → **VORSCHLAG:** Host-Modus „blind" (Host sieht nur, wer raus ist, nicht die Begriffe — wie bei Wer-ist-das-Host-Gate, aber hier: Host-Content-Preview OFF) | V |
| Secrets | eigener Begriff: PLAYER_PRIVATE; Begriffe aller + Rollen: HOST_PRIVATE; Hinweise: PUBLIC (nach Aussprechen) | F (Prinzip) |

## 4. Setup (Ziel)

```
UndercoverSetup {
  pools: ContentPoolRef[]           // Begriffspaare (A + ähnliches B)
  undercoverCount: number (default 1)
  roundMax: number (default 3)       // max Hinweisrunden, danach Win-Check
  perRound: {hintTimerMs (default 30000), voteTimerMs (default 30000),
             discussionMs (default UNLIMITED, Host gesteuert)}
  turnOrder: RANDOM (seedRef)
  scoring: {survivorBonus: 100 (Untercover bei Sieg), agentBonus: 50 (je verbleibendem Agenten bei Sieg)}
  hintRules: {noNumbers: true, noOwnName: true, maxLength: 20}
  hostCanPlay: boolean (default true, blind-Modus)
  language: de-DE
}
```

- Quick: SYSTEM-Pool „Undercover-Begriffe", 1 Undercover, 3 Runden.
- Preflight: ≥4 Spieler, Pool READY (Begriffspaare: A + B, A≠B, ähnlich).

## 5. Content-/Editor-Schema

- Item = `UndercoverPair`: agentWord (A), undercoverWord (B),
  category?, difficulty, tags, hints? (Beispiel-Hinweise, HOST_ONLY).
- READY: A + B gesetzt, A ≠ B, Sprache.
- **Wichtig:** Begriffe sind Content (serverseitig); Spieler-Hinweise
  sind Submissions.

## 6. Phasen/Commands

```
INTRO (Rollen-Zuteilung, Privat-Ansicht) → (je Runde) HINT_TURN_1 → … → HINT_TURN_n → DISCUSSION (optional, UNLIMITED) → VOTE_OPEN → VOTE_LOCKED → REVEAL (meiste Stimmen → ELIMINATED) → WIN_CHECK → … → GAME_END (WINNER: UNDERCOVER|AGENTS) → FINALIZED
```

| Command | Rolle | Phase |
|---|---|---|
| `hint.submit` (text) | aktiver Spieler | HINT_TURN_i |
| `discussion.end` | HOST | DISCUSSION |
| `vote.cast` (participantId) | PLAYER | VOTE_OPEN |
| `reveal` (auto nach Vote-Lock) | SYSTEM | VOTE_LOCKED |
| `round.next` / `game.end` (Win-Check) | SYSTEM/HOST | — |
| `pause`/`resume` / `emergency.*` | HOST | — |

- **Ablaufbeispiel:** 5 Spieler, Begriff A: „Kaffee", B (Undercover):
  „Tee". Hinweise: „braun", „heiß", „Morgens", „Beutel", „grün".
  Voting: „grün" (Tee-Hint) wird Verdacht → Player D abgestimmt (3 von 4)
  → raus → War D der Undercover? → Nein → weitere Runde…

## 7. Wertung & Endgründe (Vorschläge, DEC-UND-01)

- **FEST-Prinzip:** Rollen-basiert, keine klassischen Punkte während
  des Spiels; Sieges-Punkte erst am Ende (Vorschlag: Survivor-Bonus).
- **Tie bei Voting:** keine Elimination (Vorschlag; Alternative:
  Stichentscheid per Draw — **nicht** empfohlen).
- Endgründe: `UNDERCOVER_WINS`, `AGENTS_WIN` (Undercover raus),
  `MAX_ROUNDS` (3 Runden, Agenten gewinnen), `HOST_ABORTED`,
  `TECHNICAL_ABORT`, `INSUFFICIENT_PLAYERS`.

## 8. Projektionen & Secrets

- PLAYER: eigener Begriff (private), eigene Rolle (Agent/Undercover),
  Hinweise aller (PUBLIC), eliminierte Spieler, Voting-Zustand;
  **keine** Begriffe der anderen, **keine** Rollen-Info.
- HOST: (blind-Modus) eliminierte Spieler + Win-Status; **keine**
  Begriffe (Vorschlag, DEC-UND-01). (Normal-Modus: + Begriffe/Rollen.)
- VIEWER: Hinweise, eliminierte, Voting; keine Begriffe/Rollen.
- DISPLAY: Hinweis-Übersicht + Voting-Stand.
- Preloading: Begriffe nie (Leak = Spielruin).

## 9. Rejoin/Pause/Host-Ausfall/Recovery

- Rejoin: eigene Rolle/Begriff (wiederholt, PLAYER_PRIVATE), Phase,
  Hinweise, eliminierte; **nie** fremde Begriffe.
- Pause: Input/Voting gesperrt.
- Host-Ausfall: Spiel pausiert (Host-Transfer nötig, da Voting-
  Reveal + Win-Check host-nah); Auto-Continuation nicht vorgesehen.
- Recovery: Rollen/Begriffe persistiert (Secret, nie im Log);
  Hinweise + Votes persistiert; Turn-Order konsistent; keine
  Doppel-Votes (commandId).

## 10. Results/Stats/Events/Versionierung

- RoundResult: Hinweise (je Spieler), Votes, Eliminierte,
  War-Undercover? (ja/nein), Rundennummer.
- GameResult: Gewinner (UNDERCOVER/AGENTS), Runden, Eliminierten-
  Reihenfolge.
- Stats: games, wins (je Rolle), avg rounds, votes cast,
  „richtig erkannt" (§9.12).
- Engine-Version: `1` (neu).

## 11. Tests & DoD

- 10 Pflichttests + spezifisch: **Begriff-Leak** (kein fremder
  Begriff in Player/Viewer/Display), Rolle-Leak (kein „du bist
  Undercover" an andere), Voting-Tie-Test, Win-Condition-Test
  (alle 3), Host-Blind-Modus (Host-Payload ohne Begriffe),
  Rejoin-Secret (Begriff bleibt privat), Recovery.
- Cores: Secret Role/Visibility, Turn, Submission (Hinweise),
  Vote/Reveal (Tie), Timer, Round-Transition, Result-Screen,
  Notification, Recovery.

## 12. Offene Punkte

| ID | Frage | Vorschlag (default) |
|---|---|---|
| DEC-UND-01 | Undercover-Anzahl (1 vs. mehr), Tie-Regel, Win nach max Runden, Host-Blind-Modus, Hinweis-Regeln (Länge, Filter) | 1 Undercover, Tie = keine Elimination, 3 Runden → Agenten, Host blind, 20 Zeichen, keine Zahlen |

---

## 13. Engine-Vertrag, Late Join & Rollen-Policy (12-08)

- **Gemeinsamer Vertrag:** `undercover` referenziert `../technical-mapping.md §3.4`
  (Zustandsmaschine, Command-Guards 1–4, Projektionen/`availableActions`,
  Persistenz/Version/Recovery, Medien-/Voice-/Camera-/Mic-/Display-Defaults)
  und weicht **nur** in den folgenden Punkten ab. `INSUFFICIENT_PLAYERS`
  gilt nur an Start-/Transition-Gates, nie gegen das absichtlich sinkende
  aktive Teilnehmerfeld im Spielverlauf (§12-10).
- **Late-Join-Policy (engine-spezifisch):** **Nein nach Start** — Rollenverteilung (Undercover/Agenten) ist nicht nachträglich integrierbar → Zuschauer bis Spielende (Vorschlag DEC-UND-01).
- **Ausscheidende Teilnehmer:** Ausgeschiedene → `LEFT`, Zuschauer; Rolle bleibt geheim (keine Reveal vor `GAME_END`, außer WIN_CHECK).
- **Teamrollen/Rotation:** keine (individuell, geheime Rollen).
- **Voice/Camera/Mic (Abweichung von den Defaults):** Mikrofon MUTED (Default); Discussion-Phase optional (Voice). ·
- **Viewer (FEST, Master §7.23 — kein Spiel darf abweichen):** kein Mic/Send (Viewer senden nie Audio); Viewer hört `MAIN`; nie `TEAM`; Host kann Viewer-Audio deaktivieren. ·
  Camera: OFF (Default).
- **Medien in Phasen:** keine.
- **RESULT_REVIEW:** geerbt (§3.4).
