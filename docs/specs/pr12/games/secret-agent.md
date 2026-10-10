# Geheim Agent (`secret-agent`) — Spezifikation

**Status main:** PLANNED, keine Engine. **Ziel-PR:** PR33 (nach PR14–20).
**Slug FEST** (§14/§15.17).

## 1. Kurzbeschreibung & Regelquellen

Eigenständige Social-Deduction-Engine: geheime Rollen/Informationen,
Runden/Phasen, Abstimmungen, Siegesbedingungen — über Visibility und
Voice geregelt. **Wichtiger Hinweis:** Der Master bezeichnet „Geheim
Agent" als **eigenständige Engine** mit **einfrorenen Detailregeln**,
aber diese Detailregeln sind **im Master nicht vollständig ausformuliert**
(§15.17 gibt nur Prinzip + Slug + Core-Vorgaben).

- FEST §15.17: Social-Deduction, Slug `secret-agent`, geheime
  Rollen/Informationen, Visibility/Secret Core, Voting/Phasen
  game-spezifisch.
- OFFEN: **alle** Detailregeln (Rollen-Satz, Runden-Count,
  Siegesbedingungen, Phasen-Count) → DEC-AGT-01. **Dieses Spiel
  braucht am meisten Nutzer-Feedback**, bevor die Engine gebaut wird.

## 2. Feste Regeln (Prinzip)

- Social-Deduction mit geheimen Rollen (wie Undercover, aber
  **eigenständige Engine** — keine Imposter/Undercover-Wiederverwendung).
- Rollen: mehrere (Vorschlag: Agent, Undercover, Saboteur, Schiedsrichter?
  → **ausdrücklich offen**, DEC-AGT-01).
- Runden/Phasen: pro Runde Hinweise + Voting (wie Undercover-Struktur,
  aber eigenständig).
- Siegesbedingungen: rollenabhängig (Vorschlag: wie Undercover, aber
  erweiterbar).
- Secret Core zwingend (Rollen + Informationen `PLAYER_PRIVATE`/
  `HOST_PRIVATE`).
- **Voice-Integration (Vorschlag, DEC-AGT-01):** Voice über `MAIN` ist
  optional; Text-Hinweise bleiben bei deaktivierter Voice verfügbar. Die
  eigenständige Engine folgt aus dem Master, nicht aus einer erfundenen
  Voice-Pflicht.

## 3. Spieler/Teams/Rollen

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 5 / 12 (Vorschlag, DEC-AGT-01) | V |
| Teams | nein (individuell, Rollen-basiert) | V |
| Host-Mitspiel | erlaubt nur ohne fremde Rollen/Begriffe; mitspielender Host zwingend blind | F (Fairness §2/§10); konkrete Umsetzung V |
| Secrets | eigener Rolle/Begriff: PLAYER_PRIVATE; Rollen aller + Begriffe: HOST_PRIVATE nur für nicht mitspielenden Host; Hinweise (Voice): MAIN-Kanal (PUBLIC) | F (Prinzip) |

## 4. Setup (Ziel)

```
SecretAgentSetup {
  pools: ContentPoolRef[]           // Rollendefinitionen + Begriffe
  roleConfig: {agentCount: 'AUTO' (n - 1 - saboteurCount),
               undercoverCount: 1,
               saboteurCount: 0|1, …}   // VORSCHLAG DEC-AGT-01
  // 12-10: Rollenverteilung muss EXAKT n Spieler abdecken:
  //   ohne Saboteur: Agent (n-1) + Undercover (1) = n
  //   mit Saboteur:  Agent (n-2) + Undercover (1) + Saboteur (1) = n
  // (früher stand hier pauschal „agentCount: n-2" → ohne Saboteur nur
  //  n-1 Rollen, ein Spieler ohne Rolle)
  roundMax: number (default 4)
  perRound: {hintTimerMs (default 30000), voteTimerMs (default 30000),
             discussionMs (default UNLIMITED, Voice)}
  turnOrder: RANDOM (seedRef)
  voice: {required: false, mainChannel: true}   // PR19/20
  scoring: {survivorBonus: 100, roleSpecificBonus: {…}}  // VORSCHLAG
  hostCanPlay: boolean (default true, blind)
  language: de-DE
}
```

