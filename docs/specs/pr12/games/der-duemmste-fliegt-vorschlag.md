# Der Dümmste Fliegt (`der-duemmste-fliegt`) — **Vorschlag-Spezifikation**

> ⚠️ **Slug-Vorschlag** `der-duemmste-fliegt` (DEC-DDF-01, zu bestätigen).
> Aufnahme in V1.0: **NUTZERERGÄNZUNG 07.10.2026 (F)** — aber **konkrete
> Regeln nicht im Master**. Diese Datei ist ein **Vorschlags-Entwurf**
> mit Decision-IDs (DEC-DDF-01…06). **Die Detailmechanik ist nicht festgelegt; allgemeine Master-Regeln
> (insbesondere Secrets und Host-Fairness) gelten verbindlich.** Engine-Implementierung (PR36) blockiert bis Bestätigung.
> Dateiname bewusst mit „-vorschlag" markiert.

## 1. Kurzbeschreibung

Rundenweises Ausscheidungsspiel nach dem Prinzip „Der Dümmste Fliegt"
(Satire-Quiz): in jeder Runde werden Fragen gestellt; der/die
**„Dummste" scheidet aus** — wer die schlechteste Antwort liefert
(oder bei Voting: wer am meisten Stimmen erhält). Die letzten zwei
kommen ins **Finale**; dort gewinnt der/die „Klugste".

## 2. Vorschlag-Regeln (alle DEC-DDF-*, zu bestätigen)

### 2.1 Grundmechanik (DEC-DDF-02)

- **Runden-Modus (Vorschlag A — empfohlen):** In jeder Runde stellt der
  Host (oder ein Pool) **eine** Frage. Alle verbleibenden Spieler
  antworten gleichzeitig und privat (Submission-Core). Nach Reveal:
  **wer die schlechteste Antwort hatte** (Host-Judge: „Dummste"
  wählen; bei AUTO-Judge: wer am längsten gebraucht hat + falsch →
  „Dummste") scheidet aus.
- **Voting-Modus (Vorschlag B — Alternative):** Alle antworten;
  danach **Voting** (alle verbleibenden, außer sich selbst):
  „Wer ist der Dümmste in dieser Runde?" → Meisten Stimmen = raus.
- **Finale (2 verbleibend):** 1 Runde, wer die „klugere" Antwort hat
  → gewinnt (Host-Judge).
- **Scoring (Vorschlag):** keine klassischen Punkte während des
  Spiels; **Platzierung** durch Ausscheidungs-Zeitpunkt
  (1. = Finale-Gewinner, 2. = Finale-Verlierer, 3. = letzter
  vor Finale, …). Optional: „Dummste-Punkte" (wer ausgschieden
  wurde, bekommt 0; wer verbleibt, +10 pro Runde — Vorschlag, DEC-DDF-05).

### 2.2 Fragen-/Antwortmodell (DEC-DDF-03)

- Fragen: **freie Fragen** (Host-gestützt) **oder** Content-Pool
  (Vorschlag: **beides**, `mode: HOST_QUESTIONS|POOL_QUESTIONS|BOTH`).
- **Content-Item (wenn Pool):** `DdfQuestion`: prompt,
  „dummste Antwort" (optional, für AUTO-Judge), „klugste Antwort"
  (optional), category, difficulty, tags.
- **AUTO-Judge-Regel (Vorschlag):** wenn keine manuelle
  „Dummste"-Antwort definiert: wer **falsch + am längsten** →
  „Dummste" (kombiniert aus Falschheit + Zeit). Wenn alle korrekt:
  wer **am längsten** → „Dummste". Wenn alle falsch: ebenso die längste Antwortzeit.
  Rangfolge einheitlich: falsch vor korrekt, dann längere Serverzeit
  zuerst; gleiche Werte ergeben Tie (DEC-DDF-03/04).
- **Host-Judge (Default):** Host wählt manuell den „Dummsten"
  (wie bei Jeopardy — Judge-Ansicht).

### 2.3 Ties & Voting (DEC-DDF-04)

- **Voting-Tie (Modus B):** gleiche Stimmen → keine Elimination in
  dieser Runde, nächste Runde (Vorschlag; Alternative:
  Stichentscheid per Draw — **nicht** empfohlen).
