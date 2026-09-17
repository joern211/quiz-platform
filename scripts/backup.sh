#!/bin/bash
# ============================================================
# Backup-Skript für Online Quiz Plattform
# ============================================================
#
# Verwendung:
#   pnpm backup                    # Standard-Backup in ./storage/backups
#   BACKUP_DIR=/path/to/backups pnpm backup
#
# Umgebungsvariablen:
#   BACKUP_DIR       - Backup-Verzeichnis (Standard: ./storage/backups)
#   DATABASE_URL     - Datenbank-URL (Standard: file:./storage/database/quiz.db)
#   UPLOADS_DIR      - Uploads-Verzeichnis (Standard: ./storage/uploads)
#   RETENTION_DAYS   - Tage bis automatische Löschung (Standard: 7)
#

set -e

# Konfiguration aus Umgebung oder Standard
BACKUP_DIR="${BACKUP_DIR:-./storage/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

# Datenbank-Pfad aus DATABASE_URL extrahieren oder Standard verwenden
DATABASE_URL="${DATABASE_URL:-file:./storage/database/quiz.db}"
if [[ "$DATABASE_URL" == file:* ]]; then
    DB_PATH="${DATABASE_URL#file:}"
    # Relative Pfade auflösen
    if [[ "$DB_PATH" != /* ]]; then
        DATABASE_PATH="$(cd "$(dirname "$DB_PATH")" 2>/dev/null && pwd)/$(basename "$DB_PATH")"
    else
        DATABASE_PATH="$DB_PATH"
    fi
else
    # Für PostgreSQL/MySQL: Datenbank-Dump
    DATABASE_PATH=""
fi

UPLOADS_DIR="${UPLOADS_DIR:-./storage/uploads}"

# Zeitstempel
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="quiz_backup_${TIMESTAMP}"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"

echo "=== Quiz Plattform Backup ==="
echo "Zeit: $(date)"
echo "Backup-Verzeichnis: ${BACKUP_DIR}"
echo ""

# Verzeichnis erstellen
mkdir -p "${BACKUP_PATH}"

# ============================================================
# Datenbank sichern
# ============================================================
if [ -n "$DATABASE_PATH" ] && [ -f "$DATABASE_PATH" ]; then
    echo "Sichere SQLite-Datenbank..."
    cp "$DATABASE_PATH" "${BACKUP_PATH}/quiz.db"
    echo "  -> ${BACKUP_PATH}/quiz.db ($(du -h "$DATABASE_PATH" | cut -f1))"
elif [ -z "$DATABASE_PATH" ]; then
    echo "Datenbank-Backup übersprungen (Remote-DB erkannt, kein Dump konfiguriert)"
else
    echo "Warnung: Datenbank nicht gefunden: ${DATABASE_PATH}"
fi

# ============================================================
# Uploads sichern
# ============================================================
if [ -d "$UPLOADS_DIR" ] && [ "$(ls -A "$UPLOADS_DIR" 2>/dev/null)" ]; then
    echo "Sichere Uploads..."
    cp -r "$UPLOADS_DIR" "${BACKUP_PATH}/uploads"
    echo "  -> ${BACKUP_PATH}/uploads/"
else
    echo "Keine Uploads zum Sichern."
fi

# ============================================================
# Manifest erstellen
# ============================================================
cat > "${BACKUP_PATH}/manifest.json" << EOF
{
  "timestamp": "${TIMESTAMP}",
  "createdAt": "$(date -Iseconds)",
  "version": "1.0.0",
  "backupType": "manual",
  "components": {
    "database": $([ -n "$DATABASE_PATH" ] && [ -f "${BACKUP_PATH}/quiz.db" ] && echo "true" || echo "false"),
    "uploads": $([ -d "${BACKUP_PATH}/uploads" ] && echo "true" || echo "false")
  }
}
EOF

# ============================================================
# Prüfsummen erstellen
# ============================================================
echo "Erstelle Prüfsummen..."
cd "${BACKUP_PATH}"
sha256sum quiz.db > quiz.db.sha256 2>/dev/null || true
find . -type f -exec sha256sum {} \; > checksums.sha256

echo ""
echo "Backup erstellt: ${BACKUP_PATH}"

# ============================================================
# Alte Backups löschen
# ============================================================
echo ""
echo "Prüfe alte Backups (Aufbewahrung: ${RETENTION_DAYS} Tage)..."
find "${BACKUP_DIR}" -maxdepth 1 -type d -name "quiz_backup_*" -mtime +${RETENTION_DAYS} -exec rm -rf {} \; 2>/dev/null || true

# ============================================================
# Zusammenfassung
# ============================================================
echo ""
echo "=== Aktuelle Backups ==="
ls -la "${BACKUP_DIR}"/quiz_backup_* 2>/dev/null | tail -5 || echo "Keine Backups gefunden."

echo ""
echo "=== Backup abgeschlossen! ==="
echo ""
echo "Zum Wiederherstellen: pnpm restore"