- Quick: SYSTEM-Rollen-Preset „Klassiker" — **5 Spieler: 4 Agenten +
  1 Undercover** (Agent = n-1 ohne Saboteur, exakt n Rollen, 12-10;
  frühere Formulierung „3 Agenten + 1 Undercover" deckte nur 4 von
  5 Spielern ab), 4 Runden, Voice optional.
- Preflight: ≥5 Spieler, Rollen-Pool READY, **Rollenverteilung deckt exakt
  n ab** (sonst `INVALID_ROLE_CONFIG`).

## 5. Content-/Editor-Schema

- Item = `SecretAgentRoleSet`: roles[] (je {roleType, word?, count}),
  winConditions (JSON: rollenabhängig), category?, difficulty, tags.
- READY: ≥2 Rollentypen, Win-Conditions definiert, Sprache.
- **VORSCHLAG DEC-AGT-01 (Rollen-Satz):**
  - **Agent** (n−1−saboteurCount): gemeinsamer Begriff A.
  - **Undercover** (1): eigener Begriff B (ähnlich).
  - **Saboteur** (optional 0–1): weiß A und B, darf beide „tippen".
  - **Rollen-Check (12-10):** Summe muss exakt n ergeben (Preflight
    `INVALID_ROLE_CONFIG`).
  - Win: Undercover + Saboteur überleben bis max Runden → Team
    Undercover gewinnt; sonst Agenten.
  - **Alternative (einfacher, V1-Default):** nur Agent + Undercover
    (wie Undercover, aber mit Voice als eigenständiges Erlebnis).

## 6. Phasen/Commands

```
INTRO (Rollen-Zuteilung, Privat) → (je Runde) HINT_TURN_1 (Voice/Text) → … → DISCUSSION (Voice, UNLIMITED) → VOTE_OPEN → VOTE_LOCKED → REVEAL (Eliminierte) → WIN_CHECK → … → GAME_END (WINNER) → FINALIZED
```

| Command | Rolle | Phase |
|---|---|---|
| `hint.submit` (text, optional) | aktiver Spieler | HINT_TURN_i |
| `voice.join/leave/mute` | PLAYER | DISCUSSION (PR19/20) |
| `discussion.end` | HOST | DISCUSSION |
| `vote.cast` (participantId) | PLAYER | VOTE_OPEN |
| `reveal` (auto) | SYSTEM | VOTE_LOCKED |
| `round.next` / `game.end` (Win-Check) | SYSTEM | — |
| `pause`/`resume` / `emergency.*` | HOST | — |