- **AUTO-Judge-Tie:** identische Serverzeiten und gleicher Antwortstatus
  können Gleichstand ergeben. Vorschlag: keine Elimination, nächste Runde;
  mehrere Nichtabgaben werden ebenso behandelt (DEC-DDF-04).
- **Nichtabgabe:** Spieler, der nicht antwortet, wird automatisch
  „Dummste" (Vorschlag; Alternative: kein Ausscheiden, nur 0
  Punkte — **empfohlen:** Ausscheiden, da Nichtabgabe =
  „Dummste" im Spielprinzip).

### 2.4 Ausgeschiedene Rollen, Viewer/Display, Rejoin (DEC-DDF-06)

- **Ausgeschiedene Spieler:** bleiben im Raum (Viewer-Modus für
  sie), sehen alle weiteren Runden (keine Secrets mehr —
  alle Antworten sind PUBLIC nach Reveal), können **nicht**
  mehr antworten oder buzzen. Score/Platzierung: fixiert.
- **Viewer:** sieht alle Antworten nach Reveal, Ausscheidungs-
  Stand, Platzierungen; keine Extra-Info.
- **DISPLAY:** große Ausscheidungs-Ansicht (wer ist noch drin,
  wer ist raus, aktuelle Platzierung).
- **Rejoin (ausgeschieden):** wie Viewer (keine Mitspiel-Rechte
  mehr). **Rejoin (aktiv):** eigene Antworten (wenn offen),
  Platzierung, Phase.

### 2.5 Punkte (DEC-DDF-05)

- **Vorschlag A (empfohlen):** **keine Punkte** — nur Platzierung
  (wie Undercover/Geheim Agent).
- **Vorschlag B (Alternative):** +10 Punkte pro verbleibender Runde
  (5 überstandene Runden = 50; jede weitere = +10; Ausscheiden
  gibt keine weiteren Punkte, bereits verdiente Punkte bleiben).
  **Keine Minuspunkte in diesem Vorschlag**; der Master enthält kein
  allgemeines Minusverbot (z. B. Wer-ist-das und Jeopardy).

## 3. Spieler/Teams/Rollen (Vorschlag)

| Aspekt | Wert | Status |
|---|---|---|
| min/max | 4 / 10 (Vorschlag) | V (DEC-DDF-02) |
| Teams | nein (individuell) | V |
| Host-Mitspiel | nur ohne Wissensvorteil (FEST §2/§10). Eigene/bereits bekannte Fragen schließen Host-Mitspiel in dieser Runde aus. Bei unbekannten Poolfragen: eigene Antwort erst unwiderruflich locken, danach anonymisierte Judge-Ansicht (Mechanik V, DEC-DDF-06) | F (Fairness) / V (Mechanik) |
| Secrets | eigene Antwort: PLAYER_PRIVATE bis Reveal; alle Antworten: PUBLIC nach Reveal; „Dummste"-Entscheidung: HOST_PRIVATE (Judge) bis Reveal | V |

## 4. Setup (Vorschlag)

```
DerDuemmsteFliegtSetup {
  mode: HOST_QUESTIONS|POOL_QUESTIONS|BOTH (default HOST_QUESTIONS)
  pools: ContentPoolRef[] (wenn POOL/BOTH)
  roundCount: number|null (default null = bis 2 übrig)
  judgeMode: HOST_JUDGE|AUTO_JUDGE (default HOST_JUDGE)
  votingMode: HOST_PICK|PLAYER_VOTING (default HOST_PICK)
  perRound: {inputTimerMs (default 30000), revealDelayMs (2000)}
  scoring: {mode: NONE|SURVIVAL (default NONE)}
  hostCanPlay: boolean (default false bei eigenen/bekannten Fragen; bei unbekannten Poolfragen nur mit Antwort-Lock vor Judge-Ansicht)
  language: de-DE
}
```

- Quick: HOST_QUESTIONS, HOST_JUDGE, keine Punkte, 4–10 Spieler.
- Preflight: ≥4 Spieler, (wenn POOL) Pool READY; AUTO_JUDGE benötigt
  zusätzlich validierte Lösungs-/Matchingdaten (`acceptedAnswers`), sonst
  BLOCKED. Freitext ohne automatische Wahrheitsprüfung bleibt HOST_JUDGE.

## 5. Content-/Editor-Schema (wenn POOL-Modus)

