# Medienzugriff — Zugriffsregeln je Asset-Typ (PR11)

## Überblick

`GET /api/v1/media/:id` liefert Medien je nach `visibility` aus. Seit PR11 sind
nicht-öffentliche Assets **nur über kurzlebige HMAC-Signed-URLs** erreichbar;
rohe Asset-IDs geben keine Dateien mehr frei.

| visibility | Wer lädt wie | Cache |
| --- | --- | --- |
| `PUBLIC` | Jede/r (ohne Auth), z. B. Wissensduell-/Geo-Fragebilder | `public, max-age=86400` |
| `SYSTEM` | Jede/r (ohne Auth), System-/Avatare | `public, max-age=86400` |
| `PRIVATE` | Nur per Signed-URL (audience `game` oder `host`, s. u.) | `no-store` |
| `ROOM_TEMP` | Wie `PRIVATE` (Composite-Spielbilder von „Wer ist das?“) | `no-store` |
| `SHARED` | Wie `PRIVATE` (bis auf weiteres keine eigenen Inhalte erzeugt) | `no-store` |

## Signed-URLs (`?exp=<unix-ts>&sig=<HMAC>`)

- Signatur über `assetId|audience|exp` mit `SESSION_SECRET`, Vergleich timing-safe.
- **Audience `game`** (TTL 5 Min): das *freigegebene Spielbild* einer aktiven
  „Wer ist das?“-Runde. Funktioniert **ohne Login** — Player/Viewer/Display haben
  keine HTTP-Session. In `weristdas:update`/`weristdas:resync` als `gameImageUrl`.
- **Audience `host`** (TTL 60 Min): die *Original-Bilder*. Zusätzlich zur
  gültigen Signed-URL muss die **Session** gültig sein UND der Session-User
  Upload-Besitzer oder Raum-Host des Assets sein. In der Host-Projektion als
  `hostImageUrls`.
- Abgelaufene (`exp`), signaturfremde oder auf ein anderes Asset ausgerechnete
  Signatur → `403` (generisch, keine Detailleaks).

## Upload (`POST /api/v1/media`)

- Echter Content-Check: Bild-Format wird aus den **Bytes** decodiert (sharp),
  Audio über Magic-Bytes (RIFF/WEBM/MP4/FLAC/WAV) — Client-MIME/-Suffix wird
  nicht geglaubt. Spoofing (Text als `.png`) → `415`.
- Limits: `MAX_UPLOAD_SIZE_MB` (50), `MAX_IMAGE_SIZE_MB` (10),
  `MAX_IMAGE_DIMENSION` (4096).
- Normalisierung: Bilder → WebP, EXIF-Orientierung angewandt, übrige
  Metadaten gestrippt (keine GPS/Personen-/Kamerainfo).
- Dedupe: identische *normalisierte* Bytes desselben Uploaders → existierendes
  Asset wird zurückgegeben (200), keine zweite Zeile, kein Ownership-Transfer.
- Fehler (korrupte Datei, Limit, kein Bild) → `4xx` mit verständlicher Meldung
  und **Datei-Cleanup** (keine Orphan-Dateien, keine 500er).

## Fusion-Spielbild (`POST /api/v1/media/composite`, „Wer ist das?“)

- Nur mit gültiger Host-Session. Beide Quellen müssen existieren, Bilder sein,
  `READY` sein und **diesem Host** gehören; `roomId` wird nur akzeptiert, wenn
  der Host den Raum besitzt.
- Deterministische Erzeugung (`crossfade-v1`, 1024×1024, 50%-Crossfade) via
  `createGameImage()` (austauschbar durch späteres Morphing, gleiche Signatur).
- Ergebnis **einmal** persistiert: `ROOM_TEMP`, `derivedFromAssetIds=[A,B]`,
  Filename `fusion-<round>-<digest>` (enthält keine Lösung), idempotent über
  sha256 (Wiederholungsaufruf → gleiche Asset-ID, kein Duplikat).
- Antwort enthält `gameImageUrl` (Signed, audience `game`) für die Vorschau.

## Was nie nach außen geht

- `storagePath`, `originalName` (kann Lösungen enthalten) und rohe Secret-IDs
  stehen in **keinem** HTTP-Header und in **keiner** Spieler-/Zuschauer-
  Projektion. Private Antworten: neutraler `Content-Disposition`, `no-store`.
- Vor Reveal: keine Namen/Aliase/Original-IDs/-URLs in Socket-Events, Snapshots
  oder Resync; `game:end` ohne Reveal veröffentlicht nichts.