- **Ablaufbeispiel:** 6 Spieler (4 Agenten „Eis", 1 Undercover „Salz",
  1 Saboteur). Stimme/Hinweise: „kalt", „würzig", „Schublade", „weiß",
  „Küche", „Schneeflocke". Diskussion (Voice). Voting: Player C
  (Saboteur, hat „würzig" gesagt) wird raus (3 Stimmen) → War C
  Untercover? Nein, Saboteur → Untercover noch drin → nächste Runde…

## 7. Wertung & Endgründe (Vorschläge, DEC-AGT-01)

- **FEST-Prinzip:** Rollen-basierte Win Conditions (rollenabhängig,
  konfigurierbar).
- **Vorschlag (V1-Default, einfach):** wie Undercover (Untercover vs.
  Agenten), aber mit Voice + optional Saboteur.
- **Tie bei Voting:** keine Elimination (wie Undercover).
- Endgründe: `ROLE_A_WINS` (Agenten), `ROLE_B_WINS` (Undercover+
  Saboteur), `MAX_ROUNDS`, `HOST_ABORTED`, `TECHNICAL_ABORT`,
  `INSUFFICIENT_PLAYERS`.
- Punkte: erst am Ende (Survivor-Bonus, rollenspezifisch — Vorschlag).

## 8. Projektionen & Secrets

- PLAYER: eigene Rolle + Begriff (private), Hinweise aller,
  eliminierte, Voting; **keine** fremden Rollen/Begriffe.
- HOST: mitspielend nur eigene Rolle/Begriff sowie eliminierte + Win-Status;
  fremde Rollen/Begriffe ausschließlich für nicht mitspielenden Host.
- VIEWER: Hinweise, eliminierte, Voting; keine Rollen/Begriffe.
- DISPLAY: Hinweis-Übersicht + Voting.
- **Voice:** MAIN-Kanal (alle), keine TEAM-Kanäle in diesem Spiel
  (sozialer Chat, nicht strategisch geheim).
- Preloading: Rollen/Begriffe nie (Leak = Spielruin).

## 9. Rejoin/Pause/Host-Ausfall/Recovery

- Rejoin: eigene Rolle/Begriff (wiederholt, PLAYER_PRIVATE), Phase,
  Hinweise, eliminierte; Voice: Rejoin-Flow (PR19/20).
- Pause: Input/Voting gesperrt; Voice: Pause (alle muten, PR19/20).
- Host-Ausfall: Pause (Host-Transfer nötig); Auto-Continuation nicht
  vorgesehen (Voice-Spiel braucht moderierte Phasen).
- Recovery: Rollen/Begriffe persistiert (Secret); Hinweise + Votes
  persistiert; Turn-Order konsistent; Voice-State: Rejoin-Flow.

## 10. Results/Stats/Events/Versionierung

- RoundResult: Hinweise, Votes, Eliminierte, Rollen (im Reveal),
  Rundennummer.
- GameResult: Gewinner (rollenabhängig), Runden, Eliminierten-
  Reihenfolge.
- Stats: games, wins (je Rolle), avg rounds, voice participation
  (§9.12).
- Engine-Version: `1` (neu).

## 11. Tests & DoD

- 10 Pflichttests + spezifisch: **Rollen-Leak** (keine fremde Rolle/
  Begriff), **Saboteur-Logik** (weiß beide Begriffe, darf beide
  „tippen"), Voice-Integration (JOIN/LEAVE/MUTE, Rejoin), Voting-Tie,
  Win-Condition (rollenabhängig), Recovery, Host-Blind.
- Cores: Secret Role/Visibility, Turn, Submission (Hinweise),
  Voice (PR19/20), Vote/Reveal (Tie), Timer, Round-Transition,
  Result-Screen, Notification, Recovery.

## 12. Offene Punkte

| ID | Frage | Vorschlag (default) |
|---|---|---|
| DEC-AGT-01 | **Rollen-Satz** (Agent/Undercover/Saboteur?), **Win Conditions**, Runden-Count, optionale Voice, technische Blind-Host-Umsetzung (Fairness FEST) | V1-Default: Agent + Undercover (wie Undercover) + Voice; Saboteur als Preset; 4 Runden; Voice optional; Host blind |

> **Wichtig:** „Geheim Agent" ist das am wenigsten ausformulierte
> Spiel im Master. **DEC-AGT-01 muss vor PR33-Start entschieden sein.**
> Bis dahin: Spezifikation als Entwurf, keine Engine.

---

## 13. Engine-Vertrag, Late Join & Rollen-Policy (12-08)

- **Gemeinsamer Vertrag:** `secret-agent` referenziert `../technical-mapping.md §3.4`
  (Zustandsmaschine, Command-Guards 1–4, Projektionen/`availableActions`,
  Persistenz/Version/Recovery, Medien-/Voice-/Camera-/Mic-/Display-Defaults)
  und weicht **nur** in den folgenden Punkten ab. `INSUFFICIENT_PLAYERS`
  gilt nur an Start-/Transition-Gates, nie gegen das absichtlich sinkende
  aktive Teilnehmerfeld im Spielverlauf (§12-10).
- **Late-Join-Policy (engine-spezifisch):** **Nein nach Start** — Rollenverteilung ist nicht nachträglich integrierbar → Zuschauer bis Spielende (Vorschlag DEC-AGT-01).
- **Ausscheidende Teilnehmer:** Ausgeschiedene → Zuschauer; Rollen-Geheimhaltung bleibt bis `GAME_END`.
- **Teamrollen/Rotation:** keine (individuell, geheime Rollen).
- **Voice/Camera/Mic (Abweichung von den Defaults):** Voice optional (Vorschlag DEC-AGT-01), bei Aktivierung `MAIN` in `DISCUSSION`; ohne Voice Text-Hinweise. Mikrofon: gemeinsamer, Host-konfigurierbarer Default (§3.4/Master §7.21), Bestätigung im Prejoin. ·
- **Viewer (FEST, Master §7.23 — kein Spiel darf abweichen):** kein Mic/Send (Viewer senden nie Audio); Viewer hört `MAIN`; nie `TEAM`; Host kann Viewer-Audio deaktivieren. ·
  Camera: OFF (Default).
- **Medien in Phasen:** keine.
- **RESULT_REVIEW:** geerbt (§3.4).