- Item = `DdfQuestion`: prompt, dummsteAnswer? (optional, für
  AUTO-Judge), klugsteAnswer? (optional), category, difficulty,
  tags, language, acceptedAnswers? (für AUTO_JUDGE erforderlich).
- READY: prompt + category + Sprache.

## 6. Phasen/Commands (Vorschlag)

```
INTRO → (je Runde) QUESTION_REVEAL → INPUT_OPEN → INPUT_LOCKED → JUDGING oder VOTE_OPEN → VOTE_LOCKED (nur Voting) → REVEAL (alle Antworten + „Dummste" + Ausscheidung) → WIN_CHECK (2 übrig?) → FINALE (1 Runde, klugster gewinnt) → GAME_END (WINNER + Platzierungen) → FINALIZED
```

| Command | Rolle | Phase |
|---|---|---|
| `answer.submit` (text) | aktiver Spieler | INPUT_OPEN |
| `vote.cast` (participantId) | aktiver Spieler (außer sich) | VOTE_OPEN (Modus B) |
| `judge.pick` (anonyme answerId, „Dummste"; Server löst Teilnehmer auf) | HOST, eigene Antwort ggf. bereits LOCKED | JUDGING (Modus A) |
| `reveal` (auto) | SYSTEM | INPUT_LOCKED/VOTE_LOCKED |
| `round.next` / `finale.start` | SYSTEM | — |
| `pause`/`resume` / `emergency.*` | HOST | — |

- **Ablaufbeispiel (Host spielt nicht mit):** 6 Spieler, Poolfrage
  „Wie viele Seiten hat ein Dreieck?": A=3, B=4, C=„keine", D=3, E=1, F=3.
  Nach Input-Lock wählt der Host die anonyme Antwort „keine"; erst danach
  wird C als Autor aufgelöst und eliminiert. Weitere Runden eliminieren
  D, E und B. Finale A/F: „Wie viele Seiten hat ein Quadrat?", A=3, F=4.
  Der Host entscheidet für F. Platzierungen: F, A, B, E, D, C.

## 7. Wertung & Endgründe (Vorschlag, DEC-DDF-05)

- **Default:** keine Punkte, nur Platzierung (wie Undercover).
- **Alternative:** +10 pro Runde (SURVIVAL-Modus).
- Endgründe: `COMPLETED` (Finale beendet), `HOST_ABORTED`,
  `TECHNICAL_ABORT`, `INSUFFICIENT_PLAYERS` (nur Start-/Pause-Gate unter
  der **Start**-Mindestzahl; das absichtlich sinkende aktive Feld bis zum
  2er-Finale wird NICHT dadurch beendet — 12-10).

## 8. Projektionen & Secrets

- **Aktiver Spieler:** Frage, eigene Antwort (private), Timer,
  Platzierungs-Stand (wer ist noch drin, wer ist raus);
  **keine** fremden Antworten vor Reveal.
- **Ausgeschiedener Spieler:** wie Viewer (alle Runden sichtbar,
  keine Mitspiel-Rechte).
- **HOST (blind-Judge):** Antworten (anonymisiert — keine Namen!
  Vorschlag DEC-DDF-06), erst nach eigener unwiderruflicher Abgabe und `INPUT_LOCKED`; Phase, Platzierungen; **keine**
  Namen-Antwort-Zuordnung bis Reveal.
- **VIEWER/DISPLAY:** Frage, Timer, „wer ist noch drin";
  Antworten nach Reveal.
- Preloading: Frage (PUBLIC), Antworten nie.

## 9. Rejoin/Pause/Host-Ausfall/Recovery

- Rejoin (aktiv): Phase, eigene Antwort (wenn offen), Platzierung.
- Rejoin (ausgeschieden): wie Viewer.
- Pause: Input/Voting gesperrt.
- Host-Ausfall: Pause (Host-Judge nötig, blind-Modus);
  Auto-Reveal **nicht** vorgesehen (Judge nötig) → Transfer.
- Recovery: Antworten persistiert (PLAYER_PRIVATE bis Reveal);
  Ausscheidungs-Status konsistent; keine Doppel-Submissions.

## 10. Results/Stats/Events/Versionierung

- RoundResult: Frage-Ref, Antworten (alle, nach Reveal),
  „Dummste", Ausscheidung, Dauer.
- GameResult: Platzierungen (1. bis n.), Endgrund.
- Stats: games, wins, avg position, „Dummste" rate (§9.12).
- Engine-Version: `1` (neu).

## 11. Tests & DoD

- 10 Pflichttests + spezifisch: **Antwort-Leak** (keine fremde
  Antwort vor Reveal), **Blind-Judge-Test** (Host-Payload enthält
  keine Namen-Antwort-Zuordnung; vor eigenem Lock keine fremden Antworten;
  Host bei eigenen/bekannten Fragen ausgeschlossen), Voting-Tie-Test, Nichtabgabe-Test
  (auto-„Dummste"), Ausscheidungs-Korrektheit (Platzierungen),
  **Ausgeschiedener-Spieler-Test** (keine Mitspiel-Rechte nach
  Ausscheiden), Rejoin (aktiv vs. ausgeschieden), Recovery.
- Cores: Submission, Timer, Judge (blind), Vote (optional),
  Reveal/Visibility, Score (Platzierung), Round-Transition,
  Result-Screen, Notification, Recovery.

## 12. Offene Punkte (alle zu bestätigen)

| ID | Frage | Vorschlag (default) |
|---|---|---|
| DEC-DDF-01 | **Slug** `der-duemmste-fliegt` | bestätigen (bzw. alternativer Vorschlag) |
| DEC-DDF-02 | Grundmechanik (Vorschlag A: Host-Judge / B: Voting / C: AUTO-Judge), min/max | A (Host-Judge), 4–10 |
| DEC-DDF-03 | Fragenmodell (HOST/POOL/BOTH), AUTO-Judge-Regel | BOTH, AUTO-Judge = falsch + längste Zeit |
| DEC-DDF-04 | Ties (Voting + AUTO), Nichtabgabe | Voting-Tie = keine Elimination, Nichtabgabe = „Dummste" |
| DEC-DDF-05 | Punkte (keine / +10 pro Runde) | keine (nur Platzierung) |
| DEC-DDF-06 | Ausgeschiedene (Viewer-Modus), Host-Blind-Judge, Rejoin-Regeln | Viewer-Modus, blind (anonymisiert), Rejoin = Viewer-Status |

> **Keine dieser Vorschlags-Regeln ist festgelegt.** PR36 (Engine)
> **darf nicht starten**, bis DEC-DDF-01…06 bestätigt sind.
> Die Aufnahme in V1.0 selbst (ADD-DDF-01) ist fest (Nutzerergänzung).

---

## 13. Engine-Vertrag, Late Join & Rollen-Policy (12-08)

- **Gemeinsamer Vertrag:** `der-duemmste-fliegt` referenziert `../technical-mapping.md §3.4`
  (Zustandsmaschine, Command-Guards 1–4, Projektionen/`availableActions`,
  Persistenz/Version/Recovery, Medien-/Voice-/Camera-/Mic-/Display-Defaults)
  und weicht **nur** in den folgenden Punkten ab. `INSUFFICIENT_PLAYERS`
  gilt nur an Start-/Transition-Gates, nie gegen das absichtlich sinkende
  aktive Teilnehmerfeld im Spielverlauf (§12-10).
- **Late-Join-Policy (engine-spezifisch):** Nein in der laufenden Runde → `PENDING_JOIN`, ab der **nächsten** Runde aktiv (Vorschlag DEC-DDF-06); Host-Judge-Antworten bleiben anonym.
- **Ausscheidende Teilnehmer:** Ausgeschiedene → **Viewer-Modus** (Vorschlag DEC-DDF-06), kein Rejoin in dieselbe Partie; Finale (2 Spieler) wird nicht durch `INSUFFICIENT_PLAYERS` abgeschnitten (§12-10).
- **Teamrollen/Rotation:** keine (individuell).
- **Voice/Camera/Mic (Abweichung von den Defaults):** Mikrofon: gemeinsamer, Host-konfigurierbarer Default (§3.4/Master §7.21), Bestätigung im Prejoin. ·
- **Viewer (FEST, Master §7.23 — kein Spiel darf abweichen):** kein Mic/Send (Viewer senden nie Audio); Viewer hört `MAIN`; nie `TEAM`; Host kann Viewer-Audio deaktivieren. ·
  Camera: OFF (Default).
- **Medien in Phasen:** keine.
- **RESULT_REVIEW:** geerbt (§3.4).
